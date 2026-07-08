import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { traces } from './schema.js';
import { toDate, toInt, type BuildTraceView, type TraceView } from './trace-view.js';
import { filterEnvelopeToTrace } from './vendor/index.js';

/** Minimal top-level shape check for an OTLP/JSON trace-export envelope. */
export const otlpEnvelopeSchema = z.object({ resourceSpans: z.array(z.unknown()) });

/**
 * Thrown by `upsertTrace` when an OTLP envelope's spans can't be normalized —
 * i.e. the *input* is malformed, not that the datastore failed. The ingest
 * handler skips a trace that throws this (and 400s a wholly-malformed batch),
 * but lets any other error propagate as a real, retryable server failure.
 */
export class TraceNormalizeError extends Error {
  constructor(traceId: string, options?: { cause?: unknown }) {
    super(`trace ${traceId} has malformed OTLP spans`, options);
    this.name = 'TraceNormalizeError';
  }
}

/**
 * Collects the lowercased spanIds present in a (per-trace) OTLP envelope. Used
 * to merge a re-POSTed batch into the stored trace: incoming spans replace
 * same-id stored spans, and stored spans absent from the incoming batch are
 * carried over rather than dropped.
 */
const collectSpanIds = (envelope: { resourceSpans: unknown[] }): Set<string> => {
  const ids = new Set<string>();
  for (const rs of envelope.resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown } | null)?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown } | null)?.spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        const spanId = (span as { spanId?: unknown } | null)?.spanId;
        if (typeof spanId === 'string' && spanId.length > 0) ids.add(spanId.toLowerCase());
      }
    }
  }
  return ids;
};

/** Re-emit a per-trace envelope keeping only spans whose lowercased spanId is NOT in `exclude`, dropping empty scopes/resources. */
const keepSpansNotIn = (
  envelope: { resourceSpans: unknown[] },
  exclude: Set<string>,
): { resourceSpans: unknown[] } => {
  const kept: unknown[] = [];
  for (const rs of envelope.resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown } | null)?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    const keptScopes: unknown[] = [];
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown } | null)?.spans;
      if (!Array.isArray(spans)) continue;
      const survivors = spans.filter((s) => {
        const spanId = (s as { spanId?: unknown } | null)?.spanId;
        // Spans with no usable spanId can't be deduped, so always carry them.
        return typeof spanId !== 'string' || spanId.length === 0 || !exclude.has(spanId.toLowerCase());
      });
      if (survivors.length > 0) keptScopes.push({ ...(ss as object), spans: survivors });
    }
    if (keptScopes.length > 0) kept.push({ ...(rs as object), scopeSpans: keptScopes });
  }
  return { resourceSpans: kept };
};

/** Matches a 32-char hex OTLP traceId. */
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/** Collects the unique lowercase 32-hex traceIds present in an OTLP envelope (defensive walk). */
export const collectTraceIds = (envelope: unknown): string[] => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const resourceSpans = (envelope as { resourceSpans?: unknown })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return ordered;
  for (const rs of resourceSpans) {
    const scopeSpans = (rs as { scopeSpans?: unknown })?.scopeSpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = (ss as { spans?: unknown })?.spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        const traceId = (span as { traceId?: unknown })?.traceId;
        if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId)) continue;
        const id = traceId.toLowerCase();
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
  }
  return ordered;
};

/**
 * Regroup an envelope's spans under one resourceSpans per distinct resource and
 * one scopeSpans per distinct scope (identity = JSON of the wrapper minus its
 * spans, first occurrence winning). Without this, the span-level merge below
 * would leave a trace re-POSTed across N batches carrying a redundant wrapper per
 * POST. Purely regroups — every span (and its attributes) is preserved, and
 * consumers flatten across wrappers anyway, so the view is unchanged.
 */
const coalesceEnvelope = (envelope: { resourceSpans: unknown[] }): { resourceSpans: unknown[] } => {
  const groups: Array<{ resource: unknown; scopeSpans: Array<{ scope: unknown; spans: unknown[] }> }> = [];
  for (const rs of envelope.resourceSpans) {
    const r = rs as { resource?: unknown; scopeSpans?: unknown };
    if (!Array.isArray(r.scopeSpans)) continue;
    const rKey = JSON.stringify(r.resource ?? null);
    let group = groups.find((g) => JSON.stringify(g.resource ?? null) === rKey);
    if (!group) {
      group = { resource: r.resource, scopeSpans: [] };
      groups.push(group);
    }
    for (const ss of r.scopeSpans) {
      const s = ss as { scope?: unknown; spans?: unknown };
      if (!Array.isArray(s.spans)) continue;
      const sKey = JSON.stringify(s.scope ?? null);
      let scope = group.scopeSpans.find((sc) => JSON.stringify(sc.scope ?? null) === sKey);
      if (!scope) {
        scope = { scope: s.scope, spans: [] };
        group.scopeSpans.push(scope);
      }
      scope.spans.push(...s.spans);
    }
  }
  return { resourceSpans: groups };
};

/**
 * In-process per-trace-id mutex: serializes upsertTrace for a given trace id so
 * two concurrent OTLP batches for the same trace can't both read the stored raw,
 * merge independently, and have the later write clobber the earlier (dropping
 * spans). The server is single-process, so an in-memory lock is sufficient.
 */
const perTraceLocks = new Map<string, Promise<void>>();

/** Run `fn` only after any in-flight op for `id` settles; subsequent calls for the same id chain behind it. */
const withTraceLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const prev = perTraceLocks.get(id) ?? Promise.resolve();
  const done = prev.then(() => fn(), () => fn());
  const tail = done.then(
    () => {},
    () => {},
  );
  perTraceLocks.set(id, tail);
  try {
    return await done;
  } finally {
    // Drop the entry when we're the last op for this id, so the map can't grow unbounded.
    if (perTraceLocks.get(id) === tail) perTraceLocks.delete(id);
  }
};

/**
 * Upserts one trace row from an OTLP envelope, MERGING by spanId rather than
 * replacing. The envelope is first narrowed to this trace's spans (so a
 * multi-trace batch doesn't duplicate the whole envelope onto every row), then
 * unioned into the stored trace: incoming spans replace same-id stored spans and
 * new ones append; stored spans absent from the incoming batch are carried over.
 * This keeps a trace whole when a standard OTLP batch exporter flushes its spans
 * across several POSTs — the whole-trace-per-POST SDK path is unaffected (same
 * spanIds ⇒ pure replacement). Recomputes the denormalized fields from the merge.
 * Throws {@link TraceNormalizeError} when the incoming spans can't be normalized.
 * Callers go through {@link upsertTrace}, which serializes this per trace id.
 */
const upsertTraceUnlocked = async (
  db: CoachDb,
  id: string,
  envelope: unknown,
  buildTraceView: BuildTraceView,
): Promise<void> => {
  const incoming = filterEnvelopeToTrace(envelope, id);
  const existing = await db.select({ raw: traces.raw }).from(traces).where(eq(traces.id, id)).limit(1);
  // Merge the incoming batch over the stored spans (incoming wins on same spanId),
  // then coalesce so re-POSTing across batches doesn't accrete a wrapper per POST.
  const merged = existing[0]
    ? coalesceEnvelope({
        resourceSpans: [
          ...incoming.resourceSpans,
          ...keepSpansNotIn(filterEnvelopeToTrace(existing[0].raw, id), collectSpanIds(incoming))
            .resourceSpans,
        ],
      })
    : incoming;
  // A throw here is malformed *input* (skip the trace), not a datastore failure —
  // tag it so the ingest handler can 400 rather than 500/swallow-as-success.
  let view: TraceView;
  try {
    view = buildTraceView(merged, id);
  } catch (err) {
    throw new TraceNormalizeError(id, { cause: err });
  }
  const fields = {
    raw: merged,
    name: view.name ?? null,
    agent: view.agent ?? null,
    provider: view.provider ?? null,
    startedAt: toDate(view.startedAt),
    durationMs: toInt(view.durationMs),
    spanCount: toInt(view.spanCount),
    status: view.status ?? null,
    tokensIn: toInt(view.tokensIn),
    tokensOut: toInt(view.tokensOut),
    inputPreview: view.inputPreview ?? null,
    outputPreview: view.outputPreview ?? null,
  };
  await db
    .insert(traces)
    .values({ id, ...fields })
    .onConflictDoUpdate({
      target: traces.id,
      // A merge can materially change the trace's facts (root name lands last
      // under a batch exporter), so re-open the classification watermark — the
      // sweep re-derives idempotently and must see the completed trace.
      set: { ...fields, receivedAt: sql`now()`, classifiedAt: null },
    });
};

/** Merge-upsert one trace, serialized per trace id so concurrent OTLP batches for the same trace can't drop each other's spans. */
export const upsertTrace = (
  db: CoachDb,
  id: string,
  envelope: unknown,
  buildTraceView: BuildTraceView,
): Promise<void> => withTraceLock(id, () => upsertTraceUnlocked(db, id, envelope, buildTraceView));
