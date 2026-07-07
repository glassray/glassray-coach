import { useCallback, useEffect, useState } from "react";
import type { DeviationItem, RunStatus, Severity } from "../api";
import { fetchDeviations, runDiscovery } from "../api";
import { formatNumber, plural, readStat, relativeTime, truncate } from "../format";
import { useRun } from "../useRun";
import { SeverityBar, type SeverityCounts } from "./charts";
import { RunBar } from "./RunBar";

/** Human summary of a finished discovery run for the RunBar success line. */
const describeDiscovery = (run: RunStatus): string => {
  const scanned = readStat(run.stats, "tracesScanned");
  if (scanned === 0) return "No traces captured yet — send some traces to Coach first, then run discovery.";
  const found = readStat(run.stats, "deviationCount");
  // 0 found is a real, honest outcome — say why, rather than looking like nothing happened.
  if (found === 0)
    return `Scanned ${plural(scanned, "trace")} · no recurring deviations found — either your agent's behaving, or capture more (or rougher) traces and re-run.`;
  return `Scanned ${plural(scanned, "trace")} · found ${plural(found, "deviation type")}.`;
};

/** Colored chip conveying deviation severity (critical=red, major=amber, minor=slate). */
export const SeverityChip = ({ severity }: { severity: Severity }) => (
  <span className={`sev sev-${severity}`}>{severity}</span>
);

/** Tally deviation TYPES by severity for the distribution bar. */
const tallySeverity = (items: DeviationItem[]): SeverityCounts =>
  items.reduce<SeverityCounts>(
    (acc, d) => {
      acc[d.severity] += 1;
      return acc;
    },
    { critical: 0, major: 0, minor: 0 },
  );

/** The deviations view (#/deviations): recurring deviation types + the discovery runner. */
export const Deviations = () => {
  const [items, setItems] = useState<DeviationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sampleSize, setSampleSize] = useState("");

  /** Reload the deviation list from the server. */
  const load = useCallback(async () => {
    try {
      const res = await fetchDeviations();
      setItems(res.items);
      setTotal(res.total);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Start a discovery run, forwarding the sample size only when it parses to a positive integer. */
  const trigger = useCallback(() => {
    const parsed = Number.parseInt(sampleSize, 10);
    return runDiscovery(Number.isInteger(parsed) && parsed > 0 ? parsed : undefined);
  }, [sampleSize]);

  /** Refetch the list once a discovery run lands. */
  const onDone = useCallback(() => {
    void load();
  }, [load]);

  const run = useRun(trigger, onDone);

  const runBar = (
    <RunBar
      label="Run discovery"
      runningLabel="Discovering…"
      run={run}
      describeResult={describeDiscovery}
    >
      <input
        className="runbar-size"
        type="number"
        min={1}
        max={200}
        placeholder="20"
        title="How many recent traces to sample (default 20, max 200)"
        aria-label="Traces to sample (default 20, max 200)"
        value={sampleSize}
        disabled={run.running}
        onChange={(event) => setSampleSize(event.target.value)}
      />
    </RunBar>
  );

  if (status === "loading") {
    return <div className="notice">Loading deviations…</div>;
  }
  if (status === "error") {
    return <div className="notice notice-error">Could not reach the local Coach server.</div>;
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <h2 className="empty-title">No deviations yet</h2>
        <p className="empty-sub">
          Capture some traces, then run discovery to surface the recurring ways your agents stray.
        </p>
        <div className="empty-actions">{runBar}</div>
      </div>
    );
  }

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Deviations</h1>
          <p className="page-sub">Recurring ways your agents stray from intended behaviour.</p>
        </div>
        {runBar}
      </div>
      <div className="list-caption">{formatNumber(total)} discovered</div>
      <div className="panel card-pad sev-card">
        <SeverityBar counts={tallySeverity(items)} />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="col-sev">Severity</th>
              <th>Deviation</th>
              <th className="col-num">Examples</th>
              <th className="col-num">Found</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="row"
                onClick={() => {
                  window.location.hash = `#/deviation/${encodeURIComponent(item.id)}`;
                }}
              >
                <td className="col-sev">
                  <SeverityChip severity={item.severity} />
                </td>
                <td>
                  <a className="cell-name cell-link" href={`#/deviation/${encodeURIComponent(item.id)}`}>
                    {item.label}
                  </a>
                  {item.description ? <div className="cell-preview">{truncate(item.description, 110)}</div> : null}
                </td>
                <td className="col-num mono">{formatNumber(item.exampleCount)}</td>
                <td className="col-num muted">{relativeTime(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
