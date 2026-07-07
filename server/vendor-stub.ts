/**
 * TEMPORARY stub of the vendor trace normalizer (coach/server/vendor/index.ts).
 * Loaded only as a dynamic-import fallback while the real vendor module lands —
 * delete this file once coach/server/vendor/ exists. Mirrors the exact
 * `buildTraceView(envelope, traceId)` surface with a minimal OTLP walk.
 */
import type { BuildTraceView, TraceView } from './trace-view.js';

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
};
type OtlpKeyValue = { key?: string; value?: OtlpAnyValue };
type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number | string };
  attributes?: OtlpKeyValue[];
};
type OtlpScopeSpans = { spans?: OtlpSpan[] };
type OtlpResourceSpans = {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
};
type OtlpEnvelope = { resourceSpans?: OtlpResourceSpans[] };

/** Minimal span-tree node shape for the stub's `tree` field. */
type StubTreeNode = {
  spanId: string | null;
  name: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: string | null;
  children: StubTreeNode[];
};

/** Reads a string attribute by key from an OTLP attribute list. */
const attrString = (attributes: OtlpKeyValue[] | undefined, key: string): string | null => {
  const hit = attributes?.find((kv) => kv?.key === key);
  return typeof hit?.value?.stringValue === 'string' ? hit.value.stringValue : null;
};

/** Reads a numeric attribute (intValue/doubleValue) by key from an OTLP attribute list. */
const attrNumber = (attributes: OtlpKeyValue[] | undefined, key: string): number | null => {
  const value = attributes?.find((kv) => kv?.key === key)?.value;
  if (value === undefined) return null;
  const n =
    value.intValue !== undefined
      ? Number(value.intValue)
      : value.doubleValue !== undefined
        ? Number(value.doubleValue)
        : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Converts an OTLP unix-nano timestamp (string or number) to epoch milliseconds, or null. */
const nanosToMs = (nanos: string | number | undefined): number | null => {
  if (nanos === undefined || nanos === null || nanos === '') return null;
  const n = Number(nanos);
  return Number.isFinite(n) && n > 0 ? n / 1e6 : null;
};

/** True when an OTLP span status code marks an error (2 / STATUS_CODE_ERROR). */
const isErrorStatus = (span: OtlpSpan): boolean =>
  span.status?.code === 2 || span.status?.code === 'STATUS_CODE_ERROR';

/** Truncates a preview string to a sane display length. */
const truncate = (text: string | null, max = 240): string | null =>
  text === null ? null : text.length > max ? `${text.slice(0, max)}…` : text;

/** Stub buildTraceView: derives display fields for one traceId from a raw OTLP envelope. */
export const buildTraceView: BuildTraceView = (envelope, traceId): TraceView => {
  const wanted = traceId.toLowerCase();
  const spans: OtlpSpan[] = [];
  let agent: string | null = null;

  for (const rs of (envelope as OtlpEnvelope)?.resourceSpans ?? []) {
    const matching = (rs?.scopeSpans ?? []).flatMap(
      (ss) => ss?.spans?.filter((s) => s?.traceId?.toLowerCase() === wanted) ?? [],
    );
    if (matching.length > 0) {
      spans.push(...matching);
      agent ??= attrString(rs?.resource?.attributes, 'service.name');
    }
  }

  const startMs = spans.map((s) => nanosToMs(s.startTimeUnixNano)).filter((v): v is number => v !== null);
  const endMs = spans.map((s) => nanosToMs(s.endTimeUnixNano)).filter((v): v is number => v !== null);
  const started = startMs.length > 0 ? Math.min(...startMs) : null;
  const ended = endMs.length > 0 ? Math.max(...endMs) : null;

  const spanIds = new Set(spans.map((s) => s.spanId).filter((id): id is string => typeof id === 'string'));
  const roots = spans.filter((s) => !s.parentSpanId || !spanIds.has(s.parentSpanId));
  const root = roots[0] ?? spans[0];

  /** Recursively assembles a child tree under one span. */
  const toNode = (span: OtlpSpan): StubTreeNode => {
    const start = nanosToMs(span.startTimeUnixNano);
    const end = nanosToMs(span.endTimeUnixNano);
    return {
      spanId: span.spanId ?? null,
      name: span.name ?? null,
      startedAt: start !== null ? new Date(start).toISOString() : null,
      endedAt: end !== null ? new Date(end).toISOString() : null,
      durationMs: start !== null && end !== null ? Math.max(0, Math.round(end - start)) : null,
      status: isErrorStatus(span) ? 'error' : 'ok',
      children: spans.filter((s) => s.parentSpanId !== undefined && s.parentSpanId === span.spanId).map(toNode),
    };
  };

  const sumTokens = (keys: string[]): number | null => {
    let total = 0;
    let found = false;
    for (const span of spans) {
      for (const key of keys) {
        const n = attrNumber(span.attributes, key);
        if (n !== null) {
          total += n;
          found = true;
        }
      }
    }
    return found ? Math.round(total) : null;
  };

  return {
    name: root?.name ?? null,
    agent,
    provider: spans.map((s) => attrString(s.attributes, 'gen_ai.system')).find((v) => v !== null) ?? null,
    startedAt: started !== null ? new Date(started).toISOString() : null,
    endedAt: ended !== null ? new Date(ended).toISOString() : null,
    durationMs: started !== null && ended !== null ? Math.max(0, Math.round(ended - started)) : null,
    spanCount: spans.length,
    status: spans.some(isErrorStatus) ? 'error' : 'ok',
    tokensIn: sumTokens(['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens']),
    tokensOut: sumTokens(['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens']),
    inputPreview: truncate(attrString(root?.attributes, 'input.value') ?? attrString(root?.attributes, 'gen_ai.prompt')),
    outputPreview: truncate(attrString(root?.attributes, 'output.value') ?? attrString(root?.attributes, 'gen_ai.completion')),
    tree: roots.map(toNode),
  };
};
