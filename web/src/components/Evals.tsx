import { useCallback, useEffect, useState } from "react";
import type { Anchor, EvalSummary, FlowSummary } from "../api";
import { createEval, fetchEvals, fetchFlows } from "../api";
import { formatNumber, relativeTime } from "../format";

/**
 * Provenance chip for a rule: the repo path its first code anchor points at
 * (`from watcher/digest.ts`) when it's read from code, else a muted `custom`
 * tag. Every rule is active — this replaces the retired lifecycle.
 */
export const SourceChip = ({ anchors }: { anchors: Anchor[] | null }) => {
  const file = anchors?.[0]?.file ?? null;
  return file ? (
    <span className="source-chip" title={`Derived from ${file} — approve by reviewing glassray.yaml`}>
      from <span className="source-chip-file">{file}</span>
    </span>
  ) : (
    <span className="source-chip source-chip-custom" title="Custom — hand-written, not tied to a file">
      custom
    </span>
  );
};

/** A compact pass/fail proportion bar for one eval's latest run (empty when never run). */
const ResultBar = ({ passed, failed }: { passed: number; failed: number }) => {
  const total = passed + failed;
  if (total === 0) return <span className="muted">—</span>;
  const passPct = Math.round((passed / total) * 100);
  return (
    <div className="eval-bar" title={`${passed} pass · ${failed} fail`}>
      {passPct > 0 ? <div className="eval-bar-pass" style={{ width: `${passPct}%` }} /> : null}
      {passPct < 100 ? <div className="eval-bar-fail" style={{ width: `${100 - passPct}%` }} /> : null}
    </div>
  );
};

/** One-word health badge: regressions (red) → failing (amber) → all-passing (green) → not-run. */
export const HealthBadge = ({ ev }: { ev: EvalSummary }) => {
  if (ev.scored === 0) return <span className="eval-health eval-health-idle">Not run</span>;
  if (ev.regressionCount > 0) {
    const n = ev.regressionCount;
    return <span className="eval-health eval-health-regress">▲ {n} regression{n === 1 ? "" : "s"}</span>;
  }
  if (ev.failed > 0) return <span className="eval-health eval-health-fail">{ev.failed} failing</span>;
  return <span className="eval-health eval-health-pass">All passing</span>;
};

/** Flow-binding chip: links to the flow when bound, or a muted "global" marker. */
export const FlowChip = ({ flowId, flowName }: { flowId: string | null; flowName?: string }) => {
  if (!flowId) return <span className="muted">global</span>;
  return (
    <a
      className="tag tag-link"
      href={`#/flow/${encodeURIComponent(flowId)}`}
      onClick={(e) => e.stopPropagation()}
      title="View the flow this eval samples"
    >
      {flowName ?? "flow"}
    </a>
  );
};

/** Inline "new rule" form — a hand-written (custom) label + rule (+ optional description / flow scope). */
const NewEvalForm = ({ flows, onCreated }: { flows: FlowSummary[]; onCreated: () => void }) => {
  const [label, setLabel] = useState("");
  const [rule, setRule] = useState("");
  const [description, setDescription] = useState("");
  const [flowId, setFlowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Submit the form: create the (custom) eval, reset, and let the parent refresh. */
  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!label.trim() || !rule.trim() || busy) return;
      setBusy(true);
      setError(null);
      try {
        await createEval({
          name: label.trim(),
          text: rule.trim(),
          description: description.trim() || undefined,
          flowId: flowId || undefined,
        });
        setLabel("");
        setRule("");
        setDescription("");
        setFlowId("");
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create eval.");
      } finally {
        setBusy(false);
      }
    },
    [label, rule, description, flowId, busy, onCreated],
  );

  return (
    <form className="panel new-eval" onSubmit={submit}>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="eval-label">
          Name
        </label>
        <input
          id="eval-label"
          className="new-eval-input"
          placeholder="e.g. Always cites its sources"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="eval-rule">
          Rule the agent should follow
        </label>
        <textarea
          id="eval-rule"
          className="new-eval-input new-eval-textarea"
          placeholder="The agent must ground every claim in a retrieved source and never invent facts."
          value={rule}
          onChange={(e) => setRule(e.target.value)}
        />
      </div>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="eval-desc">
          Description <span className="muted">(optional)</span>
        </label>
        <input
          id="eval-desc"
          className="new-eval-input"
          placeholder="Why this matters"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {flows.length > 0 ? (
        <div className="new-eval-field">
          <label className="new-eval-label" htmlFor="eval-flow">
            Flow <span className="muted">(optional — runs sample this flow's members)</span>
          </label>
          <select
            id="eval-flow"
            className="new-eval-input"
            value={flowId}
            onChange={(e) => setFlowId(e.target.value)}
          >
            <option value="">Global — sample all traces</option>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {error ? <p className="runbar-error">{error}</p> : null}
      <div className="new-eval-actions">
        <button className="btn" type="submit" disabled={busy || !label.trim() || !rule.trim()}>
          {busy ? "Creating…" : "Create rule"}
        </button>
      </div>
    </form>
  );
};

/** The evals view (#/evals): every saved rule + its flow binding, latest pass/fail rollup, and regression watch. */
export const Evals = () => {
  const [items, setItems] = useState<EvalSummary[]>([]);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showForm, setShowForm] = useState(false);

  /** Reload the eval list (and, best-effort, the flows for name lookups + the form's picker). */
  const load = useCallback(async () => {
    try {
      const [res, flowsRes] = await Promise.all([
        fetchEvals(),
        fetchFlows("all").catch(() => ({ items: [] as FlowSummary[], unclassified: 0 })),
      ]);
      setItems(res.items);
      setFlows(flowsRes.items);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** After a create, hide the form and refresh the list. */
  const onCreated = useCallback(() => {
    setShowForm(false);
    void load();
  }, [load]);

  if (status === "loading") return <div className="notice">Loading evals…</div>;
  if (status === "error") return <div className="notice notice-error">Could not reach the local Coach server.</div>;

  const newButton = (
    <button className="btn" type="button" onClick={() => setShowForm((v) => !v)}>
      {showForm ? "Close" : "New rule"}
    </button>
  );

  if (items.length === 0 && !showForm) {
    return (
      <div className="empty">
        <h2 className="empty-title">No rules yet</h2>
        <p className="empty-sub">
          Turn a recurring problem into a repeatable check: open a{" "}
          <a className="inline-link" href="#/deviations">
            deviation
          </a>{" "}
          and “Save as rule”, or write one by hand. Every rule autoruns and gates{" "}
          <span className="mono">glassray check</span>.
        </p>
        <div className="empty-actions">{newButton}</div>
      </div>
    );
  }

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Rules</h1>
          <p className="page-sub">
            Assertion rules re-checked against new traces — every rule is active; each is linked to a file or custom.
          </p>
        </div>
        {newButton}
      </div>
      {showForm ? (
        <NewEvalForm flows={flows.filter((f) => f.status === "active")} onCreated={onCreated} />
      ) : null}
      {items.length === 0 ? (
        <div className="notice">No rules yet — create one above.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Source</th>
                <th>Flow</th>
                <th className="col-bar">Latest result</th>
                <th className="col-num">Passing</th>
                <th>Status</th>
                <th className="col-num">Last run</th>
              </tr>
            </thead>
            <tbody>
              {items.map((ev) => (
                <tr
                  key={ev.id}
                  className={`row${ev.regressionCount > 0 ? " row-error" : ""}`}
                  onClick={() => {
                    window.location.hash = `#/eval/${encodeURIComponent(ev.id)}`;
                  }}
                >
                  <td>
                    <a className="cell-name cell-link" href={`#/eval/${encodeURIComponent(ev.id)}`}>
                      {ev.name}
                    </a>
                    <div className="cell-preview">{ev.text}</div>
                  </td>
                  <td>
                    <SourceChip anchors={ev.anchors} />
                  </td>
                  <td>
                    <FlowChip flowId={ev.flowId} flowName={flows.find((f) => f.id === ev.flowId)?.name} />
                    {ev.flowId ? (
                      <div className="cell-preview" title={`Reruns after ${ev.autorunThreshold} new member traces`}>
                        autorun ≥{formatNumber(ev.autorunThreshold)}
                      </div>
                    ) : null}
                  </td>
                  <td className="col-bar">
                    <ResultBar passed={ev.passed} failed={ev.failed} />
                  </td>
                  <td className="col-num mono">
                    {ev.scored > 0 ? `${formatNumber(ev.passed)}/${formatNumber(ev.scored)}` : "—"}
                  </td>
                  <td>
                    <HealthBadge ev={ev} />
                  </td>
                  <td className="col-num muted">{ev.lastRunAt ? relativeTime(ev.lastRunAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
