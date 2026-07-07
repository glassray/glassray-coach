import { useState } from "react";
import type { SpanNode } from "../api";
import { formatDuration } from "../format";

/** Clamp a number into the inclusive [min, max] range. */
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Props shared by every row and the tree root. */
interface TreeContext {
  traceStartMs: number;
  traceDurationMs: number;
  selectedId: string | null;
  onSelect: (node: SpanNode) => void;
}

/** A single span rendered as a waterfall row, with its children nested below. */
const SpanRow = ({
  node,
  depth,
  ctx,
}: {
  node: SpanNode;
  depth: number;
  ctx: TreeContext;
}) => {
  const [open, setOpen] = useState(true);
  // Defensive: view builders may omit `children` entirely on leaf nodes.
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const selected = ctx.selectedId === node.id;

  const startMs = node.startedAt ? Date.parse(node.startedAt) : Number.NaN;
  const duration = node.durationMs ?? 0;
  const offsetPct = Number.isNaN(startMs)
    ? 0
    : clamp(((startMs - ctx.traceStartMs) / ctx.traceDurationMs) * 100, 0, 100);
  const widthPct = clamp((duration / ctx.traceDurationMs) * 100, 1.5, 100 - offsetPct);
  const barKind = node.status === "error" ? "error" : node.kind;

  return (
    <div className="span-branch">
      <div
        className={`span-row${selected ? " span-row-selected" : ""}`}
        onClick={() => ctx.onSelect(node)}
        style={{ paddingLeft: 10 + depth * 16 }}
      >
        <button
          className={`span-caret${hasChildren ? "" : " span-caret-empty"}`}
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) setOpen((prev) => !prev);
          }}
        >
          {hasChildren ? (open ? "▾" : "▸") : ""}
        </button>
        <span className={`badge badge-${node.kind}`}>{node.kind}</span>
        <span className="span-name">{node.name || "span"}</span>
        <span className="span-track" aria-hidden="true">
          <span
            className={`span-bar span-bar-${barKind}`}
            style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
          />
        </span>
        <span className="span-duration mono">{formatDuration(node.durationMs)}</span>
      </div>
      {hasChildren && open ? (
        <div className="span-children">
          {children.map((child) => (
            <SpanRow key={child.id} node={child} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** The full collapsible span tree for one trace, rooted at `root`. */
export const SpanTree = ({
  root,
  traceStartMs,
  traceDurationMs,
  selectedId,
  onSelect,
}: {
  root: SpanNode;
  traceStartMs: number;
  traceDurationMs: number;
  selectedId: string | null;
  onSelect: (node: SpanNode) => void;
}) => {
  const ctx: TreeContext = {
    traceStartMs,
    traceDurationMs: traceDurationMs > 0 ? traceDurationMs : 1,
    selectedId,
    onSelect,
  };
  return (
    <div className="span-tree">
      <SpanRow node={root} depth={0} ctx={ctx} />
    </div>
  );
};
