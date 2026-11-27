import { describe, expect, it } from 'vitest';
import { formatExperimentCost, experimentCostDelta } from './experiment-cost.js';
import { buildExperimentReport, displayReport } from './experiments.js';

/** A minimal compare report with the given per-side costs and no rules. */
const compareOf = (baseline: number, candidate: number) => ({
  rules: [],
  baseline: { estCostIfMeteredUsd: baseline },
  candidate: { estCostIfMeteredUsd: candidate },
  costIfMeteredDeltaUsd: candidate - baseline,
  regressions: 0,
});

describe('formatExperimentCost', () => {
  it.each([
    [undefined, '$0'],
    [0, '$0'],
    [Number.NaN, '$0'],
    [0.00000012, '$0.00000012'],
    // Cancellation residue in a delta stays hidden.
    [0.003703 - 0.003702, '$0.000001'],
    [0.0099999, '$0.0099999'],
    [0.00450015, '$0.00450015'],
    [0.25, '$0.2500'],
    [1.234, '$1.23'],
  ])('formats %s as %s', (usd, expected) => {
    expect(formatExperimentCost(usd)).toBe(expected);
  });
});

describe('experimentCostDelta', () => {
  it('snaps float residue to zero and keeps real differences', () => {
    expect(experimentCostDelta(15000, 15000 + 1.8189894035458565e-12)).toBe(0);
    expect(experimentCostDelta(0.0045, 0.00450015)).toBe(0.00000015);
  });
});

describe('buildExperimentReport cost phrase', () => {
  it('names sub-cent prices instead of a placeholder', () => {
    const { summary } = buildExperimentReport(compareOf(0.00000013, 0.00000012));
    expect(summary).toContain('Cost down $0.00000001 ($0.00000013 → $0.00000012)');
    expect(summary).not.toContain('<$0.01');
  });

  it('reads float residue between equal costs as unchanged', () => {
    const report = buildExperimentReport({ ...compareOf(0.0037, 0.0037), costIfMeteredDeltaUsd: -2.7755575615628914e-17 });
    expect(report.summary).toContain('Cost unchanged ($0.0037)');
    expect(report.costDeltaUsd).toBe(0);
  });
});

it('refreshes a historical cost without rebuilding the regressed rule name', () => {
  const report = buildExperimentReport(compareOf(0.0037, 0.0037));
  const historic = { ...report, costDeltaUsd: -5e-17, summary: '1 regressed (Cites sources). Cost down <$0.01.' };
  expect(displayReport(historic)).toMatchObject({
    summary: '1 regressed (Cites sources). Cost unchanged ($0.0037).', costDeltaUsd: 0,
  });
});
