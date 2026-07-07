import { useCallback, useEffect, useState } from "react";
import type { FlowItem, RunStatus } from "../api";
import { fetchFlows, runFlows } from "../api";
import { formatNumber, plural, readStat, truncate } from "../format";
import { useRun } from "../useRun";
import { RunBar } from "./RunBar";

/** Human summary of a finished flows run for the RunBar success line. */
const describeFlows = (run: RunStatus): string => {
  const scanned = readStat(run.stats, "tracesScanned");
  if (scanned === 0) return "No traces captured yet — send some traces to Coach first, then run flows.";
  return `Grouped ${plural(scanned, "trace")} into ${plural(readStat(run.stats, "flowCount"), "flow")}.`;
};

/** The flows view (#/flows): recurring flows grouped across traces + the flows runner. */
export const Flows = () => {
  const [items, setItems] = useState<FlowItem[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  /** Reload the flow list from the server. */
  const load = useCallback(async () => {
    try {
      const res = await fetchFlows();
      setItems(res.items);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Refetch the list once a flows run lands. */
  const onDone = useCallback(() => {
    void load();
  }, [load]);

  const run = useRun(runFlows, onDone);

  const runBar = (
    <RunBar label="Run flows" runningLabel="Grouping…" run={run} describeResult={describeFlows} />
  );

  if (status === "loading") {
    return <div className="notice">Loading flows…</div>;
  }
  if (status === "error") {
    return <div className="notice notice-error">Could not reach the local Coach server.</div>;
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <h2 className="empty-title">No flows yet</h2>
        <p className="empty-sub">
          Capture some traces, then run flows to group them into the recurring workflows your agents run.
        </p>
        <div className="empty-actions">{runBar}</div>
      </div>
    );
  }

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Flows</h1>
          <p className="page-sub">The recurring workflows your agents run.</p>
        </div>
        {runBar}
      </div>
      <div className="list-caption">{formatNumber(items.length)} discovered</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Flow</th>
              <th className="col-num">Traces</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className="row"
                onClick={() => {
                  window.location.hash = `#/flow/${encodeURIComponent(item.id)}`;
                }}
              >
                <td>
                  <a className="cell-name cell-link" href={`#/flow/${encodeURIComponent(item.id)}`}>
                    {item.name}
                  </a>
                  {item.description ? <div className="cell-preview">{truncate(item.description, 120)}</div> : null}
                </td>
                <td className="col-num mono">{formatNumber(item.traceCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
