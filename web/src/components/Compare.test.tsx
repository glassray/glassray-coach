import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CompareCorpusStats, CompareReport } from "../api";
import { CompareReportView } from "./Compare";

const side = (cost: number): CompareCorpusStats => ({
  ref: { label: "test" },
  traces: 1,
  tokensIn: 1,
  tokensOut: 1,
  estCostUsd: cost,
  estCostIfMeteredUsd: cost,
  avgDurationMs: 1,
});

it.each([
  [0.00000012, 0.00000013, "$0.00000012", "$0.00000013"],
  [0, 0.01, "$0", "$0.0100"],
  [0.25, 1.234, "$0.2500", "$1.23"],
] as const)("renders baseline %s and candidate %s as comparable prices", (a, b, baseline, candidate) => {
  const report: CompareReport = {
    baseline: side(a), candidate: side(b), rules: [], regressions: 0,
    flowId: null, sampleSize: 1, costIfMeteredDeltaUsd: b - a,
  };
  const html = renderToStaticMarkup(<CompareReportView report={report} flows={[]} />);
  const prices = Array.from(html.matchAll(/>([^<>]+)<\/span><span class="kpi-label">cost if metered/g));
  expect(prices.map((match) => match[1])).toEqual([baseline, candidate]);
});
