import { useCallback, useEffect, useState } from "react";
import type { Experiment, FlowSummary } from "../api";
import { fetchExperiment, fetchFlows, fetchRun, isNotFoundError, runExperimentReport } from "../api";
import { relativeTime } from "../format";
import { CompareReportView } from "./Compare";
import { VerdictBadge } from "./Experiments";

/*
 * EXPERIMENT DETAIL (#/experiment/:id) — one experiment's report: the question,
 * the verdict, the compare table (per-rule pass-rate deltas + cost-if-metered),
 * and the generated prose + failing examples. Reuses CompareReportView so the
 * report renders identically to a live compare. A never-run experiment can be
 * concluded from here.
 */

/** Percent from a 0..1 rate, or an em-dash. */
const pct = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

export const ExperimentDetail = ({ id }: { id: string }) => {
  const [exp, setExp] = useState<Experiment | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Reload the experiment (with its embedded report). */
  const load = useCallback(async () => {
    try {
      setExp(await fetchExperiment(id));
    } catch (err) {
      if (isNotFoundError(err)) setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    setExp(null);
    setMissing(false);
    void load();
    void fetchFlows("all")
      .then((r) => setFlows(r.items))
      .catch(() => {});
  }, [id, load]);

  /** (Re)generate the report: run the compare over the two newest labels, poll to done, refresh. */
  const generate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const handle = await runExperimentReport(id);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const run = await fetchRun(handle.runId);
        if (run.status === "done") break;
        if (run.status === "error") throw new Error(run.error ?? "The compare failed.");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the report.");
    } finally {
      setBusy(false);
    }
  }, [id, busy, load]);

  if (missing) return <p className="empty">Experiment not found.</p>;
  if (!exp) return <p className="muted">Loading…</p>;

  const report = exp.report;
  const flowName = exp.flowId ? (flows.find((f) => f.id === exp.flowId)?.name ?? "flow") : null;

  return (
    <>
      <div className="page-head">
        <div>
          <a className="cell-link muted" href="#/experiments">
            ← Experiments
          </a>
          <h1 className="page-title">{exp.question}</h1>
          <p className="muted exp-detail-meta">
            <VerdictBadge exp={exp} />
            {flowName ? <span className="tag">{flowName}</span> : <span className="muted">global rules</span>}
            {exp.baselineLabel && exp.candidateLabel ? (
              <span className="mono muted">
                {exp.baselineLabel} → {exp.candidateLabel}
              </span>
            ) : null}
            <span>{relativeTime(exp.concludedAt ?? exp.createdAt)}</span>
          </p>
        </div>
        <button className="btn" type="button" onClick={() => void generate()} disabled={busy}>
          {busy ? "Running…" : report ? "Re-run report" : "Run report"}
        </button>
      </div>

      {error ? <p className="runbar-error">{error}</p> : null}

      {report ? (
        <>
          <div className="callout">
            <div className="callout-label">Report</div>
            <div className="callout-body">{report.summary}</div>
          </div>

          <CompareReportView report={report.compare} flows={flows} />

          {report.failing.length > 0 ? (
            <>
              <h2 className="section-title">Regressed rules ({report.failing.length})</h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th className="col-num">Baseline</th>
                      <th className="col-num">Candidate</th>
                      <th className="col-num">Candidate fails</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.failing.map((f) => (
                      <tr key={f.ruleId} className="row row-error">
                        <td>
                          <a className="cell-name cell-link" href={`#/eval/${encodeURIComponent(f.ruleId)}`}>
                            {f.ruleLabel}
                          </a>
                        </td>
                        <td className="col-num mono">{pct(f.baselinePassRate)}</td>
                        <td className="col-num mono">{pct(f.candidatePassRate)}</td>
                        <td className="col-num mono">
                          {f.candidateFailed}/{f.candidateScored}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <p className="empty">
          No report yet — run it to compare the two newest run labels over this experiment's rules.
        </p>
      )}
    </>
  );
};
