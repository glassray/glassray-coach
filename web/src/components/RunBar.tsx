import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { LlmInfo, RunStatus } from "../api";
import { fetchLlm } from "../api";
import { readStat } from "../format";
import type { RunState } from "../useRun";

/** Sentence-case a raw lowercase server error (e.g. the 409 string) for display. */
const humanizeError = (msg: string): string => {
  const trimmed = msg.trim();
  const cased = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  if (/already in progress/i.test(cased)) return `${cased} — results will appear when it finishes.`;
  return cased;
};

/**
 * Action row shared by the Deviations/Flows views: optional extra controls
 * (`children`) beside the run button, with the LLM-provider status, a success
 * confirmation, and any run error shown beneath. The button disables itself and
 * spins while a run polls. `describeResult` formats the finished-run summary.
 */
export const RunBar = ({
  label,
  runningLabel,
  run,
  describeResult,
  children,
}: {
  label: string;
  runningLabel: string;
  run: RunState;
  describeResult?: (run: RunStatus) => string;
  children?: ReactNode;
}) => {
  const [llm, setLlm] = useState<LlmInfo | null>(null);

  useEffect(() => {
    void fetchLlm()
      .then(setLlm)
      .catch(() => setLlm(null));
  }, []);

  /** The success line: shown once a run has finished cleanly and no error is pending. */
  const success =
    !run.running && !run.error && run.lastRun?.status === "done"
      ? (describeResult?.(run.lastRun) ?? "Done.")
      : null;

  // Mid-run progress ("8/20"), published by the scan loop — reassures the
  // developer a long run is working rather than stuck.
  const total = run.progress ? readStat(run.progress, "total") : 0;
  const scanned = run.progress ? readStat(run.progress, "scanned") : 0;
  const runningText = total > 0 ? `${runningLabel} ${scanned}/${total}` : runningLabel;

  return (
    <div className="runbar">
      <div className="runbar-row">
        {children}
        <button className="btn" type="button" disabled={run.running} onClick={run.start}>
          {run.running ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {runningText}
            </>
          ) : (
            label
          )}
        </button>
        {run.running ? (
          <button className="btn btn-ghost" type="button" onClick={run.cancel} title="Cancel this run">
            Cancel
          </button>
        ) : null}
      </div>
      {llm && !llm.ready ? (
        <p className="runbar-error">{llm.reason || "LLM provider not ready."}</p>
      ) : llm && llm.provider === "mock" ? (
        <p className="runbar-hint">
          Using the offline <strong>mock</strong> provider — analysis results are deterministic
          placeholders. Set <code>GLASSRAY_LLM_PROVIDER</code> (+ an API key), or sign in with the
          Claude CLI, for real analysis.
        </p>
      ) : null}
      {run.error ? <p className="runbar-error">{humanizeError(run.error)}</p> : null}
      {success ? <p className="runbar-success">✓ {success}</p> : null}
    </div>
  );
};
