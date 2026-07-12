import { useCallback, useEffect, useState } from "react";
import type { CompareReport, CorpusRef, FlowSummary, RunStatus, StatsResponse } from "../api";
import { fetchFlows, fetchLastCompare, fetchStats, runCompare } from "../api";
import { formatDuration, formatNumber, relativeTime } from "../format";
import { useRun } from "../useRun";
import { RunBar } from "./RunBar";

/*
 * COMPARE (#/compare) — the change-with-confidence screen. Pick two corpora
 * (an agent tag or a flow's members per side), run every watched rule over
 * both, and read per-rule pass-rate deltas + the cost/latency diff. The
 * canonical use: baseline = the old model's agent tag, candidate = the new
 * one's — "did quality hold, and is it cheaper?".
 */

/** A corpus side of the form: which kind of corpus and its value. */
interface CorpusDraft {
  kind: "agent" | "flow";
  value: string;
}

/** Build the API corpusRef from a form side; null while incomplete. */
const toRef = (draft: CorpusDraft): CorpusRef | null => {
  if (!draft.value) return null;
  return draft.kind === "agent" ? { agent: draft.value } : { flowId: draft.value };
};

/** Read a finished compare run's stats blob as the typed report (null when absent/malformed). */
export const parseCompareReport = (run: RunStatus | null): CompareReport | null => {
  const stats = run?.stats;
  if (!stats || !Array.isArray((stats as { rules?: unknown }).rules)) return null;
  return stats as unknown as CompareReport;
};

/** Compact USD (compare sides are usually cents). Defensive: reports stored by older versions may lack a field. */
const money = (usd: number | undefined): string => {
  const v = typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
  return v <= 0 ? "$0" : v < 0.01 ? "<$0.01" : `$${v.toFixed(v < 1 ? 4 : 2)}`;
};

/** Percent from a 0..1 rate, or an em-dash. */
const pct = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/** Signed percentage-point delta chip for one rule. */
export const DeltaChip = ({ delta }: { delta: number | null }) => {
  if (delta === null) return <span className="muted">—</span>;
  const pts = Math.round(delta * 100);
  const cls = pts < 0 ? "delta-chip delta-down" : pts > 0 ? "delta-chip delta-up" : "delta-chip delta-flat";
  return <span className={cls}>{pts > 0 ? `+${pts}` : pts} pts</span>;
};

/** Human name for a corpus ref. */
export const describeRef = (ref: CorpusRef, flows: FlowSummary[]): string => {
  if ("label" in ref) return `label ${ref.label}`;
  if ("agent" in ref) return `agent ${ref.agent}`;
  if ("flowId" in ref) return `flow ${flows.find((f) => f.id === ref.flowId)?.name ?? ref.flowId}`;
  return `${ref.traceIds.length} pinned traces (fixtures)`;
};

/** The full report: per-rule pass rates + the two sides' cost/latency facts. */
export const CompareReportView = ({ report, flows }: { report: CompareReport; flows: FlowSummary[] }) => (
  <>
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Rule</th>
            <th className="col-num">Baseline</th>
            <th className="col-num">Candidate</th>
            <th className="col-num">Δ pass rate</th>
          </tr>
        </thead>
        <tbody>
          {report.rules.map((r) => (
            <tr key={r.id} className={`row${r.regressed ? " row-error" : ""}`}>
              <td>
                <a className="cell-name cell-link" href={`#/eval/${encodeURIComponent(r.id)}`}>
                  {r.name}
                </a>
              </td>
              <td className="col-num mono">
                {r.baseline.passed}/{r.baseline.scored} ({pct(r.baseline.passRate)})
              </td>
              <td className="col-num mono">
                {r.candidate.passed}/{r.candidate.scored} ({pct(r.candidate.passRate)})
              </td>
              <td className="col-num">
                <DeltaChip delta={r.deltaPassRate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="overview-cols">
      {(["baseline", "candidate"] as const).map((side) => {
        const s = report[side];
        return (
          <div key={side} className="panel card-pad">
            <div className="card-head">
              <h2 className="card-title">{side === "baseline" ? "Baseline" : "Candidate"}</h2>
              <span className="muted">{describeRef(s.ref, flows)}</span>
            </div>
            <div className="kpi-row">
              <div className="kpi">
                <span className="kpi-value mono">{formatNumber(s.traces)}</span>
                <span className="kpi-label">traces</span>
              </div>
              <div className="kpi">
                <span className="kpi-value mono">
                  {formatNumber(s.tokensIn)}→{formatNumber(s.tokensOut)}
                </span>
                <span className="kpi-label">tokens</span>
              </div>
              <div
                className="kpi"
                title="price-book estimate by each trace's primary model — honest even when the corpus ran on a free provider"
              >
                <span className="kpi-value mono">{money(s.estCostIfMeteredUsd)}</span>
                <span className="kpi-label">cost if metered</span>
              </div>
              <div className="kpi">
                <span className="kpi-value mono">{formatDuration(s.avgDurationMs)}</span>
                <span className="kpi-label">avg latency</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </>
);

/** One corpus side of the form (baseline or candidate). */
const CorpusPicker = ({
  side,
  draft,
  onChange,
  agents,
  flows,
  disabled,
}: {
  side: string;
  draft: CorpusDraft;
  onChange: (draft: CorpusDraft) => void;
  agents: string[];
  flows: FlowSummary[];
  disabled: boolean;
}) => (
  <div className="new-eval-field">
    <label className="new-eval-label" htmlFor={`cmp-${side}-value`}>
      {side}
    </label>
    <div className="runbar-row">
      <select
        id={`cmp-${side}-kind`}
        className="new-eval-input compare-kind"
        value={draft.kind}
        disabled={disabled}
        aria-label={`${side} corpus kind`}
        onChange={(e) => onChange({ kind: e.target.value as CorpusDraft["kind"], value: "" })}
      >
        <option value="agent">agent</option>
        <option value="flow">flow</option>
      </select>
      <select
        id={`cmp-${side}-value`}
        className="new-eval-input"
        value={draft.value}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, value: e.target.value })}
      >
        <option value="">{draft.kind === "agent" ? "Pick an agent…" : "Pick a flow…"}</option>
        {draft.kind === "agent"
          ? agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))
          : flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
      </select>
    </div>
  </div>
);

/** The compare view: the two-corpus form, the run control, and the latest report. */
export const Compare = () => {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [flowId, setFlowId] = useState("");
  const [baseline, setBaseline] = useState<CorpusDraft>({ kind: "agent", value: "" });
  const [candidate, setCandidate] = useState<CorpusDraft>({ kind: "agent", value: "" });
  const [report, setReport] = useState<{ report: CompareReport; at: string | null } | null>(null);

  // Pickers + the most recent finished compare (so the screen is useful on arrival).
  useEffect(() => {
    void fetchFlows("all")
      .then((res) => setFlows(res.items))
      .catch(() => setFlows([]));
    void fetchStats()
      .then((res: StatsResponse) => setAgents(res.agents))
      .catch(() => setAgents([]));
    void fetchLastCompare()
      .then((run) => {
        const parsed = parseCompareReport(run);
        if (parsed) setReport({ report: parsed, at: run?.finishedAt ?? null });
      })
      .catch(() => {});
  }, []);

  const trigger = useCallback(() => {
    const b = toRef(baseline);
    const c = toRef(candidate);
    if (!b || !c) return Promise.reject(new Error("Pick both corpora first."));
    return runCompare({ baseline: b, candidate: c, ...(flowId ? { flowId } : {}) });
  }, [baseline, candidate, flowId]);

  const onDone = useCallback((run: RunStatus) => {
    const parsed = parseCompareReport(run);
    if (parsed) setReport({ report: parsed, at: run.finishedAt });
  }, []);

  const run = useRun(trigger, onDone);
  const ready = toRef(baseline) !== null && toRef(candidate) !== null;

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Compare</h1>
          <p className="page-sub">
            Run the watched rule suite over two corpora — did quality hold, and is it cheaper?
          </p>
        </div>
      </div>

      <div className="panel new-eval">
        <div className="compare-form-row">
          <CorpusPicker side="Baseline" draft={baseline} onChange={setBaseline} agents={agents} flows={flows} disabled={run.running} />
          <CorpusPicker side="Candidate" draft={candidate} onChange={setCandidate} agents={agents} flows={flows} disabled={run.running} />
          <div className="new-eval-field">
            <label className="new-eval-label" htmlFor="cmp-flow">
              Rule suite <span className="muted">(optional — one flow's watched rules)</span>
            </label>
            <select
              id="cmp-flow"
              className="new-eval-input"
              value={flowId}
              disabled={run.running}
              onChange={(e) => setFlowId(e.target.value)}
            >
              <option value="">All watched rules</option>
              {flows
                .filter((f) => f.status === "active")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        {ready ? null : <p className="muted">Pick a baseline and a candidate corpus (e.g. the old and new model's agent tags).</p>}
        <RunBar label="Run compare" runningLabel="Scoring…" run={run} describeResult={() => "Compare finished."} />
      </div>

      {report ? (
        <>
          <div className="section-head">
            <h2 className="section-title">
              Result{report.report.regressions > 0 ? ` — ${report.report.regressions} rule(s) regressed` : " — no regressions"}
            </h2>
            {report.at ? <span className="muted">{relativeTime(report.at)}</span> : null}
          </div>
          <CompareReportView report={report.report} flows={flows} />
        </>
      ) : (
        <div className="notice">
          No compare yet. The CLI equivalent:{" "}
          <span className="mono">glassray compare agent:&lt;old&gt; agent:&lt;new&gt;</span>
        </div>
      )}
    </section>
  );
};
