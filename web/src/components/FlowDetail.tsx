import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowAudit, FlowClassify, FlowDetail as FlowDetailData, FlowMember } from "../api";
import { deleteFlow, fetchFlow, fetchFlowAudit, isNotFoundError, updateFlow } from "../api";
import { formatNumber, relativeTime, truncate } from "../format";
import type { SelectorFields } from "./Flows";
import { ClassifyChip, describeSelector, fieldsToSelector, SelectorFieldsGrid, selectorToFields } from "./Flows";

/** Provenance badge for one membership (selector/llm/manual), with a low-confidence marker. */
const AssignBadge = ({ assignedBy, confidence }: { assignedBy: string; confidence: string | null }) => (
  <>
    <span className={`assign-badge assign-${assignedBy}`}>{assignedBy}</span>
    {confidence === "low" ? (
      <span className="confidence-low" title="Low-confidence LLM assignment">
        low
      </span>
    ) : null}
  </>
);

/** One member row shared by the members table and the audit sample (optionally with the intent preview). */
const MemberRow = ({ member, inputPreview }: { member: FlowMember; inputPreview?: string | null }) => (
  <tr
    className={`row${member.confidence === "low" ? " row-lowconf" : ""}`}
    onClick={() => {
      window.location.hash = `#/trace/${encodeURIComponent(member.traceId)}`;
    }}
  >
    <td>
      <div className="cell-name">{member.name ?? "Untitled trace"}</div>
      {inputPreview ? <div className="cell-preview">{truncate(inputPreview, 110)}</div> : null}
    </td>
    <td>{member.agent ? <span className="tag">{member.agent}</span> : <span className="muted">—</span>}</td>
    <td className="muted">{member.receivedAt ? relativeTime(member.receivedAt) : "—"}</td>
    <td>
      <AssignBadge assignedBy={member.assignedBy} confidence={member.confidence} />
    </td>
  </tr>
);

/** Column headers shared by the member tables. */
const MemberHead = () => (
  <thead>
    <tr>
      <th>Trace</th>
      <th>Agent</th>
      <th>Received</th>
      <th>Assigned by</th>
    </tr>
  </thead>
);

/** Editable definition form state: identity + selector fields + rule + classify mode. */
interface DefinitionDraft {
  name: string;
  description: string;
  fields: SelectorFields;
  rule: string;
  classify: FlowClassify;
}

/** The flow detail view (#/flow/:id): definition card, members with provenance, attached evals, and the audit. */
export const FlowDetail = ({ id }: { id: string }) => {
  const [data, setData] = useState<FlowDetailData | null>(null);
  const [audit, setAudit] = useState<FlowAudit | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [missing, setMissing] = useState(true);
  const [draft, setDraft] = useState<DefinitionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The id the currently-displayed data belongs to, so a late response for a prior id is ignored. */
  const shownId = useRef(id);

  /** Reload the detail (and, best-effort, the audit) from the server. */
  const load = useCallback(async () => {
    try {
      const res = await fetchFlow(id);
      if (shownId.current !== id) return;
      setData(res);
      setStatus("ready");
    } catch (err) {
      if (shownId.current !== id) return;
      setMissing(isNotFoundError(err));
      setStatus("error");
      return;
    }
    // The audit is supplementary — a failure keeps the detail usable.
    try {
      const auditRes = await fetchFlowAudit(id);
      if (shownId.current === id) setAudit(auditRes);
    } catch {
      if (shownId.current === id) setAudit(null);
    }
  }, [id]);

  useEffect(() => {
    shownId.current = id;
    setStatus("loading");
    setDraft(null);
    setAudit(null);
    void load();
  }, [id, load]);

  /** Open the definition editor pre-filled from the current flow. */
  const startEdit = useCallback(() => {
    if (!data) return;
    setSaveError(null);
    setDraft({
      name: data.name,
      description: data.description,
      fields: selectorToFields(data.selector),
      rule: data.rule ?? "",
      classify: data.classify,
    });
  }, [data]);

  /** PATCH the edited definition; existing trace-id pins survive a selector edit. */
  const saveDraft = useCallback(async () => {
    if (!draft || !data || saving) return;
    const built = fieldsToSelector(draft.fields);
    // Pins are managed outside this form (e.g. by Claude) — carry them over.
    const pins = data.selector?.traceIds;
    const selector = built !== null || pins?.length ? { ...(built ?? {}), ...(pins?.length ? { traceIds: pins } : {}) } : null;
    const rule = draft.rule.trim() || null;
    if (draft.classify === "llm" && !rule) {
      setSaveError("An llm-classified flow needs a rule.");
      return;
    }
    if (selector === null && rule === null) {
      setSaveError("A flow needs at least one selector field or a rule.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await updateFlow(id, {
        name: draft.name.trim() || data.name,
        description: draft.description.trim(),
        selector,
        rule,
        classify: draft.classify,
      });
      if (shownId.current !== id) return;
      setData(res);
      setDraft(null);
      // Memberships may have re-materialized — refresh the audit too.
      void fetchFlowAudit(id)
        .then((a) => {
          if (shownId.current === id) setAudit(a);
        })
        .catch(() => {});
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the flow.");
    } finally {
      setSaving(false);
    }
  }, [draft, data, id, saving]);

  /** Flip the flow between active and archived. */
  const toggleArchived = useCallback(async () => {
    if (!data || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await updateFlow(id, { status: data.status === "active" ? "archived" : "active" });
      if (shownId.current === id) setData(res);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update the flow.");
    } finally {
      setActionBusy(false);
    }
  }, [data, id, actionBusy]);

  /** Delete this flow (after confirmation) and return to the list. */
  const onDelete = useCallback(async () => {
    if (actionBusy) return;
    if (!window.confirm("Delete this flow? Its memberships go with it; attached evals become global.")) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await deleteFlow(id);
      window.location.hash = "#/flows";
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete the flow.");
      setActionBusy(false);
    }
  }, [id, actionBusy]);

  if (status === "loading") return <div className="notice">Loading flow…</div>;
  if (status === "error" || !data) {
    return (
      <section className="detail">
        <a className="back" href="#/flows">
          ← All flows
        </a>
        <div className="notice notice-error">
          {missing ? "Flow not found — it may have been removed." : "Could not reach the local Coach server."}
        </div>
      </section>
    );
  }

  const selectorLine = describeSelector(data.selector);

  return (
    <section className="detail">
      <a className="back" href="#/flows">
        ← All flows
      </a>

      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">{data.name}</h1>
          <ClassifyChip classify={data.classify} />
          {data.status === "archived" ? <span className="sev sev-resolved">archived</span> : null}
          <span className="tag">
            {formatNumber(data.traceCount)} {data.traceCount === 1 ? "trace" : "traces"}
          </span>
          <span className="muted">by {data.createdBy}</span>
        </div>
        {data.description ? <p className="detail-sub">{data.description}</p> : null}
        <div className="eval-actions">
          <div className="runbar-row">
            {draft === null ? (
              <button className="btn" type="button" onClick={startEdit}>
                Edit definition
              </button>
            ) : null}
            <button className="btn btn-ghost" type="button" onClick={toggleArchived} disabled={actionBusy}>
              {data.status === "active" ? "Archive" : "Unarchive"}
            </button>
          </div>
          <button className="btn btn-danger" type="button" onClick={onDelete} disabled={actionBusy}>
            Delete
          </button>
        </div>
        {actionError ? <p className="runbar-error">{actionError}</p> : null}
      </header>

      {draft === null ? (
        <div className="callout">
          <div className="callout-label">Definition</div>
          <div className="callout-body">
            {selectorLine ? (
              <div className="mono flow-def-line">{selectorLine}</div>
            ) : (
              <div className="muted flow-def-line">
                {data.classify === "llm"
                  ? "No selector — members come from the LLM rule."
                  : "No selector defined — add one (or switch to an LLM rule) for this flow to gain members."}
              </div>
            )}
            {data.rule ? (
              <div className="flow-def-line">“{data.rule}”</div>
            ) : (
              <div className="muted flow-def-line">No rule — members come from the selector only.</div>
            )}
          </div>
        </div>
      ) : (
        <form
          className="panel new-eval"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <div className="new-eval-field">
            <label className="new-eval-label" htmlFor="fd-name">
              Name
            </label>
            <input
              id="fd-name"
              className="new-eval-input"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="new-eval-field">
            <label className="new-eval-label" htmlFor="fd-desc">
              Description
            </label>
            <input
              id="fd-desc"
              className="new-eval-input"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="new-eval-field">
            <span className="new-eval-label">Selector — deterministic match (fields AND-combined)</span>
            <SelectorFieldsGrid
              fields={draft.fields}
              onChange={(fields) => setDraft({ ...draft, fields })}
              disabled={saving}
              idPrefix="fd-sel"
            />
            {data.selector?.traceIds?.length ? (
              <p className="muted">
                {formatNumber(data.selector.traceIds.length)} pinned trace
                {data.selector.traceIds.length === 1 ? "" : "s"} are kept as-is.
              </p>
            ) : null}
          </div>
          <div className="new-eval-field">
            <label className="new-eval-label" htmlFor="fd-rule">
              Rule <span className="muted">(plain language, for the LLM sweep)</span>
            </label>
            <textarea
              id="fd-rule"
              className="new-eval-input new-eval-textarea"
              value={draft.rule}
              onChange={(e) => setDraft({ ...draft, rule: e.target.value })}
            />
          </div>
          <div className="new-eval-field flow-classify-field">
            <label className="new-eval-label" htmlFor="fd-classify">
              Classify by
            </label>
            <select
              id="fd-classify"
              className="new-eval-input"
              value={draft.classify}
              onChange={(e) => setDraft({ ...draft, classify: e.target.value as FlowClassify })}
            >
              <option value="selector">selector only</option>
              <option value="llm">llm rule</option>
            </select>
          </div>
          {saveError ? <p className="runbar-error">{saveError}</p> : null}
          <div className="new-eval-actions">
            <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save definition"}
            </button>
          </div>
        </form>
      )}

      <h2 className="section-title">Evals ({data.evals.length})</h2>
      {data.evals.length === 0 ? (
        <div className="notice">
          No evals scoped to this flow yet — create one from the{" "}
          <a className="inline-link" href="#/evals">
            Evals
          </a>{" "}
          view and bind it here.
        </div>
      ) : (
        <ul className="mini-list panel card-pad">
          {data.evals.map((ev) => (
            <li key={ev.id}>
              <a className="mini-row" href={`#/eval/${encodeURIComponent(ev.id)}`}>
                <span className="mini-name">{ev.label}</span>
                <span className={`tag${ev.autorun ? " tag-autorun" : ""}`}>
                  {ev.autorun ? "autorun on" : "autorun off"}
                </span>
                <span className="mono muted mini-age">{ev.lastRunAt ? relativeTime(ev.lastRunAt) : "never run"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title">Member traces ({formatNumber(data.traceCount)})</h2>
      {data.members.length === 0 ? (
        <div className="notice">No member traces yet — new traces are assigned as they arrive.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <MemberHead />
            <tbody>
              {data.members.map((m) => (
                <MemberRow key={m.traceId} member={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {audit ? (
        <>
          <h2 className="section-title">Audit</h2>
          <p className="muted flow-audit-counts">
            {formatNumber(audit.counts.members)} members · {formatNumber(audit.counts.lowConfidence)} low-confidence ·{" "}
            {formatNumber(audit.counts.unclassifiedStoreWide)} unclassified store-wide
          </p>
          {audit.lowConfidence.length > 0 ? (
            <>
              <h3 className="flow-audit-subtitle">Low-confidence assignments</h3>
              <div className="table-wrap">
                <table className="table">
                  <MemberHead />
                  <tbody>
                    {audit.lowConfidence.map((m) => (
                      <MemberRow key={m.traceId} member={m} inputPreview={m.inputPreview} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {audit.sample.length > 0 ? (
            <>
              <h3 className="flow-audit-subtitle">Newest members (sample)</h3>
              <div className="table-wrap">
                <table className="table">
                  <MemberHead />
                  <tbody>
                    {audit.sample.map((m) => (
                      <MemberRow key={m.traceId} member={m} inputPreview={m.inputPreview} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
};
