import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { parseSelector } from './classify.js';
import { finishRun, failRun, isRunLive, judgeInWaves, renderTraceView } from './discovery.js';
import { resolveLlmConfig } from './llm.js';
import { generateStructuredTracked } from './usage.js';
import { newId } from './ids.js';
import { deviations, evalResults, evals, flowTraces, flows, runs, traces, type Anchor } from './schema.js';
import { buildTraceView } from './vendor/index.js';

/*
 * Local EVALS — turn a discovered deviation (or a hand-written rule) into a
 * repeatable pass/fail check. Each eval carries one plain-language `rule`; a run
 * samples recent traces and asks the model, per trace, whether the trace
 * COMPLIES with the rule (pass) or VIOLATES it (fail). Verdicts are stored per
 * (eval, run, trace) so the Evals view can show pass/fail counts and flag
 * regressions — traces that passed last run and now fail.
 */

/** Judge system prompt for a single-rule eval — strict and scoped to the one rule. */
const EVAL_SYSTEM_PROMPT =
  'You are a strict evaluator of agent execution traces. You are given ONE rule the agent should follow and a single trace. Decide only whether this trace COMPLIES with the rule (pass) or VIOLATES it (fail). Judge against the rule alone — ignore unrelated quality issues. Always cite specific evidence from the trace.';

/** Per-trace eval verdict returned by the model. */
const EvalVerdictSchema = z.object({
  verdict: z
    .enum(['pass', 'fail'])
    .describe('pass = the trace complies with the rule; fail = the trace violates the rule'),
  evidence: z
    .string()
    .describe('Quote or cite the specific part of the trace that justifies the verdict'),
});

/** Default number of traces scored per eval run. */
const DEFAULT_EVAL_SAMPLE = 20;

/** Derive cloud `FlowRule.source` provenance from anchors: a file-anchored rule is read-from-`code`, else authored (`promoted`). */
export const sourceFromAnchors = (anchors: Anchor[] | null | undefined): 'code' | 'promoted' =>
  anchors && anchors.length > 0 ? 'code' : 'promoted';

/** A stored eval (assertion rule) — mirrors cloud `FlowRule`: name (title) + text (predicate) + provenance + anchors + flow scoping. */
export type EvalRecord = {
  id: string;
  name: string;
  description: string;
  text: string;
  /** Provenance (cloud `FlowRule.source`): `code` (read from a file anchor) or `promoted` (authored). */
  source: string;
  sourceDeviationId: string | null;
  /** The flow this eval is scoped to (runs sample its members); null = global. */
  flowId: string | null;
  /** WHERE in code this rule is enforced (cloud `FlowRule.anchors`); Coach populates only `file`. Null = authored/custom. */
  anchors: Anchor[] | null;
  /** New member traces (since the last run) needed to trigger an automatic rerun of a watched rule. */
  autorunThreshold: number;
  /** Pass-rate gate for `glassray check` (0..1); null = 1.0. */
  threshold: number | null;
  /** Preferred judge model for this rule's runs; null = the light-tier default. */
  judgeModel: string | null;
  /** Stable artifact identity (the `glassray.yaml` rule id); null until exported/imported. */
  slug: string | null;
  /** When the most recent run started — the autorun watermark. */
  lastRunAt: Date | null;
  createdAt: Date;
};

/** Rollup for one eval: latest-run pass/fail counts + regressions vs the previous run. */
export type EvalSummary = EvalRecord & {
  latestRunId: string | null;
  lastRunAt: Date | null;
  scored: number;
  passed: number;
  failed: number;
  /** Traces failing in the latest run that were passing in the previous run. */
  regressionCount: number;
};

/** One per-trace verdict in an eval's latest run, annotated with a regression flag + trace display fields. */
export type EvalResultRow = {
  traceId: string;
  name: string | null;
  agent: string | null;
  /** When the scored trace was received — disambiguates identically-named traces. */
  receivedAt: Date | null;
  verdict: string;
  evidence: string;
  /** True when this trace is failing now but passed in the previous run. */
  regression: boolean;
};

/** One past run of an eval, oldest→newest — powers the pass-rate trend sparkline. */
export type EvalRunPoint = { runId: string; at: Date | null; passed: number; failed: number; total: number };

/** Full eval detail: the eval, its latest-run rollup, the per-trace verdicts, and the run history. */
export type EvalDetail = EvalSummary & { results: EvalResultRow[]; history: EvalRunPoint[] };

/**
 * Create an eval from a discovered deviation — copies its title / description /
 * predicate. Idempotent: if an eval was already saved from this deviation, its
 * id is returned instead of creating a duplicate. Returns null if the deviation
 * no longer exists.
 */
export const createEvalFromDeviation = async (
  db: CoachDb,
  deviationId: string,
  opts?: { flowId?: string },
): Promise<string | null> => {
  const rows = await db.select().from(deviations).where(eq(deviations.id, deviationId)).limit(1);
  const dev = rows[0];
  if (!dev) return null;
  const already = await db
    .select({ id: evals.id })
    .from(evals)
    .where(eq(evals.sourceDeviationId, deviationId))
    .limit(1);
  if (already[0]) {
    // Idempotent hit — but an explicitly requested flow binding must still land,
    // not be silently dropped.
    if (opts?.flowId) {
      await db.update(evals).set({ flowId: opts.flowId }).where(eq(evals.id, already[0].id));
    }
    return already[0].id;
  }
  const id = newId('eval_');
  // A deviation-promoted rule is AUTHORED (`source: 'promoted'`, no anchors) — it
  // wasn't read from a specific line of code. Every rule is active from the moment it lands.
  await db.insert(evals).values({
    id,
    name: dev.label,
    description: dev.description,
    text: dev.rule,
    source: 'promoted',
    sourceDeviationId: dev.id,
    flowId: opts?.flowId ?? null,
    anchors: null,
    state: 'active',
  });
  return id;
};

/** Create a hand-written eval from a name + text (+ optional description / flow scope / code anchors / gate tuning). Returns the new eval id. */
export const createManualEval = async (
  db: CoachDb,
  input: {
    name: string;
    text: string;
    description?: string;
    flowId?: string;
    /** WHERE in code this rule is enforced; supplying anchors makes it `source: 'code'`, omitting them `source: 'promoted'`. */
    anchors?: Anchor[] | null;
    autorunThreshold?: number;
    threshold?: number;
    judgeModel?: string;
    slug?: string;
  },
): Promise<string> => {
  const id = newId('eval_');
  const anchors = input.anchors ?? null;
  await db.insert(evals).values({
    id,
    name: input.name,
    description: input.description ?? '',
    text: input.text,
    source: sourceFromAnchors(anchors),
    sourceDeviationId: null,
    flowId: input.flowId ?? null,
    anchors,
    state: 'active',
    ...(input.autorunThreshold !== undefined ? { autorunThreshold: input.autorunThreshold } : {}),
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    ...(input.judgeModel !== undefined ? { judgeModel: input.judgeModel } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
  });
  return id;
};

/** Patch shape for an eval: flow binding, code anchors, and gate tuning (the rule text itself is immutable). */
export type EvalPatch = {
  flowId?: string | null;
  anchors?: Anchor[] | null;
  autorunThreshold?: number;
  threshold?: number | null;
  judgeModel?: string | null;
};

/** Patch an eval's flow binding / code anchors / gate tuning. Setting anchors re-derives `source`. Returns false when the eval doesn't exist. */
export const updateEval = async (db: CoachDb, id: string, patch: EvalPatch): Promise<boolean> => {
  const set: Partial<typeof evals.$inferInsert> = {};
  if (patch.flowId !== undefined) set.flowId = patch.flowId;
  if (patch.anchors !== undefined) {
    set.anchors = patch.anchors;
    set.source = sourceFromAnchors(patch.anchors);
  }
  if (patch.autorunThreshold !== undefined) set.autorunThreshold = patch.autorunThreshold;
  if (patch.threshold !== undefined) set.threshold = patch.threshold;
  if (patch.judgeModel !== undefined) set.judgeModel = patch.judgeModel;
  if (Object.keys(set).length === 0) {
    const rows = await db.select({ id: evals.id }).from(evals).where(eq(evals.id, id)).limit(1);
    return rows.length > 0;
  }
  const updated = await db.update(evals).set(set).where(eq(evals.id, id)).returning({ id: evals.id });
  return updated.length > 0;
};

/** Delete an eval and all of its stored verdicts. Returns false if the eval didn't exist. */
export const deleteEval = async (db: CoachDb, evalId: string): Promise<boolean> => {
  const rows = await db.select({ id: evals.id }).from(evals).where(eq(evals.id, evalId)).limit(1);
  if (!rows[0]) return false;
  await db.delete(evalResults).where(eq(evalResults.evalId, evalId));
  await db.delete(evals).where(eq(evals.id, evalId));
  return true;
};

/**
 * Score traces against one eval's rule (light tier, per trace) and store a
 * pass/fail verdict + evidence per trace under `runId`. The corpus is either an
 * explicit `traceIds` pin (the fixtures path — deterministic, for `check`), or
 * a sample: a flow-scoped eval samples its flow's newest members (capped by the
 * flow selector's `limit`), a global eval the newest traces store-wide. Stamps
 * the eval's `lastRunAt` watermark at start (the autorun trigger), and records
 * the judge model in the run stats. Marks the run `done` (or `error`, re-throwing).
 */
export const runEval = async (
  db: CoachDb,
  opts: {
    evalId: string;
    runId: string;
    sampleSize?: number;
    model?: string;
    /** Score exactly these traces (fixtures corpus) instead of sampling live members. */
    traceIds?: string[];
    signal?: AbortSignal;
  },
): Promise<{ scored: number; passed: number; failed: number }> => {
  try {
    const evalRows = await db.select().from(evals).where(eq(evals.id, opts.evalId)).limit(1);
    const ev = evalRows[0];
    if (!ev) throw new Error(`eval ${opts.evalId} not found`);

    // Stamp the autorun watermark unconditionally at start — even a failing run
    // resets the new-member counter, so a broken eval can't refire every sweep.
    await db.update(evals).set({ lastRunAt: new Date() }).where(eq(evals.id, ev.id));

    // Sample size: explicit override > the flow selector's `limit` > default.
    const flowRow = ev.flowId
      ? (await db.select().from(flows).where(eq(flows.id, ev.flowId)).limit(1))[0]
      : undefined;
    if (ev.flowId && !flowRow) throw new Error(`flow ${ev.flowId} for eval ${ev.id} not found`);
    const flowLimit = flowRow ? parseSelector(flowRow.selector)?.limit : undefined;
    const sampleSize = Math.max(1, Math.min(opts.sampleSize ?? flowLimit ?? DEFAULT_EVAL_SAMPLE, 200));

    // The judge model this run will use (recorded in stats for cross-run
    // comparison): explicit override > the rule's own judge > the light default.
    const judgeModel = opts.model ?? ev.judgeModel ?? resolveLlmConfig().lightModelId;

    // The corpus: pinned trace ids (deterministic — fixtures), else the newest
    // traces (full raw envelope needed to rebuild the view), scoped to the
    // flow's members for a flow-bound eval.
    const rows = opts.traceIds
      ? await db
          .select({ id: traces.id, raw: traces.raw })
          .from(traces)
          .where(inArray(traces.id, opts.traceIds.map((id) => id.toLowerCase())))
          .orderBy(desc(traces.receivedAt), desc(traces.id))
      : await db
          .select({ id: traces.id, raw: traces.raw })
          .from(traces)
          .where(
            ev.flowId
              ? inArray(
                  traces.id,
                  db.select({ id: flowTraces.traceId }).from(flowTraces).where(eq(flowTraces.flowId, ev.flowId)),
                )
              : undefined,
          )
          .orderBy(desc(traces.receivedAt), desc(traces.id))
          .limit(sampleSize);

    // Score each sampled trace against the rule (in concurrent waves; progress
    // publishes per wave, and a canceled/timed-out run stops between waves).
    const verdicts = await judgeInWaves(db, opts.runId, rows, async (row) => {
      const view = buildTraceView(row.raw, row.id);
      const block = renderTraceView(view, row.id);
      const { object } = await generateStructuredTracked(db, 'eval', {
        schema: EvalVerdictSchema,
        system: EVAL_SYSTEM_PROMPT,
        prompt: `Rule the agent should follow:\n"${ev.text}"\n\nDoes the following trace COMPLY with that rule (pass) or VIOLATE it (fail)? Judge only against the rule above.\n\n${block}`,
        tier: 'light',
        model: judgeModel,
        temperature: 0,
        signal: opts.signal,
      });
      return { traceId: row.id, verdict: object.verdict, evidence: object.evidence };
    });
    const passed = verdicts.filter((v) => v.verdict === 'pass').length;
    const failed = verdicts.length - passed;
    const results: Array<typeof evalResults.$inferInsert> = verdicts.map((v) => ({
      id: newId('evr_'),
      evalId: ev.id,
      runId: opts.runId,
      traceId: v.traceId,
      verdict: v.verdict,
      evidence: v.evidence,
    }));
    // Skip the write if the run was canceled/timed out mid-scoring.
    if (!(await isRunLive(db, opts.runId))) return { scored: 0, passed: 0, failed: 0 };
    if (results.length > 0) await db.insert(evalResults).values(results);

    const result = { scored: rows.length, passed, failed };
    await finishRun(db, opts.runId, { ...result, judgeModel });
    return result;
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};

/**
 * The evals due an automatic rerun: flow-scoped and their flow has accrued at
 * least `autorunThreshold` member traces since the eval last ran (or ever, for
 * a never-run eval — the hands-free baseline). Called after every classify
 * sweep; the queue's per-eval dedup absorbs repeats. Every rule is active, so
 * every flow-scoped rule is autorun-eligible.
 */
export const autorunDueEvals = async (db: CoachDb): Promise<Array<{ id: string; flowId: string }>> => {
  const rows = await db
    .select({ id: evals.id, flowId: evals.flowId })
    .from(evals)
    .where(
      and(
        isNotNull(evals.flowId),
        sql`(
          select count(*) from flow_traces ft
          where ft.flow_id = ${evals.flowId}
            and ft.assigned_at > coalesce(${evals.lastRunAt}, '-infinity'::timestamptz)
        ) >= ${evals.autorunThreshold}`,
      ),
    );
  return rows.filter((r): r is { id: string; flowId: string } => r.flowId !== null);
};

/**
 * The two most recent run ids that produced verdicts for one eval, newest
 * first (by run start). `[latestRunId, previousRunId]`, either possibly absent.
 */
const latestTwoRuns = async (db: CoachDb, evalId: string): Promise<Array<{ runId: string; startedAt: Date }>> =>
  db
    .selectDistinct({ runId: evalResults.runId, startedAt: runs.startedAt })
    .from(evalResults)
    .innerJoin(runs, eq(evalResults.runId, runs.id))
    .where(eq(evalResults.evalId, evalId))
    .orderBy(desc(runs.startedAt))
    .limit(2);

/** The set of trace ids that received a given verdict for one eval in one run. */
const traceIdsWithVerdict = async (
  db: CoachDb,
  evalId: string,
  runId: string,
  verdict: 'pass' | 'fail',
): Promise<Set<string>> => {
  const rows = await db
    .select({ traceId: evalResults.traceId })
    .from(evalResults)
    .where(and(eq(evalResults.evalId, evalId), eq(evalResults.runId, runId), eq(evalResults.verdict, verdict)));
  return new Set(rows.map((r) => r.traceId));
};

/**
 * List every eval with its latest-run rollup (pass/fail counts + regression
 * count vs the previous run), newest eval first.
 */
export const listEvalSummaries = async (db: CoachDb): Promise<EvalSummary[]> => {
  const evalRows = await db.select().from(evals).orderBy(desc(evals.createdAt), desc(evals.id));
  const summaries: EvalSummary[] = [];
  for (const ev of evalRows) {
    const runsForEval = await latestTwoRuns(db, ev.id);
    const latest = runsForEval[0];
    const previous = runsForEval[1];
    if (!latest) {
      summaries.push({ ...ev, latestRunId: null, lastRunAt: null, scored: 0, passed: 0, failed: 0, regressionCount: 0 });
      continue;
    }
    const latestRows = await db
      .select({ traceId: evalResults.traceId, verdict: evalResults.verdict })
      .from(evalResults)
      .where(and(eq(evalResults.evalId, ev.id), eq(evalResults.runId, latest.runId)));
    const passed = latestRows.filter((r) => r.verdict === 'pass').length;
    const failed = latestRows.length - passed;
    // Regression = a trace failing now that was passing in the previous run.
    const prevPass = previous ? await traceIdsWithVerdict(db, ev.id, previous.runId, 'pass') : new Set<string>();
    const regressionCount = latestRows.filter((r) => r.verdict === 'fail' && prevPass.has(r.traceId)).length;
    summaries.push({
      ...ev,
      latestRunId: latest.runId,
      lastRunAt: latest.startedAt,
      scored: latestRows.length,
      passed,
      failed,
      regressionCount,
    });
  }
  return summaries;
};

/**
 * One eval's full detail: the latest-run rollup plus every per-trace verdict
 * (each flagged when it is a regression). Returns null if the eval is gone.
 */
export const getEvalDetail = async (db: CoachDb, evalId: string): Promise<EvalDetail | null> => {
  const rows = await db.select().from(evals).where(eq(evals.id, evalId)).limit(1);
  const ev = rows[0];
  if (!ev) return null;

  // Every past run's pass/fail totals, oldest→newest, for the trend sparkline.
  const historyRows = await db
    .select({
      runId: evalResults.runId,
      at: runs.startedAt,
      passed: sql<number>`count(*) filter (where ${evalResults.verdict} = 'pass')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(evalResults)
    .innerJoin(runs, eq(evalResults.runId, runs.id))
    .where(eq(evalResults.evalId, ev.id))
    .groupBy(evalResults.runId, runs.startedAt)
    .orderBy(runs.startedAt);
  const history: EvalRunPoint[] = historyRows.map((h) => ({
    runId: h.runId,
    at: h.at,
    passed: h.passed,
    failed: h.total - h.passed,
    total: h.total,
  }));

  const runsForEval = await latestTwoRuns(db, ev.id);
  const latest = runsForEval[0];
  const previous = runsForEval[1];
  if (!latest) {
    return { ...ev, latestRunId: null, lastRunAt: null, scored: 0, passed: 0, failed: 0, regressionCount: 0, results: [], history };
  }

  const prevPass = previous ? await traceIdsWithVerdict(db, ev.id, previous.runId, 'pass') : new Set<string>();
  const resultRows = await db
    .select({
      traceId: evalResults.traceId,
      verdict: evalResults.verdict,
      evidence: evalResults.evidence,
      name: traces.name,
      agent: traces.agent,
      receivedAt: traces.receivedAt,
    })
    .from(evalResults)
    .leftJoin(traces, eq(evalResults.traceId, traces.id))
    .where(and(eq(evalResults.evalId, ev.id), eq(evalResults.runId, latest.runId)));

  // Failing traces first (they're what the user acts on), regressions at the very top.
  const results: EvalResultRow[] = resultRows
    .map((r) => ({ ...r, regression: r.verdict === 'fail' && prevPass.has(r.traceId) }))
    .sort((a, b) => rank(a) - rank(b));
  const passed = results.filter((r) => r.verdict === 'pass').length;
  const failed = results.length - passed;
  const regressionCount = results.filter((r) => r.regression).length;

  return {
    ...ev,
    latestRunId: latest.runId,
    lastRunAt: latest.startedAt,
    scored: results.length,
    passed,
    failed,
    regressionCount,
    results,
    history,
  };
};

/** Ordering key for the detail rows: regressions (0) → other failures (1) → passes (2). */
const rank = (r: EvalResultRow): number => (r.regression ? 0 : r.verdict === 'fail' ? 1 : 2);
