/*
 * Source: packages/shared/src/server/traces/facets.ts
 * Vendored for Glassray Coach — refresh by re-copying from the main app.
 * Coach-only changes: the `trace_nodes` insert-row builder (`buildTraceNodeRows`
 * / `TraceNodeRow`, which depends on the app's deterministic-id helper) is
 * dropped — Coach persists no per-node rows; everything else verbatim.
 */

import { createHash } from "node:crypto";
import {
  TRACE_METADATA_ATTRS,
  type TraceMetadataTagKey,
} from "./trace-attributes";
import type { CanonicalNode, NodeKind, TraceEnvelope } from "./normalize";

/*
 * `extractFacets` — the pure, deterministic heart of trace augmentation. Given a
 * normalized `TraceEnvelope` (with its canonical `nodes` tree), it derives the
 * queryable facets. No I/O, no LLM — every value is a function of the tree, so
 * it's cheap to run at ingest and cheap to unit-test.
 */

/** Cap on stored input/output text (chars) — bounded projection, not the full blob. */
export const MAX_TEXT_CHARS = 8000;

/**
 * Framework glue node names (normalized) that appear across ~every trace and so
 * identify no flow — dropped from `nodeNames` + the shape signature. Matched on
 * the name's leading token (the part before any `<…>` generic), lower-cased and
 * stripped to alphanumerics. Start broad-but-obvious; coarsen if shapes explode.
 */
const GLUE_NAMES = new Set([
  "chatopenai",
  "chatanthropic",
  "azurechatopenai",
  "chatvertexai",
  "chatgooglegenerativeai",
  "chatbedrock",
  "runnablesequence",
  "runnablelambda",
  "runnableparallel",
  "runnableassign",
  "runnablebinding",
  "runnablepassthrough",
  "runnablewithfallbacks",
  "runnablemap",
  "chatprompttemplate",
  "prompttemplate",
  "structuredoutputparser",
  "jsonoutputparser",
  "stroutputparser",
  "pydanticoutputparser",
  "channelwrite",
  "langgraph",
  "branch",
  "start",
  "end",
  "write",
]);

/** Lower-case, drop any `<…>` generic suffix, strip to alphanumerics — the glue key. */
const glueKey = (name: string): string =>
  name
    .split("<")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** True when a node name is framework scaffolding rather than a flow/agent step. */
export const isGlueName = (name: string): boolean => GLUE_NAMES.has(glueKey(name));

/**
 * One node's projection for per-node rows. Provider-relative: carries the
 * source's own node id + (orphan-resolved) parent id. Numerics are pre-rounded
 * to match integer columns. `providerParentId` is null at a root OR an
 * orphan-parent (parent absent from the set) — the same root rule the scalar
 * facets use.
 */
export interface TraceNodeFacet {
  providerId: string;
  providerParentId: string | null;
  kind: NodeKind;
  name: string;
  model: string | null;
  provider: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  latencyMs: number | null;
  startedAt: string | null;
  status: "ok" | "error" | null;
  error: string | null;
}

/** The facet record `extractFacets` produces — scalar columns + the tag set. */
export interface TraceFacets {
  /**
   * Provider session/conversation id grouping related traces; `null` when the
   * source carried none. Projected straight from the envelope.
   */
  sessionId: string | null;
  latencyMs: number | null;
  status: "ok" | "error" | null;
  errorCount: number;
  totalTokensIn: number | null;
  totalTokensOut: number | null;
  totalCost: number | null;
  spanCount: number;
  maxDepth: number;
  maxFanOut: number;
  /** Distinct, glue-dropped node names (original casing) — agent-marker substrate. */
  nodeNames: string[];
  /** Hash of the normalized `nodeNames` set; null when there are no meaningful names. */
  shapeSignature: string | null;
  inputText: string | null;
  outputText: string | null;
  /** Set-valued facets (model / tool / provider / §4.2 metadata keys). */
  tags: Array<{ key: string; value: string }>;
  /** Per-node projection; one entry per node. */
  nodes: TraceNodeFacet[];
}

/** Round to an integer, preserving null — for the `integer` facet columns. */
const roundOrNull = (v: number | null): number | null => (v === null ? null : Math.round(v));

/** Sum a per-node numeric attribute across nodes; null when none carried it. */
const sumDefined = (
  nodes: ReadonlyArray<CanonicalNode>,
  pick: (n: CanonicalNode) => number | undefined,
) => {
  let total = 0;
  let any = false;
  for (const n of nodes) {
    const v = pick(n);
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
};

/** Max root→leaf depth + the widest fan-out, computed over the parentId tree (cycle-safe). */
const treeShape = (
  nodes: ReadonlyArray<CanonicalNode>,
): { maxDepth: number; maxFanOut: number } => {
  if (nodes.length === 0) return { maxDepth: 0, maxFanOut: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, CanonicalNode[]>();
  const roots: CanonicalNode[] = [];
  for (const n of nodes) {
    // A node with no parent, or a parent we never saw, is a root.
    if (n.parentId === null || !ids.has(n.parentId)) {
      roots.push(n);
    } else {
      (children.get(n.parentId) ?? children.set(n.parentId, []).get(n.parentId)!).push(n);
    }
  }
  const maxFanOut =
    children.size === 0 ? 0 : Math.max(...[...children.values()].map((c) => c.length));

  let maxDepth = 0;
  // Iterative DFS with a visited guard so a malformed cycle can't loop forever.
  const stack: Array<{ node: CanonicalNode; depth: number }> = roots.map((node) => ({
    node,
    depth: 1,
  }));
  const visited = new Set<string>();
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    if (depth > maxDepth) maxDepth = depth;
    for (const child of children.get(node.id) ?? []) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return { maxDepth, maxFanOut };
};

/** Stringify a value to bounded text, or null. Strings pass through; objects JSON-encode. */
const boundedText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  s = s.trim();
  if (!s) return null;
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
};

/** Push `value` under `key` into the dedupe set + collector. */
const addTag = (
  seen: Set<string>,
  out: Array<{ key: string; value: string }>,
  key: string,
  value: string | undefined,
) => {
  if (!value) return;
  const dedupe = `${key}\u0000${value}`;
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  out.push({ key, value });
};

/**
 * Derive the full facet record from a normalized envelope. Pure — safe to call
 * at ingest and in the backfill.
 */
export const extractFacets = (env: TraceEnvelope): TraceFacets => {
  const nodes = env.nodes ?? [];
  // Usage (tokens / cost) is summed over the `llm` generation nodes ONLY (see
  // the return). Summing every node double-counts: providers like LangSmith roll
  // child usage UP onto parent chain/agent runs, so an all-node sum is ~5× the
  // real total. The leaf generations are the ground truth.
  const llmNodes = nodes.filter((n) => n.kind === "llm");

  const errorCount = nodes.filter((n) => n.status === "error").length;
  const status: "ok" | "error" | null = nodes.length === 0 ? null : errorCount > 0 ? "error" : "ok";

  // A node is a root when it has no parent OR its parent isn't in the set (an
  // orphan-parent root — e.g. an OTLP child span whose parent arrived in another
  // push). Same rule treeShape uses, so latency + depth stay consistent.
  const ids = new Set(nodes.map((n) => n.id));
  const isRoot = (n: CanonicalNode) => n.parentId === null || !ids.has(n.parentId);

  // Trace latency = the widest root span's duration (it encloses its children).
  // Rounded to an integer — OTLP nanosecond timestamps yield fractional ms, and
  // the column is `integer` (an unrounded value makes the whole facet write throw).
  const rootLatencies = nodes
    .filter(isRoot)
    .map((n) => n.latencyMs)
    .filter((v): v is number => typeof v === "number");
  const latencyMs = rootLatencies.length > 0 ? Math.round(Math.max(...rootLatencies)) : null;

  const { maxDepth, maxFanOut } = treeShape(nodes);

  // Meaningful (glue-dropped) distinct node names — original casing preserved.
  const nodeNames: string[] = [];
  const seenNames = new Set<string>();
  for (const n of nodes) {
    if (isGlueName(n.name)) continue;
    if (seenNames.has(n.name)) continue;
    seenNames.add(n.name);
    nodeNames.push(n.name);
  }
  // Langfuse stores the root trace name in `env.name` rather than as a node —
  // observations are the nodes, but the trace itself is not. When all
  // observations are framework glue the name list above is empty even though
  // the trace has a meaningful top-level name (e.g. "trace_classify"). Including
  // it here makes such traces distinguishable so the flow classifier and the
  // unmatched-pool clustering don't mistake them for truly-empty infra spans.
  //
  // The guard is intentionally source-agnostic: any adapter that also omits the
  // root from `nodes` benefits automatically. Any adapter that sets `env.name`
  // to a DIFFERENT value from all its node names — e.g. a display name that
  // differs from the root span's technical name — will have that display name
  // added, which is the correct behaviour (it's a meaningful trace-level label,
  // not glue).
  if (env.name && !isGlueName(env.name) && !seenNames.has(env.name)) {
    seenNames.add(env.name);
    nodeNames.push(env.name);
  }

  // Shape signature: normalized + sorted set of the meaningful names, hashed.
  const normalized = [...new Set(nodeNames.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")))]
    .filter(Boolean)
    .sort();
  const shapeSignature =
    normalized.length === 0
      ? null
      : `shape_${createHash("sha256").update(normalized.join("|")).digest("hex").slice(0, 12)}`;

  // Set-valued facets → tags.
  const tags: Array<{ key: string; value: string }> = [];
  const seenTags = new Set<string>();
  for (const n of nodes) {
    addTag(seenTags, tags, "model", n.model);
    addTag(seenTags, tags, "provider", n.provider);
    if (n.kind === "tool") addTag(seenTags, tags, "tool", n.toolName ?? n.name);
  }
  // §4.2 metadata convention → tags (customer / environment / agent / flow).
  // The adapter resolved the values at normalize time (resource defaults with
  // root-span override); each present key becomes one `{key, value}` tag row.
  if (env.metadata) {
    for (const key of Object.keys(TRACE_METADATA_ATTRS) as TraceMetadataTagKey[]) {
      addTag(seenTags, tags, key, env.metadata[key]);
    }
  }

  // Per-node projection. `isRoot` resolves orphan-parents to null exactly as
  // the latency/depth rules above, so the derived tree is consistent.
  const nodeFacets: TraceNodeFacet[] = nodes.map((n) => ({
    providerId: n.id,
    providerParentId: isRoot(n) ? null : n.parentId,
    kind: n.kind,
    name: n.name,
    model: n.model ?? null,
    provider: n.provider ?? null,
    tokensIn: roundOrNull(n.tokensIn ?? null),
    tokensOut: roundOrNull(n.tokensOut ?? null),
    cost: n.cost ?? null,
    latencyMs: roundOrNull(n.latencyMs ?? null),
    startedAt: n.startedAt ?? null,
    status: n.status ?? null,
    error: n.error ?? null,
  }));

  return {
    // Session id is a passthrough from the envelope (no tree derivation) — the
    // adapters resolved it from each provider's own field at normalize time.
    sessionId: env.sessionId ?? null,
    latencyMs,
    status,
    errorCount,
    // llm-only (see `llmNodes` above) so rolled-up parent usage isn't
    // double-counted. Token columns are `integer` — round defensively in case a
    // source reports fractional usage (cost is a `real` column, stays exact).
    totalTokensIn: roundOrNull(sumDefined(llmNodes, (n) => n.tokensIn)),
    totalTokensOut: roundOrNull(sumDefined(llmNodes, (n) => n.tokensOut)),
    totalCost: sumDefined(llmNodes, (n) => n.cost),
    spanCount: nodes.length,
    maxDepth,
    maxFanOut,
    nodeNames,
    shapeSignature,
    inputText: boundedText(env.input),
    outputText: boundedText(env.output),
    tags,
    nodes: nodeFacets,
  };
};
