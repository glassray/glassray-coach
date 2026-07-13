import { desc, sql } from 'drizzle-orm';
import type { CoachDb } from './bootstrap.js';
import { newId } from './ids.js';
import {
  generateStructured,
  generateText,
  type GenerateStructuredArgs,
  type GenerateTextArgs,
  type GeneratedObject,
  type GeneratedText,
} from './llm.js';
import { estimateCostForModel, estimateCostIfMetered } from './pricing.js';
import { getSettings } from './settings.js';
import { llmUsage } from './schema.js';

/*
 * LLM usage metering + a spend cap. Every Coach analysis call (discovery / eval
 * / flows / replay) goes through the tracked wrappers here, which (1) refuse the
 * call when the accrued metered spend has reached the budget and (2) record the
 * tokens + estimated cost afterwards. The default budget ($50) exists so a
 * metered API key can't quietly drain a developer's balance during testing; the
 * free `mock` / `claude-subscription` paths accrue $0 and are never blocked.
 */

/** What an LLM call was for — the usage `kind` column. */
export type UsageKind = 'discovery' | 'eval' | 'flows' | 'replay' | 'improver' | 'classify' | 'compare';

/** Default spend cap in USD when GLASSRAY_LLM_BUDGET_USD is unset. */
const DEFAULT_BUDGET_USD = 50;

/**
 * The metered-spend cap in USD. `GLASSRAY_LLM_BUDGET_USD=0` (or negative) means
 * unlimited (returns Infinity); a positive number overrides; anything else
 * falls back to the $50 default.
 */
export const resolveBudgetUsd = (): number => {
  // Dashboard setting wins over env, which wins over the default.
  const fromSettings = getSettings().budgetUsd;
  const raw = fromSettings !== undefined ? String(fromSettings) : process.env.GLASSRAY_LLM_BUDGET_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUDGET_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_BUDGET_USD;
  if (parsed <= 0) return Infinity; // opt-out (0 = unlimited)
  return parsed;
};

/** Thrown by the tracked wrappers when the metered spend has reached the budget. */
export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `LLM budget of $${budgetUsd.toFixed(2)} reached (spent ~$${spentUsd.toFixed(2)}). ` +
        'Raise GLASSRAY_LLM_BUDGET_USD, reset usage, or switch to the free mock / claude-subscription provider.',
    );
    this.name = 'BudgetExceededError';
  }
}

/** Total metered USD spent so far (0 when only free providers have run). */
export const getSpentUsd = async (db: CoachDb): Promise<number> => {
  const rows = await db.select({ spent: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)::double precision` }).from(llmUsage);
  return rows[0]?.spent ?? 0;
};

/** Throw BudgetExceededError when the accrued metered spend has reached the cap. */
export const assertBudget = async (db: CoachDb): Promise<void> => {
  const budget = resolveBudgetUsd();
  if (!Number.isFinite(budget)) return; // unlimited
  const spent = await getSpentUsd(db);
  if (spent >= budget) throw new BudgetExceededError(spent, budget);
};

/** Append one usage row, pricing the tokens for the (provider, model). */
const recordUsage = async (
  db: CoachDb,
  kind: UsageKind,
  entry: { provider: string; model: string; tokensIn: number; tokensOut: number },
): Promise<void> => {
  const costUsd = estimateCostForModel(entry.provider, entry.model, entry.tokensIn, entry.tokensOut);
  await db.insert(llmUsage).values({
    id: newId('use_'),
    kind,
    provider: entry.provider,
    model: entry.model,
    tokensIn: entry.tokensIn,
    tokensOut: entry.tokensOut,
    costUsd,
  });
};

/** Structured generation with the budget check + usage recording (the wrapper every DB-backed pass uses). */
export const generateStructuredTracked = async <T>(
  db: CoachDb,
  kind: UsageKind,
  args: GenerateStructuredArgs<T>,
): Promise<GeneratedObject<T>> => {
  await assertBudget(db);
  const result = await generateStructured(args);
  await recordUsage(db, kind, {
    provider: result.provider,
    model: result.model,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
  });
  return result;
};

/** Free-text generation with the budget check + usage recording (the span-replay path). */
export const generateTextTracked = async (
  db: CoachDb,
  kind: UsageKind,
  args: GenerateTextArgs,
): Promise<GeneratedText> => {
  await assertBudget(db);
  const result = await generateText(args);
  await recordUsage(db, kind, {
    provider: result.provider,
    model: result.model,
    tokensIn: result.usage.tokensIn,
    tokensOut: result.usage.tokensOut,
  });
  return result;
};

/** Per-model usage roll-up. */
export type ModelUsage = {
  provider: string;
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** What these tokens WOULD cost on a metered key (the price book) — honest even at $0 actual. */
  costIfMeteredUsd: number;
};

/** The usage summary surfaced at GET /api/usage (budget meter + per-model / per-kind breakdown). */
export type UsageSummary = {
  /** The cap in USD, or null when unlimited (opt-out). */
  budgetUsd: number | null;
  spentUsd: number;
  /** What the recorded tokens WOULD have cost on metered API keys (price-book estimate). */
  spentIfMeteredUsd: number;
  /** Remaining USD, or null when unlimited. */
  remainingUsd: number | null;
  overBudget: boolean;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  byModel: ModelUsage[];
  byKind: Array<{ kind: string; calls: number; costUsd: number }>;
};

/** Assemble the budget + per-model + per-kind usage summary. */
export const getUsageSummary = async (db: CoachDb): Promise<UsageSummary> => {
  const [totals, byModel, byKind] = await Promise.all([
    db
      .select({
        calls: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
        spent: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)::double precision`,
      })
      .from(llmUsage),
    db
      .select({
        provider: llmUsage.provider,
        model: llmUsage.model,
        calls: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)::double precision`,
      })
      .from(llmUsage)
      .groupBy(llmUsage.provider, llmUsage.model)
      .orderBy(desc(sql`sum(${llmUsage.costUsd})`), desc(sql`sum(${llmUsage.tokensIn} + ${llmUsage.tokensOut})`)),
    db
      .select({
        kind: llmUsage.kind,
        calls: sql<number>`count(*)::int`,
        costUsd: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)::double precision`,
      })
      .from(llmUsage)
      .groupBy(llmUsage.kind)
      .orderBy(desc(sql`sum(${llmUsage.costUsd})`)),
  ]);
  const t = totals[0] ?? { calls: 0, tokensIn: 0, tokensOut: 0, spent: 0 };
  const budget = resolveBudgetUsd();
  const unlimited = !Number.isFinite(budget);
  // Price every model bucket through the price book so "is it cheaper?" is
  // answerable even when the actual spend is $0 (subscription / mock).
  const pricedByModel = byModel.map((m) => ({
    ...m,
    costIfMeteredUsd: estimateCostIfMetered(m.model, m.tokensIn, m.tokensOut),
  }));
  return {
    budgetUsd: unlimited ? null : budget,
    spentUsd: t.spent,
    spentIfMeteredUsd: pricedByModel.reduce((sum, m) => sum + m.costIfMeteredUsd, 0),
    remainingUsd: unlimited ? null : Math.max(0, budget - t.spent),
    overBudget: !unlimited && t.spent >= budget,
    calls: t.calls,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    byModel: pricedByModel,
    byKind,
  };
};

/** Clear the usage ledger (a deliberate "I've reviewed my spend, continue" reset). */
export const resetUsage = async (db: CoachDb): Promise<void> => {
  await db.delete(llmUsage);
};
