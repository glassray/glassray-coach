import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalDetail as EvalDetailData, FlowSummary, RunStatus } from "../api";
import { deleteEval, fetchEval, fetchFlows, fetchRun, isNotFoundError, runEval, updateEval } from "../api";
import { plural, readStat, relativeTime, truncate } from "../format";
import { useRun } from "../useRun";
import { PassRateTrend } from "./charts";
import { FlowChip } from "./Evals";
import { RunBar } from "./RunBar";

/** A pass/fail verdict pill for one scored trace. */
const VerdictPill = ({ verdict }: { verdict: "pass" | "fail" }) => (
  <span className={`verdict verdict-${verdict}`}>{verdict}</span>
);

/** Human summary of a finished eval run for the RunBar success line. */
const describeEval = (run: RunStatus): string => {
  const scored = readStat(run.stats, "scored");
  if (scored === 0) return "No traces to score yet — send some traces to Coach first, then run this eval.";
  return `Scored ${plural(scored, "trace")} · ${readStat(run.stats, "passed")} passing / ${readStat(run.stats, "failed")} failing.`;
};

/** The eval detail view (#/eval/:id): rule + latest-run rollup + per-trace verdicts, with a re-run control. */
export const EvalDetail = ({ id }: { id: string }) => {
  const [data, setData] = useState<EvalDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [missing, setMissing] = useState(true);
  const [sampleSize, setSampleSize] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  /** The judge model recorded in the latest run's stats, when present. */
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [threshold, setThreshold] = useState("");
  const [patchBusy, setPatchBusy] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  /** The id the currently-displayed data belongs to, so a late response for a prior id is ignored. */
  const shownId = useRef(id);

  /** Reload this eval's detail (+ the latest run's judge model), ignoring a response for a prior id. */
  const load = useCallback(async () => {
    try {
      const res = await fetchEval(id);
      if (shownId.current !== id) return;
      setData(res);
      setThreshold(String(res.autorunThreshold));
      setStatus("ready");
      // The judge model lives in the scoring run's stats, not on the eval row.
      const run = res.latestRunId ? await fetchRun(res.latestRunId).catch(() => null) : null;
      if (shownId.current !== id) return;
      const jm = run?.stats?.judgeModel;
      setJudgeModel(typeof jm === "string" ? jm : null);
    } catch (err) {
      if (shownId.current !== id) return;
      setMissing(isNotFoundError(err));
      setStatus("error");
    }
  }, [id]);

  useEffect(() => {
    shownId.current = id;
    setStatus("loading");
    void load();
  }, [id, load]);

  // The flows list feeds the scope picker + the header chip's name (best-effort).
  useEffect(() => {
    void fetchFlows("all")
      .then((res) => setFlows(res.items))
      .catch(() => setFlows([]));
  }, []);

  /** Serializes PATCHes so an interaction during an in-flight save queues behind it instead of being dropped. */
  const patchChain = useRef<Promise<void>>(Promise.resolve());

  /** PATCH one scope/autorun change (queued behind any in-flight save) and adopt the refreshed detail. */
  const applyPatch = useCallback(
    (patch: { flowId?: string | null; autorun?: boolean; autorunThreshold?: number }): Promise<void> => {
      const run = async () => {
        setPatchBusy(true);
        setPatchError(null);
        try {
          const res = await updateEval(id, patch);
          if (shownId.current !== id) return;
          setData(res);
          setThreshold(String(res.autorunThreshold));
        } catch (err) {
          setPatchError(err instanceof Error ? err.message : "Could not update the eval.");
        } finally {
          setPatchBusy(false);
        }
      };
      patchChain.current = patchChain.current.then(run, run);
      return patchChain.current;
    },
    [id],
  );

  /** Commit the threshold field on blur when it parses to a new positive integer; else snap back. */
  const commitThreshold = useCallback(() => {
    if (!data) return;
    const parsed = Number.parseInt(threshold, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 && parsed !== data.autorunThreshold) {
      void applyPatch({ autorunThreshold: parsed });
    } else {
      setThreshold(String(data.autorunThreshold));
    }
  }, [data, threshold, applyPatch]);

  /** Start an eval run, forwarding the sample size only when it parses to a positive integer. */
  const trigger = useCallback(() => {
    const parsed = Number.parseInt(sampleSize, 10);
    return runEval(id, Number.isInteger(parsed) && parsed > 0 ? parsed : undefined);
  }, [id, sampleSize]);

  const onDone = useCallback(() => {
    void load();
  }, [load]);

  const run = useRun(trigger, onDone);

  /** Delete this eval (after confirmation) and return to the list. */
  const onDelete = useCallback(async () => {
    if (deleting) return;
    if (!window.confirm("Delete this eval and its stored verdicts?")) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteEval(id);
      window.location.hash = "#/evals";
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete this eval.");
      setDeleting(false);
    }
  }, [id, deleting]);

  if (status === "loading") return <div className="notice">Loading eval…</div>;
  if (status === "error" || !data) {
    return (
      <section className="detail">
        <a className="back" href="#/evals">
          ← All evals
        </a>
        <div className="notice notice-error">
          {missing ? "Eval not found." : "Could not reach the local Coach server."}
        </div>
      </section>
    );
  }

  const neverRun = data.scored === 0;

  return (
    <section className="detail">
      <a className="back" href="#/evals">
        ← All evals
      </a>

      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">{data.label}</h1>
          {data.source === "deviation" && data.sourceDeviationId ? (
            <a
              className="eval-source eval-source-deviation eval-source-link"
              href={`#/deviation/${encodeURIComponent(data.sourceDeviationId)}`}
              title="View the deviation this eval was saved from"
            >
              deviation ↗
            </a>
          ) : (
            <span className={`eval-source eval-source-${data.source}`}>{data.source}</span>
          )}
          {data.flowId ? (
            <FlowChip flowId={data.flowId} flowName={flows.find((f) => f.id === data.flowId)?.name} />
          ) : null}
          <span className="muted">{relativeTime(data.createdAt)}</span>
        </div>
        {data.description ? <p className="detail-sub">{data.description}</p> : null}
        <div className="callout">
          <div className="callout-label">Rule</div>
          <div className="callout-body">{data.rule}</div>
        </div>

        <div className="panel card-pad eval-scope">
          <div className="eval-scope-row">
            <div className="new-eval-field">
              <label className="new-eval-label" htmlFor="ed-flow">
                Flow scope
              </label>
              <select
                id="ed-flow"
                className="new-eval-input"
                value={data.flowId ?? ""}
                disabled={patchBusy}
                onChange={(e) => void applyPatch({ flowId: e.target.value || null })}
              >
                <option value="">Global — sample all traces</option>
                {flows
                  .filter((f) => f.status === "active" || f.id === data.flowId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                      {f.status === "archived" ? " (archived)" : ""}
                    </option>
                  ))}
              </select>
            </div>
            <label className="eval-autorun-toggle" htmlFor="ed-autorun" title="Rerun automatically when the flow accrues new member traces">
              <input
                id="ed-autorun"
                type="checkbox"
                checked={data.autorun}
                disabled={patchBusy || !data.flowId}
                onChange={(e) => void applyPatch({ autorun: e.target.checked })}
              />
              Autorun
            </label>
            <div className="new-eval-field">
              <label className="new-eval-label" htmlFor="ed-threshold">
                New members to trigger
              </label>
              <input
                id="ed-threshold"
                className="new-eval-input eval-threshold"
                type="number"
                min={1}
                max={1000}
                value={threshold}
                disabled={patchBusy || !data.flowId}
                onChange={(e) => setThreshold(e.target.value)}
                onBlur={commitThreshold}
              />
            </div>
          </div>
          {!data.flowId ? (
            <p className="muted">Autorun needs a flow scope — bind this eval to a flow to rerun it hands-free.</p>
          ) : null}
          {patchError ? <p className="runbar-error">{patchError}</p> : null}
        </div>
        <div className="eval-actions">
          <RunBar
            label={neverRun ? "Run eval" : "Re-run eval"}
            runningLabel="Scoring…"
            run={run}
            describeResult={describeEval}
          >
            <input
              className="runbar-size"
              type="number"
              min={1}
              max={200}
              placeholder="20"
              title="How many recent traces to score (default 20, max 200)"
              aria-label="Traces to score (default 20, max 200)"
              value={sampleSize}
              disabled={run.running}
              onChange={(event) => setSampleSize(event.target.value)}
            />
          </RunBar>
          <button className="btn btn-danger" type="button" onClick={onDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
        {deleteError ? <p className="runbar-error">{deleteError}</p> : null}
      </header>

      {neverRun ? (
        <div className="notice">Not scored yet — run this eval to check it against your recent traces.</div>
      ) : (
        <>
          <div className="eval-summary">
            <div className="eval-stat">
              <span className="eval-stat-value">{data.passed}</span>
              <span className="eval-stat-label">passing</span>
            </div>
            <div className="eval-stat">
              <span className={`eval-stat-value${data.failed > 0 ? " eval-stat-fail" : ""}`}>{data.failed}</span>
              <span className="eval-stat-label">failing</span>
            </div>
            <div className="eval-stat">
              <span className={`eval-stat-value${data.regressionCount > 0 ? " eval-stat-regress" : ""}`}>
                {data.regressionCount}
              </span>
              <span className="eval-stat-label">regressions</span>
            </div>
            <div className="eval-stat">
              <span className="eval-stat-value">{data.scored}</span>
              <span className="eval-stat-label">scored</span>
            </div>
            {data.lastRunAt ? (
              <span className="eval-summary-when muted">last run {relativeTime(data.lastRunAt)}</span>
            ) : null}
            {judgeModel ? (
              <span className="eval-summary-when muted" title="The model that judged the latest run">
                judge <span className="mono">{judgeModel}</span>
              </span>
            ) : null}
          </div>

          {data.history.length > 1 ? (
            <div className="panel card-pad trend-card">
              <div className="card-head">
                <h2 className="card-title">Pass rate over runs</h2>
                <span className="muted">{data.history.length} runs</span>
              </div>
              <PassRateTrend
                points={data.history.map((h) => ({
                  passed: h.passed,
                  total: h.total,
                  title: `${h.total > 0 ? Math.round((h.passed / h.total) * 100) : 0}% pass (${h.passed}/${h.total})${h.at ? ` · ${relativeTime(h.at)}` : ""}`,
                }))}
              />
            </div>
          ) : null}

          <h2 className="section-title">Verdicts ({data.results.length})</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-verdict">Verdict</th>
                  <th>Trace</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <tr
                    key={r.traceId}
                    className={`row${r.regression ? " row-error" : ""}`}
                    onClick={() => {
                      window.location.hash = `#/trace/${encodeURIComponent(r.traceId)}`;
                    }}
                  >
                    <td className="col-verdict">
                      <VerdictPill verdict={r.verdict} />
                      {r.regression ? <span className="regress-tag" title="Passed in the previous run">▲ new</span> : null}
                    </td>
                    <td>
                      <div className="cell-name">{r.name ?? "Untitled trace"}</div>
                      <span className="cell-preview">
                        {r.agent ? <span className="tag">{r.agent}</span> : null}
                        {r.receivedAt ? <span className="muted"> {relativeTime(r.receivedAt)}</span> : null}
                      </span>
                    </td>
                    <td>
                      <span className="eval-evidence" title={r.evidence}>
                        {truncate(r.evidence, 160)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
};
