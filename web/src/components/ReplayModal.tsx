import { useCallback, useEffect, useMemo, useState } from "react";
import type { LlmInfo, SpanNode } from "../api";
import { fetchLlm, replaySpan } from "../api";
import { prettyValue } from "../format";
import { extractLlmRequest } from "../replay";

/**
 * The span-replay debugger: lift an LLM call's request out of the trace, let the
 * user edit the model / system / prompt / temperature, re-issue it through the
 * local LLM core, and show the fresh completion beside the original output.
 */
export const ReplayModal = ({ node, onClose }: { node: SpanNode; onClose: () => void }) => {
  const initial = useMemo(() => extractLlmRequest(node), [node]);
  const [model, setModel] = useState(initial.model);
  const [system, setSystem] = useState(initial.system);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [temperature, setTemperature] = useState("0");
  const [output, setOutput] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);
  const [llm, setLlm] = useState<LlmInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Close the modal on Escape for a keyboard-friendly debugger loop. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Which provider actually serves the replay (the captured model is only a hint). */
  useEffect(() => {
    void fetchLlm()
      .then(setLlm)
      .catch(() => setLlm(null));
  }, []);

  const originalOutput = prettyValue(node.output);

  /** Re-issue the (edited) request and capture the fresh completion. */
  const replay = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = Number.parseFloat(temperature);
      const res = await replaySpan({
        model: model.trim() || undefined,
        system: system.trim() ? system : undefined,
        prompt,
        // Clamp to the accepted range so an out-of-range field can't trip the
        // server's whole-body validation error.
        temperature: Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : undefined,
      });
      setOutput(res.output);
      setMeta({ provider: res.provider, model: res.model });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay failed.");
    } finally {
      setBusy(false);
    }
  }, [model, system, prompt, temperature, busy]);

  return (
    // No scrim-click close: this is an edit-heavy dialog, so a stray backdrop
    // click must not discard the edited prompt + captured completion (✕ / Escape close it).
    <div className="modal-scrim" role="presentation">
      <div className="modal replay-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-title-row">
            <h2 className="modal-title">Replay LLM call</h2>
            <span className="muted">{node.name || "llm span"}</span>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="replay-grid">
          <div className="replay-col">
            <div className="replay-field replay-field-row">
              <label className="replay-label" htmlFor="replay-model">
                Model
              </label>
              <input
                id="replay-model"
                className="replay-input mono"
                placeholder="(provider default)"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <label className="replay-label" htmlFor="replay-temp">
                Temp
              </label>
              <input
                id="replay-temp"
                className="replay-input replay-temp mono"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
            <div className="replay-field">
              <label className="replay-label" htmlFor="replay-system">
                System
              </label>
              <textarea
                id="replay-system"
                className="replay-input replay-textarea replay-system"
                placeholder="(no system prompt)"
                value={system}
                onChange={(e) => setSystem(e.target.value)}
              />
            </div>
            <div className="replay-field replay-field-grow">
              <label className="replay-label" htmlFor="replay-prompt">
                Prompt
              </label>
              <textarea
                id="replay-prompt"
                className="replay-input replay-textarea replay-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="replay-actions">
              {error ? (
                <span className="runbar-error">{error}</span>
              ) : llm ? (
                <span className="muted replay-provider">runs via {llm.provider}</span>
              ) : (
                <span />
              )}
              <button className="btn" type="button" disabled={busy || !prompt.trim()} onClick={replay}>
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Replaying…
                  </>
                ) : (
                  "Replay"
                )}
              </button>
            </div>
          </div>

          <div className="replay-col replay-outputs">
            <div className="replay-field replay-field-grow">
              <div className="replay-label">Original output</div>
              {originalOutput ? (
                <pre className="replay-output replay-output-original">
                  <code>{originalOutput}</code>
                </pre>
              ) : (
                <div className="io-empty">Not captured</div>
              )}
            </div>
            <div className="replay-field replay-field-grow">
              <div className="replay-label">
                Replay output
                {meta ? <span className="replay-meta mono"> {meta.provider} · {meta.model}</span> : null}
              </div>
              {output !== null ? (
                <pre className="replay-output replay-output-new">
                  <code>{output}</code>
                </pre>
              ) : (
                <div className="io-empty">Edit the request and press Replay to compare.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
