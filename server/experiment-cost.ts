/** One unit is the eighth decimal place in the per-token USD price book. */
const UNITS_PER_USD = 100_000_000;

/** Convert a summed dollar price to whole price-book units before comparing totals. */
const units = (usd: number): number => Math.round(usd * UNITS_PER_USD);

/** Candidate minus baseline, after removing summation noise from each side. */
export const experimentCostDelta = (baseline: number, candidate: number): number =>
  (units(candidate) - units(baseline)) / UNITS_PER_USD;

/** Display sub-cent costs at price-book precision and retain the usual format for larger prices. */
export const formatExperimentCost = (usd: number | undefined): string => {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return '$0';
  const amount = units(usd) / UNITS_PER_USD;
  if (amount < 0.01) return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
};
