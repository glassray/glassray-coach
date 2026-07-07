/*
 * Source: packages/shared/src/server/traces/types.ts (envelope types) +
 *         packages/shared/src/server/traces/normalize.ts (OTLP path only).
 * Vendored for Glassray Coach — refresh by re-copying from the main app.
 * Coach-only changes: the Langfuse / LangSmith / PostHog / mock-LangGraph
 * adapters are dropped (`RawProvider` narrows to "otlp"); `compactTrace` is
 * skipped (the `shared` $ref dict is an LLM-consumption optimization the local
 * viewer doesn't need); `NodeKind` is defined directly as a Zod enum instead of
 * being single-sourced from the domain skeleton types; the attribute-map
 * helpers are widened to `Record<string, unknown>` and exported (with the
 * node-kind ladder extracted as `otlpNodeKind`) so `index.ts` can reuse the
 * exact alias-ladder logic per tree node.
 */

import { z } from "zod";
import {
  GEN_AI_COMPLETION_PREFIX,
  GEN_AI_PROMPT_PREFIX,
  TRACE_ATTR,
  TRACE_METADATA_ATTRS,
  TRACE_PROVIDER_LADDER,
  TRACE_SESSION_LADDER,
  TRACE_TOKENS_IN_LADDER,
  TRACE_TOKENS_OUT_LADDER,
  TRACE_TOOL_NAME_LADDER,
  type TraceMetadataTagKey,
} from "./trace-attributes";

// ── envelope types (from server/traces/types.ts) ────────────────────────────

/** A single normalized step within a trace. Flat, ordered. */
export const TraceStep = z.object({
  index: z.number().int().min(0),
  name: z.string(),
  runType: z.string().optional(),
  inputs: z.unknown().optional(),
  outputs: z.unknown().optional(),
  toolResults: z.array(z.unknown()).optional(),
  goto: z.string().optional(),
});
export type TraceStep = z.infer<typeof TraceStep>;

/**
 * What a canonical node *is*. `workflow` is an orchestration container (a
 * chain / graph / runnable-sequence) that sequences children rather than doing
 * leaf work — it's the framework glue dropped from the shape signature.
 * `unknown` covers nodes whose source type doesn't map cleanly.
 */
export const NodeKind = z.enum(["llm", "tool", "retriever", "agent", "workflow", "unknown"]);
export type NodeKind = z.infer<typeof NodeKind>;

/**
 * One node of the provider-agnostic canonical tree. The structural +
 * per-node-attribute skeleton trace augmentation reads — deliberately LIGHT
 * (no per-node inputs/outputs; those stay on `TraceStep` for the LLM
 * consumers and as the trace-level input/output projections). The tree is
 * carried as a flat array linked by `parentId` (`null` at the root); every
 * attribute is best-effort and absent when the source didn't instrument it.
 */
export const CanonicalNode = z.object({
  /** Stable id within the trace (the source's span/run/observation id, else synthesized). */
  id: z.string(),
  /** Parent node id, or `null` for a root. */
  parentId: z.string().nullable(),
  kind: NodeKind,
  name: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  cost: z.number().optional(),
  /** ISO start time, when the source carried one. */
  startedAt: z.string().optional(),
  latencyMs: z.number().optional(),
  status: z.enum(["ok", "error"]).optional(),
  error: z.string().optional(),
  /** For `tool` nodes: the tool/function name (often == `name`). */
  toolName: z.string().optional(),
});
export type CanonicalNode = z.infer<typeof CanonicalNode>;

/** Provider-agnostic normalized trace. Only the OTLP source is vendored here. */
export const TraceEnvelope = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(["mock-langgraph", "langsmith", "langfuse", "posthog", "otlp"]),
  traceId: z.string(),
  /** Stamped by the loader; never read from the raw file. */
  organizationId: z.string(),
  /**
   * Provider session / conversation / thread id that groups related traces
   * (a multi-turn chat). Extracted by each adapter from the provider's own
   * session field; `undefined` when the source carried none.
   */
  sessionId: z.string().nullish(),
  name: z.string().optional(),
  input: z.unknown(),
  output: z.unknown(),
  steps: z.array(TraceStep),
  /**
   * The canonical node tree (flat, linked by `parentId`) — the structural
   * substrate trace augmentation extracts facets, the shape signature, and
   * agent markers from. Defaults to `[]` so envelopes predating it still parse;
   * every adapter populates it. Distinct from `steps`, which stays the flat,
   * input/output-carrying view the deviation-discovery LLM path reads.
   */
  nodes: z.array(CanonicalNode).default([]),
  /**
   * The §4.2 metadata convention (APP-14691) resolved at normalize time —
   * customer / environment / agent / flow. Only the OTLP adapter populates it
   * today (resource attributes as the default, root-span attributes winning).
   * `extractFacets` projects each present key into a tag.
   */
  metadata: z
    .object({
      customer: z.string().optional(),
      environment: z.string().optional(),
      agent: z.string().optional(),
      flow: z.string().optional(),
    })
    .optional(),
  /**
   * Content-addressed shared dict populated by `compactTrace` in the main app.
   * Never populated by the Coach vendoring (compaction is skipped) but kept so
   * envelopes stay schema-compatible.
   */
  shared: z.record(z.string(), z.unknown()).optional(),
});
export type TraceEnvelope = z.infer<typeof TraceEnvelope>;

// ── shared helpers (from normalize.ts) ───────────────────────────────────────

/**
 * First non-empty trimmed string among the candidates, else `undefined`. Used
 * to resolve a session/conversation id from the several keys a provider might
 * carry it under.
 */
const firstString = (...candidates: Array<unknown>): string | undefined => {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
};

/**
 * Map a source's node-type token (OTLP `gen_ai.operation.name`, or an explicit
 * `glassray.span.kind`) to a canonical `NodeKind`. Chains / graphs / sequences
 * collapse to `workflow` (orchestration glue); anything unrecognised is
 * `unknown` (then `refineKindByName` gets a last shot).
 */
export const mapKind = (rawType: string | undefined): NodeKind => {
  switch ((rawType ?? "").toLowerCase()) {
    // `text_completion` / `generate_content` are the OTel GenAI
    // `gen_ai.operation.name` chat-generation spellings.
    case "llm":
    case "chat":
    case "generation":
    case "text_completion":
    case "generate_content":
      return "llm";
    case "tool":
    case "function":
    case "execute_tool":
      return "tool";
    case "retriever":
    case "retrieval":
      return "retriever";
    case "agent":
    case "invoke_agent":
      return "agent";
    case "chain":
    case "workflow":
    case "graph":
    case "span":
      return "workflow";
    default:
      return "unknown";
  }
};

/**
 * Last-resort kind from the node name, used only to upgrade a `workflow` /
 * `unknown` node when the source type was coarse — a name screaming
 * "retriever"/"tool"/"agent" is a strong signal. Never downgrades a kind the
 * source stated explicitly.
 */
export const refineKindByName = (kind: NodeKind, name: string): NodeKind => {
  if (kind !== "workflow" && kind !== "unknown") return kind;
  const n = name.toLowerCase();
  if (/retriev|vector|search|rag/.test(n)) return "retriever";
  if (/(^|[^a-z])tool([^a-z]|$)|function/.test(n)) return "tool";
  if (/agent/.test(n)) return "agent";
  return kind;
};

/** Coerce to a finite number, or `undefined`. */
const numOr = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Milliseconds between two ISO/epoch timestamps, or `undefined` if either is missing. */
const latencyMs = (
  start: string | number | null | undefined,
  end: string | number | null | undefined,
): number | undefined => {
  const a = epochMs(start);
  const b = epochMs(end);
  if (a === undefined || b === undefined || b < a) return undefined;
  return b - a;
};

/**
 * A timestamp (ISO string or epoch ms/number) → epoch ms, or `undefined`.
 * Tolerates `null` (a running/incomplete span often has a `null` `endTime`)
 * by treating it the same as missing.
 */
const epochMs = (value: string | number | null | undefined): number | undefined => {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Normalize a timestamp to an ISO string for `startedAt`, or `undefined`. */
const toIso = (value: string | number | null | undefined): string | undefined => {
  const ms = epochMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
};

// ── OTLP ───────────────────────────────────────────────────────────────────

/** An OTLP attribute value — the union OTLP serialises scalars as. */
const OtlpAttrValue = z
  .object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
  })
  .passthrough();

const OtlpSpan = z
  .object({
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),
    name: z.string().optional(),
    startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    endTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    attributes: z
      .array(z.object({ key: z.string(), value: OtlpAttrValue }).passthrough())
      .default([]),
    status: z
      .object({ code: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
type OtlpSpan = z.infer<typeof OtlpSpan>;

/** An OTLP attribute list (`[{ key, value }]`) — on a span OR a resource. */
const OtlpAttrList = z
  .array(z.object({ key: z.string(), value: OtlpAttrValue }).passthrough())
  .default([]);

const OtlpRaw = z.object({
  resourceSpans: z
    .array(
      z
        .object({
          // Resource-level attributes — where a session/conversation id is most
          // often set (the exporter stamps it once per resource, not per span).
          resource: z.object({ attributes: OtlpAttrList }).passthrough().optional(),
          scopeSpans: z
            .array(z.object({ spans: z.array(OtlpSpan).default([]) }).passthrough())
            .default([]),
        })
        .passthrough(),
    )
    .default([]),
});

/**
 * Resolve a trace's session id from the already-flattened attribute maps:
 * resource attributes first (the common placement), then every span, for the
 * first `TRACE_SESSION_LADDER` hit. `undefined` when none is present. Takes
 * flattened maps (not the raw document) so `fromOtlp`'s per-span cache is
 * reused instead of re-flattening every attribute list.
 */
const otlpSessionId = (
  resourceAttrs: OtlpAttrMap,
  spanAttrs: readonly OtlpAttrMap[],
): string | undefined => {
  const fromResource = attrString(resourceAttrs, TRACE_SESSION_LADDER);
  if (fromResource !== undefined) return fromResource;
  for (const a of spanAttrs) {
    const v = attrString(a, TRACE_SESSION_LADDER);
    if (v !== undefined) return v;
  }
  return undefined;
};

/** Flatten an OTLP attribute list into a plain `{ key: scalar }` map. */
const otlpAttrs = (
  attributes: OtlpSpan["attributes"],
): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {};
  for (const { key, value } of attributes) {
    if (value.stringValue !== undefined) out[key] = value.stringValue;
    else if (value.intValue !== undefined) out[key] = Number(value.intValue);
    else if (value.doubleValue !== undefined) out[key] = value.doubleValue;
    else if (value.boolValue !== undefined) out[key] = value.boolValue;
  }
  return out;
};

/** A flattened OTLP attribute map, as `otlpAttrs` produces. */
type OtlpAttrMap = Record<string, string | number | boolean>;

/** First non-empty trimmed string among an alias ladder's keys — `firstString` over a map. */
export const attrString = (
  a: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => firstString(...keys.map((key) => a[key]));

/** First finite number among an alias ladder's keys, else `undefined`. */
export const attrNumber = (
  a: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const n = numOr(a[key]);
    if (n !== undefined) return n;
  }
  return undefined;
};

/**
 * Parse a content string that looks like JSON (an object/array), keeping the
 * raw string on parse failure or when it isn't JSON-shaped. Content attributes
 * are OTLP strings on the wire, but structured content (messages arrays, tool
 * args) reads far better restored to its real shape.
 */
const parseMaybeJson = (s: string): unknown => {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return s;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return s;
  }
};

/**
 * Reassemble the deprecated-but-ubiquitous OpenLLMetry indexed attribute
 * family (`gen_ai.prompt.0.role`, `gen_ai.prompt.0.content`, … or the
 * `gen_ai.completion.{i}.*` mirror) into an ordered array of message objects.
 * `undefined` when the span carries nothing under the prefix.
 */
const collectIndexedMessages = (a: Record<string, unknown>, prefix: string): unknown => {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(a)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length); // e.g. "0.role"
    const dot = rest.indexOf(".");
    if (dot <= 0) continue;
    const index = Number(rest.slice(0, dot));
    const field = rest.slice(dot + 1);
    if (!Number.isInteger(index) || index < 0 || field.length === 0) continue;
    const message = byIndex.get(index) ?? {};
    message[field] = typeof value === "string" ? parseMaybeJson(value) : value;
    byIndex.set(index, message);
  }
  if (byIndex.size === 0) return undefined;
  return [...byIndex.entries()].sort(([x], [y]) => x - y).map(([, message]) => message);
};

/**
 * Resolve one span's content via a §4.3 v0 ladder: the JSON-string messages
 * attribute → the OpenInference value attribute → the indexed OpenLLMetry
 * family under `indexedPrefix`. One body serves both directions so a new
 * ladder rung (or a rung-skipping rule) can never apply to only one of them.
 * An empty-string value counts as absent — the next rung still gets its shot.
 */
const otlpSpanContent = (
  a: Record<string, unknown>,
  messagesKey: string,
  valueKey: string,
  indexedPrefix: string,
): unknown => {
  const messagesRaw = a[messagesKey];
  if (typeof messagesRaw === "string" && messagesRaw.length > 0) return parseMaybeJson(messagesRaw);
  const value = a[valueKey];
  if (typeof value === "string") {
    if (value.length > 0) return parseMaybeJson(value);
  } else if (value !== undefined) {
    return value;
  }
  return collectIndexedMessages(a, indexedPrefix);
};

/**
 * One span's input content (`gen_ai.input.messages` → `input.value` →
 * `gen_ai.prompt.{i}.*`); when the messages attribute matched and
 * `gen_ai.system_instructions` accompanies it, both are carried together.
 */
export const otlpSpanInput = (a: Record<string, unknown>): unknown => {
  const content = otlpSpanContent(
    a,
    TRACE_ATTR.GEN_AI_INPUT_MESSAGES,
    TRACE_ATTR.INPUT_VALUE,
    GEN_AI_PROMPT_PREFIX,
  );
  const instructions = a[TRACE_ATTR.GEN_AI_SYSTEM_INSTRUCTIONS];
  const messagesRaw = a[TRACE_ATTR.GEN_AI_INPUT_MESSAGES];
  const hasMessages = typeof messagesRaw === "string" && messagesRaw.length > 0;
  if (hasMessages && typeof instructions === "string" && instructions.length > 0) {
    return { systemInstructions: parseMaybeJson(instructions), messages: content };
  }
  return content;
};

/** One span's output content (`gen_ai.output.messages` → `output.value` → `gen_ai.completion.{i}.*`). */
export const otlpSpanOutput = (a: Record<string, unknown>): unknown =>
  otlpSpanContent(
    a,
    TRACE_ATTR.GEN_AI_OUTPUT_MESSAGES,
    TRACE_ATTR.OUTPUT_VALUE,
    GEN_AI_COMPLETION_PREFIX,
  );

/**
 * Canonical node kind for one OTLP span's flattened attributes. Kind ladder,
 * first non-`unknown` wins: declared `gen_ai.operation.name` → explicit
 * `glassray.span.kind` → infer `llm` from a request model (common with partial
 * instrumentation; only when NO operation was declared, so a declared non-llm
 * op is respected) → the `refineKindByName` name heuristics as the last resort.
 */
export const otlpNodeKind = (a: Record<string, unknown>, name: string): NodeKind => {
  const op = attrString(a, [TRACE_ATTR.GEN_AI_OPERATION_NAME]);
  const model = attrString(a, [TRACE_ATTR.GEN_AI_REQUEST_MODEL]);
  const declaredKind = attrString(a, [TRACE_ATTR.GLASSRAY_SPAN_KIND]);
  let kind: NodeKind = op !== undefined ? mapKind(op) : "unknown";
  if (kind === "unknown" && declaredKind !== undefined) kind = mapKind(declaredKind);
  if (kind === "unknown" && op === undefined && model !== undefined) kind = "llm";
  return refineKindByName(kind, name);
};

/**
 * Resolve the §4.2 metadata convention (customer / environment / agent / flow)
 * for an OTLP document: resource attributes are the per-process default and
 * the ROOT span's attributes override (root wins), each key reading its
 * `TRACE_METADATA_ATTRS` alias ladder. `undefined` when nothing resolved, so
 * non-SDK traffic adds no envelope field.
 */
const otlpMetadata = (
  resourceAttrs: OtlpAttrMap,
  rootAttrs: OtlpAttrMap,
): Partial<Record<TraceMetadataTagKey, string>> | undefined => {
  const out: Partial<Record<TraceMetadataTagKey, string>> = {};
  for (const key of Object.keys(TRACE_METADATA_ATTRS) as TraceMetadataTagKey[]) {
    const ladder = TRACE_METADATA_ATTRS[key];
    const value = attrString(rootAttrs, ladder) ?? attrString(resourceAttrs, ladder);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Nanosecond epoch (OTLP serialises as a string) → epoch ms, or `undefined`. */
const nanoToMs = (nano: string | number | undefined): number | undefined => {
  if (nano === undefined) return undefined;
  const n = typeof nano === "string" ? Number(nano) : nano;
  return Number.isFinite(n) ? n / 1e6 : undefined;
};

/**
 * Map a stored OTLP `{ resourceSpans }` document into the normalized
 * `TraceEnvelope`. Spans across all resource/scope groups are flattened, the
 * tree is rebuilt from `parentSpanId`, and per-node attributes are read from
 * the §4.3 alias ladders (`gen_ai.*` GenAI semconv + OpenInference
 * `input.value`/`output.value` + the `glassray.*` vocabulary). Span content
 * lands on `steps[].inputs/outputs`; the ROOT span's content becomes the
 * trace-level input/output (the Langfuse rule). `organizationId` is stamped by
 * the caller. Tokens/cost are best-effort — absent unless the exporter set them.
 */
export const fromOtlp = (raw: unknown, organizationId: string): TraceEnvelope => {
  const parsed = OtlpRaw.parse(raw);
  const spans = parsed.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
  if (spans.length === 0) throw new Error("otlp document has no spans");
  const traceId = spans.find((s) => s.traceId)?.traceId;
  if (!traceId) throw new Error("otlp spans are missing `traceId`");

  // Flatten each span's attribute list once — nodes, steps, and the root
  // content/metadata reads all consume the same map.
  const attrCache = new Map<OtlpSpan, OtlpAttrMap>();
  /** Memoized flattened attributes for one span. */
  const attrsOf = (s: OtlpSpan): OtlpAttrMap => {
    let a = attrCache.get(s);
    if (!a) {
      a = otlpAttrs(s.attributes);
      attrCache.set(s, a);
    }
    return a;
  };

  /** Per-span start in ms, for ordering. */
  const startOf = (s: OtlpSpan) => nanoToMs(s.startTimeUnixNano) ?? Number.POSITIVE_INFINITY;
  const ordered = spans
    .map((span, originalIndex) => ({ span, originalIndex }))
    .sort((a, b) => {
      const d = startOf(a.span) - startOf(b.span);
      return d !== 0 ? d : a.originalIndex - b.originalIndex;
    });

  const nodes: CanonicalNode[] = spans.map((span, index) => {
    const a = attrsOf(span);
    const name = span.name ?? "span";
    const code = String(span.status?.code ?? "");
    const errored = code === "2" || code.toUpperCase() === "STATUS_CODE_ERROR";
    return {
      id: span.spanId ?? `span-${index}`,
      parentId: span.parentSpanId ? span.parentSpanId : null,
      kind: otlpNodeKind(a, name),
      name,
      model: attrString(a, [TRACE_ATTR.GEN_AI_REQUEST_MODEL]),
      provider: attrString(a, TRACE_PROVIDER_LADDER),
      tokensIn: attrNumber(a, TRACE_TOKENS_IN_LADDER),
      tokensOut: attrNumber(a, TRACE_TOKENS_OUT_LADDER),
      startedAt: toIso(nanoToMs(span.startTimeUnixNano)),
      latencyMs: latencyMs(nanoToMs(span.startTimeUnixNano), nanoToMs(span.endTimeUnixNano)),
      status: errored ? "error" : "ok",
      toolName: attrString(a, TRACE_TOOL_NAME_LADDER),
    };
  });

  const steps: TraceStep[] = ordered.map(({ span }, index) => {
    const a = attrsOf(span);
    return {
      index,
      name: span.name ?? "span",
      runType: attrString(a, [TRACE_ATTR.GEN_AI_OPERATION_NAME]),
      inputs: otlpSpanInput(a),
      outputs: otlpSpanOutput(a),
    };
  });

  // Trace-level content = the ROOT span's resolved input/output (the Langfuse
  // rule, and exactly what the SDK's root `input.value`/`output.value` carry).
  // Only a true parentless root qualifies: a partial batch of child spans (a
  // generic exporter flushing mid-run, with replace-not-merge ingest) must not
  // promote an arbitrary span's content or `glassray.*` overrides to trace
  // level. The root's content is reused from its already-resolved step.
  const rootSpan = spans.find((s) => !s.parentSpanId);
  const rootStep = rootSpan
    ? steps[ordered.findIndex(({ span }) => span === rootSpan)]
    : undefined;
  const rootAttrs: OtlpAttrMap = rootSpan ? attrsOf(rootSpan) : {};

  // Resource-level attributes across groups, first occurrence winning — the
  // per-process metadata defaults the root span may override.
  const resourceAttrs: OtlpAttrMap = {};
  for (const rs of parsed.resourceSpans) {
    for (const [k, v] of Object.entries(otlpAttrs(rs.resource?.attributes ?? []))) {
      if (!(k in resourceAttrs)) resourceAttrs[k] = v;
    }
  }

  const envelope: TraceEnvelope = {
    schemaVersion: 1,
    source: "otlp",
    traceId,
    organizationId,
    sessionId: otlpSessionId(
      resourceAttrs,
      spans.map((s) => attrsOf(s)),
    ),
    name: rootSpan?.name,
    input: rootStep?.inputs,
    output: rootStep?.outputs,
    metadata: otlpMetadata(resourceAttrs, rootAttrs),
    steps,
    nodes,
  };

  // Coach vendoring: `compactTrace` is intentionally skipped (see header).
  return TraceEnvelope.parse(envelope);
};

// ── dispatcher ───────────────────────────────────────────────────────────────

/** Providers whose stored raw documents this vendored `normalizeRaw` can normalize. */
export type RawProvider = "otlp";

/**
 * Map a stored raw provider document to a `TraceEnvelope`, dispatching on the
 * trace's `provider`. `organizationId` is supplied by the caller — never read
 * from the document. Only the OTLP branch is vendored for Glassray Coach.
 */
export const normalizeRaw = (
  raw: unknown,
  provider: RawProvider,
  organizationId: string,
): TraceEnvelope => {
  switch (provider) {
    case "otlp":
      return fromOtlp(raw, organizationId);
    default: {
      // Exhaustiveness guard — a new provider must add a branch here.
      const exhaustive: never = provider;
      throw new Error(`unknown trace provider: ${String(exhaustive)}`);
    }
  }
};
