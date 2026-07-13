import { useCallback, useEffect, useState } from "react";
import type { DeviationDetail as DeviationDetailData } from "../api";
import {
  fetchDeviation,
  generateDeviationFix,
  isNotFoundError,
  reopenDeviation,
  resolveDeviation,
  saveEvalFromDeviation,
} from "../api";
import { relativeTime } from "../format";
import { useRun } from "../useRun";
import { SeverityChip } from "./Deviations";
import { RunBar } from "./RunBar";

/** Success line for a finished fix-generation run. */
const describeFix = (): string => "Fix generated — apply the steps in your coding agent, then Save as rule and re-run to verify.";

/**
 * Render the fix instruction markdown with a light touch: `## ` lines become
 * section headings, everything else stays as pre-wrapped text. Dependency-free
 * (Coach ships no markdown lib) — enough to read a six-section fix doc cleanly.
 */
const FixMarkdown = ({ markdown }: { markdown: string }) => {
  const blocks: { heading: string | null; body: string }[] = [];
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      blocks.push({ heading: heading[1] ?? "", body: "" });
    } else if (blocks.length === 0) {
      blocks.push({ heading: null, body: line });
    } else {
      const last = blocks[blocks.length - 1]!;
      last.body = last.body ? `${last.body}\n${line}` : line;
    }
  }
  return (
    <div className="fix-md">
      {blocks.map((block, i) => (
        <div key={i} className="fix-block">
          {block.heading ? <h3 className="fix-h">{block.heading}</h3> : null}
          {block.body.trim() ? <pre className="fix-body">{block.body.trim()}</pre> : null}
        </div>
      ))}
    </div>
  );
};

/** The deviation detail view (#/deviation/:id): header + rule callout + generated fix + example traces. */
export const DeviationDetail = ({ id }: { id: string }) => {
  const [data, setData] = useState<DeviationDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [missing, setMissing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [copied, setCopied] = useState(false);

  /** (Re)load the deviation from the server — also used to pick up a freshly generated fix / status change. */
  const load = useCallback(async () => {
    try {
      const res = await fetchDeviation(id);
      setData(res);
      setStatus("ready");
    } catch (err) {
      setMissing(isNotFoundError(err));
      setStatus("error");
    }
  }, [id]);

  useEffect(() => {
    setStatus("loading");
    void load();
  }, [load]);

  /** Turn this deviation's rule into a repeatable eval, then jump to it. */
  const onSaveAsEval = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { id: evalId } = await saveEvalFromDeviation(id);
      window.location.hash = `#/eval/${encodeURIComponent(evalId)}`;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save eval.");
      setSaving(false);
    }
  }, [id, saving]);

  /** Fix-generation run: start it, then refetch so the new fixMarkdown renders. */
  const fixRun = useRun(
    useCallback(() => generateDeviationFix(id), [id]),
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Flip the deviation between open and resolved (the loop's final step). */
  const onToggleResolved = useCallback(async () => {
    if (!data || resolving) return;
    setResolving(true);
    try {
      if (data.deviation.status === "resolved") await reopenDeviation(id);
      else await resolveDeviation(id);
      await load();
    } catch {
      // Non-fatal — the button re-enables and the user can retry.
    } finally {
      setResolving(false);
    }
  }, [data, id, resolving, load]);

  /** Copy the generated fix to the clipboard (to paste into a coding agent). */
  const onCopyFix = useCallback(async () => {
    if (!data?.deviation.fixMarkdown) return;
    try {
      await navigator.clipboard.writeText(data.deviation.fixMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — no-op; the text is on screen to copy manually.
    }
  }, [data]);

  if (status === "loading") return <div className="notice">Loading deviation…</div>;
  if (status === "error" || !data) {
    return (
      <section className="detail">
        <a className="back" href="#/deviations">
          ← All deviations
        </a>
        <div className="notice notice-error">
          {missing ? "Deviation not found." : "Could not reach the local Coach server."}
        </div>
      </section>
    );
  }

  const { deviation, examples } = data;
  const resolved = deviation.status === "resolved";

  return (
    <section className="detail">
      <a className="back" href="#/deviations">
        ← All deviations
      </a>

      <header className="detail-head">
        <div className="detail-title-row">
          <SeverityChip severity={deviation.severity} />
          <h1 className="detail-title">{deviation.label}</h1>
          {resolved ? <span className="sev sev-resolved">resolved</span> : null}
          <span className="muted">{relativeTime(deviation.createdAt)}</span>
          <button className="btn detail-title-action" type="button" onClick={onToggleResolved} disabled={resolving}>
            {resolving ? "Saving…" : resolved ? "Reopen" : "Mark resolved"}
          </button>
          <button
            className="btn detail-title-action"
            type="button"
            onClick={onSaveAsEval}
            disabled={saving}
            title="Promote this deviation into a proposed assertion rule — watch it once you trust it"
          >
            {saving ? "Saving…" : "Save as rule"}
          </button>
        </div>
        {deviation.description ? <p className="detail-sub">{deviation.description}</p> : null}
        <div className="callout">
          <div className="callout-label">Rule</div>
          <div className="callout-body">{deviation.rule}</div>
        </div>
        {saveError ? <p className="runbar-error">{saveError}</p> : null}
      </header>

      <div className="section-head">
        <h2 className="section-title">Fix</h2>
        <RunBar
          label={deviation.fixMarkdown ? "Regenerate fix" : "Generate fix"}
          runningLabel="Generating…"
          run={fixRun}
          describeResult={describeFix}
        />
      </div>
      {deviation.fixMarkdown ? (
        <article className="panel fix-panel">
          <div className="fix-meta">
            <span className="muted">
              Generated {deviation.fixGeneratedAt ? relativeTime(deviation.fixGeneratedAt) : ""}
              {deviation.fixModel ? ` · ${deviation.fixModel}` : ""}
            </span>
            <button className="btn btn-sm" type="button" onClick={onCopyFix}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <FixMarkdown markdown={deviation.fixMarkdown} />
        </article>
      ) : (
        <div className="notice">
          No fix yet. Generate one to get step-by-step instructions you can paste into your coding agent, then Save as
          rule to verify the fix holds.
        </div>
      )}

      <h2 className="section-title">Examples ({examples.length})</h2>
      {examples.length === 0 ? (
        <div className="notice">No examples recorded for this deviation.</div>
      ) : (
        <div className="example-list">
          {examples.map((example, index) => (
            <article key={`${example.traceId}-${index}`} className="panel example">
              <div className="example-head">
                <SeverityChip severity={example.severity} />
                <span className="example-label">{example.label}</span>
                <a className="example-link" href={`#/trace/${encodeURIComponent(example.traceId)}`}>
                  View trace →
                </a>
              </div>
              {example.description ? <p className="example-desc">{example.description}</p> : null}
              {example.evidence ? (
                <blockquote className="evidence">
                  <code>{example.evidence}</code>
                </blockquote>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
};
