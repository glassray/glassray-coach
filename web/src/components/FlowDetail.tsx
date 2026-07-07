import { useEffect, useState } from "react";
import type { FlowDetail as FlowDetailData } from "../api";
import { fetchFlow, isNotFoundError } from "../api";
import { formatNumber, truncate } from "../format";

/** The flow detail view (#/flow/:id): flow header + the member traces table. */
export const FlowDetail = ({ id }: { id: string }) => {
  const [data, setData] = useState<FlowDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [missing, setMissing] = useState(true);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    fetchFlow(id)
      .then((res) => {
        if (!active) return;
        setData(res);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!active) return;
        setMissing(isNotFoundError(err));
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (status === "loading") return <div className="notice">Loading flow…</div>;
  if (status === "error" || !data) {
    return (
      <section className="detail">
        <a className="back" href="#/flows">
          ← All flows
        </a>
        <div className="notice notice-error">
          {missing ? "Flow not found — it may have been removed or re-grouped." : "Could not reach the local Coach server."}
        </div>
      </section>
    );
  }

  const { flow, traces } = data;

  return (
    <section className="detail">
      <a className="back" href="#/flows">
        ← All flows
      </a>

      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">{flow.name}</h1>
          <span className="tag">
            {formatNumber(flow.traceCount)} {flow.traceCount === 1 ? "trace" : "traces"}
          </span>
        </div>
        {flow.description ? <p className="detail-sub">{flow.description}</p> : null}
      </header>

      <h2 className="section-title">Member traces</h2>
      {traces.length === 0 ? (
        <div className="notice">No traces recorded for this flow.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Agent</th>
                <th>Trace</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((trace) => (
                <tr
                  key={trace.traceId}
                  className="row"
                  onClick={() => {
                    window.location.hash = `#/trace/${encodeURIComponent(trace.traceId)}`;
                  }}
                >
                  <td>
                    <div className="cell-name">{trace.name ?? "Untitled trace"}</div>
                  </td>
                  <td>{trace.agent ? <span className="tag">{trace.agent}</span> : <span className="muted">—</span>}</td>
                  <td className="mono muted">{truncate(trace.traceId, 22)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
