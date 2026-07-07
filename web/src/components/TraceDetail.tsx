import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SpanNode, TraceView } from "../api";
import { fetchTrace, isNotFoundError } from "../api";
import { formatDuration, formatNumber, formatTokens, prettyValue, relativeTime } from "../format";
import { useTailRefresh } from "../useTailRefresh";
import { SpanTree } from "./SpanTree";
import { StatusDot } from "./TraceList";
import { ReplayModal } from "./ReplayModal";
import { SaveEvalModal } from "./SaveEvalModal";

/** One labelled metric in the detail header. */
const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
  </div>
);

/** A pretty-printed input/output block, or a placeholder when nothing was captured. */
const IOBlock = ({ label, value }: { label: string; value: unknown }) => {
  const text = prettyValue(value);
  return (
    <div className="io">
      <div className="io-label">{label}</div>
      {text ? (
        <pre className="io-body">
          <code>{text}</code>
        </pre>
      ) : (
        <div className="io-empty">Not captured</div>
      )}
    </div>
  );
};

/** Side panel showing the currently selected span's model, tokens, and I/O. */
const InspectPanel = ({ node, onReplay }: { node: SpanNode | null; onReplay: (node: SpanNode) => void }) => {
  if (!node) {
    return (
      <aside className="inspect inspect-empty">
        <p className="muted">Select a span to inspect its input, output, and model.</p>
      </aside>
    );
  }
  const attributes = node.attributes ?? {};
  const attrKeys = Object.keys(attributes).sort();
  return (
    <aside className="inspect">
      <div className="inspect-head">
        <span className={`badge badge-${node.kind}`}>{node.kind}</span>
        <span className="inspect-name">{node.name || "span"}</span>
        <StatusDot status={node.status} />
      </div>
      {node.status === "error" && node.statusMessage ? (
        <p className="inspect-error">{node.statusMessage}</p>
      ) : null}
      <div className="inspect-meta">
        {node.model ? <span className="tag">{node.model}</span> : null}
        <span className="mono muted">{formatDuration(node.durationMs)}</span>
        {node.tokensIn != null || node.tokensOut != null ? (
          <span className="mono muted">{formatTokens(node.tokensIn, node.tokensOut)} tok</span>
        ) : null}
      </div>
      {/* Replay is meaningful only for LLM spans — the ones with a request to re-issue. */}
      {node.kind === "llm" ? (
        <button className="btn btn-block inspect-replay" type="button" onClick={() => onReplay(node)}>
          Replay this call
        </button>
      ) : null}
      <IOBlock label="Input" value={node.input} />
      <IOBlock label="Output" value={node.output} />
      {attrKeys.length > 0 ? (
        <details className="inspect-attrs">
          <summary>Attributes ({attrKeys.length})</summary>
          <dl className="attr-list">
            {attrKeys.map((k) => (
              <div className="attr-row" key={k}>
                <dt className="mono">{k}</dt>
                <dd className="mono">{prettyValue(attributes[k])}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </aside>
  );
};

/** Depth-first search for a span node by id, so a live refresh can re-select the same span. */
const findNode = (root: SpanNode | null, id: string | null): SpanNode | null => {
  if (!root || !id) return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
};

/** The trace detail view (#/trace/:id): header stats + span waterfall + inspector. */
export const TraceDetail = ({ id }: { id: string }) => {
  const [view, setView] = useState<TraceView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [missing, setMissing] = useState(true);
  const [selected, setSelected] = useState<SpanNode | null>(null);
  /** The LLM span currently open in the replay debugger (null when closed). */
  const [replayNode, setReplayNode] = useState<SpanNode | null>(null);
  /** Whether the "save this trace as an eval" dialog is open. */
  const [savingEval, setSavingEval] = useState(false);
  /** Currently-selected span id, so a live refresh can restore the selection after the tree rebuilds. */
  const selectedId = useRef<string | null>(null);
  selectedId.current = selected?.id ?? null;

  /** Load the trace; on a live refresh keep the current selection instead of resetting to the root. */
  const load = useCallback(
    async (preserveSelection: boolean) => {
      try {
        const res = await fetchTrace(id);
        setView(res.view);
        setSelected(
          preserveSelection
            ? (findNode(res.view.tree, selectedId.current) ?? res.view.tree)
            : res.view.tree,
        );
        setStatus("ready");
      } catch (err) {
        // A refresh failure keeps the already-rendered trace on screen.
        if (!preserveSelection) {
          setMissing(isNotFoundError(err));
          setStatus("error");
        }
      }
    },
    [id],
  );

  useEffect(() => {
    setStatus("loading");
    setSelected(null);
    setReplayNode(null); // don't leave a prior trace's span open in the modal across navigation
    void load(false);
  }, [id, load]);

  // Keep an open trace fresh while its spans are still arriving (batch exporters
  // flush mid-run); refetch on tail activity, preserving the selected span.
  useTailRefresh(() => void load(true));

  /** Trace window used to scale the waterfall bars, resilient to missing fields. */
  const timeline = useMemo(() => {
    const startIso = view?.startedAt ?? view?.tree?.startedAt ?? null;
    const startMs = startIso ? Date.parse(startIso) : 0;
    const durationMs = view?.durationMs ?? view?.tree?.durationMs ?? 1;
    return { startMs: Number.isNaN(startMs) ? 0 : startMs, durationMs: durationMs > 0 ? durationMs : 1 };
  }, [view]);

  if (status === "loading") return <div className="notice">Loading trace…</div>;
  if (status === "error" || !view) {
    return (
      <section className="detail">
        <a className="back" href="#/traces">
          ← All traces
        </a>
        <div className="notice notice-error">
          {missing ? "Trace not found." : "Could not load this trace — the local Coach server may be unreachable."}
        </div>
      </section>
    );
  }

  return (
    <section className="detail">
      <a className="back" href="#/traces">
        ← All traces
      </a>

      <header className="detail-head">
        <div className="detail-title-row">
          <StatusDot status={view.status} />
          <h1 className="detail-title">{view.name ?? "Untitled trace"}</h1>
          {view.agent ? <span className="tag">{view.agent}</span> : null}
          <button
            className="btn btn-ghost detail-head-action"
            type="button"
            onClick={() => setSavingEval(true)}
            title="Turn this trace into a repeatable pass/fail check"
          >
            Save as eval
          </button>
        </div>
        <div className="stat-grid">
          <Stat label="Duration" value={<span className="mono">{formatDuration(view.durationMs)}</span>} />
          <Stat label="Spans" value={<span className="mono">{formatNumber(view.spanCount)}</span>} />
          <Stat label="Tokens" value={<span className="mono">{formatTokens(view.tokensIn, view.tokensOut)}</span>} />
          <Stat label="Provider" value={view.provider ?? "—"} />
          <Stat label="Started" value={relativeTime(view.startedAt)} />
        </div>
      </header>

      <div className="detail-body">
        <div className="detail-tree">
          {view.tree ? (
            <SpanTree
              root={view.tree}
              traceStartMs={timeline.startMs}
              traceDurationMs={timeline.durationMs}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          ) : (
            <div className="notice">No spans captured for this trace.</div>
          )}
        </div>
        <InspectPanel node={selected} onReplay={setReplayNode} />
      </div>

      {replayNode ? <ReplayModal node={replayNode} onClose={() => setReplayNode(null)} /> : null}
      {savingEval ? (
        <SaveEvalModal trace={view} selected={selected} onClose={() => setSavingEval(false)} />
      ) : null}
    </section>
  );
};
