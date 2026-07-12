import { desc, eq, sql } from 'drizzle-orm';
import type { CoachDb } from './bootstrap.js';
import { runCompare } from './compare.js';
import { newId } from './ids.js';
import { experiments, runs, traces } from './schema.js';

/*
 * EXPERIMENTS — the durable container for one question ("can we switch to
 * Haiku?"). An experiment wraps a baseline-vs-candidate `compare` and keeps the
 * generated report (data only, no go/no-go call). `runCompare` is the mechanism; the
 * experiment persists its result and the prose you share. Experiments are
 * records — never part of `glassray.yaml`.
 */

/** One rule's two-sided result inside a compare report (mirrors compare.ts's RuleComparison). */
type CompareRule = {
  id: string;
  name: string;
  baseline: { scored: number; passed: number; failed: number; passRate: number | null };
  candidate: { scored: number; passed: number; failed: number; passRate: number | null };
  deltaPassRate: number | null;
  regressed: boolean;
};

/** The compare report as stored in a finished compare run's stats blob. */
type CompareReport = {
  rules: CompareRule[];
  baseline: { estCostIfMeteredUsd: number };
  candidate: { estCostIfMeteredUsd: number };
  costIfMeteredDeltaUsd: number;
  regressions: number;
};

/** One regressed rule surfaced in the experiment report (rule-level — compare keeps no per-trace verdicts). */
export type FailingRule = {
  ruleId: string;
  ruleLabel: string;
  baselinePassRate: number | null;
  candidatePassRate: number | null;
  deltaPassRate: number | null;
  candidateFailed: number;
  candidateScored: number;
};

/** The generated experiment report: the compare result + prose, stored on the row. Data only — no go/no-go call; the human decides. */
export type ExperimentReport = {
  /** One-paragraph plain-language summary (rules held/regressed + the cost delta). No recommendation. */
  summary: string;
  /** How many rules regressed. */
  regressions: number;
  /** candidate − baseline price-book cost (negative = cheaper). */
  costDeltaUsd: number;
  /** Per-regressed-rule detail (the "failing examples"). */
  failing: FailingRule[];
  /** The full compare report, embedded so the detail view renders without a second fetch. */
  compare: CompareReport;
};

/** A stored experiment row shaped for the API. */
export type ExperimentRecord = {
  id: string;
  flowId: string | null;
  question: string;
  status: 'open' | 'running' | 'concluded';
  baselineLabel: string | null;
  candidateLabel: string | null;
  runId: string | null;
  report: ExperimentReport | null;
  createdAt: Date;
  concludedAt: Date | null;
};

/** Compact USD for the prose (compare sides are usually cents). */
const money = (usd: number): string => {
  const v = Number.isFinite(usd) ? usd : 0;
  return v <= 0 ? '$0' : v < 0.01 ? '<$0.01' : `$${v.toFixed(v < 1 ? 4 : 2)}`;
};

/** Percent from a 0..1 rate, or an em-dash. */
const pct = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

/** Open a new experiment for a question (status `open`, no report yet). Returns the new id. */
export const createExperiment = async (
  db: CoachDb,
  input: { flowId?: string | null; question: string },
): Promise<string> => {
  const id = newId('exp_');
  await db.insert(experiments).values({
    id,
    flowId: input.flowId ?? null,
    question: input.question,
    status: 'open',
  });
  return id;
};

/** Map a raw experiment row to the API record (typing the jsonb `report`). */
const toRecord = (row: typeof experiments.$inferSelect): ExperimentRecord => ({
  id: row.id,
  flowId: row.flowId,
  question: row.question,
  status: row.status as ExperimentRecord['status'],
  baselineLabel: row.baselineLabel,
  candidateLabel: row.candidateLabel,
  runId: row.runId,
  report: (row.report ?? null) as ExperimentReport | null,
  createdAt: row.createdAt,
  concludedAt: row.concludedAt,
});

/** List experiments (optionally one flow's), newest-first. */
export const listExperiments = async (db: CoachDb, flowId?: string): Promise<ExperimentRecord[]> => {
  const rows = await db
    .select()
    .from(experiments)
    .where(flowId ? eq(experiments.flowId, flowId) : undefined)
    .orderBy(desc(experiments.createdAt), desc(experiments.id));
  return rows.map(toRecord);
};

/** Load one experiment (with its embedded report), or null when gone. */
export const getExperiment = async (db: CoachDb, id: string): Promise<ExperimentRecord | null> => {
  const rows = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
};

/**
 * The two newest run labels (by their newest trace), candidate-first — the
 * default corpora when a report doesn't name them. `[candidate, baseline]`.
 */
export const newestTwoLabels = async (db: CoachDb): Promise<string[]> => {
  const rows = await db
    .select({ label: traces.runLabel, at: sql<string>`max(${traces.receivedAt})` })
    .from(traces)
    .where(sql`${traces.runLabel} is not null`)
    .groupBy(traces.runLabel)
    .orderBy(desc(sql`max(${traces.receivedAt})`))
    .limit(2);
  return rows.map((r) => r.label).filter((l): l is string => l !== null);
};

/** Turn a finished compare report into the generated experiment report — the data, stated plainly, with no go/no-go call. */
export const buildExperimentReport = (compare: CompareReport): ExperimentReport => {
  const regressed = compare.rules.filter((r) => r.regressed);
  const held = compare.rules.filter((r) => !r.regressed);
  const costDelta = compare.costIfMeteredDeltaUsd;
  const costPhrase =
    costDelta < 0
      ? `cost down ${money(Math.abs(costDelta))} (${money(compare.baseline.estCostIfMeteredUsd)} → ${money(compare.candidate.estCostIfMeteredUsd)})`
      : costDelta > 0
        ? `cost up ${money(costDelta)} (${money(compare.baseline.estCostIfMeteredUsd)} → ${money(compare.candidate.estCostIfMeteredUsd)})`
        : `cost unchanged (${money(compare.candidate.estCostIfMeteredUsd)})`;
  const rulesPhrase =
    regressed.length > 0
      ? `${held.length} of ${compare.rules.length} rule(s) held; ${regressed.length} regressed (${regressed.map((r) => r.name).join(', ')})`
      : `all ${compare.rules.length} rule(s) held`;
  const summary = `${rulesPhrase}. ${costPhrase[0]!.toUpperCase()}${costPhrase.slice(1)}.`;
  const failing: FailingRule[] = regressed.map((r) => ({
    ruleId: r.id,
    ruleLabel: r.name,
    baselinePassRate: r.baseline.passRate,
    candidatePassRate: r.candidate.passRate,
    deltaPassRate: r.deltaPassRate,
    candidateFailed: r.candidate.failed,
    candidateScored: r.candidate.scored,
  }));
  return { summary, regressions: regressed.length, costDeltaUsd: costDelta, failing, compare };
};

/**
 * Conclude an experiment: run `compare` over the flow's rules (baseline vs
 * candidate labels), store the result, generate the report, and mark
 * it `concluded`. Runs as a queued `compare` runner — `runCompare` finalizes
 * the run row with the compare report in its stats, which this then reads back
 * and wraps. On a compare failure the experiment reverts to `open` (the run
 * carries the error) and the error re-throws.
 */
export const concludeExperiment = async (
  db: CoachDb,
  opts: {
    experimentId: string;
    runId: string;
    baseline: string;
    candidate: string;
    signal?: AbortSignal;
  },
): Promise<{ regressions: number }> => {
  const rows = await db.select().from(experiments).where(eq(experiments.id, opts.experimentId)).limit(1);
  const exp = rows[0];
  if (!exp) throw new Error(`experiment ${opts.experimentId} not found`);

  await db
    .update(experiments)
    .set({ status: 'running', baselineLabel: opts.baseline, candidateLabel: opts.candidate, runId: opts.runId })
    .where(eq(experiments.id, opts.experimentId));

  try {
    await runCompare(db, {
      runId: opts.runId,
      flowId: exp.flowId ?? undefined,
      baseline: { label: opts.baseline },
      candidate: { label: opts.candidate },
      signal: opts.signal,
    });
  } catch (err) {
    // The compare run is already marked errored by runCompare — revert the
    // experiment so the user can retry, and surface the failure via the run.
    await db.update(experiments).set({ status: 'open' }).where(eq(experiments.id, opts.experimentId)).catch(() => {});
    throw err;
  }

  const runRows = await db.select({ stats: runs.stats }).from(runs).where(eq(runs.id, opts.runId)).limit(1);
  const compare = runRows[0]?.stats as CompareReport | undefined;
  if (!compare || !Array.isArray(compare.rules)) {
    // The run was canceled/timed out mid-compare (no report persisted).
    await db.update(experiments).set({ status: 'open' }).where(eq(experiments.id, opts.experimentId)).catch(() => {});
    throw new Error('the compare produced no report (canceled or timed out)');
  }

  const report = buildExperimentReport(compare);
  await db
    .update(experiments)
    .set({ status: 'concluded', report, concludedAt: new Date() })
    .where(eq(experiments.id, opts.experimentId));
  return { regressions: report.regressions };
};
