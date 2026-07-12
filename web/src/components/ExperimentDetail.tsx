import { useEffect, useState } from "react";
import type { FlowSummary, RunStatus } from "../api";
import { fetchFlows, fetchRun, isNotFoundError } from "../api";
import { relativeTime } from "../format";
import { CompareReportView, describeRef, parseCompareReport } from "./Compare";

/*
 * EXPERIMENT DETAIL (#/experiment/:id) — one experiment's report: the compare
 * table (per-rule pass-rate deltas + regressions) and the two corpora with
 * their cost-if-metered. Reached by clicking an experiment; never embedded in
 * a flow. Reuses CompareReportView so the report and a live compare render
 * identically.
 */
export const ExperimentDetail = ({ id }: { id: string }) => {
  const [run, setRun] = useState<RunStatus | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setRun(null);
    setMissing(false);
    void fetchRun(id)
      .then(setRun)
      .catch((err) => {
        if (isNotFoundError(err)) setMissing(true);
      });
    void fetchFlows()
      .then((r) => setFlows(r.items))
      .catch(() => {});
  }, [id]);

  if (missing) return <p className="empty">Experiment not found.</p>;
  if (!run) return <p className="muted">Loading…</p>;

  const report = parseCompareReport(run);
  const title = report
    ? `${describeRef(report.baseline.ref, flows)} → ${describeRef(report.candidate.ref, flows)}`
    : "Experiment";
  const subtitle =
    run.status === "done" && report
      ? report.regressions > 0
        ? `${report.regressions} rule${report.regressions === 1 ? "" : "s"} regressed`
        : "no regressions"
      : run.status;

  return (
    <>
      <div className="page-head">
        <div>
          <a className="cell-link muted" href="#/experiments">
            ← Experiments
          </a>
          <h1 className="page-title">{title}</h1>
          <p className="muted">
            {subtitle} · {relativeTime(run.finishedAt ?? run.startedAt)}
          </p>
        </div>
      </div>
      {report ? (
        <CompareReportView report={report} flows={flows} />
      ) : (
        <p className="empty">This run produced no report ({run.status}).</p>
      )}
    </>
  );
};
