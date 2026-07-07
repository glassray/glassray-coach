/*
 * Source: Glassray Coach assembly over the vendored main-app modules
 * (trace-attributes.ts, trace-tree.ts, normalize.ts, facets.ts,
 * input-preview.ts — see each file's header for its exact source path).
 * Vendored for Glassray Coach — refresh by re-copying from the main app.
 *
 * `buildTraceView(otlpEnvelope, traceId)` derives the per-trace display view
 * the Coach server persists at ingest and recomputes on read
 * (coach/server/trace-view.ts loads this module dynamically): the structural
 * span tree comes from the domain OTLP builder, the canonical kinds / status /
 * aggregates from the normalize + facets pipeline, and per-node LLM content
 * from the §4.3 alias ladders (`gen_ai.input/output.messages` →
 * `input.value`/`output.value` → indexed `gen_ai.prompt.{i}.*`).
 */

import { extractFacets } from "./facets";
import { extractInputPreview } from "./input-preview";
import {
  attrString,
  fromOtlp,
  otlpNodeKind,
  otlpSpanInput,
  otlpSpanOutput,
  type NodeKind,
} from "./normalize";
import { TRACE_ATTR } from "./trace-attributes";
import { buildOtlpTree, flattenAttrList, type TraceNode } from "./trace-tree";

// Re-export the vendored surfaces so Coach code can reach any of them through
// the single "./vendor/index.js" entry point.
export * from "./trace-attributes";
export { buildOtlpTree, flattenAttrList } from "./trace-tree";
export type { TraceNode, TraceTree, TraceProvider } from "./trace-tree";
export {
  fromOtlp,
  normalizeRaw,
  otlpNodeKind,
  otlpSpanInput,
  otlpSpanOutput,
  attrString,
  attrNumber,
  mapKind,
  refineKindByName,
  CanonicalNode,
  NodeKind,
  TraceEnvelope,
  TraceStep,
} from "./normalize";
export type { RawProvider } from "./normalize";
export { extractFacets, isGlueName, MAX_TEXT_CHARS } from "./facets";
export type { TraceFacets, TraceNodeFacet } from "./facets";
export { extractInputPreview, INPUT_PREVIEW_MAX } from "./input-preview";

/** Badge kinds the Coach UI renders; canonical retriever/workflow/unknown collapse to "span". */
export type SpanKind = "agent" | "llm" | "tool" | "span";

/** One node of the nested span tree the Coach UI renders; children nest recursively. */
export interface SpanNode {
  id: string;
  name: string;
  kind: SpanKind;
  startedAt: string | null;
  durationMs: number | null;
  status: "ok" | "error" | null;
  /** The OTLP span status.message (why it failed), when present. */
  statusMessage?: string | null;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** The span's flattened OTLP attributes, for the inspector's raw view. */
  attributes?: Record<string, unknown>;
  children: SpanNode[];
}

/** The per-trace display view the Coach server persists at ingest and serves from GET /api/traces/:id. */
export interface TraceView {
  name: string | null;
  agent: string | null;
  provider: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  spanCount: number;
  status: "ok" | "error" | null;
  tokensIn: number | null;
  tokensOut: number | null;
  inputPreview: string | null;
  outputPreview: string | null;
  tree: SpanNode | null;
}

/** Sentinel organizationId for the single-tenant local envelope (the schema requires one; Coach has no orgs). */
const LOCAL_ORG_ID = "local";

/** Narrow an OTLP envelope to the spans of one trace (case-insensitive 32-hex id), preserving resource/scope wrappers. */
export const filterEnvelopeToTrace = (
  envelope: unknown,
  traceId: string,
): { resourceSpans: unknown[] } => {
  const wanted = traceId.toLowerCase();
  const kept: unknown[] = [];
  const resourceSpans = (envelope as { resourceSpans?: unknown } | null)?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return { resourceSpans: kept };
  for (const rs of resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown } | null)?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    const keptScopes: unknown[] = [];
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown } | null)?.spans;
      if (!Array.isArray(spans)) continue;
      const matching = spans.filter((s) => {
        const id = (s as { traceId?: unknown } | null)?.traceId;
        return typeof id === "string" && id.toLowerCase() === wanted;
      });
      if (matching.length > 0) keptScopes.push({ ...(ss as object), spans: matching });
    }
    if (keptScopes.length > 0) kept.push({ ...(rs as object), scopeSpans: keptScopes });
  }
  return { resourceSpans: kept };
};

/** Merge resource-level attributes across all groups, first occurrence winning. */
const collectResourceAttrs = (envelope: { resourceSpans: unknown[] }): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const rs of envelope.resourceSpans) {
    const attrs = flattenAttrList(
      (rs as { resource?: { attributes?: unknown } } | null)?.resource?.attributes,
    );
    for (const [k, v] of Object.entries(attrs)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
};

/** Collapse a canonical NodeKind onto the UI's four badge kinds. */
const collapseKind = (kind: NodeKind): SpanKind =>
  kind === "agent" || kind === "llm" || kind === "tool" ? kind : "span";

/** True when a raw OTLP span carries an error status code (2 / STATUS_CODE_ERROR). */
const spanErrored = (raw: unknown): boolean => {
  const code = (raw as { status?: { code?: unknown } } | null)?.status?.code;
  return String(code ?? "") === "2" || String(code ?? "").toUpperCase() === "STATUS_CODE_ERROR";
};

/** Read a raw OTLP span's status.message, when it is a non-empty string. */
const spanStatusMessage = (raw: unknown): string | null => {
  const msg = (raw as { status?: { message?: unknown } } | null)?.status?.message;
  return typeof msg === "string" && msg.length > 0 ? msg : null;
};

/** Map a structural TraceNode to a display SpanNode, resolving kind + content via the alias ladders. */
const toSpanNode = (node: TraceNode): SpanNode => ({
  id: node.id,
  name: node.name,
  kind: collapseKind(otlpNodeKind(node.attributes, node.name)),
  startedAt: node.startMs !== null ? new Date(node.startMs).toISOString() : null,
  durationMs: node.durationMs !== null ? Math.round(node.durationMs) : null,
  status: spanErrored(node.raw) ? "error" : "ok",
  statusMessage: spanStatusMessage(node.raw),
  // §4.3 ladder first (messages → value → indexed family), then the tree
  // builder's legacy bare `gen_ai.prompt`/`gen_ai.completion` reads.
  input: otlpSpanInput(node.attributes) ?? node.input ?? undefined,
  output: otlpSpanOutput(node.attributes) ?? node.output ?? undefined,
  model: node.model,
  tokensIn: node.tokens.input,
  tokensOut: node.tokens.output,
  attributes: node.attributes,
  children: node.children.map(toSpanNode),
});

/** Sibling start-time sort for grafted orphan roots; missing timestamps last. */
const byNodeStart = (a: SpanNode, b: SpanNode): number => {
  const am = a.startedAt !== null ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
  const bm = b.startedAt !== null ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
  return am - bm;
};

/** Earliest start / latest end (epoch ms) across a structural tree, or nulls when untimed. */
const traceWindow = (roots: TraceNode[]): { startMs: number | null; endMs: number | null } => {
  let startMs: number | null = null;
  let endMs: number | null = null;
  /** DFS accumulator over one subtree. */
  const visit = (n: TraceNode): void => {
    if (n.startMs !== null && (startMs === null || n.startMs < startMs)) startMs = n.startMs;
    if (n.endMs !== null && (endMs === null || n.endMs > endMs)) endMs = n.endMs;
    for (const child of n.children) visit(child);
  };
  for (const root of roots) visit(root);
  return { startMs, endMs };
};

/** The all-null view for a trace with no spans in the envelope. */
const emptyView = (): TraceView => ({
  name: null,
  agent: null,
  provider: null,
  startedAt: null,
  endedAt: null,
  durationMs: null,
  spanCount: 0,
  status: null,
  tokensIn: null,
  tokensOut: null,
  inputPreview: null,
  outputPreview: null,
  tree: null,
});

/**
 * Derive the display view for one traceId from a raw OTLP/JSON envelope. The
 * envelope may carry several traces (one POST = one envelope); only spans of
 * `traceId` are considered. Aggregates follow the main app's facet rules
 * (llm-only token sums, widest-root latency, any-error status); `agent`
 * resolves `glassray.agent` (root over resource) → root `gen_ai.agent.name` →
 * resource `service.name`.
 */
export const buildTraceView = (otlpEnvelope: unknown, traceId: string): TraceView => {
  const filtered = filterEnvelopeToTrace(otlpEnvelope, traceId);
  const tree = buildOtlpTree(filtered);
  if (tree.spanCount === 0) return emptyView();

  const envelope = fromOtlp(filtered, LOCAL_ORG_ID);
  const facets = extractFacets(envelope);

  // Single UI root: the earliest-starting structural root; any extra roots
  // (orphan-parent spans from partial batches) are grafted under it so no
  // captured span disappears from the waterfall.
  const roots = tree.roots.map(toSpanNode);
  const primary = roots[0] ?? null;
  if (primary !== null && roots.length > 1) {
    primary.children = [...primary.children, ...roots.slice(1)].sort(byNodeStart);
  }

  const { startMs, endMs } = traceWindow(tree.roots);
  const resourceAttrs = collectResourceAttrs(filtered);
  const rootAttrs = tree.roots[0]?.attributes ?? {};

  return {
    name: envelope.name ?? primary?.name ?? null,
    agent:
      envelope.metadata?.agent ??
      attrString(rootAttrs, [TRACE_ATTR.GEN_AI_AGENT_NAME]) ??
      attrString(resourceAttrs, ["service.name"]) ??
      null,
    provider: envelope.nodes.find((n) => n.provider !== undefined)?.provider ?? null,
    startedAt: startMs !== null ? new Date(startMs).toISOString() : null,
    endedAt: endMs !== null ? new Date(endMs).toISOString() : null,
    durationMs:
      facets.latencyMs ??
      (startMs !== null && endMs !== null ? Math.round(endMs - startMs) : null),
    spanCount: facets.spanCount,
    status: facets.status,
    tokensIn: facets.totalTokensIn,
    tokensOut: facets.totalTokensOut,
    inputPreview: extractInputPreview(envelope.input),
    outputPreview: extractInputPreview(envelope.output),
    tree: primary,
  };
};
