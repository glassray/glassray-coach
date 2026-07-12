import { useCallback, useEffect, useState } from "react";
import type { Experiment, FlowSummary } from "../api";
import { createExperiment, fetchExperiments, fetchFlows, fetchRun, runExperimentReport } from "../api";
import { relativeTime } from "../format";
import { DeltaChip } from "./Compare";

/*
 * EXPERIMENTS (#/experiments) — the record of every change you tried. An
 * experiment is a durable object: a question, a baseline vs candidate compare,
 * and a generated report + verdict. This list shows the cards; the full report
 * lives on the detail page (#/experiment/:id).
 */

/** A data-only outcome chip: how many rules regressed (or the run status). No go/no-go call — the data, you decide. */
export const OutcomeChip = ({ exp }: { exp: Experiment }) => {
  if (exp.status !== "concluded" || !exp.report) {
    const label = exp.status === "running" ? "running…" : exp.status === "open" ? "open" : "no report";
    return <span className="verdict-badge verdict-badge-open">{label}</span>;
  }
  const n = exp.report.regressions;
  const cls = n > 0 ? "verdict-badge-nogo" : "verdict-badge-go";
  return <span className={`verdict-badge ${cls}`}>{n > 0 ? `${n} regressed` : "no regressions"}</span>;
};

/** Compact USD for the cost-delta chip. */
const money = (usd: number): string => {
  const v = Number.isFinite(usd) ? usd : 0;
  const abs = Math.abs(v);
  const s = abs < 0.01 ? "<$0.01" : `$${abs.toFixed(abs < 1 ? 4 : 2)}`;
  return v < 0 ? `−${s}` : v > 0 ? `+${s}` : "$0";
};

/** One experiment card: question, outcome, flow tag, per-rule delta chips, cost delta. */
const ExperimentCard = ({ exp, flows }: { exp: Experiment; flows: FlowSummary[] }) => {
  const flowName = exp.flowId ? (flows.find((f) => f.id === exp.flowId)?.name ?? "flow") : null;
  const report = exp.report;
  const accent = report ? (report.regressions > 0 ? "nogo" : "go") : "open";
  return (
    <a className={`exp-card exp-card-${accent}`} href={`#/experiment/${encodeURIComponent(exp.id)}`}>
      <div className="exp-card-head">
        <span className="exp-card-title">{exp.question}</span>
        <OutcomeChip exp={exp} />
        <span className="muted exp-card-when">{relativeTime(exp.concludedAt ?? exp.createdAt)}</span>
      </div>
      <div className="exp-card-meta">
        {flowName ? <span className="tag">{flowName}</span> : <span className="muted">global rules</span>}
        {report ? (
          <span className="mono muted" title="candidate − baseline cost if metered">
            cost {money(report.costDeltaUsd)}
          </span>
        ) : null}
      </div>
      {report ? (
        <div className="exp-chips">
          {report.compare.rules.map((r) => (
            <span key={r.id} className="exp-chip">
              <span className="exp-chip-name">{r.name}</span>
              <DeltaChip delta={r.deltaPassRate} />
            </span>
          ))}
        </div>
      ) : null}
    </a>
  );
};

/** The "new experiment" form: pick a flow + a question + the two run labels, then run the report. */
const NewExperimentForm = ({
  flows,
  onCreated,
}: {
  flows: FlowSummary[];
  onCreated: (id: string) => void;
}) => {
  const [question, setQuestion] = useState("");
  const [flowId, setFlowId] = useState("");
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Create the experiment, run its report (compare), poll to done, then hand the id back. */
  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!question.trim() || busy) return;
      setBusy(true);
      setError(null);
      try {
        const { id } = await createExperiment({
          question: question.trim(),
          flowId: flowId || null,
        });
        const handle = await runExperimentReport(id, {
          baseline: baseline.trim() || undefined,
          candidate: candidate.trim() || undefined,
        });
        // Poll the compare run to a terminal state so the card lands concluded.
        for (;;) {
          await new Promise((r) => setTimeout(r, 1200));
          const run = await fetchRun(handle.runId);
          if (run.status === "done") break;
          if (run.status === "error") throw new Error(run.error ?? "The compare failed.");
        }
        onCreated(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not run the experiment.");
      } finally {
        setBusy(false);
      }
    },
    [question, flowId, baseline, candidate, busy, onCreated],
  );

  return (
    <form className="panel new-eval" onSubmit={submit}>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="exp-question">
          Question
        </label>
        <input
          id="exp-question"
          className="new-eval-input"
          placeholder="Can we switch the digest from Sonnet to Haiku?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </div>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="exp-flow">
          Rule suite <span className="muted">(optional — one flow's rules; else all global rules)</span>
        </label>
        <select id="exp-flow" className="new-eval-input" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
          <option value="">All global rules</option>
          {flows
            .filter((f) => f.status === "active")
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </div>
      <div className="compare-form-row">
        <div className="new-eval-field">
          <label className="new-eval-label" htmlFor="exp-baseline">
            Baseline label <span className="muted">(blank = 2nd-newest)</span>
          </label>
          <input
            id="exp-baseline"
            className="new-eval-input"
            placeholder="baseline"
            value={baseline}
            onChange={(e) => setBaseline(e.target.value)}
          />
        </div>
        <div className="new-eval-field">
          <label className="new-eval-label" htmlFor="exp-candidate">
            Candidate label <span className="muted">(blank = newest)</span>
          </label>
          <input
            id="exp-candidate"
            className="new-eval-input"
            placeholder="candidate"
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
          />
        </div>
      </div>
      {error ? <p className="runbar-error">{error}</p> : null}
      <div className="new-eval-actions">
        <button className="btn" type="submit" disabled={busy || !question.trim()}>
          {busy ? "Running…" : "Run experiment"}
        </button>
      </div>
    </form>
  );
};

/** The Experiments list: every experiment as a card, newest-first, with a "new experiment" flow. */
export const Experiments = () => {
  const [items, setItems] = useState<Experiment[] | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [showForm, setShowForm] = useState(false);

  /** Reload the experiment list (and the flows for name lookups + the form picker). */
  const load = useCallback(async () => {
    const [exps, flowsRes] = await Promise.all([
      fetchExperiments().catch(() => ({ items: [] as Experiment[], total: 0 })),
      fetchFlows("all").catch(() => ({ items: [] as FlowSummary[], unclassified: 0 })),
    ]);
    setItems(exps.items);
    setFlows(flowsRes.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** After a new experiment concludes, hide the form, refresh, and open its detail. */
  const onCreated = useCallback(
    (id: string) => {
      setShowForm(false);
      void load();
      window.location.hash = `#/experiment/${encodeURIComponent(id)}`;
    },
    [load],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Experiments</h1>
          <p className="muted">Every change you tried — the question, the compare, and what regressed. You make the call.</p>
        </div>
        <button className="btn" type="button" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "New experiment"}
        </button>
      </div>
      {showForm ? <NewExperimentForm flows={flows} onCreated={onCreated} /> : null}
      {items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="empty">No experiments yet — pose a question and run it against your rules over two corpora.</p>
      ) : (
        <div className="exp-list">
          {items.map((exp) => (
            <ExperimentCard key={exp.id} exp={exp} flows={flows} />
          ))}
        </div>
      )}
    </>
  );
};
