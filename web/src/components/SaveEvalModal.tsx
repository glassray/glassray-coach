import { useCallback, useEffect, useState } from "react";
import type { FlowSummary, SpanNode, TraceView } from "../api";
import { createEval, fetchFlows } from "../api";
import { prettyValue, truncate } from "../format";

/**
 * Turn the trace you're looking at into a repeatable eval — without a full
 * discovery run. The most common debugging moment is "this specific run is
 * wrong": this closes the loop right there. You write the rule the agent should
 * have followed; the trace's input/output is shown for reference. On save it
 * navigates to the new eval so you can run it immediately.
 */
export const SaveEvalModal = ({
  trace,
  selected,
  onClose,
}: {
  trace: TraceView;
  selected: SpanNode | null;
  onClose: () => void;
}) => {
  const [label, setLabel] = useState("");
  const [rule, setRule] = useState("");
  const [flowId, setFlowId] = useState("");
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Close on Escape, matching the replay debugger. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Active flows feed the optional scope picker (best-effort — the select hides on failure).
  useEffect(() => {
    void fetchFlows("active")
      .then((res) => setFlows(res.items))
      .catch(() => setFlows([]));
  }, []);

  /** Reference evidence: prefer the selected span's I/O, else the whole trace's. */
  const evidenceInput = selected ? prettyValue(selected.input) : trace.inputPreview;
  const evidenceOutput = selected ? prettyValue(selected.output) : trace.outputPreview;

  /** Create the eval, then jump to it so the developer can run it right away. */
  const save = useCallback(async () => {
    if (!label.trim() || !rule.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await createEval({
        label: label.trim(),
        rule: rule.trim(),
        flowId: flowId || undefined,
      });
      window.location.hash = `#/eval/${encodeURIComponent(id)}`;
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create eval.");
      setBusy(false);
    }
  }, [label, rule, flowId, busy, onClose]);

  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal save-eval-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-title-row">
            <h2 className="modal-title">Save as eval</h2>
            <span className="muted">{selected ? selected.name || "span" : trace.name || "trace"}</span>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="save-eval-body">
          <div className="new-eval-field">
            <label className="new-eval-label" htmlFor="se-label">
              Name
            </label>
            <input
              id="se-label"
              className="new-eval-input"
              placeholder={trace.name ? `e.g. ${trace.name} must ground its answer in a tool call` : "e.g. Never leak PII"}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </div>
          <div className="new-eval-field">
            <label className="new-eval-label" htmlFor="se-rule">
              Rule the agent should follow
            </label>
            <textarea
              id="se-rule"
              className="new-eval-input new-eval-textarea"
              placeholder="Describe the behavior this trace got wrong — e.g. 'The agent must call lookup_order before stating an order's status, never inventing one.'"
              value={rule}
              onChange={(e) => setRule(e.target.value)}
            />
          </div>
          {flows.length > 0 ? (
            <div className="new-eval-field">
              <label className="new-eval-label" htmlFor="se-flow">
                Flow <span className="muted">(optional — runs sample this flow's members)</span>
              </label>
              <select
                id="se-flow"
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

          <div className="save-eval-evidence">
            <div className="new-eval-label">From this trace (for reference)</div>
            {evidenceInput ? (
              <pre className="save-eval-pre">
                <span className="save-eval-pre-label">input</span>
                <code>{truncate(evidenceInput, 400)}</code>
              </pre>
            ) : null}
            {evidenceOutput ? (
              <pre className="save-eval-pre">
                <span className="save-eval-pre-label">output</span>
                <code>{truncate(evidenceOutput, 400)}</code>
              </pre>
            ) : null}
          </div>

          <div className="save-eval-actions">
            {error ? <span className="runbar-error">{error}</span> : <span />}
            <button className="btn" type="button" disabled={busy || !label.trim() || !rule.trim()} onClick={save}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save eval"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
