import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import fastifyStatic from '@fastify/static';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applyImport,
  artifactSchema,
  artifactToYaml,
  exportArtifact,
  mergeLocalOnly,
  parseArtifactYaml,
  planImport,
  slugify,
} from './artifact.js';
import type { CoachRuntime } from './bootstrap.js';
import {
  classifyTracesInline,
  countUnclassified,
  flowSelectorSchema,
  resetClassificationForBackfill,
  runClassifySweep,
} from './classify.js';
import { corpusRefSchema, runCompare } from './compare.js';
import {
  concludeExperiment,
  createExperiment,
  getExperiment,
  listExperiments,
  newestTwoLabels,
} from './experiments.js';
import { claimQueuedRun, createRun, failRun, runDiscovery, type RunKind } from './discovery.js';
import {
  autorunDueEvals,
  createEvalFromDeviation,
  createManualEval,
  deleteEval,
  getEvalDetail,
  listEvalSummaries,
  runEval,
  updateEval,
} from './evals.js';
import {
  auditFlow,
  createFlow,
  deleteFlow,
  getFlowDetail,
  listFlows,
  runFlows,
  updateFlow,
} from './flows.js';
import { runImprover } from './improver.js';
import { collectTraceIds, otlpEnvelopeSchema, TraceNormalizeError, upsertTrace } from './ingest.js';
import { providerAvailability, resolveLlm, resolveLlmConfig } from './llm.js';
import { saveSettings, settingsSchema } from './settings.js';
import { estimateCostIfMetered, estimateCostUsd } from './pricing.js';
import { BudgetExceededError, generateTextTracked, getUsageSummary, resetUsage, resolveBudgetUsd } from './usage.js';
import { deviationExamples, deviations, evals, flowTraces, flows, runs, traces } from './schema.js';
import { bearerToken, isLoopbackHost, isLoopbackOrigin, timingSafeKeyEquals } from './security.js';
import { createTailHub } from './tail.js';
import { loadBuildTraceView } from './trace-view.js';

/** Max accepted request body size — 16 MiB OTLP envelope cap. */
const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Decode a (possibly compressed) request body. The `@glassray/tracing` SDK and
 * standard OTLP/HTTP exporters gzip payloads once they pass ~8 KiB and send
 * `content-encoding: gzip`, so ingest must inflate before JSON-parsing.
 * Decompression is bounded to the body limit (a zip-bomb guard).
 */
const decodeRequestBody = (encoding: string | undefined, raw: Buffer): Buffer => {
  const enc = encoding?.split(',')[0]?.trim().toLowerCase();
  switch (enc) {
    case undefined:
    case '':
    case 'identity':
      return raw;
    case 'gzip':
    case 'x-gzip':
      return gunzipSync(raw, { maxOutputLength: BODY_LIMIT_BYTES });
    case 'deflate':
      return inflateSync(raw, { maxOutputLength: BODY_LIMIT_BYTES });
    case 'br':
      return brotliDecompressSync(raw, { maxOutputLength: BODY_LIMIT_BYTES });
    default:
      throw new Error(`unsupported content-encoding: ${enc}`);
  }
};

/** package.json, read once — feeds the version reported by /api/info. */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Absolute path of the built SPA (coach/web/dist). */
const WEB_DIST_DIR = fileURLToPath(new URL('../web/dist', import.meta.url));

/** Query-string contract for GET /api/traces (list + filters). */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Substring match against trace name OR agent (case-insensitive). */
  q: z.string().trim().max(200).optional(),
  /** Exact agent filter. */
  agent: z.string().trim().max(200).optional(),
  /** `error` → only error traces; `ok` → only ok traces; omitted → all. */
  status: z.enum(['error', 'ok']).optional(),
  /** Only traces that are members of this flow. */
  flow: z.string().trim().max(100).optional(),
  /** Exact run-label filter (the `glassray run --label` corpus key). */
  label: z.string().trim().min(1).max(200).optional(),
});

/** Optional query contract for the ingest routes: a run-label override for every trace in the POST. */
const ingestQuerySchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
});

/** Body contract for POST /api/discovery/run — optional sample-size override + flow scope. */
const discoveryBodySchema = z.object({
  sampleSize: z.coerce.number().int().min(1).max(200).optional(),
  flowId: z.string().trim().min(1).max(100).optional(),
});

/**
 * Body contract for POST /api/evals — either "save from a deviation"
 * (`{ deviationId }` — lands as a custom rule) or a hand-written rule
 * (`{ label, rule, … }`), both optionally scoped to a flow. `sourceFile` links
 * the rule to the repo path its expectation is written in (absent = custom).
 */
const createEvalBodySchema = z.union([
  z.object({
    deviationId: z.string().trim().min(1),
    flowId: z.string().trim().min(1).max(100).optional(),
  }),
  z.object({
    label: z.string().trim().min(1).max(200),
    rule: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(2000).optional(),
    flowId: z.string().trim().min(1).max(100).optional(),
    sourceFile: z.string().trim().min(1).max(500).nullable().optional(),
    autorunThreshold: z.number().int().min(1).max(1000).optional(),
    threshold: z.number().min(0).max(1).optional(),
    judgeModel: z.string().trim().min(1).max(200).optional(),
  }),
]);

/** Body contract for PATCH /api/evals/:id — flow binding + source file + gate tuning. */
const evalPatchSchema = z.object({
  flowId: z.string().trim().min(1).max(100).nullable().optional(),
  sourceFile: z.string().trim().min(1).max(500).nullable().optional(),
  autorunThreshold: z.number().int().min(1).max(1000).optional(),
  threshold: z.number().min(0).max(1).nullable().optional(),
  judgeModel: z.string().trim().min(1).max(200).nullable().optional(),
});

/** Body contract for POST /api/evals/:id/run — sample-size / judge-model overrides, or a pinned fixtures corpus. */
const evalRunBodySchema = z.object({
  sampleSize: z.coerce.number().int().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  /** Score exactly these traces (the deterministic `check --fixtures` corpus). */
  traceIds: z.array(z.string().regex(/^[0-9a-f]{32}$/i)).min(1).max(200).optional(),
});

/** Body contract for POST /api/export — fresh export (or an external artifact) merged over a base file's local-only sections. */
const exportBodySchema = z.object({
  baseYaml: z.string().max(1_000_000).optional(),
  artifact: z.unknown().optional(),
});

/** Body contract for POST /api/artifact/parse — a glassray.yaml document to validate + return structured. */
const parseBodySchema = z.object({
  yaml: z.string().min(1).max(1_000_000),
});

/** Body contract for POST /api/import — the artifact as YAML text or a parsed object, plan-only by default. */
const importBodySchema = z.object({
  yaml: z.string().max(1_000_000).optional(),
  artifact: z.unknown().optional(),
  /** False (default) = plan only (`--dry-run`); true = apply the plan. */
  apply: z.boolean().default(false),
  /** Execute prunes (archive unmentioned live flows/rules) — never on by default. */
  prune: z.boolean().default(false),
});

/** Body contract for POST /api/compare — two corpora + the optional flow whose rules form the suite. */
const compareBodySchema = z.object({
  flowId: z.string().trim().min(1).max(100).optional(),
  baseline: corpusRefSchema,
  candidate: corpusRefSchema,
  sampleSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** Query contract for GET /api/flows/:id/fixtures — how many newest members to freeze. */
const fixturesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

/** Body contract for POST /api/experiments — open a new experiment for a question, optionally scoped to a flow. */
const createExperimentBodySchema = z.object({
  flowId: z.string().trim().min(1).max(100).nullable().optional(),
  question: z.string().trim().min(1).max(500),
});

/** Query contract for GET /api/experiments — optional flow scope. */
const experimentListQuerySchema = z.object({
  flowId: z.string().trim().min(1).max(100).optional(),
});

/** Body contract for POST /api/experiments/:id/report — the two corpus labels (default = the two newest). */
const experimentReportBodySchema = z.object({
  baseline: z.string().trim().min(1).max(200).optional(),
  candidate: z.string().trim().min(1).max(200).optional(),
});

/** Body contract for POST /api/flows — a durable flow definition (selector and/or rule). */
const flowCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  selector: flowSelectorSchema.nullish(),
  rule: z.string().trim().min(1).max(2000).nullish(),
  classify: z.enum(['selector', 'llm']).optional(),
  createdBy: z.enum(['user', 'claude']).optional(),
});

/** Body contract for PATCH /api/flows/:id — a partial definition update. */
const flowPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  selector: flowSelectorSchema.nullable().optional(),
  rule: z.string().trim().min(1).max(2000).nullable().optional(),
  classify: z.enum(['selector', 'llm']).optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/** Query-string contract for GET /api/flows — active by default. */
const flowListQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
});

/** Query-string contract for GET /api/runs. */
const runListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

/** Body contract for POST /api/replay — an edited LLM request to re-issue (free-text). */
const replayBodySchema = z.object({
  /** Optional system-role instruction. */
  system: z.string().max(40_000).optional(),
  /** The prompt to complete. */
  prompt: z.string().min(1).max(80_000),
  /** Model id override within the configured provider. */
  model: z.string().trim().max(200).optional(),
  /** Sampling temperature. */
  temperature: z.coerce.number().min(0).max(2).optional(),
});

/** Number of buckets the activity timeline is split into. */
const TIMELINE_BUCKETS = 30;

/** Floor on a timeline bucket's width (1 minute) so a sub-second ingest burst doesn't render as a flat full-width chart. */
const MIN_BUCKET_MS = 60_000;

/**
 * Explicit backstop timeout for a background run, when set: GLASSRAY_RUN_TIMEOUT_MS
 * verbatim (`0` disables). Null = unset, use the provider-adaptive default below.
 */
const RUN_TIMEOUT_ENV_MS = (() => {
  const raw = Number(process.env.GLASSRAY_RUN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
})();

/** Default backstop timeout for a background run on the metered/mock providers. */
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/**
 * The zero-config `claude-subscription` provider runs a full Agent SDK turn per
 * call — its heavy-tier grouping legitimately outlives the flat 600s backstop
 * (the dogfood's discovery run timed out and produced nothing). Give it 3×.
 */
const SUBSCRIPTION_TIMEOUT_MULTIPLIER = 3;

/**
 * Backstop timeout for a background run (discovery / flows / eval / compare). A
 * stalled LLM call would otherwise leave the run `running` forever — holding the
 * single-run lock and spinning the UI. Provider-adaptive: the explicit env wins,
 * else 600s, tripled under `claude-subscription`. Resolved per run start so a
 * settings change applies without a restart.
 */
const runTimeoutMs = (): number =>
  RUN_TIMEOUT_ENV_MS ??
  (resolveLlmConfig().provider === 'claude-subscription'
    ? DEFAULT_RUN_TIMEOUT_MS * SUBSCRIPTION_TIMEOUT_MULTIPLIER
    : DEFAULT_RUN_TIMEOUT_MS);

/**
 * Debounce (ms) between the last ingest and the background classify sweep, so
 * a burst of traces triggers one sweep rather than one per POST. Overridable
 * via GLASSRAY_CLASSIFY_DEBOUNCE_MS (tests set it low).
 */
const CLASSIFY_DEBOUNCE_MS = (() => {
  const raw = Number(process.env.GLASSRAY_CLASSIFY_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
})();

/** Upper bound on rows scanned for the timeline (a wedge cap — newest-first). */
const TIMELINE_ROW_CAP = 5000;

/** One point of the activity timeline: a bucket midpoint with its trace + error counts. */
type TimelinePoint = { t: string; traces: number; errors: number };

/**
 * Bucket trace timestamps into a fixed-width activity series over the data's own
 * range (min→max), so the sparkline is populated whether traces span minutes or
 * days. Empty when nothing is captured.
 */
const buildTimeline = (
  rows: Array<{ ts: unknown; status: string | null }>,
): { points: TimelinePoint[]; from: string | null; to: string | null } => {
  const pts = rows
    .map((r) => ({ t: new Date(r.ts as string | Date).getTime(), error: r.status === 'error' }))
    .filter((p) => Number.isFinite(p.t));
  if (pts.length === 0) return { points: [], from: null, to: null };
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.t < lo) lo = p.t;
    if (p.t > hi) hi = p.t;
  }
  // Bucket width has a 1-minute floor: a burst of traces landing within a few
  // hundred ms would otherwise stretch across the whole chart with identical
  // per-minute labels. The window ends at the latest trace, so a burst reads as
  // a spike at the right edge of an honest ≥30-minute axis; a genuinely
  // day-spanning range still uses its own width (span / buckets ≥ the floor).
  const span = hi - lo;
  const width = Math.max(span / TIMELINE_BUCKETS, MIN_BUCKET_MS);
  const start = hi - width * TIMELINE_BUCKETS;
  const traces = new Array<number>(TIMELINE_BUCKETS).fill(0);
  const errors = new Array<number>(TIMELINE_BUCKETS).fill(0);
  for (const p of pts) {
    const idx = Math.min(TIMELINE_BUCKETS - 1, Math.max(0, Math.floor((p.t - start) / width)));
    traces[idx] += 1;
    if (p.error) errors[idx] += 1;
  }
  const points = traces.map((n, i) => ({
    t: new Date(start + width * (i + 0.5)).toISOString(),
    traces: n,
    errors: errors[i] ?? 0,
  }));
  return { points, from: new Date(start).toISOString(), to: new Date(hi).toISOString() };
};

/** Paths that must 404 as JSON instead of falling back to the SPA shell. */
const isReservedPath = (url: string): boolean => {
  const pathname = url.split('?')[0] ?? url;
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/v1/traces' ||
    pathname.startsWith('/v1/traces/')
  );
};

export type BuildAppOptions = {
  runtime: CoachRuntime;
  /** Fallback port for /api/info's ingestEndpoint when the socket isn't bound yet. */
  port?: number;
};

/** Builds the Fastify app (routes + guards) without binding a port, so tests can boot it hermetically. */
export const buildApp = async ({ runtime, port = 5899 }: BuildAppOptions): Promise<FastifyInstance> => {
  const { db, apiKey } = runtime;
  const buildTraceView = await loadBuildTraceView();
  const tail = createTailHub();

  const app = Fastify({ bodyLimit: BODY_LIMIT_BYTES, logger: false });

  // application/json only, but transparently decode gzip/deflate/br request
  // bodies first (the SDK + OTLP exporters compress large payloads). Dropping the
  // other built-in parsers keeps any non-JSON content type a 415.
  app.removeContentTypeParser(['text/plain', 'application/json']);
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, raw, done) => {
    try {
      const buf = decodeRequestBody(req.headers['content-encoding'], raw as Buffer);
      // An empty body parses to `undefined`; handlers already treat that as absent.
      done(null, buf.length === 0 ? undefined : JSON.parse(buf.toString('utf8')));
    } catch (err) {
      const e = (err instanceof Error ? err : new Error(String(err))) as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e);
    }
  });

  // Loopback-only guard on EVERY route: reject non-loopback Host headers and, when an
  // Origin header is present, non-loopback origins (DNS-rebinding defense).
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (
      !isLoopbackHost(req.headers.host) ||
      (typeof origin === 'string' && !isLoopbackOrigin(origin))
    ) {
      return reply.code(403).send({ error: 'forbidden: glassray only accepts loopback requests' });
    }
  });

  app.addHook('onClose', async () => {
    // Stop background scheduling first, then abort any executing run so its
    // provider call doesn't outlive the datastore it writes to.
    if (classifyTimer) clearTimeout(classifyTimer);
    activeRun?.abort.abort();
    tail.close();
    await runtime.client.close();
  });

  /**
   * Bearer check as an `onRequest` hook — runs BEFORE the body is parsed/inflated,
   * so an unauthenticated caller can't force a (bounded) gzip/brotli decompression
   * + JSON.parse of a 16 MiB body without a valid key. Registered on the ingest
   * routes below.
   */
  const requireApiKey = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(req.headers.authorization);
    if (token === null || !timingSafeKeyEquals(token, apiKey)) {
      return reply.code(401).send({ error: 'unauthorized: missing or invalid API key' });
    }
  };

  /** Shared OTLP ingest handler (per-trace merge upsert; auth is enforced by `requireApiKey` pre-parse). */
  const handleIngest = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = otlpEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid OTLP JSON envelope: expected { resourceSpans: [...] }' });
    }
    // Optional `?label=` overrides every landed trace's run label — how
    // cloud-pulled traces are tagged `production` on their way in.
    const query = ingestQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid label query parameter' });
    }
    const labelOverride = query.data.label;
    const envelope = req.body;
    const traceIds = collectTraceIds(envelope);
    // Ingest each trace independently: one malformed span shouldn't 500 the
    // request (leaking zod internals) or reject a batch's other, valid traces.
    // A bad trace is skipped + logged; the request succeeds if any trace landed.
    const landed: string[] = [];
    for (const traceId of traceIds) {
      try {
        await upsertTrace(db, traceId, envelope, buildTraceView, labelOverride);
        tail.broadcast(traceId);
        landed.push(traceId);
      } catch (err) {
        // Only a normalization failure is the trace's fault (skip it). Anything
        // else — a datastore error, say — is a real server failure: surface it as
        // a retryable 503 rather than swallowing it and reporting success.
        if (!(err instanceof TraceNormalizeError)) {
          req.log.error({ traceId, err }, 'ingest failed for a trace');
          return reply.code(503).send({ error: 'ingest failed — please retry' });
        }
        req.log.warn({ traceId, err: err.cause }, 'skipped a trace with malformed OTLP spans');
      }
    }
    if (traceIds.length > 0 && landed.length === 0) {
      return reply.code(400).send({ error: 'no traces could be ingested (malformed OTLP spans)' });
    }
    if (landed.length > 0) {
      // Freshness pass (selector flows) + watermark sweep — classification must
      // never fail an ingest that already committed.
      try {
        await classifyTracesInline(db, landed);
      } catch (err) {
        req.log.warn({ err }, 'inline flow classification failed');
      }
      scheduleClassifySweep();
    }
    return reply.code(200).send({});
  };

  app.post('/v1/traces', { onRequest: requireApiKey }, handleIngest);
  app.post('/api/public/otel/v1/traces', { onRequest: requireApiKey }, handleIngest);

  app.get('/api/info', async () => {
    const address = app.server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    return {
      name: 'glassray',
      version: pkg.version,
      ingestEndpoint: `http://127.0.0.1:${boundPort}/v1/traces`,
      apiKey,
    };
  });

  app.get('/api/traces', async (req, reply) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid limit/offset query parameters' });
    }
    const { limit, offset, q, agent, status, flow, label } = query.data;
    // Compose the active filters into one WHERE (undefined clauses drop out).
    const clauses: SQL[] = [];
    if (q) {
      const like = `%${q}%`;
      clauses.push(or(ilike(traces.name, like), ilike(traces.agent, like))!);
    }
    if (agent) clauses.push(eq(traces.agent, agent));
    if (status) clauses.push(eq(traces.status, status));
    if (label) clauses.push(eq(traces.runLabel, label));
    if (flow) {
      clauses.push(
        inArray(
          traces.id,
          db.select({ id: flowTraces.traceId }).from(flowTraces).where(eq(flowTraces.flowId, flow)),
        ),
      );
    }
    const where = clauses.length > 0 ? and(...clauses) : undefined;
    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: traces.id,
          name: traces.name,
          agent: traces.agent,
          startedAt: traces.startedAt,
          durationMs: traces.durationMs,
          spanCount: traces.spanCount,
          status: traces.status,
          tokensIn: traces.tokensIn,
          tokensOut: traces.tokensOut,
          inputPreview: traces.inputPreview,
          runLabel: traces.runLabel,
        })
        .from(traces)
        .where(where)
        .orderBy(desc(traces.receivedAt), desc(traces.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(traces).where(where),
    ]);
    return { items, total: totalRows[0]?.count ?? 0 };
  });

  app.get('/api/stats', async () => {
    // Rollups over the denormalized trace columns — cheap, no `raw` walk. The
    // cost figure is a rough provider-blended estimate (see pricing.ts); the
    // "if metered" figure prices each (agent, model) token bucket through the
    // price book via the persisted per-trace primary model.
    const [totalsRow, byAgentRows, byProviderRows, agentRows, byAgentModelRows] = await Promise.all([
      db
        .select({
          traces: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
          errors: sql<number>`count(*) filter (where ${traces.status} = 'error')::int`,
          avgDurationMs: sql<number>`coalesce(avg(${traces.durationMs}), 0)::int`,
          p95DurationMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${traces.durationMs}) filter (where ${traces.durationMs} is not null), 0)::int`,
        })
        .from(traces),
      db
        .select({
          agent: traces.agent,
          provider: sql<string | null>`max(${traces.provider})`,
          traces: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
          avgDurationMs: sql<number>`coalesce(avg(${traces.durationMs}), 0)::int`,
        })
        .from(traces)
        .groupBy(traces.agent)
        .orderBy(desc(sql`count(*)`)),
      db
        .select({
          provider: traces.provider,
          tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
        })
        .from(traces)
        .groupBy(traces.provider),
      // Distinct non-null agents for the filter dropdown.
      db
        .selectDistinct({ agent: traces.agent })
        .from(traces)
        .where(sql`${traces.agent} is not null`)
        .orderBy(traces.agent),
      // (agent, model) token buckets — priced in JS through the price book.
      db
        .select({
          agent: traces.agent,
          model: traces.model,
          tokensIn: sql<number>`coalesce(sum(${traces.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${traces.tokensOut}), 0)::int`,
        })
        .from(traces)
        .groupBy(traces.agent, traces.model),
    ]);
    const totals = totalsRow[0] ?? {
      traces: 0,
      tokensIn: 0,
      tokensOut: 0,
      errors: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
    };
    // Blend the per-provider token buckets into one rough cost estimate.
    const estCostUsd = byProviderRows.reduce(
      (sum, r) => sum + estimateCostUsd(r.provider, r.tokensIn, r.tokensOut),
      0,
    );
    // Price-book cost per agent: each (agent, model) bucket priced by model id.
    const ifMeteredByAgent = new Map<string | null, number>();
    for (const r of byAgentModelRows) {
      const cost = estimateCostIfMetered(r.model, r.tokensIn, r.tokensOut);
      ifMeteredByAgent.set(r.agent, (ifMeteredByAgent.get(r.agent) ?? 0) + cost);
    }
    const estCostIfMeteredUsd = [...ifMeteredByAgent.values()].reduce((sum, v) => sum + v, 0);
    return {
      totals: { ...totals, estCostUsd, estCostIfMeteredUsd },
      byAgent: byAgentRows.map((r) => ({
        ...r,
        estCostUsd: estimateCostUsd(r.provider, r.tokensIn, r.tokensOut),
        estCostIfMeteredUsd: ifMeteredByAgent.get(r.agent) ?? 0,
      })),
      agents: agentRows.map((r) => r.agent).filter((a): a is string => a !== null),
    };
  });

  app.get('/api/timeline', async () => {
    // Newest-first, capped; bucketed by the trace's own start (falling back to
    // receipt time) so the series reflects when the work actually happened.
    const rows = await db
      .select({
        ts: sql<string>`coalesce(${traces.startedAt}, ${traces.receivedAt})`,
        status: traces.status,
      })
      .from(traces)
      .orderBy(desc(traces.receivedAt), desc(traces.id))
      .limit(TIMELINE_ROW_CAP);
    return buildTimeline(rows);
  });

  app.get('/api/traces/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id.toLowerCase();
    const rows = await db.select({ raw: traces.raw }).from(traces).where(eq(traces.id, id)).limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'trace not found' });
    // The view is computed on read from the stored raw envelope, never persisted.
    return { id, view: buildTraceView(row.raw, id) };
  });

  app.get('/api/tail', (req, reply) => {
    // Take over the raw socket for the SSE stream; the hub owns it from here.
    reply.hijack();
    tail.register(reply.raw);
    void req;
  });

  // ── background run queue ─────────────────────────────────────────────────
  // One run executes at a time (PGlite is single-process; the analysis passes
  // parallelize internally via judgeInWaves). Everything else — user POSTs and
  // server-initiated work (classify sweeps, autorun eval runs) alike — waits in
  // an in-memory FIFO with per-key dedup. Deliberately not durable: a crash
  // loses only pending entries, boot reconcile fails the orphaned rows, and
  // classification re-derives its backlog from `classified_at`.

  /** One run waiting in the FIFO. */
  type QueueEntry = {
    runId: string;
    /** Dedup key — at most one pending-or-active run per key (e.g. 'classify', 'eval:<id>'). */
    key: string;
    /** Starts the runner once the run reaches the front of the queue. */
    start: (runId: string, signal: AbortSignal) => Promise<unknown>;
  };

  const pendingRuns: QueueEntry[] = [];
  let activeRun: { runId: string; key: string; abort: AbortController } | null = null;

  /** The runId already pending/active under `key`, if any (the dedup lookup). */
  const findRunByKey = (key: string): string | undefined =>
    activeRun?.key === key ? activeRun.runId : pendingRuns.find((p) => p.key === key)?.runId;

  /**
   * Own the executing run's lifetime: when it settles, release the active slot
   * and pump the queue. If RUN_TIMEOUT_MS is set and the run stalls past it (a
   * hung LLM call), mark it errored, abort its provider call, and release the
   * slot immediately — the zombie's late finalisers no-op (`running`-guarded)
   * and its late settle only triggers a harmless extra pump.
   */
  const superviseRun = (runId: string, work: Promise<unknown>, controller: AbortController): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = runTimeoutMs();
    const settled = work.then(() => 'settled' as const).catch(() => 'settled' as const);
    const race =
      timeoutMs > 0
        ? Promise.race([
            settled,
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), timeoutMs);
            }),
          ])
        : settled;
    void race
      .then(async (outcome) => {
        if (outcome === 'timeout') {
          // Mark errored first (so the runner's own error-path finaliser no-ops),
          // then abort the stuck provider call to stop further spend.
          await failRun(db, runId, `run timed out after ${Math.round(timeoutMs / 1000)}s`).catch(() => {});
          controller.abort();
        }
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (activeRun?.runId === runId) activeRun = null;
        pump();
      });
  };

  /** Advance the queue: claim the next queued run and start it (no-op while one is active). */
  const pump = (): void => {
    if (activeRun !== null) return;
    const next = pendingRuns.shift();
    if (!next) return;
    const abort = new AbortController();
    // Reserve the slot synchronously — the event loop can't interleave another
    // pump between this assignment and the async claim below.
    activeRun = { runId: next.runId, key: next.key, abort };
    void (async () => {
      // A run canceled while queued is already finalized — skip it.
      const claimed = await claimQueuedRun(db, next.runId).catch(() => false);
      if (!claimed) {
        if (activeRun?.runId === next.runId) activeRun = null;
        pump();
        return;
      }
      superviseRun(next.runId, next.start(next.runId, abort.signal), abort);
    })();
  };

  /**
   * In-flight enqueue promises per key: reserved synchronously so two
   * concurrent POSTs for the same key can't both create a run row while the
   * first `createRun` is still awaiting.
   */
  const inflightEnqueues = new Map<string, Promise<{ runId: string; status: 'queued' | 'running' }>>();

  /** Enqueue a background run (deduped by key) and return its id + queue state. */
  const enqueueRun = (
    kind: RunKind,
    key: string,
    start: (runId: string, signal: AbortSignal) => Promise<unknown>,
  ): Promise<{ runId: string; status: 'queued' | 'running' }> => {
    const existing = findRunByKey(key);
    if (existing !== undefined) {
      return Promise.resolve({
        runId: existing,
        status: activeRun?.runId === existing ? ('running' as const) : ('queued' as const),
      });
    }
    const inflight = inflightEnqueues.get(key);
    if (inflight) return inflight;
    const created = (async () => {
      const runId = await createRun(db, kind, 'queued');
      pendingRuns.push({ runId, key, start });
      pump();
      return {
        runId,
        status: activeRun?.runId === runId ? ('running' as const) : ('queued' as const),
      };
    })().finally(() => inflightEnqueues.delete(key));
    inflightEnqueues.set(key, created);
    return created;
  };

  // ── background classification + autorun triggers ──────────────────────────

  /** After a sweep: enqueue a run for every flow-scoped eval past its new-member threshold. */
  const enqueueAutorunEvals = async (): Promise<void> => {
    const due = await autorunDueEvals(db);
    for (const d of due) {
      await enqueueRun('eval', `eval:${d.id}`, (runId, signal) => runEval(db, { evalId: d.id, runId, signal }));
    }
  };

  /** Enqueue the classify sweep now (deduped), chaining the autorun check after it. */
  const enqueueClassifySweep = (): Promise<unknown> =>
    enqueueRun('classify', 'classify', async (runId, signal) => {
      await runClassifySweep(db, { runId, signal });
      // Autorun scheduling failures must not fail the (already finished) sweep,
      // but silence would make a stalled autorun undiagnosable — log them.
      await enqueueAutorunEvals().catch((err) => {
        console.error('[glassray] autorun eval scheduling failed:', err instanceof Error ? err.message : err);
      });
    });

  let classifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced sweep scheduling — one sweep after an ingest burst settles. */
  const scheduleClassifySweep = (): void => {
    if (classifyTimer) clearTimeout(classifyTimer);
    classifyTimer = setTimeout(() => {
      classifyTimer = null;
      void enqueueClassifySweep().catch(() => {});
    }, CLASSIFY_DEBOUNCE_MS);
    classifyTimer.unref?.();
  };

  app.post('/api/discovery/run', async (req, reply) => {
    const parsed = discoveryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body: expected { sampleSize?: number, flowId?: string }' });
    }
    const { sampleSize, flowId } = parsed.data;
    if (flowId) {
      const rows = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, flowId)).limit(1);
      if (!rows[0]) return reply.code(404).send({ error: 'flow not found' });
    }
    const res = await enqueueRun(
      'discovery',
      flowId ? `discovery:${flowId}` : 'discovery',
      (runId, signal) => runDiscovery(db, { runId, sampleSize, flowId, signal }),
    );
    return reply.code(202).send(res);
  });

  app.post('/api/flows/run', async (_req, reply) => {
    const res = await enqueueRun('flows', 'flows', (runId, signal) => runFlows(db, { runId, signal }));
    return reply.code(202).send(res);
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await db
      .select({
        id: runs.id,
        kind: runs.kind,
        status: runs.status,
        error: runs.error,
        stats: runs.stats,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'run not found' });
    return row;
  });

  app.get('/api/runs', async (req, reply) => {
    const query = runListQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid limit query parameter' });
    const items = await db
      .select({
        id: runs.id,
        kind: runs.kind,
        status: runs.status,
        error: runs.error,
        stats: runs.stats,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(query.data.limit);
    return { items };
  });

  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // The executing run: finalize it (running-guarded — its late finalisers
    // no-op and it won't persist, per its isRunLive checks), abort the in-flight
    // provider call, and free the slot now so the queue advances immediately.
    if (activeRun?.runId === id) {
      // Capture the controller BEFORE the await: the run can settle on its own
      // during failRun's I/O, in which case superviseRun releases the slot and
      // pumps the next run into `activeRun` — which must not be touched here.
      const { abort } = activeRun;
      await failRun(db, id, 'canceled').catch(() => {});
      abort.abort(); // no-op if the run already settled
      if (activeRun?.runId === id) {
        activeRun = null;
        pump();
      }
      return reply.code(200).send({});
    }
    // A run still waiting in the FIFO: drop the entry and finalize its row.
    const queuedIndex = pendingRuns.findIndex((p) => p.runId === id);
    if (queuedIndex >= 0) {
      pendingRuns.splice(queuedIndex, 1);
      await failRun(db, id, 'canceled').catch(() => {});
      return reply.code(200).send({});
    }
    return reply.code(409).send({ error: 'that run is not currently in progress or queued' });
  });

  app.get('/api/deviations', async () => {
    // Scope to the most recent discovery run (like /api/flows): each run inserts
    // a fresh result set, so showing only the newest run keeps the list from
    // accreting duplicate rows every time the user re-runs discovery.
    const latest = await db
      .select({ runId: deviations.runId })
      .from(deviations)
      .orderBy(desc(deviations.createdAt), desc(deviations.id))
      .limit(1);
    const runId = latest[0]?.runId ?? null;
    const items = runId
      ? await db
          .select({
            id: deviations.id,
            label: deviations.label,
            description: deviations.description,
            rule: deviations.rule,
            severity: deviations.severity,
            exampleCount: deviations.exampleCount,
            status: deviations.status,
            hasFix: sql<boolean>`(${deviations.fixMarkdown} is not null)`,
            createdAt: deviations.createdAt,
          })
          .from(deviations)
          .where(eq(deviations.runId, runId))
          .orderBy(desc(deviations.exampleCount), desc(deviations.id))
      : [];
    return { items, total: items.length, runId };
  });

  app.get('/api/deviations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await db.select().from(deviations).where(eq(deviations.id, id)).limit(1);
    const deviation = rows[0];
    if (!deviation) return reply.code(404).send({ error: 'deviation not found' });
    const examples = await db
      .select({
        traceId: deviationExamples.traceId,
        label: deviationExamples.label,
        description: deviationExamples.description,
        severity: deviationExamples.severity,
        evidence: deviationExamples.evidence,
      })
      .from(deviationExamples)
      .where(eq(deviationExamples.deviationId, id));
    return { deviation, examples };
  });

  app.post('/api/deviations/:id/fix', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const exists = await db.select({ id: deviations.id }).from(deviations).where(eq(deviations.id, id)).limit(1);
    if (!exists[0]) return reply.code(404).send({ error: 'deviation not found' });
    const res = await enqueueRun('improver', `fix:${id}`, (runId, signal) =>
      runImprover(db, { deviationId: id, runId, signal }),
    );
    return reply.code(202).send(res);
  });

  app.post('/api/deviations/:id/resolve', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const updated = await db
      .update(deviations)
      .set({ status: 'resolved' })
      .where(eq(deviations.id, id))
      .returning({ id: deviations.id });
    if (!updated[0]) return reply.code(404).send({ error: 'deviation not found' });
    return reply.code(200).send({ status: 'resolved' });
  });

  app.post('/api/deviations/:id/reopen', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const updated = await db
      .update(deviations)
      .set({ status: 'open' })
      .where(eq(deviations.id, id))
      .returning({ id: deviations.id });
    if (!updated[0]) return reply.code(404).send({ error: 'deviation not found' });
    return reply.code(200).send({ status: 'open' });
  });

  // ── durable flows: CRUD + audit ────────────────────────────────────────────

  app.get('/api/flows', async (req, reply) => {
    const query = flowListQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid status query parameter' });
    const [items, unclassified] = await Promise.all([listFlows(db, query.data.status), countUnclassified(db)]);
    return { items, unclassified };
  });

  app.post('/api/flows', async (req, reply) => {
    const parsed = flowCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { name, description?, selector?, rule?, classify? }' });
    }
    const { name, description, selector, rule, classify, createdBy } = parsed.data;
    if (!selector && !rule) {
      return reply.code(400).send({ error: 'a flow needs a selector, a rule, or both' });
    }
    if (classify === 'llm' && !rule) {
      return reply.code(400).send({ error: 'an llm-classified flow needs a rule' });
    }
    if (classify === 'selector' && !selector) {
      return reply.code(400).send({ error: 'a selector-classified flow needs a selector' });
    }
    const created = await createFlow(db, {
      name,
      description,
      selector: selector ?? null,
      rule: rule ?? null,
      classify,
      createdBy,
    });
    // A rule-defined flow reconsiders the newest traces (bounded backfill).
    let llmBackfill = 0;
    if (created.classify === 'llm') {
      llmBackfill = await resetClassificationForBackfill(db);
      scheduleClassifySweep();
    }
    return reply.code(201).send({ id: created.id, memberCount: created.memberCount, llmBackfill });
  });

  app.get('/api/flows/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = await getFlowDetail(db, id);
    if (!detail) return reply.code(404).send({ error: 'flow not found' });
    return detail;
  });

  app.patch('/api/flows/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = flowPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { name?, description?, selector?, rule?, classify?, status? }' });
    }
    const result = await updateFlow(db, id, parsed.data);
    if (!result.ok) {
      if (result.reason === 'not-found') return reply.code(404).send({ error: 'flow not found' });
      return reply.code(400).send({
        error:
          result.reason === 'llm-needs-rule'
            ? 'an llm-classified flow needs a rule'
            : 'a selector-classified flow needs a selector',
      });
    }
    if (result.llmDefinitionChanged) {
      await resetClassificationForBackfill(db);
      scheduleClassifySweep();
    }
    // The flow can vanish between the update and this read (e.g. a concurrent
    // DELETE) — never 200 a null body.
    const detail = await getFlowDetail(db, id);
    if (!detail) return reply.code(404).send({ error: 'flow not found' });
    return detail;
  });

  app.delete('/api/flows/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const deleted = await deleteFlow(db, id);
    if (!deleted) return reply.code(404).send({ error: 'flow not found' });
    return reply.code(200).send({});
  });

  app.get('/api/flows/:id/audit', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const audit = await auditFlow(db, id);
    if (!audit) return reply.code(404).send({ error: 'flow not found' });
    return audit;
  });

  // ── M6: deviations → repeatable evals ──────────────────────────────────────

  /** 404-guard for an optional flow binding on eval create/patch. */
  const flowExists = async (flowId: string): Promise<boolean> => {
    const rows = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, flowId)).limit(1);
    return rows.length > 0;
  };

  app.post('/api/evals', async (req, reply) => {
    const parsed = createEvalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { deviationId, flowId? } or { label, rule, description?, flowId?, sourceFile?, autorunThreshold?, threshold?, judgeModel? }' });
    }
    if (parsed.data.flowId && !(await flowExists(parsed.data.flowId))) {
      return reply.code(404).send({ error: 'flow not found' });
    }
    if ('deviationId' in parsed.data) {
      const id = await createEvalFromDeviation(db, parsed.data.deviationId, { flowId: parsed.data.flowId });
      if (id === null) return reply.code(404).send({ error: 'deviation not found' });
      return reply.code(201).send({ id });
    }
    const id = await createManualEval(db, parsed.data);
    return reply.code(201).send({ id });
  });

  app.patch('/api/evals/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = evalPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { flowId?, sourceFile?, autorunThreshold?, threshold?, judgeModel? }' });
    }
    if (parsed.data.flowId && !(await flowExists(parsed.data.flowId))) {
      return reply.code(404).send({ error: 'flow not found' });
    }
    const updated = await updateEval(db, id, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'eval not found' });
    // The eval can vanish between the update and this read — never 200 a null body.
    const detail = await getEvalDetail(db, id);
    if (!detail) return reply.code(404).send({ error: 'eval not found' });
    return detail;
  });

  app.get('/api/evals', async () => {
    const items = await listEvalSummaries(db);
    return { items, total: items.length };
  });

  app.get('/api/evals/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = await getEvalDetail(db, id);
    if (!detail) return reply.code(404).send({ error: 'eval not found' });
    return detail;
  });

  app.delete('/api/evals/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const deleted = await deleteEval(db, id);
    if (!deleted) return reply.code(404).send({ error: 'eval not found' });
    return reply.code(200).send({});
  });

  app.post('/api/evals/:id/run', async (req, reply) => {
    const evalId = (req.params as { id: string }).id;
    const parsed = evalRunBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { sampleSize?: number, model?: string, traceIds?: string[] }' });
    }
    const rows = await db.select({ id: evals.id }).from(evals).where(eq(evals.id, evalId)).limit(1);
    if (!rows[0]) return reply.code(404).send({ error: 'eval not found' });
    const { sampleSize, model, traceIds } = parsed.data;
    const res = await enqueueRun('eval', `eval:${evalId}`, (runId, signal) =>
      runEval(db, { evalId, runId, sampleSize, model, traceIds, signal }),
    );
    return reply.code(202).send(res);
  });

  // ── the portable rule artifact: export / import / fixtures / compare ───────
  // (docs/portable-rule-artifact.md — serialize the flows + rules to
  // glassray.yaml, reconcile a file back in, freeze golden traces, and the A/B
  // compare that is the local product's reason to exist.)

  app.get('/api/export', async () => {
    const artifact = await exportArtifact(db);
    return { artifact, yaml: artifactToYaml(artifact) };
  });

  /**
   * POST /api/export — export with LOCAL-ONLY preservation. `baseYaml` is the
   * repo's existing glassray.yaml: its per-flow `run` recipes, `project`, and
   * `fixtures` refs are overlaid onto the fresh portable sections. `artifact`
   * (optional) substitutes an external portable source — the cloud-pull path —
   * instead of exporting this server's own state.
   */
  app.post('/api/export', async (req, reply) => {
    const parsed = exportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body: expected { baseYaml?: string, artifact?: object }' });
    }
    try {
      let fresh;
      if (parsed.data.artifact !== undefined) {
        const validated = artifactSchema.safeParse(parsed.data.artifact);
        if (!validated.success) throw new Error(`invalid artifact: ${z.prettifyError(validated.error)}`);
        fresh = validated.data;
      } else {
        fresh = await exportArtifact(db);
      }
      const merged =
        parsed.data.baseYaml !== undefined ? mergeLocalOnly(fresh, parseArtifactYaml(parsed.data.baseYaml)) : fresh;
      return { artifact: merged, yaml: artifactToYaml(merged) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'export failed' });
    }
  });

  /** Parse + validate a glassray.yaml document for the zero-dependency CLI (`glassray run` reads recipes through this). */
  app.post('/api/artifact/parse', async (req, reply) => {
    const parsed = parseBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body: expected { yaml: string }' });
    }
    try {
      return { artifact: parseArtifactYaml(parsed.data.yaml) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid glassray.yaml' });
    }
  });

  app.post('/api/import', async (req, reply) => {
    const parsed = importBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { yaml? | artifact?, apply?: boolean, prune?: boolean }' });
    }
    const { yaml, artifact: rawArtifact, apply, prune } = parsed.data;
    if ((yaml === undefined) === (rawArtifact === undefined)) {
      return reply.code(400).send({ error: 'pass exactly one of yaml (document text) or artifact (parsed object)' });
    }
    let artifact;
    try {
      if (yaml !== undefined) {
        artifact = parseArtifactYaml(yaml);
      } else {
        const validated = artifactSchema.safeParse(rawArtifact);
        if (!validated.success) throw new Error(`invalid artifact: ${z.prettifyError(validated.error)}`);
        artifact = validated.data;
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid artifact' });
    }
    if (!apply) {
      const plan = await planImport(db, artifact);
      return { ...plan, applied: false };
    }
    try {
      const result = await applyImport(db, artifact, { prune });
      // A changed/new LLM membership rule reconsiders the newest traces
      // (bounded backfill), exactly like the flow CRUD routes.
      if (result.llmDefinitionChanged) {
        await resetClassificationForBackfill(db);
        scheduleClassifySweep();
      }
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'import failed' });
    }
  });

  app.get('/api/flows/:id/fixtures', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const query = fixturesQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid limit query parameter' });
    const flowRows = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
    const flow = flowRows[0];
    if (!flow) return reply.code(404).send({ error: 'flow not found' });
    // The stored raw envelope IS the fixture: re-POSTing it to /v1/traces
    // reproduces the trace byte-for-byte (same trace id ⇒ idempotent upsert).
    const items = await db
      .select({ traceId: flowTraces.traceId, raw: traces.raw })
      .from(flowTraces)
      .innerJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(eq(flowTraces.flowId, id))
      .orderBy(desc(flowTraces.assignedAt), desc(flowTraces.traceId))
      .limit(query.data.limit);
    return { flow: { id: flow.id, name: flow.name, slug: flow.slug ?? slugify(flow.name) }, items };
  });

  app.post('/api/compare', async (req, reply) => {
    const parsed = compareBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error:
          'invalid body: expected { baseline, candidate, flowId?, sampleSize? } where each corpus is { traceIds } | { agent } | { flowId }',
      });
    }
    const { flowId, baseline, candidate, sampleSize } = parsed.data;
    if (flowId && !(await flowExists(flowId))) {
      return reply.code(404).send({ error: 'flow not found' });
    }
    const res = await enqueueRun('compare', 'compare', (runId, signal) =>
      runCompare(db, { runId, flowId, baseline, candidate, sampleSize, signal }),
    );
    return reply.code(202).send(res);
  });

  // ── experiments: the durable compare container + report ────────────────────

  app.post('/api/experiments', async (req, reply) => {
    const parsed = createExperimentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body: expected { question: string, flowId?: string }' });
    }
    if (parsed.data.flowId && !(await flowExists(parsed.data.flowId))) {
      return reply.code(404).send({ error: 'flow not found' });
    }
    const id = await createExperiment(db, parsed.data);
    return reply.code(201).send({ id });
  });

  app.get('/api/experiments', async (req, reply) => {
    const query = experimentListQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid flowId query parameter' });
    const items = await listExperiments(db, query.data.flowId);
    return { items, total: items.length };
  });

  app.get('/api/experiments/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const experiment = await getExperiment(db, id);
    if (!experiment) return reply.code(404).send({ error: 'experiment not found' });
    return experiment;
  });

  app.post('/api/experiments/:id/report', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = experimentReportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body: expected { baseline?: string, candidate?: string }' });
    }
    const experiment = await getExperiment(db, id);
    if (!experiment) return reply.code(404).send({ error: 'experiment not found' });
    // Default the corpora to the two newest run labels (candidate newest).
    let { baseline, candidate } = parsed.data;
    if (baseline === undefined || candidate === undefined) {
      const [newest, prior] = await newestTwoLabels(db);
      candidate ??= newest;
      baseline ??= prior;
    }
    if (!baseline || !candidate) {
      return reply.code(400).send({
        error: 'need a baseline and a candidate label — run the flow twice (glassray run <flow> --label <x>) or pass both',
      });
    }
    const res = await enqueueRun('compare', `experiment:${id}`, (runId, signal) =>
      concludeExperiment(db, { experimentId: id, runId, baseline: baseline!, candidate: candidate!, signal }),
    );
    return reply.code(202).send({ ...res, experimentId: id, baseline, candidate });
  });

  app.get('/api/llm', async () => resolveLlm());

  /** The settings view model: effective provider/models/budget + which providers are usable right now. */
  const settingsPayload = () => {
    const cfg = resolveLlmConfig();
    const budget = resolveBudgetUsd();
    return {
      provider: cfg.provider,
      ready: cfg.ready,
      reason: cfg.reason,
      heavyModelId: cfg.heavyModelId,
      lightModelId: cfg.lightModelId,
      budgetUsd: Number.isFinite(budget) ? budget : 0, // 0 = unlimited
      availability: providerAvailability(),
    };
  };

  app.get('/api/settings', async () => settingsPayload());

  app.patch('/api/settings', async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid settings: expected { llmProvider?, heavyModelId?, lightModelId?, budgetUsd? }',
      });
    }
    await saveSettings(runtime.home, parsed.data);
    return settingsPayload();
  });

  // ── M7: replay an LLM span (viewer → debugger) ─────────────────────────────
  app.post('/api/replay', async (req, reply) => {
    const parsed = replayBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { prompt, system?, model?, temperature? }' });
    }
    try {
      const result = await generateTextTracked(db, 'replay', {
        system: parsed.data.system,
        prompt: parsed.data.prompt,
        model: parsed.data.model,
        temperature: parsed.data.temperature ?? 0,
      });
      return { output: result.text, provider: result.provider, model: result.model };
    } catch (err) {
      // The spend cap is a distinct, expected outcome (402); anything else is a
      // misconfigured/unreachable provider (502).
      if (err instanceof BudgetExceededError) {
        return reply.code(402).send({ error: err.message });
      }
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'replay failed' });
    }
  });

  app.get('/api/usage', async () => getUsageSummary(db));

  app.post('/api/usage/reset', async () => {
    await resetUsage(db);
    return {};
  });

  if (existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
    await app.register(fastifyStatic, { root: WEB_DIST_DIR });
    // SPA fallback: any unmatched GET that isn't an API/ingest path serves the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !isReservedPath(req.url)) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/plain').send('UI not built — run npm run build:ui'),
    );
  }

  // Sweep anything that landed while the server was down (or was never swept) —
  // classification self-heals its backlog from the `classified_at` watermark.
  if ((await countUnclassified(db)) > 0) void enqueueClassifySweep().catch(() => {});

  return app;
};
