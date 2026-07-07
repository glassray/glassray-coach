import { useCallback, useEffect, useState } from "react";
import type { EvalSummary } from "../api";
import { createEval, fetchEvals } from "../api";
import { formatNumber, relativeTime } from "../format";

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

/** Inline "new eval" form — a hand-written label + rule (+ optional description). */
const NewEvalForm = ({ onCreated }: { onCreated: () => void }) => {
  const [label, setLabel] = useState("");
  const [rule, setRule] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Submit the form: create the eval, reset, and let the parent refresh. */
  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!label.trim() || !rule.trim() || busy) return;
      setBusy(true);
      setError(null);
      try {
        await createEval({
          label: label.trim(),
          rule: rule.trim(),
          description: description.trim() || undefined,
        });
        setLabel("");
        setRule("");
        setDescription("");
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create eval.");
      } finally {
        setBusy(false);
      }
    },
    [label, rule, description, busy, onCreated],
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
      {error ? <p className="runbar-error">{error}</p> : null}
      <div className="new-eval-actions">
        <button className="btn" type="submit" disabled={busy || !label.trim() || !rule.trim()}>
          {busy ? "Creating…" : "Create eval"}
        </button>
      </div>
    </form>
  );
};

/** The evals view (#/evals): every saved rule + its latest pass/fail rollup and regression watch. */
export const Evals = () => {
  const [items, setItems] = useState<EvalSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showForm, setShowForm] = useState(false);

  /** Reload the eval list from the server. */
  const load = useCallback(async () => {
    try {
      const res = await fetchEvals();
      setItems(res.items);
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
      {showForm ? "Close" : "New eval"}
    </button>
  );

  if (items.length === 0 && !showForm) {
    return (
      <div className="empty">
        <h2 className="empty-title">No evals yet</h2>
        <p className="empty-sub">
          Turn a recurring problem into a repeatable check: open a{" "}
          <a className="inline-link" href="#/deviations">
            deviation
          </a>{" "}
          and “Save as eval”, or write a rule by hand.
        </p>
        <div className="empty-actions">{newButton}</div>
      </div>
    );
  }

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Evals</h1>
          <p className="page-sub">Rules you re-check against new traces — watch for regressions over time.</p>
        </div>
        {newButton}
      </div>
      {showForm ? <NewEvalForm onCreated={onCreated} /> : null}
      {items.length === 0 ? (
        <div className="notice">No evals yet — create one above.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Eval</th>
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
                      {ev.label}
                    </a>
                    <div className="cell-preview">{ev.rule}</div>
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
