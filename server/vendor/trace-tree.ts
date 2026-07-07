/*
 * Source: packages/shared/src/domain/trace-tree/types.ts + packages/shared/src/domain/trace-tree/otlp.ts
 * Vendored for Glassray Coach — refresh by re-copying from the main app.
 * Coach-only changes: `TraceProvider` narrowed to the literal "otlp" (Coach is
 * OTLP-only) and `flattenAttrList` exported so `index.ts` can read resource
 * attributes; body otherwise verbatim.
 */

/*
 * Provider-agnostic span-tree the trace viewer renders. Each raw provider
 * payload is mapped into a tree of these via a per-provider builder; only the
 * OTLP builder is vendored here. Optional fields are genuinely optional: when
 * a provider doesn't surface duration / cost / tokens, the field is left
 * undefined and the UI renders a "—".
 */

/** The one trace provider Glassray Coach ingests. */
export type TraceProvider = "otlp";

/**
 * One node in the trace tree. The shape is intentionally close to LangSmith's
 * since LangSmith carries the richest data (parent ids + start/end + tokens),
 * with Langfuse and OTLP filling in what they can.
 */
export type TraceNode = {
  /** Stable provider-side span id. Used as React key + parent lookup. */
  id: string;
  /** Parent span id, or `null` for the root. */
  parentId: string | null;
  /** Display name (OTLP: `name`). */
  name: string;
  /**
   * Coarse run kind. OTLP gets a derived label (`llm` if the span carries
   * `gen_ai.*` attributes, otherwise the OTLP `kind` lowercased — `internal`,
   * `client`, `server`, `producer`, `consumer`).
   */
  kind: string | null;
  /** Epoch ms when the span started, when the provider exposes it. */
  startMs: number | null;
  /** Epoch ms when the span ended, when the provider exposes it. */
  endMs: number | null;
  /** Convenience — `endMs - startMs` when both are present, else `null`. */
  durationMs: number | null;
  /** Model id when the span is a generation (OTLP `gen_ai.request.model`). */
  model: string | null;
  /** Prompt / completion / total token counts when the provider records them. */
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
  };
  /** Aggregate USD cost on this span when the provider records it. */
  costUsd: number | null;
  /** The span's input payload (OTLP `attributes['gen_ai.prompt']`). */
  input: unknown;
  /** The span's output payload (symmetric to `input`). */
  output: unknown;
  /**
   * Anything else the provider attached to the span — surfaced in the
   * "Attributes" tab as a flat key/value list. The builder owns what goes in
   * here; the renderer just iterates.
   */
  attributes: Record<string, unknown>;
  /**
   * The original raw span object. Lets the detail pane render an "as-stored"
   * JSON view for power users without re-fetching anything.
   */
  raw: unknown;
  /** Direct children — already in start-time order when timestamps exist. */
  children: TraceNode[];
};

/**
 * What the builder returns. A degenerate trace (no spans) still produces a
 * synthetic root so the UI has something to render — `nodes` is always at
 * least one element. `flat` is the same tree linearised by DFS, for callers
 * that just want a list (e.g. simple metrics).
 */
export type TraceTree = {
  provider: TraceProvider;
  /** External trace id from the provider, when available. */
  externalTraceId: string | null;
  /** Top-level nodes — usually one root, but tolerant of multiple. */
  roots: TraceNode[];
  /** Total span count across all roots. */
  spanCount: number;
};

/*
 * OTLP-JSON → TraceTree. Stored shape is `{ resourceSpans: [ { resource,
 * scopeSpans: [ { scope, spans: [span] } ] } ] }` — exactly what the
 * OpenTelemetry HTTP/JSON exporter sends.
 *
 * Span fields we use:
 *   - `traceId`, `spanId` (hex strings) — identity
 *   - `parentSpanId` — tree linkage (empty / undefined for roots)
 *   - `name` — display
 *   - `kind` — numeric OTLP enum; mapped to a label
 *   - `startTimeUnixNano`, `endTimeUnixNano` — string- or number-encoded nanos
 *   - `attributes` — array of `{ key, value: { stringValue | intValue | … } }`
 *     entries; we extract gen_ai.* hints (model, tokens) and flatten the rest
 *     into a key/value map for the Attributes pane
 *   - `status` — surfaced as an attribute when non-OK
 *
 * OTLP doesn't ship a dedicated "input" / "output" field — gen_ai
 * instrumentation puts the LLM prompt under `gen_ai.prompt` and the
 * completion under `gen_ai.completion`. We surface those when present so the
 * detail pane reads like the LangSmith / Langfuse case for LLM spans.
 */

/** Minimum span shape we read. Anything else lands in `attributes`. */
type OtlpSpan = {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  kind?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: unknown;
  status?: unknown;
  [k: string]: unknown;
};

/** Scope wrapper. */
type OtlpScopeSpan = { scope?: unknown; spans?: unknown };
/** Resource wrapper. */
type OtlpResourceSpan = { resource?: unknown; scopeSpans?: unknown };
/** Top-level document. */
type OtlpRaw = { resourceSpans?: unknown };

/** Map OTLP `SpanKind` numeric enum to a lowercase label. */
const KIND_LABELS: Record<number, string> = {
  0: "unspecified",
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

/**
 * Convert a UnixNano value (string or number) to epoch milliseconds. OTLP
 * sends nanos as either decimal strings (HTTP/JSON canonical) or numbers
 * (some SDKs ignore the spec); both are normalized to ms-precision JS
 * timestamps the viewer can subtract. Returns `null` when neither form
 * parses.
 */
const nanoToMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value / 1_000_000;
  if (typeof value === "string" && value.length > 0) {
    // BigInt → ms via integer division; preserves precision for the
    // 13-digit ms range without rounding through Number's mantissa.
    try {
      const bi = BigInt(value);
      return Number(bi / 1_000_000n);
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Flatten one `{ key, value }` OTLP attribute entry to a JS scalar. OTLP
 * attributes are typed by which field is set on `value` — `stringValue`,
 * `intValue`, `doubleValue`, `boolValue`, `arrayValue`, `kvlistValue`. We
 * unwrap the obvious scalars; complex types are returned as-is so the JSON
 * viewer can render them faithfully.
 */
const unwrapAttrValue = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) {
    // Spec sends int64 as a decimal string; parse to a JS number when safe.
    const raw = v.intValue;
    if (typeof raw === "string") {
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : raw;
    }
    return raw;
  }
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) {
    const arr = (v.arrayValue as Record<string, unknown>).values;
    return Array.isArray(arr) ? arr.map((e) => unwrapAttrValue(e)) : [];
  }
  if ("kvlistValue" in v) {
    const kv = (v.kvlistValue as Record<string, unknown>).values;
    return Array.isArray(kv) ? flattenAttrList(kv) : {};
  }
  return value;
};

/**
 * Flatten OTLP's `[{ key, value }, …]` attribute encoding to a JS object.
 * Duplicate keys keep the last value (rare in practice — OTel discourages it).
 */
export const flattenAttrList = (attrs: unknown): Record<string, unknown> => {
  if (!Array.isArray(attrs)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of attrs) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const key = e.key;
    if (typeof key !== "string") continue;
    out[key] = unwrapAttrValue(e.value);
  }
  return out;
};

/**
 * Extract LLM-specific hints from the attribute bag — model, tokens, prompt,
 * completion — using the standard `gen_ai.*` semantic conventions plus a few
 * pragmatic fallbacks (`llm.*` from older SDKs, `ai.*` from Vercel AI SDK).
 */
const extractGenAi = (
  attrs: Record<string, unknown>,
): {
  model: string | null;
  tokens: TraceNode["tokens"];
  input: unknown;
  output: unknown;
} => {
  const model =
    pickString(attrs, ["gen_ai.request.model", "gen_ai.response.model", "llm.model", "ai.model.id"]) ??
    null;
  const inputTokens = pickNumber(attrs, [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "llm.usage.prompt_tokens",
    "ai.usage.promptTokens",
  ]);
  const outputTokens = pickNumber(attrs, [
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "llm.usage.completion_tokens",
    "ai.usage.completionTokens",
  ]);
  const totalTokens = pickNumber(attrs, [
    "gen_ai.usage.total_tokens",
    "llm.usage.total_tokens",
    "ai.usage.totalTokens",
  ]);
  return {
    model,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total:
        totalTokens ??
        (inputTokens !== null || outputTokens !== null
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : null),
    },
    // Prompts/completions are usually multi-message JSON strings — leave
    // as-is so the JSON viewer can format them.
    input: attrs["gen_ai.prompt"] ?? attrs["llm.prompt"] ?? attrs["ai.prompt"] ?? null,
    output: attrs["gen_ai.completion"] ?? attrs["llm.completion"] ?? attrs["ai.response"] ?? null,
  };
};

/** First matching key with a string value, or null. */
const pickString = (attrs: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
};

/** First matching key coercible to a finite number, or null. */
const pickNumber = (attrs: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

/** Map one OTLP span to a TraceNode (parent linkage happens later). */
const toNode = (span: OtlpSpan, fallbackId: string): TraceNode => {
  const id = typeof span.spanId === "string" && span.spanId.length > 0 ? span.spanId : fallbackId;
  const parentRaw = span.parentSpanId;
  // Empty string is OTLP's "no parent" — treat the same as missing.
  const parentId =
    typeof parentRaw === "string" && parentRaw.length > 0 ? parentRaw : null;
  const startMs = nanoToMs(span.startTimeUnixNano);
  const endMs = nanoToMs(span.endTimeUnixNano);
  const attributes = flattenAttrList(span.attributes);
  const genAi = extractGenAi(attributes);
  // Heuristic: if a span carries any gen_ai.* attributes we tag it as `llm`
  // for parity with LangSmith's `run_type`. Otherwise we use the OTLP
  // SpanKind label so the viewer can still group `client` / `internal` etc.
  const hasGenAi = Object.keys(attributes).some(
    (k) => k.startsWith("gen_ai.") || k.startsWith("llm.") || k.startsWith("ai."),
  );
  const kindLabel = (() => {
    if (hasGenAi) return "llm";
    const k = span.kind;
    if (typeof k === "number") return KIND_LABELS[k] ?? null;
    if (typeof k === "string") return k.toLowerCase().replace(/^span_kind_/, "");
    return null;
  })();

  return {
    id,
    parentId,
    name: typeof span.name === "string" ? span.name : "span",
    kind: kindLabel,
    startMs,
    endMs,
    durationMs: startMs !== null && endMs !== null ? endMs - startMs : null,
    model: genAi.model,
    tokens: genAi.tokens,
    costUsd: null, // OTLP doesn't standardize a cost field.
    input: genAi.input,
    output: genAi.output,
    attributes,
    raw: span,
    children: [],
  };
};

/**
 * Walk the OTLP envelope into a tree. Spans can arrive across multiple
 * `resourceSpans` / `scopeSpans` entries (the ingest groups by traceId but
 * preserves the per-span scope), so we flatten everything first, then link
 * by `parentSpanId`. Orphans become additional roots — preserving them is
 * better than dropping data the customer paid to capture.
 */
export const buildOtlpTree = (raw: unknown): TraceTree => {
  const doc = (raw ?? {}) as OtlpRaw;
  const resourceSpans = Array.isArray(doc.resourceSpans)
    ? (doc.resourceSpans as OtlpResourceSpan[])
    : [];

  const allSpans: OtlpSpan[] = [];
  let traceId: string | null = null;
  for (const rs of resourceSpans) {
    const scopeSpans = Array.isArray(rs.scopeSpans) ? (rs.scopeSpans as OtlpScopeSpan[]) : [];
    for (const ss of scopeSpans) {
      const spans = Array.isArray(ss.spans) ? (ss.spans as OtlpSpan[]) : [];
      for (const s of spans) {
        allSpans.push(s);
        if (traceId === null && typeof s.traceId === "string") traceId = s.traceId;
      }
    }
  }

  const nodes = allSpans.map((s, i) => toNode(s, `__otlp_span_${i}`));
  const byId = new Map<string, TraceNode>(nodes.map((n) => [n.id, n]));

  const roots: TraceNode[] = [];
  for (const node of nodes) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of nodes) {
    node.children.sort(byStart);
  }
  roots.sort(byStart);

  return {
    provider: "otlp",
    externalTraceId: traceId,
    roots,
    spanCount: nodes.length,
  };
};

/** Sibling start-time sort; nulls last. */
const byStart = (a: TraceNode, b: TraceNode): number => {
  if (a.startMs === b.startMs) return 0;
  if (a.startMs === null) return 1;
  if (b.startMs === null) return -1;
  return a.startMs - b.startMs;
};
