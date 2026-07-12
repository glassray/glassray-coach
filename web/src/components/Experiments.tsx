import { useEffect, useState } from "react";
import type { CompareRuleResult, FlowSummary, RunStatus } from "../api";
import { fetchFlows, fetchRuns } from "../api";
import { relativeTime } from "../format";
import { DeltaChip, describeRef, parseCompareReport } from "./Compare";

/*
 * EXPERIMENTS (#/experiments) — the record of every change you tried. An
 * experiment is one compare run, read as a question (baseline → candidate),
 * a verdict (did any rule regress?), and the per-rule deltas. The full report
 * lives on the detail page (#/experiment/:id). This is the local half's memory:
 * what held, what regressed, on this machine.
 */

/** A short verdict for a compare run: regressed (any rule down), clean, or its non-terminal status. */
const verdictOf = (run: RunStatus, regressions: number | null): { label: string; cls: string } => {
  if (run.status === "running" || run.status === "queued") return { label: run.status, cls: "verdict" };
  if (run.status === "error") return { label: "error", cls: "verdict verdict-fail" };
  if (regressions === null) return { label: "no report", cls: "verdict" };
  return regressions > 0
    ? { label: `${regressions} regressed`, cls: "verdict verdict-fail" }
    : { label: "clean", cls: "verdict verdict-pass" };
};

/** One experiment card: title, verdict, per-rule delta chips, and when it ran. */
const ExperimentCard = ({ run, flows }: { run: RunStatus; flows: FlowSummary[] }) => {
  const report = parseCompareReport(run);
  const title = report
    ? `${describeRef(report.baseline.ref, flows)} → ${describeRef(report.candidate.ref, flows)}`
    : "Comparison";
  const verdict = verdictOf(run, report ? report.regressions : null);
  return (
    <a className="exp-card" href={`#/experiment/${encodeURIComponent(run.id)}`}>
      <div className="exp-card-head">
        <span className="exp-card-title">{title}</span>
        <span className={verdict.cls}>{verdict.label}</span>
        <span className="muted exp-card-when">{relativeTime(run.finishedAt ?? run.startedAt)}</span>
      </div>
      {report && (
        <div className="exp-chips">
          {report.rules.map((r: CompareRuleResult) => (
            <span key={r.id} className="exp-chip">
              <span className="exp-chip-name">{r.label}</span>
              <DeltaChip delta={r.deltaPassRate} />
            </span>
          ))}
        </div>
      )}
    </a>
  );
};

/** The Experiments list: every compare run as an experiment, newest-first. */
export const Experiments = () => {
  const [runs, setRuns] = useState<RunStatus[] | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);

  useEffect(() => {
    void fetchRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
    void fetchFlows()
      .then((r) => setFlows(r.items))
      .catch(() => {});
  }, []);

  const experiments = (runs ?? []).filter((r) => r.kind === "compare");

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Experiments</h1>
          <p className="muted">Every change you tried — what held and what regressed, on this machine.</p>
        </div>
        <a className="btn" href="#/compare">
          New experiment
        </a>
      </div>
      {runs === null ? (
        <p className="muted">Loading…</p>
      ) : experiments.length === 0 ? (
        <p className="empty">No experiments yet — run a comparison to test a change against your rules.</p>
      ) : (
        <div className="exp-list">
          {experiments.map((run) => (
            <ExperimentCard key={run.id} run={run} flows={flows} />
          ))}
        </div>
      )}
    </>
  );
};
