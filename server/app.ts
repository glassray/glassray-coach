import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import fastifyStatic from '@fastify/static';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoachRuntime } from './bootstrap.js';
import { createRun, failRun, runDiscovery } from './discovery.js';
import {
  createEvalFromDeviation,
  createManualEval,
  deleteEval,
  getEvalDetail,
  listEvalSummaries,
  runEval,
} from './evals.js';
import { runFlows } from './flows.js';
import { runImprover } from './improver.js';
import { collectTraceIds, otlpEnvelopeSchema, TraceNormalizeError, upsertTrace } from './ingest.js';
import { providerAvailability, resolveLlm, resolveLlmConfig } from './llm.js';
import { saveSettings, settingsSchema } from './settings.js';
import { estimateCostUsd } from './pricing.js';
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
});

/** Body contract for POST /api/discovery/run — an optional sample-size override. */
const discoveryBodySchema = z.object({
  sampleSize: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Body contract for POST /api/evals — either "save from a deviation"
 * (`{ deviationId }`) or a hand-written eval (`{ label, rule, description? }`).
 */
const createEvalBodySchema = z.union([
  z.object({ deviationId: z.string().trim().min(1) }),
  z.object({
    label: z.string().trim().min(1).max(200),
    rule: z.string().trim().min(1).max(2000),
    description: z.string().trim().max(2000).optional(),
  }),
]);

/** Body contract for POST /api/evals/:id/run — an optional sample-size override. */
const evalRunBodySchema = z.object({
  sampleSize: z.coerce.number().int().min(1).max(200).optional(),
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
 * Backstop timeout for a background run (discovery / flows / eval). A stalled LLM
 * call would otherwise leave the run `running` forever — holding the single-run
 * lock and spinning the UI. Overridable via GLASSRAY_RUN_TIMEOUT_MS; `0` disables.
 */
const RUN_TIMEOUT_MS = (() => {
  const raw = Number(process.env.GLASSRAY_RUN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300_000;
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
    const envelope = req.body;
    const traceIds = collectTraceIds(envelope);
    // Ingest each trace independently: one malformed span shouldn't 500 the
    // request (leaking zod internals) or reject a batch's other, valid traces.
    // A bad trace is skipped + logged; the request succeeds if any trace landed.
    let ingested = 0;
    for (const traceId of traceIds) {
      try {
        await upsertTrace(db, traceId, envelope, buildTraceView);
        tail.broadcast(traceId);
        ingested += 1;
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
    if (traceIds.length > 0 && ingested === 0) {
      return reply.code(400).send({ error: 'no traces could be ingested (malformed OTLP spans)' });
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
    const { limit, offset, q, agent, status } = query.data;
    // Compose the active filters into one WHERE (undefined clauses drop out).
    const clauses: SQL[] = [];
    if (q) {
      const like = `%${q}%`;
      clauses.push(or(ilike(traces.name, like), ilike(traces.agent, like))!);
    }
    if (agent) clauses.push(eq(traces.agent, agent));
    if (status) clauses.push(eq(traces.status, status));
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
    // cost figure is a rough provider-blended estimate (see pricing.ts).
    const [totalsRow, byAgentRows, byProviderRows, agentRows] = await Promise.all([
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
    return {
      totals: { ...totals, estCostUsd },
      byAgent: byAgentRows.map((r) => ({
        ...r,
        estCostUsd: estimateCostUsd(r.provider, r.tokensIn, r.tokensOut),
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

  // ── M3: local discovery + flows ────────────────────────────────────────────
  // In-memory single-run lock shared across discovery + flows: at most one
  // background run at a time (a wedge — no durable queue). Reserved SYNCHRONOUSLY
  // (before the createRun await) so two concurrent POSTs can't both pass the guard.
  let activeRunId: string | null = null;
  // Cancel handle for the in-flight run's LLM calls, paired with `activeRunId`.
  // Aborting it stops the current provider request (and its spend) immediately,
  // rather than only after the runner reaches its next `isRunLive` loop check.
  let activeAbort: AbortController | null = null;

  /**
   * Own a background run's lifetime: release the single-run lock when it settles,
   * and — if RUN_TIMEOUT_MS is set — mark it errored should it stall past the
   * limit (a hung LLM call), so the lock frees and the UI stops spinning. On
   * timeout it also aborts the run's controller, so the stuck provider call is
   * cut off rather than left running. A late finish by the abandoned runner
   * no-ops (its finalisers are `running`-guarded).
   */
  const superviseRun = (runId: string, work: Promise<unknown>, controller: AbortController): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = work.then(() => 'settled' as const).catch(() => 'settled' as const);
    const race =
      RUN_TIMEOUT_MS > 0
        ? Promise.race([
            settled,
            new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), RUN_TIMEOUT_MS);
            }),
          ])
        : settled;
    void race
      .then(async (outcome) => {
        if (outcome === 'timeout') {
          // Mark errored first (so the runner's own error-path finaliser no-ops),
          // then abort the stuck provider call to stop further spend.
          await failRun(db, runId, `run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`).catch(() => {});
          controller.abort();
        }
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (activeRunId === runId) {
          activeRunId = null;
          activeAbort = null;
        }
      });
  };

  app.post('/api/discovery/run', async (req, reply) => {
    const parsed = discoveryBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body: expected { sampleSize?: number }' });
    }
    if (activeRunId !== null) {
      // Only surface a real run id — during the reservation window `activeRunId`
      // is the empty-string sentinel, which is not a pollable run.
      return reply
        .code(409)
        .send({ error: 'a run is already in progress', ...(activeRunId ? { runId: activeRunId } : {}) });
    }
    activeRunId = ''; // reserve the lock before the first await (race-free)
    try {
      const runId = await createRun(db, 'discovery');
      activeRunId = runId;
      const controller = new AbortController();
      activeAbort = controller;
      superviseRun(
        runId,
        runDiscovery(db, { runId, sampleSize: parsed.data.sampleSize, signal: controller.signal }),
        controller,
      );
      return reply.code(202).send({ runId });
    } catch {
      activeRunId = null;
      activeAbort = null;
      return reply.code(500).send({ error: 'failed to start discovery run' });
    }
  });

  app.post('/api/flows/run', async (_req, reply) => {
    if (activeRunId !== null) {
      // Only surface a real run id — the reservation-window sentinel is not pollable.
      return reply
        .code(409)
        .send({ error: 'a run is already in progress', ...(activeRunId ? { runId: activeRunId } : {}) });
    }
    activeRunId = ''; // reserve the lock before the first await (race-free)
    try {
      const runId = await createRun(db, 'flows');
      activeRunId = runId;
      const controller = new AbortController();
      activeAbort = controller;
      superviseRun(runId, runFlows(db, { runId, signal: controller.signal }), controller);
      return reply.code(202).send({ runId });
    } catch {
      activeRunId = null;
      activeAbort = null;
      return reply.code(500).send({ error: 'failed to start flows run' });
    }
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

  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // Only the single in-flight run can be canceled ('' is the reservation window).
    if (activeRunId === null || activeRunId === '' || activeRunId !== id) {
      return reply.code(409).send({ error: 'that run is not currently in progress' });
    }
    // Mark it errored (running-guarded) and free the lock now; the abandoned
    // runner's late finalisers no-op, and it won't persist (its isRunLive check).
    // Then abort the in-flight provider call so the run stops spending at once,
    // instead of only when the runner reaches its next `isRunLive` loop check.
    await failRun(db, id, 'canceled').catch(() => {});
    activeAbort?.abort();
    activeRunId = null;
    activeAbort = null;
    return reply.code(200).send({});
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
    // Share the single-run lock with discovery/flows/eval — one background run at a time.
    if (activeRunId !== null) {
      return reply
        .code(409)
        .send({ error: 'a run is already in progress', ...(activeRunId ? { runId: activeRunId } : {}) });
    }
    activeRunId = ''; // reserve the lock before the first await (race-free)
    try {
      const runId = await createRun(db, 'improver');
      activeRunId = runId;
      const controller = new AbortController();
      activeAbort = controller;
      superviseRun(runId, runImprover(db, { deviationId: id, runId, signal: controller.signal }), controller);
      return reply.code(202).send({ runId });
    } catch {
      activeRunId = null;
      activeAbort = null;
      return reply.code(500).send({ error: 'failed to start fix generation' });
    }
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

  app.get('/api/flows', async () => {
    // The flows of the most recent flows run (identified by the newest flow row).
    const latest = await db
      .select({ runId: flows.runId })
      .from(flows)
      .orderBy(desc(flows.createdAt))
      .limit(1);
    const runId = latest[0]?.runId ?? null;
    const items = runId
      ? await db
          .select({
            id: flows.id,
            name: flows.name,
            description: flows.description,
            traceCount: flows.traceCount,
          })
          .from(flows)
          .where(eq(flows.runId, runId))
          .orderBy(desc(flows.traceCount), desc(flows.id))
      : [];
    return { items, runId };
  });

  app.get('/api/flows/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
    const flow = rows[0];
    if (!flow) return reply.code(404).send({ error: 'flow not found' });
    const traceRows = await db
      .select({ traceId: flowTraces.traceId, name: traces.name, agent: traces.agent })
      .from(flowTraces)
      .leftJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(eq(flowTraces.flowId, id));
    return { flow, traces: traceRows };
  });

  // ── M6: deviations → repeatable evals ──────────────────────────────────────

  app.post('/api/evals', async (req, reply) => {
    const parsed = createEvalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body: expected { deviationId } or { label, rule, description? }' });
    }
    if ('deviationId' in parsed.data) {
      const id = await createEvalFromDeviation(db, parsed.data.deviationId);
      if (id === null) return reply.code(404).send({ error: 'deviation not found' });
      return reply.code(201).send({ id });
    }
    const id = await createManualEval(db, parsed.data);
    return reply.code(201).send({ id });
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
      return reply.code(400).send({ error: 'invalid body: expected { sampleSize?: number }' });
    }
    // Share the single-run lock with discovery/flows — one background run at a time.
    if (activeRunId !== null) {
      return reply
        .code(409)
        .send({ error: 'a run is already in progress', ...(activeRunId ? { runId: activeRunId } : {}) });
    }
    activeRunId = ''; // reserve the lock BEFORE the awaited eval lookup (race-free)
    try {
      const rows = await db.select({ id: evals.id }).from(evals).where(eq(evals.id, evalId)).limit(1);
      if (!rows[0]) {
        activeRunId = null;
        return reply.code(404).send({ error: 'eval not found' });
      }
      const runId = await createRun(db, 'eval');
      activeRunId = runId;
      const controller = new AbortController();
      activeAbort = controller;
      superviseRun(
        runId,
        runEval(db, { evalId, runId, sampleSize: parsed.data.sampleSize, signal: controller.signal }),
        controller,
      );
      return reply.code(202).send({ runId });
    } catch {
      activeRunId = null;
      activeAbort = null;
      return reply.code(500).send({ error: 'failed to start eval run' });
    }
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

  return app;
};
