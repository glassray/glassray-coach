import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { generateStructuredTracked } from './usage.js';
import { newId } from './ids.js';
import { deviationExamples, deviations, flowTraces, runs, traces } from './schema.js';
import { buildTraceView, type SpanNode, type TraceView } from './vendor/index.js';

/*
 * Local deviation DISCOVERY — a spec-free adaptation of the platform worker's
 * `routes/deviations.ts`. Coach has no Platform Intent Spec, so the flow /
 * rubric / checklist / diverged-step machinery is dropped: we sample recent
 * local traces, ask the model the open-ended "what went wrong?" question per
 * trace (light tier), then cluster the findings into a small set of recurring
 * TYPES (heavy tier) and persist them.
 */

// ── prompts + schemas (lifted spec-free from the worker) ─────────────────────

/** Judge system prompt — verbatim from the worker's `JUDGE_SYSTEM_PROMPT`. */
export const JUDGE_SYSTEM_PROMPT =
  'You are a careful evaluator of agent execution traces. Given a multi-agent system trace, identify every problem, failure, or quality issue you can find — without any predefined taxonomy or checklist. Report what you actually see.';

/** Per-trace judge instructions — the worker's `JUDGE_INSTRUCTIONS` with all spec / checklist / flow paragraphs removed. */
export const JUDGE_INSTRUCTIONS = `Below I will provide a multiagent system trace from an agent system.

Your job: analyze the trace end-to-end and tell me everything that went wrong — every factual error, every grounding failure, every place where the agent's output doesn't match what the sources actually say, every quality issue.

Do NOT use a predefined checklist. Look at the actual trace: the user's question, the retrieved sources, the agent's intermediate reasoning, and the final output. Then tell me what's wrong.

For each deviation you find:
- Give it a short label (2-5 words)
- Describe what went wrong specifically, citing the relevant part of the trace
- Rate severity as critical (would mislead the user), major (noticeable quality gap), or minor (cosmetic / debatable)
- Quote the specific evidence from the trace

Also tell me whether the task was successfully completed overall (did the user get a correct, useful answer?).

Be thorough but precise — only report deviations you can point to specific evidence for. Don't flag things that are merely suboptimal style choices.`;

/** Per-trace structured output — an open-ended deviations list (spec-free). */
const FindingSchema = z.object({
  passed: z.boolean().describe('Whether the task was successfully completed overall'),
  reasoning: z.string().describe('One-paragraph summary of overall trace quality'),
  findings: z
    .array(
      z.object({
        label: z.string().describe('Short label for the deviation (2-5 words)'),
        description: z.string().describe('What went wrong, citing the trace'),
        severity: z.enum(['critical', 'major', 'minor']),
        evidence: z.string().describe('Quote from the trace supporting this deviation'),
      }),
    )
    .describe('Every deviation found in the trace'),
});

/** Grouping system prompt — near-verbatim from the worker. */
export const GROUPING_SYSTEM_PROMPT =
  'You cluster individual agent-trace deviations into a small set of recurring TYPES. Group deviations that describe the same underlying failure mode. Every deviation must belong to exactly one group.';

/** Output of the grouping pass — clusters per-trace deviations into recurring types. */
const GroupingSchema = z.object({
  groups: z
    .array(
      z.object({
        label: z.string().describe('Short name for the recurring deviation type'),
        description: z
          .string()
          .describe('One- or two-sentence description of the type (the observed failure)'),
        rule: z
          .string()
          .describe(
            'The plain-language rule the agent should follow for this type — what it SHOULD or should NOT do, in everyday language, NOT a restatement of the failure. One or two sentences.',
          ),
        memberIndexes: z
          .array(z.number().int().min(0))
          .describe('Indexes (from the numbered list) of the deviations in this group'),
      }),
    )
    .describe('The recurring deviation types the individual deviations roll up into'),
});

/** Severity ordering for reducing a group's member findings to its worst severity. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2 };

/** One deviation discovered in a single trace, flattened with its trace id. */
type DiscoveredDeviation = {
  traceId: string;
  label: string;
  description: string;
  severity: 'critical' | 'major' | 'minor';
  evidence: string;
};

// ── trace rendering (compact block for the judge prompt) ─────────────────────

/** Per-node input/output character cap in the rendered trace block. */
const NODE_IO_CAP = 800;

/** Coerce + cap a span's input/output for the prompt; JSON-stringifies non-strings. */
const boundIo = (value: unknown): string => {
  if (value === undefined || value === null) return '—';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > NODE_IO_CAP ? `${s.slice(0, NODE_IO_CAP)}… [+${s.length - NODE_IO_CAP} chars]` : s;
};

/** Recursively render one span node (name + kind/model/tokens/status + bounded I/O) with indentation. */
const renderSpan = (node: SpanNode, depth: number): string[] => {
  const indent = '  '.repeat(depth);
  const meta = [
    node.kind,
    node.model ? `model=${node.model}` : null,
    node.tokensIn != null || node.tokensOut != null
      ? `tokens=${node.tokensIn ?? 0}/${node.tokensOut ?? 0}`
      : null,
    node.status ? `status=${node.status}` : null,
  ]
    .filter((p): p is string => Boolean(p))
    .join(' ');
  const lines = [
    `${indent}- ${node.name} [${meta}]`,
    `${indent}    input:  ${boundIo(node.input)}`,
    `${indent}    output: ${boundIo(node.output)}`,
  ];
  for (const child of node.children) lines.push(...renderSpan(child, depth + 1));
  return lines;
};

/** Render a whole trace view (header + previews + nested span tree) into a compact text block. Reused by evals. */
export const renderTraceView = (view: TraceView, id: string): string => {
  const header = [
    `Trace ${id}`,
    `name: ${view.name ?? '—'}  agent: ${view.agent ?? '—'}  provider: ${view.provider ?? '—'}`,
    `status: ${view.status ?? '—'}  duration: ${view.durationMs ?? '—'}ms  spans: ${view.spanCount}`,
    '',
    `User input: ${boundIo(view.inputPreview)}`,
    `Agent output: ${boundIo(view.outputPreview)}`,
    '',
    'Spans:',
  ];
  const spans = view.tree ? renderSpan(view.tree, 0) : ['  (no spans)'];
  return [...header, ...spans].join('\n');
};

// ── run lifecycle helpers (shared with flows.ts) ─────────────────────────────

/** The background pass kinds a run can drive. */
export type RunKind = 'discovery' | 'flows' | 'eval' | 'improver' | 'classify' | 'compare';

/** Create a run row (default `running`; the queue creates `queued` rows and claims them later) and return its id. */
export const createRun = async (
  db: CoachDb,
  kind: RunKind,
  status: 'running' | 'queued' = 'running',
): Promise<string> => {
  const id = newId('run_');
  await db.insert(runs).values({ id, kind, status, startedAt: new Date() });
  return id;
};

/**
 * Claim a `queued` run as it reaches the front of the FIFO: flip it to
 * `running` and reset its start time to the actual execution start. Returns
 * false when the run is no longer queued (i.e. it was canceled while waiting).
 */
export const claimQueuedRun = async (db: CoachDb, id: string): Promise<boolean> => {
  const updated = await db
    .update(runs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
    .returning({ id: runs.id });
  return updated.length > 0;
};

/**
 * Mark a run `done`, stamping its finish time + terminal stats blob. Guarded on
 * `status = 'running'` so a run already finalized as errored (a cancel or the
 * timeout backstop) is NOT resurrected to `done` by a late-completing runner.
 */
export const finishRun = async (db: CoachDb, id: string, stats: Record<string, unknown>): Promise<void> => {
  await db
    .update(runs)
    .set({ status: 'done', finishedAt: new Date(), stats })
    .where(and(eq(runs.id, id), eq(runs.status, 'running')));
};

/**
 * Mark a run `error`, stamping its finish time + message. Guarded on the run
 * still being live — `running` (first finaliser wins) or `queued` (a cancel
 * while waiting in the FIFO).
 */
export const failRun = async (db: CoachDb, id: string, error: string): Promise<void> => {
  await db
    .update(runs)
    .set({ status: 'error', finishedAt: new Date(), error })
    .where(and(eq(runs.id, id), inArray(runs.status, ['running', 'queued'])));
};

/** Publish mid-run progress into the (still-running) run's stats blob, so the UI can show "scanned N/M". */
export const updateRunProgress = async (
  db: CoachDb,
  id: string,
  scanned: number,
  total: number,
): Promise<void> => {
  await db
    .update(runs)
    .set({ stats: { scanned, total } })
    .where(and(eq(runs.id, id), eq(runs.status, 'running')));
};

/** True while a run is still `running` — i.e. not canceled or timed-out — gating a runner's late persist. */
export const isRunLive = async (db: CoachDb, id: string): Promise<boolean> => {
  const rows = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).limit(1);
  return rows[0]?.status === 'running';
};

/**
 * Concurrent per-trace judge calls per wave. Sequential judging is unusably
 * slow on the zero-config `claude-subscription` provider (~30s per call — a
 * 20-trace run would blow the run timeout); small waves keep runs fast without
 * hammering provider rate limits.
 */
const JUDGE_WAVE_SIZE = 4;

/**
 * Judge `items` in order-preserving waves of `JUDGE_WAVE_SIZE` concurrent
 * calls: checks the run is still live before each wave (canceled/timed-out
 * runs stop promptly) and publishes scanned-count progress after each.
 * Returns results in input order — truncated if the run stopped mid-way.
 */
export const judgeInWaves = async <T, R>(
  db: CoachDb,
  runId: string,
  items: T[],
  judge: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = [];
  await updateRunProgress(db, runId, 0, items.length);
  for (let i = 0; i < items.length; i += JUDGE_WAVE_SIZE) {
    if (!(await isRunLive(db, runId))) break;
    const wave = await Promise.all(items.slice(i, i + JUDGE_WAVE_SIZE).map(judge));
    out.push(...wave);
    await updateRunProgress(db, runId, out.length, items.length);
  }
  return out;
};

// ── discovery pipeline ───────────────────────────────────────────────────────

/** Default number of traces sampled per discovery run. */
const DEFAULT_SAMPLE_SIZE = 20;

/** A clustered recurring type with a pre-generated id + its member finding positions. */
type Cluster = { id: string; label: string; description: string; rule: string; memberIndexes: number[] };

/**
 * Run a full deviation discovery: sample the newest local traces, judge each
 * open-ended (light tier), cluster the findings into recurring types (heavy
 * tier), and persist `deviations` + `deviation_examples`. Marks the run `done`
 * (or `error`, re-throwing) via the lifecycle helpers.
 */
export const runDiscovery = async (
  db: CoachDb,
  opts: { sampleSize?: number; runId: string; flowId?: string; signal?: AbortSignal },
): Promise<{ deviationCount: number; exampleCount: number }> => {
  const sampleSize = Math.max(1, Math.min(opts.sampleSize ?? DEFAULT_SAMPLE_SIZE, 200));
  try {
    // 1 — sample the newest traces (full raw envelope needed to rebuild the
    //     view), scoped to a flow's members when a flowId is given.
    const rows = await db
      .select({ id: traces.id, raw: traces.raw })
      .from(traces)
      .where(
        opts.flowId
          ? inArray(
              traces.id,
              db.select({ id: flowTraces.traceId }).from(flowTraces).where(eq(flowTraces.flowId, opts.flowId)),
            )
          : undefined,
      )
      .orderBy(desc(traces.receivedAt), desc(traces.id))
      .limit(sampleSize);

    // 2 — per-trace open-ended judge (in concurrent waves; progress publishes
    //     per wave so the UI can show "scanned N/M"); collect all findings
    //     tagged with their trace id, in sample order.
    const judged = await judgeInWaves(db, opts.runId, rows, async (row) => {
      const view = buildTraceView(row.raw, row.id);
      const block = renderTraceView(view, row.id);
      const { object } = await generateStructuredTracked(db, 'discovery', {
        schema: FindingSchema,
        system: JUDGE_SYSTEM_PROMPT,
        prompt: `${JUDGE_INSTRUCTIONS}\n\n${block}`,
        tier: 'light',
        temperature: 0,
        signal: opts.signal,
      });
      return { traceId: row.id, found: object.findings };
    });
    const findings: DiscoveredDeviation[] = judged.flatMap((j) =>
      j.found.map((f) => ({
        traceId: j.traceId,
        label: f.label,
        description: f.description,
        severity: f.severity,
        evidence: f.evidence,
      })),
    );

    // Canceled/timed out while judging → skip the heavy clustering call (and
    // the persist below); the run's already finalized as errored.
    if (!(await isRunLive(db, opts.runId))) {
      return { deviationCount: 0, exampleCount: findings.length };
    }

    // 3 — cluster the findings into recurring types (one heavy call). Every
    //     finding maps to exactly one group; any the model misses fall into a
    //     synthetic catch-all so no example is silently dropped.
    const clusters: Cluster[] = [];
    if (findings.length > 0) {
      const numbered = findings
        .map((d, i) => `${i}. [${d.severity}] ${d.label} — ${d.description}`)
        .join('\n');
      const { object } = await generateStructuredTracked(db, 'discovery', {
        schema: GroupingSchema,
        system: GROUPING_SYSTEM_PROMPT,
        prompt: `Here are the deviations discovered across a set of traces, one per line, prefixed by their index:\n\n${numbered}\n\nCluster them into recurring types. For each type give a short label, a one- or two-sentence description of what goes wrong (the observed failure), the plain-language \`rule\` the agent SHOULD follow (what it should or should NOT do — NOT a restatement of the failure), and the list of member indexes.`,
        tier: 'heavy',
        temperature: 0,
        signal: opts.signal,
      });
      for (const g of object.groups) {
        clusters.push({
          id: newId('dev_'),
          label: g.label,
          description: g.description,
          rule: g.rule,
          memberIndexes: g.memberIndexes.filter((i) => i >= 0 && i < findings.length),
        });
      }
    }

    // Position → group id (first assignment wins), then sweep unassigned findings
    // into one catch-all cluster so every finding is persisted as an example.
    const indexToGroupId = new Map<number, string>();
    for (const c of clusters) {
      for (const i of c.memberIndexes) if (!indexToGroupId.has(i)) indexToGroupId.set(i, c.id);
    }
    const orphans = findings.map((_, i) => i).filter((i) => !indexToGroupId.has(i));
    if (orphans.length > 0) {
      const fallback: Cluster = {
        id: newId('dev_'),
        label: 'Other deviations',
        description: 'Findings that did not cluster into a shared recurring type.',
        rule: 'Review these individually — they may each point to a distinct issue.',
        memberIndexes: orphans,
      };
      clusters.push(fallback);
      for (const i of orphans) indexToGroupId.set(i, fallback.id);
    }

    // If the run was canceled or timed out while we were judging/clustering,
    // stop before persisting — don't write deviations for an abandoned run.
    if (!(await isRunLive(db, opts.runId))) {
      return { deviationCount: 0, exampleCount: findings.length };
    }

    // 4 — persist. Deviation rows first (the example rows reference them), each
    //     with its worst member severity + member count.
    const memberIdxByGroup = new Map<string, number[]>();
    for (const [i, gid] of indexToGroupId) {
      const arr = memberIdxByGroup.get(gid) ?? [];
      arr.push(i);
      memberIdxByGroup.set(gid, arr);
    }
    const persistedClusters = clusters.filter((c) => (memberIdxByGroup.get(c.id)?.length ?? 0) > 0);

    if (persistedClusters.length > 0) {
      await db.insert(deviations).values(
        persistedClusters.map((c) => {
          const members = (memberIdxByGroup.get(c.id) ?? []).map((i) => findings[i]!);
          const worst = members.reduce<'critical' | 'major' | 'minor'>((w, m) => {
            return (SEVERITY_RANK[m.severity] ?? 3) < (SEVERITY_RANK[w] ?? 3) ? m.severity : w;
          }, 'minor');
          return {
            id: c.id,
            runId: opts.runId,
            label: c.label,
            description: c.description,
            rule: c.rule,
            severity: worst,
            exampleCount: members.length,
          };
        }),
      );
      await db.insert(deviationExamples).values(
        persistedClusters.flatMap((c) =>
          (memberIdxByGroup.get(c.id) ?? []).map((i) => {
            const f = findings[i]!;
            return {
              id: newId('dex_'),
              deviationId: c.id,
              traceId: f.traceId,
              label: f.label,
              description: f.description,
              severity: f.severity,
              evidence: f.evidence,
            };
          }),
        ),
      );
    }

    const result = { deviationCount: persistedClusters.length, exampleCount: findings.length };
    await finishRun(db, opts.runId, { ...result, tracesScanned: rows.length });
    return result;
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};
