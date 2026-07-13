import { desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { failRun, finishRun, isRunLive, judgeInWaves, renderTraceView } from './discovery.js';
import { primaryLlmModel } from './ingest.js';
import { resolveLlmConfig } from './llm.js';
import { estimateCostIfMetered, estimateCostUsd } from './pricing.js';
import { generateStructuredTracked } from './usage.js';
import { evals, flowTraces, traces } from './schema.js';
import { buildTraceView } from './vendor/index.js';

/*
 * COMPARE — the change-with-confidence screen. Runs the flow's assertion rules
 * (or all global rules) over two corpora (baseline vs candidate) and reports
 * per-rule pass rate + corpus cost for each side, plus the delta. Every rule is
 * active, so the suite is the whole set — no lifecycle gate. This is what a
 * model swap needs:
 * "did quality hold, and is it cheaper?". Verdicts are NOT persisted to
 * eval_results (a compare must never pollute an eval's regression history);
 * the full report lands in the run's stats blob.
 */

/** How a compare side names its corpus: pinned trace ids (fixtures), a run label, an agent tag, or a flow's members. */
export const corpusRefSchema = z.union([
  z.object({ traceIds: z.array(z.string().regex(/^[0-9a-f]{32}$/i)).min(1).max(200) }).strict(),
  z.object({ label: z.string().trim().min(1).max(200) }).strict(),
  z.object({ agent: z.string().trim().min(1).max(200) }).strict(),
  z.object({ flowId: z.string().trim().min(1).max(100) }).strict(),
]);

export type CorpusRef = z.infer<typeof corpusRefSchema>;

/** Default / max traces sampled per side for the agent / flow corpus kinds (pins are exact). */
const DEFAULT_COMPARE_SAMPLE = 20;
const MAX_COMPARE_SAMPLE = 100;

/** Same strict single-rule judge as an eval run — one rule, one trace, pass/fail + evidence. */
const COMPARE_SYSTEM_PROMPT =
  'You are a strict evaluator of agent execution traces. You are given ONE rule the agent should follow and a single trace. Decide only whether this trace COMPLIES with the rule (pass) or VIOLATES it (fail). Judge against the rule alone — ignore unrelated quality issues. Always cite specific evidence from the trace.';

/** Per-trace compare verdict returned by the model. */
const CompareVerdictSchema = z.object({
  verdict: z
    .enum(['pass', 'fail'])
    .describe('pass = the trace complies with the rule; fail = the trace violates the rule'),
  evidence: z
    .string()
    .describe('Quote or cite the specific part of the trace that justifies the verdict'),
});

/** A corpus side, resolved: display facts + the rows to score. */
type Corpus = {
  ref: CorpusRef;
  rows: Array<{ id: string; raw: unknown }>;
};

/** Aggregate facts about one side's traces (the "is it cheaper?" half of the report). */
type CorpusStats = {
  traces: number;
  tokensIn: number;
  tokensOut: number;
  /** Provider-blended estimate of real spend — 0 for corpora produced on a free provider. */
  estCostUsd: number;
  /** What the corpus WOULD cost on metered keys — price-book by each trace's primary model. Never $0-by-provider. */
  estCostIfMeteredUsd: number;
  avgDurationMs: number;
};

/** One rule's two-sided result. */
type RuleComparison = {
  id: string;
  slug: string | null;
  name: string;
  baseline: { scored: number; passed: number; failed: number; passRate: number | null };
  candidate: { scored: number; passed: number; failed: number; passRate: number | null };
  /** candidate − baseline pass rate; null when either side scored nothing. */
  deltaPassRate: number | null;
  /** True when the candidate's pass rate dropped below the baseline's. */
  regressed: boolean;
};

/** Resolve one corpus ref to its newest-first trace rows (raw envelopes included for the judge). */
const resolveCorpus = async (db: CoachDb, ref: CorpusRef, sampleSize: number): Promise<Corpus> => {
  if ('traceIds' in ref) {
    const ids = ref.traceIds.map((id) => id.toLowerCase());
    const rows = await db
      .select({ id: traces.id, raw: traces.raw })
      .from(traces)
      .where(inArray(traces.id, ids))
      .orderBy(desc(traces.receivedAt), desc(traces.id));
    return { ref, rows };
  }
  const where =
    'label' in ref
      ? eq(traces.runLabel, ref.label)
      : 'agent' in ref
        ? eq(traces.agent, ref.agent)
        : inArray(
            traces.id,
            db.select({ id: flowTraces.traceId }).from(flowTraces).where(eq(flowTraces.flowId, ref.flowId)),
          );
  const rows = await db
    .select({ id: traces.id, raw: traces.raw })
    .from(traces)
    .where(where)
    .orderBy(desc(traces.receivedAt), desc(traces.id))
    .limit(sampleSize);
  return { ref, rows };
};

/**
 * Sum a corpus's token/cost/latency facts. The headline cost is the PRICE-BOOK
 * one (`estCostIfMeteredUsd`): each trace priced by its primary LLM model —
 * the persisted `traces.model`, or (for pre-column rows) a walk of the stored
 * envelope's span tree. The provider-blended `estCostUsd` stays as the
 * real-spend estimate (legitimately $0 on a free provider) — without the
 * price-book figure, "is it cheaper?" reads $0/$0 and the compare is theater.
 */
const corpusStats = async (db: CoachDb, rows: Array<{ id: string; raw: unknown }>): Promise<CorpusStats> => {
  if (rows.length === 0) {
    return { traces: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0, estCostIfMeteredUsd: 0, avgDurationMs: 0 };
  }
  const rawById = new Map(rows.map((r) => [r.id, r.raw]));
  const facts = await db
    .select({
      id: traces.id,
      provider: traces.provider,
      model: traces.model,
      tokensIn: traces.tokensIn,
      tokensOut: traces.tokensOut,
      durationMs: traces.durationMs,
    })
    .from(traces)
    .where(inArray(traces.id, rows.map((r) => r.id)));
  let tokensIn = 0;
  let tokensOut = 0;
  let estCostUsd = 0;
  let estCostIfMeteredUsd = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const f of facts) {
    tokensIn += f.tokensIn ?? 0;
    tokensOut += f.tokensOut ?? 0;
    estCostUsd += estimateCostUsd(f.provider, f.tokensIn ?? 0, f.tokensOut ?? 0);
    const model = f.model ?? primaryLlmModel(buildTraceView(rawById.get(f.id), f.id).tree);
    estCostIfMeteredUsd += estimateCostIfMetered(model, f.tokensIn ?? 0, f.tokensOut ?? 0);
    if (f.durationMs !== null) {
      durationSum += f.durationMs;
      durationCount += 1;
    }
  }
  return {
    traces: facts.length,
    tokensIn,
    tokensOut,
    estCostUsd,
    estCostIfMeteredUsd,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
  };
};

/** Pass rate as a 0..1 fraction, or null when nothing scored. */
const passRate = (passed: number, scored: number): number | null => (scored > 0 ? passed / scored : null);

/**
 * Run one compare: resolve both corpora, score the suite (the flow's rules when
 * a flow is given, else every global rule) over each side in concurrent waves,
 * and finish the run with the full report in its stats blob. Marks the run
 * `done` (or `error`, re-throwing) via the shared lifecycle helpers.
 */
export const runCompare = async (
  db: CoachDb,
  opts: {
    runId: string;
    flowId?: string;
    baseline: CorpusRef;
    candidate: CorpusRef;
    sampleSize?: number;
    signal?: AbortSignal;
  },
): Promise<{ rules: number; regressions: number }> => {
  try {
    const sampleSize = Math.max(1, Math.min(opts.sampleSize ?? DEFAULT_COMPARE_SAMPLE, MAX_COMPARE_SAMPLE));

    // The suite: the flow's rules when scoped to a flow, else every global rule.
    // Every rule is active — there is no lifecycle gate to filter on.
    const suite = await db
      .select()
      .from(evals)
      .where(opts.flowId ? eq(evals.flowId, opts.flowId) : isNull(evals.flowId))
      .orderBy(evals.createdAt, evals.id);
    if (suite.length === 0) {
      throw new Error(
        opts.flowId
          ? `flow ${opts.flowId} has no rules to compare — add a rule to this flow first`
          : 'no global rules to compare — add a rule first',
      );
    }

    const [baseline, candidate] = await Promise.all([
      resolveCorpus(db, opts.baseline, sampleSize),
      resolveCorpus(db, opts.candidate, sampleSize),
    ]);
    if (baseline.rows.length === 0) throw new Error('the baseline corpus matched no traces');
    if (candidate.rows.length === 0) throw new Error('the candidate corpus matched no traces');

    // Flatten (rule × side × trace) so judgeInWaves drives one progress bar
    // over the whole matrix and cancellation stops between waves.
    const lightModel = resolveLlmConfig().lightModelId;
    type Item = { ruleIdx: number; side: 'baseline' | 'candidate'; row: { id: string; raw: unknown } };
    const items: Item[] = [];
    for (let i = 0; i < suite.length; i += 1) {
      for (const row of baseline.rows) items.push({ ruleIdx: i, side: 'baseline', row });
      for (const row of candidate.rows) items.push({ ruleIdx: i, side: 'candidate', row });
    }
    const verdicts = await judgeInWaves(db, opts.runId, items, async (item) => {
      const rule = suite[item.ruleIdx]!;
      const view = buildTraceView(item.row.raw, item.row.id);
      const block = renderTraceView(view, item.row.id);
      const { object } = await generateStructuredTracked(db, 'compare', {
        schema: CompareVerdictSchema,
        system: COMPARE_SYSTEM_PROMPT,
        prompt: `Rule the agent should follow:\n"${rule.text}"\n\nDoes the following trace COMPLY with that rule (pass) or VIOLATE it (fail)? Judge only against the rule above.\n\n${block}`,
        tier: 'light',
        model: rule.judgeModel ?? lightModel,
        temperature: 0,
        signal: opts.signal,
      });
      return { ruleIdx: item.ruleIdx, side: item.side, verdict: object.verdict };
    });

    // A canceled/timed-out run is already finalized — don't overwrite it.
    if (!(await isRunLive(db, opts.runId))) return { rules: 0, regressions: 0 };

    const rules: RuleComparison[] = suite.map((rule, i) => {
      const forRule = verdicts.filter((v) => v.ruleIdx === i);
      const side = (name: 'baseline' | 'candidate') => {
        const vs = forRule.filter((v) => v.side === name);
        const passed = vs.filter((v) => v.verdict === 'pass').length;
        return { scored: vs.length, passed, failed: vs.length - passed, passRate: passRate(passed, vs.length) };
      };
      const b = side('baseline');
      const c = side('candidate');
      const delta = b.passRate !== null && c.passRate !== null ? c.passRate - b.passRate : null;
      return {
        id: rule.id,
        slug: rule.slug,
        name: rule.name,
        baseline: b,
        candidate: c,
        deltaPassRate: delta,
        regressed: delta !== null && delta < 0,
      };
    });

    const [baselineStats, candidateStats] = await Promise.all([
      corpusStats(db, baseline.rows),
      corpusStats(db, candidate.rows),
    ]);
    const regressions = rules.filter((r) => r.regressed).length;
    const report = {
      flowId: opts.flowId ?? null,
      sampleSize,
      rules,
      baseline: { ref: baseline.ref, ...baselineStats },
      candidate: { ref: candidate.ref, ...candidateStats },
      /** candidate − baseline price-book cost: negative = the change is cheaper. */
      costIfMeteredDeltaUsd: candidateStats.estCostIfMeteredUsd - baselineStats.estCostIfMeteredUsd,
      regressions,
    };
    await finishRun(db, opts.runId, report);
    return { rules: rules.length, regressions };
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};
