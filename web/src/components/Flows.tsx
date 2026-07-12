import { useCallback, useEffect, useState } from "react";
import type { FlowClassify, FlowSelector, FlowSummary, RunStatus } from "../api";
import { createFlow, fetchFlows, runFlows } from "../api";
import { formatNumber, plural, readStat, truncate } from "../format";
import { useRun } from "../useRun";
import { RunBar } from "./RunBar";

/** Human summary of a finished discover-flows run for the RunBar success line. */
const describeFlows = (run: RunStatus): string => {
  const files = readStat(run.stats, "filesRead");
  const flowsFound = readStat(run.stats, "flowCount");
  const rules = readStat(run.stats, "ruleCount");
  const readPart = files > 0 ? `Read ${plural(files, "file")}` : "Read the code";
  if (flowsFound === 0 && rules === 0) {
    return `${readPart} — no new flows; either the set already covers them, or no codeRoot is set in glassray.yaml.`;
  }
  return `${readPart} · added ${plural(flowsFound, "new flow")} and ${plural(rules, "rule")}.`;
};

/** Chip conveying how a flow classifies members: deterministic selector vs LLM rule. */
export const ClassifyChip = ({ classify }: { classify: FlowClassify }) => (
  <span className={`classify-chip classify-chip-${classify}`}>{classify}</span>
);

/** Compact one-line summary of a flow's selector constraints ("agent = bot · status = error"). */
export const describeSelector = (selector: FlowSelector | null): string => {
  if (!selector) return "";
  const parts: string[] = [];
  if (selector.agent) parts.push(`agent = ${selector.agent}`);
  if (selector.nameContains) parts.push(`name ~ “${selector.nameContains}”`);
  if (selector.q) parts.push(`intent ~ “${selector.q}”`);
  if (selector.status) parts.push(`status = ${selector.status}`);
  if (selector.traceIds?.length) parts.push(plural(selector.traceIds.length, "pinned trace"));
  if (selector.limit != null) parts.push(`sample ${selector.limit}`);
  return parts.join(" · ");
};

/** Raw string values of the selector form fields (shared by the create + edit forms). */
export interface SelectorFields {
  agent: string;
  nameContains: string;
  q: string;
  status: string;
  limit: string;
}

/** An all-empty selector form. */
export const emptySelectorFields: SelectorFields = { agent: "", nameContains: "", q: "", status: "", limit: "" };

/** Selector form fields pre-filled from an existing flow's selector. */
export const selectorToFields = (selector: FlowSelector | null): SelectorFields => ({
  agent: selector?.agent ?? "",
  nameContains: selector?.nameContains ?? "",
  q: selector?.q ?? "",
  status: selector?.status ?? "",
  limit: selector?.limit != null ? String(selector.limit) : "",
});

/** Build a FlowSelector from raw form values; null when every field is empty (no selector). */
export const fieldsToSelector = (fields: SelectorFields): FlowSelector | null => {
  const selector: FlowSelector = {};
  if (fields.agent.trim()) selector.agent = fields.agent.trim();
  if (fields.nameContains.trim()) selector.nameContains = fields.nameContains.trim();
  if (fields.q.trim()) selector.q = fields.q.trim();
  if (fields.status === "ok" || fields.status === "error") selector.status = fields.status;
  const limit = Number.parseInt(fields.limit, 10);
  if (Number.isInteger(limit) && limit > 0) selector.limit = Math.min(limit, 200);
  return Object.keys(selector).length > 0 ? selector : null;
};

/** The grid of selector constraint inputs, shared by the new-flow and edit-definition forms. */
export const SelectorFieldsGrid = ({
  fields,
  onChange,
  disabled,
  idPrefix,
}: {
  fields: SelectorFields;
  onChange: (fields: SelectorFields) => void;
  disabled?: boolean;
  idPrefix: string;
}) => (
  <div className="flow-form-grid">
    <div className="new-eval-field">
      <label className="new-eval-label" htmlFor={`${idPrefix}-agent`}>
        Agent <span className="muted">(exact)</span>
      </label>
      <input
        id={`${idPrefix}-agent`}
        className="new-eval-input"
        placeholder="e.g. support-bot"
        value={fields.agent}
        disabled={disabled}
        onChange={(e) => onChange({ ...fields, agent: e.target.value })}
      />
    </div>
    <div className="new-eval-field">
      <label className="new-eval-label" htmlFor={`${idPrefix}-name`}>
        Name contains
      </label>
      <input
        id={`${idPrefix}-name`}
        className="new-eval-input"
        placeholder="e.g. checkout"
        value={fields.nameContains}
        disabled={disabled}
        onChange={(e) => onChange({ ...fields, nameContains: e.target.value })}
      />
    </div>
    <div className="new-eval-field">
      <label className="new-eval-label" htmlFor={`${idPrefix}-q`}>
        Intent contains
      </label>
      <input
        id={`${idPrefix}-q`}
        className="new-eval-input"
        placeholder="e.g. refund"
        value={fields.q}
        disabled={disabled}
        onChange={(e) => onChange({ ...fields, q: e.target.value })}
      />
    </div>
    <div className="new-eval-field">
      <label className="new-eval-label" htmlFor={`${idPrefix}-status`}>
        Status
      </label>
      <select
        id={`${idPrefix}-status`}
        className="new-eval-input"
        value={fields.status}
        disabled={disabled}
        onChange={(e) => onChange({ ...fields, status: e.target.value })}
      >
        <option value="">any</option>
        <option value="ok">ok only</option>
        <option value="error">errors only</option>
      </select>
    </div>
    <div className="new-eval-field">
      <label className="new-eval-label" htmlFor={`${idPrefix}-limit`}>
        Eval sample size
      </label>
      <input
        id={`${idPrefix}-limit`}
        className="new-eval-input"
        type="number"
        min={1}
        max={200}
        placeholder="20"
        value={fields.limit}
        disabled={disabled}
        onChange={(e) => onChange({ ...fields, limit: e.target.value })}
      />
    </div>
  </div>
);

/** Inline "new flow" form — name + description, selector constraints, and an optional LLM rule. */
const NewFlowForm = ({ onCreated }: { onCreated: () => void }) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<SelectorFields>(emptySelectorFields);
  const [rule, setRule] = useState("");
  const [classify, setClassify] = useState<"auto" | FlowClassify>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selector = fieldsToSelector(fields);
  const hasDefinition = selector !== null || rule.trim().length > 0;
  const needsRule = classify === "llm" && !rule.trim();
  const needsSelector = classify === "selector" && selector === null;

  /** Submit the form: create the flow, reset, and let the parent refresh. */
  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!name.trim() || !hasDefinition || needsRule || needsSelector || busy) return;
      setBusy(true);
      setError(null);
      try {
        await createFlow({
          name: name.trim(),
          description: description.trim() || undefined,
          selector,
          rule: rule.trim() || undefined,
          ...(classify !== "auto" ? { classify } : {}),
        });
        setName("");
        setDescription("");
        setFields(emptySelectorFields);
        setRule("");
        setClassify("auto");
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create flow.");
      } finally {
        setBusy(false);
      }
    },
    [name, description, selector, rule, classify, hasDefinition, needsRule, needsSelector, busy, onCreated],
  );

  return (
    <form className="panel new-eval" onSubmit={submit}>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="flow-name">
          Name
        </label>
        <input
          id="flow-name"
          className="new-eval-input"
          placeholder="e.g. Refund requests"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="flow-desc">
          Description <span className="muted">(optional)</span>
        </label>
        <input
          id="flow-desc"
          className="new-eval-input"
          placeholder="What this workflow does"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="new-eval-field">
        <span className="new-eval-label">Selector — deterministic match (fields AND-combined)</span>
        <SelectorFieldsGrid fields={fields} onChange={setFields} idPrefix="flow-new" />
      </div>
      <div className="new-eval-field">
        <label className="new-eval-label" htmlFor="flow-rule">
          Rule <span className="muted">(optional — plain language, classified by the background LLM sweep)</span>
        </label>
        <textarea
          id="flow-rule"
          className="new-eval-input new-eval-textarea"
          placeholder="e.g. The user is asking for a refund or disputing a charge."
          value={rule}
          onChange={(e) => setRule(e.target.value)}
        />
      </div>
      <div className="new-eval-field flow-classify-field">
        <label className="new-eval-label" htmlFor="flow-classify">
          Classify by
        </label>
        <select
          id="flow-classify"
          className="new-eval-input"
          value={classify}
          onChange={(e) => setClassify(e.target.value as "auto" | FlowClassify)}
        >
          <option value="auto">auto (rule → llm, else selector)</option>
          <option value="selector">selector only</option>
          <option value="llm">llm rule</option>
        </select>
      </div>
      {!hasDefinition ? (
        <p className="muted">A flow needs at least one selector field or a rule.</p>
      ) : needsRule ? (
        <p className="muted">An llm-classified flow needs a rule.</p>
      ) : needsSelector ? (
        <p className="muted">A selector-classified flow needs at least one selector field.</p>
      ) : null}
      {error ? <p className="runbar-error">{error}</p> : null}
      <div className="new-eval-actions">
        <button className="btn" type="submit" disabled={busy || !name.trim() || !hasDefinition || needsRule || needsSelector}>
          {busy ? "Creating…" : "Create flow"}
        </button>
      </div>
    </form>
  );
};

/** One flow row's compact definition summary: the selector line and/or the truncated rule. */
const DefinitionCell = ({ flow }: { flow: FlowSummary }) => {
  const selectorLine = describeSelector(flow.selector);
  return (
    <>
      {selectorLine ? <div className="cell-preview mono">{selectorLine}</div> : null}
      {flow.rule ? <div className="cell-preview">{truncate(flow.rule, 90)}</div> : null}
      {!selectorLine && !flow.rule ? <span className="muted">—</span> : null}
    </>
  );
};

/** The flows view (#/flows): durable flows with their definitions, the discover bootstrap, and a new-flow form. */
export const Flows = () => {
  const [items, setItems] = useState<FlowSummary[]>([]);
  const [unclassified, setUnclassified] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [showArchived, setShowArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);

  /** Reload the flow list (active or archived) from the server. */
  const load = useCallback(async () => {
    try {
      const res = await fetchFlows(showArchived ? "archived" : "active");
      setItems(res.items);
      setUnclassified(res.unclassified);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Refetch the list once a discover-flows run lands. */
  const onDone = useCallback(() => {
    void load();
  }, [load]);

  const run = useRun(runFlows, onDone);

  /** After a create, hide the form and show the ACTIVE list — new flows are active, so
   * creating one from the archived view must not make it look like creation failed. */
  const onCreated = useCallback(() => {
    setShowForm(false);
    if (showArchived) setShowArchived(false); // flips the list; the load effect refetches
    else void load();
  }, [load, showArchived]);

  const runBar = (
    <RunBar label="Discover flows" runningLabel="Discovering…" run={run} describeResult={describeFlows} />
  );

  const newButton = (
    <button className="btn" type="button" onClick={() => setShowForm((v) => !v)}>
      {showForm ? "Close" : "New flow"}
    </button>
  );

  if (status === "loading") {
    return <div className="notice">Loading flows…</div>;
  }
  if (status === "error") {
    return <div className="notice notice-error">Could not reach the local Coach server.</div>;
  }

  if (items.length === 0 && !showForm && !showArchived) {
    return (
      <div className="empty">
        <h2 className="empty-title">No flows yet</h2>
        <p className="empty-sub">
          A flow is a named agent workflow. Define one by hand, or discover them by reading your code — Coach maps
          the flows and their rules straight from the source at your <span className="mono">codeRoot</span>.
        </p>
        <div className="empty-actions">
          {newButton}
          {runBar}
        </div>
      </div>
    );
  }

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Flows</h1>
          <p className="page-sub">The recurring workflows your agents run, and how traces are assigned to them.</p>
        </div>
        <div className="flow-head-actions">
          {newButton}
          {runBar}
        </div>
      </div>
      {showForm ? <NewFlowForm onCreated={onCreated} /> : null}
      {unclassified > 0 ? (
        <div className="notice">
          {plural(unclassified, "trace")} awaiting classification — the background sweep will assign them shortly.
        </div>
      ) : null}
      <div className="list-caption">
        {formatNumber(items.length)} {showArchived ? "archived" : "active"}
        <button className="list-toggle" type="button" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Show active" : "Show archived"}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="notice">{showArchived ? "No archived flows." : "No active flows yet — create one above."}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Flow</th>
                <th>Classify</th>
                <th>Definition</th>
                <th>Created by</th>
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
                    {item.description ? <div className="cell-preview">{truncate(item.description, 100)}</div> : null}
                  </td>
                  <td>
                    <ClassifyChip classify={item.classify} />
                  </td>
                  <td className="flow-def-cell">
                    <DefinitionCell flow={item} />
                  </td>
                  <td className="muted">{item.createdBy}</td>
                  <td className="col-num mono">{formatNumber(item.traceCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
