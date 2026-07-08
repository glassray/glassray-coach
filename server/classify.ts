import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { failRun, finishRun, isRunLive } from './discovery.js';
import { generateStructuredTracked } from './usage.js';
import { flowTraces, flows, traces } from './schema.js';

/*
 * Flow CLASSIFICATION — the background half of the Claude-driven revamp. A flow
 * carries a membership definition: a deterministic `selector` query (matched
 * inline at ingest and re-derived idempotently by the sweep) and/or a
 * plain-language `rule` scored by a light-tier LLM batch call. The sweep is the
 * single consumer of the `traces.classified_at` watermark: it picks unswept
 * traces, runs both layers, and stamps them — so it re-spends nothing on
 * re-runs, and a crash simply leaves the backlog for the next sweep.
 */

/**
 * A flow's deterministic membership query. All constraint fields are optional
 * and AND-combined; `traceIds` is an explicit pin that matches regardless of
 * the other fields. An empty object matches every trace (an "all traces" flow);
 * a pins-only selector matches only its pins.
 */
export const flowSelectorSchema = z
  .object({
    /** Exact match on the trace's agent. */
    agent: z.string().trim().min(1).max(200).optional(),
    /** Case-insensitive substring match on the trace's root name. */
    nameContains: z.string().trim().min(1).max(200).optional(),
    /** Case-insensitive substring match on the trace's input preview (user intent). */
    q: z.string().trim().min(1).max(200).optional(),
    /** Only ok or only error traces. */
    status: z.enum(['ok', 'error']).optional(),
    /** Explicit 32-hex trace-id pins — always members, regardless of the constraints. */
    traceIds: z.array(z.string().regex(/^[0-9a-f]{32}$/i)).max(200).optional(),
    /** How many of the flow's newest members an eval run samples (default 20). */
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** A flow's parsed deterministic membership query. */
export type FlowSelector = z.infer<typeof flowSelectorSchema>;

/** The denormalized trace columns the selector matcher consumes. */
export type TraceFacts = {
  id: string;
  name: string | null;
  agent: string | null;
  status: string | null;
  inputPreview: string | null;
};

/** Case-insensitive substring test that treats a null haystack as no match. */
const includesCi = (haystack: string | null, needle: string): boolean =>
  haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * The single membership authority for selector-defined flows: pins match
 * unconditionally; otherwise every present constraint must hold. With no
 * constraints and no `traceIds` key at all, everything matches (an "all
 * traces" flow); a pins-only selector — `traceIds` present, even empty —
 * matches nothing but its pins.
 */
export const matchesFlowSelector = (trace: TraceFacts, selector: FlowSelector): boolean => {
  if (selector.traceIds?.some((id) => id.toLowerCase() === trace.id)) return true;
  const constrained =
    selector.agent !== undefined ||
    selector.nameContains !== undefined ||
    selector.q !== undefined ||
    selector.status !== undefined;
  if (!constrained) return selector.traceIds === undefined;
  if (selector.agent !== undefined && trace.agent !== selector.agent) return false;
  if (selector.status !== undefined && trace.status !== selector.status) return false;
  if (selector.nameContains !== undefined && !includesCi(trace.name, selector.nameContains)) return false;
  if (selector.q !== undefined && !includesCi(trace.inputPreview, selector.q)) return false;
  return true;
};

/** Defensively parse a stored jsonb selector; null on absence or a shape this version doesn't understand. */
export const parseSelector = (value: unknown): FlowSelector | null => {
  if (value === null || value === undefined) return null;
  const parsed = flowSelectorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** An active flow as the classifier sees it: identity + membership definition. */
export type ActiveFlow = {
  id: string;
  name: string;
  description: string;
  rule: string | null;
  classify: string;
  selector: FlowSelector | null;
};

/** Load every active flow with its parsed selector. */
export const loadActiveFlows = async (db: CoachDb): Promise<ActiveFlow[]> => {
  const rows = await db
    .select({
      id: flows.id,
      name: flows.name,
      description: flows.description,
      rule: flows.rule,
      classify: flows.classify,
      selector: flows.selector,
    })
    .from(flows)
    .where(eq(flows.status, 'active'));
  return rows.map((r) => ({ ...r, selector: parseSelector(r.selector) }));
};

/** Collapse a preview to a single bounded line for classification/clustering prompts. */
export const oneLineIntent = (preview: string | null, cap = 200): string => {
  if (!preview) return '—';
  const flat = preview.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat || '—';
};

/**
 * Inline selector pass, run at ingest for freshness: match the just-landed
 * traces against every active flow that has a selector and insert memberships.
 * Deliberately does NOT stamp `classified_at` — the sweep owns the watermark
 * (and re-derives these inserts idempotently via the composite-PK conflict).
 */
export const classifyTracesInline = async (db: CoachDb, traceIds: string[]): Promise<void> => {
  if (traceIds.length === 0) return;
  const selectorFlows = (await loadActiveFlows(db)).filter((f) => f.selector !== null);
  if (selectorFlows.length === 0) return;
  const rows: TraceFacts[] = await db
    .select({
      id: traces.id,
      name: traces.name,
      agent: traces.agent,
      status: traces.status,
      inputPreview: traces.inputPreview,
    })
    .from(traces)
    .where(inArray(traces.id, traceIds));
  const memberships: Array<typeof flowTraces.$inferInsert> = [];
  for (const row of rows) {
    for (const flow of selectorFlows) {
      if (matchesFlowSelector(row, flow.selector!)) {
        memberships.push({ flowId: flow.id, traceId: row.id, assignedBy: 'selector' });
      }
    }
  }
  if (memberships.length > 0) await db.insert(flowTraces).values(memberships).onConflictDoNothing();
};

/** Classifier system prompt — assign each trace to at most one rule-defined flow, never forcing a fit. */
const CLASSIFY_SYSTEM_PROMPT =
  'You classify agent execution traces into known FLOWS — named agent workflows, each defined by a membership rule. Assign each trace to the single flow whose rule genuinely describes it, or to no flow when none fit. Never force a fit.';

/** Output of one classification batch: per-trace flow assignment (or none) with a confidence. */
const ClassifySchema = z.object({
  assignments: z
    .array(
      z.object({
        traceId: z.string().describe('The trace id, copied verbatim from the list'),
        flowId: z
          .string()
          .nullable()
          .describe('The id of the single best-fitting flow, or null when no rule describes this trace'),
        confidence: z
          .enum(['high', 'low'])
          .describe('high = the rule clearly describes the trace; low = plausible but ambiguous'),
      }),
    )
    .describe('One entry per trace in the list'),
});

/** Traces picked up per sweep iteration (also the LLM batch size — one call per iteration). */
const SWEEP_BATCH = 100;

/** Build the classification prompt: rule-defined flow cards + compact per-trace lines. */
const buildClassifyPrompt = (llmFlows: ActiveFlow[], batch: TraceFacts[]): string => {
  const flowCards = llmFlows
    .map((f) => `- ${f.id} | ${f.name}: ${f.rule ?? f.description}`)
    .join('\n');
  const traceLines = batch
    .map((t) => `- ${t.id} | name: ${t.name ?? '—'} | agent: ${t.agent ?? '—'} | intent: ${oneLineIntent(t.inputPreview)}`)
    .join('\n');
  return `Known flows, one per line (\`- <flowId> | <name>: <membership rule>\`):\n\n${flowCards}\n\nTraces to classify, one per line (\`- <traceId> | name | agent | intent\`):\n\n${traceLines}\n\nFor EACH trace, return its traceId (verbatim), the flowId of the single best-fitting flow (verbatim, or null if none of the rules genuinely describe it), and your confidence (high or low).`;
};

/**
 * The background classify sweep: loop over unswept traces in batches — re-derive
 * the selector layer idempotently, batch-classify against rule-defined flows
 * (light tier), stamp `classified_at` — until the backlog is empty. Marks the
 * run `done` (or `error`, re-throwing) via the shared lifecycle helpers.
 */
export const runClassifySweep = async (
  db: CoachDb,
  opts: { runId: string; signal?: AbortSignal },
): Promise<{ swept: number; assigned: number }> => {
  try {
    let swept = 0;
    let assigned = 0;
    for (;;) {
      if (!(await isRunLive(db, opts.runId))) break;
      const batch: TraceFacts[] = await db
        .select({
          id: traces.id,
          name: traces.name,
          agent: traces.agent,
          status: traces.status,
          inputPreview: traces.inputPreview,
        })
        .from(traces)
        .where(isNull(traces.classifiedAt))
        .orderBy(traces.receivedAt, traces.id)
        .limit(SWEEP_BATCH);
      if (batch.length === 0) break;

      const activeFlows = await loadActiveFlows(db);
      const batchIds = batch.map((t) => t.id);

      /** Delete memberships grouped per flow (small stale sets — usually empty). */
      const deleteStale = async (rows: Array<{ flowId: string; traceId: string }>, by: string) => {
        const byFlow = new Map<string, string[]>();
        for (const r of rows) byFlow.set(r.flowId, [...(byFlow.get(r.flowId) ?? []), r.traceId]);
        for (const [flowId, ids] of byFlow) {
          await db
            .delete(flowTraces)
            .where(and(eq(flowTraces.flowId, flowId), eq(flowTraces.assignedBy, by), inArray(flowTraces.traceId, ids)));
        }
      };

      // Selector layer — a RECONCILE, not just an insert: a re-ingested trace's
      // facts can change (root name lands last under a batch exporter), so
      // memberships that no longer match are removed alongside the new inserts.
      const selectorRows: Array<typeof flowTraces.$inferInsert> = [];
      for (const trace of batch) {
        for (const flow of activeFlows) {
          if (flow.selector !== null && matchesFlowSelector(trace, flow.selector)) {
            selectorRows.push({ flowId: flow.id, traceId: trace.id, assignedBy: 'selector' });
          }
        }
      }
      const matchedPairs = new Set(selectorRows.map((r) => `${r.flowId} ${r.traceId}`));
      const existingSelector = await db
        .select({ flowId: flowTraces.flowId, traceId: flowTraces.traceId })
        .from(flowTraces)
        .where(and(inArray(flowTraces.traceId, batchIds), eq(flowTraces.assignedBy, 'selector')));
      await deleteStale(
        existingSelector.filter((r) => !matchedPairs.has(`${r.flowId} ${r.traceId}`)),
        'selector',
      );
      if (selectorRows.length > 0) {
        await db.insert(flowTraces).values(selectorRows).onConflictDoNothing();
        assigned += selectorRows.length;
      }

      // LLM layer — one light-tier batch call over the rule-defined flows.
      const llmFlows = activeFlows.filter((f) => f.classify === 'llm');
      if (llmFlows.length > 0) {
        const { object } = await generateStructuredTracked(db, 'classify', {
          schema: ClassifySchema,
          system: CLASSIFY_SYSTEM_PROMPT,
          prompt: buildClassifyPrompt(llmFlows, batch),
          tier: 'light',
          temperature: 0,
          signal: opts.signal,
        });
        const knownFlowIds = new Set(llmFlows.map((f) => f.id));
        const batchIdSet = new Set(batchIds);
        // Hallucinated flow/trace ids are dropped so memberships only ever
        // reference real rows from this batch. Traces the model EXPLICITLY
        // judged (a valid traceId — flowId may be null) are reconciled: their
        // old llm memberships to OTHER flows are stale under the current rules
        // and removed. Traces the model didn't answer for are left untouched,
        // so a flaky response can never purge memberships.
        const llmRows: Array<typeof flowTraces.$inferInsert> = [];
        const judged = new Map<string, string | null>();
        for (const a of object.assignments) {
          const traceId = a.traceId.toLowerCase();
          if (!batchIdSet.has(traceId)) continue;
          // A hallucinated flowId is a model ERROR, not an explicit "none" — skip it.
          if (a.flowId !== null && !knownFlowIds.has(a.flowId)) continue;
          judged.set(traceId, a.flowId);
          if (a.flowId !== null) {
            llmRows.push({ flowId: a.flowId, traceId, assignedBy: 'llm', confidence: a.confidence });
          }
        }
        const existingLlm = await db
          .select({ flowId: flowTraces.flowId, traceId: flowTraces.traceId })
          .from(flowTraces)
          .where(and(inArray(flowTraces.traceId, batchIds), eq(flowTraces.assignedBy, 'llm')));
        await deleteStale(
          existingLlm.filter((r) => judged.has(r.traceId) && judged.get(r.traceId) !== r.flowId),
          'llm',
        );
        if (llmRows.length > 0) {
          await db.insert(flowTraces).values(llmRows).onConflictDoNothing();
          assigned += llmRows.length;
        }
      }

      // Canceled/timed out mid-batch → leave the watermark unstamped so the next
      // sweep re-derives this batch (idempotent) instead of silently skipping it.
      if (!(await isRunLive(db, opts.runId))) break;
      await db
        .update(traces)
        .set({ classifiedAt: new Date() })
        .where(inArray(traces.id, batch.map((t) => t.id)));
      swept += batch.length;
    }
    const result = { swept, assigned };
    await finishRun(db, opts.runId, result);
    return result;
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};

/** Newest-first scan bound for selector re-materialization (matches the timeline's wedge cap). */
const MATERIALIZE_SCAN_CAP = 5000;

/** The trace-facts projection the classifier reads. */
const TRACE_FACTS_SELECT = {
  id: traces.id,
  name: traces.name,
  agent: traces.agent,
  status: traces.status,
  inputPreview: traces.inputPreview,
} as const;

/**
 * Re-derive a flow's selector memberships from the store as a DIFF: memberships
 * that still match keep their `assigned_at` (so a flow edit can't spuriously
 * trip autorun thresholds), no-longer-matching selector rows are dropped
 * (manual + LLM assignments survive), and new matches are inserted. Constraint
 * matching scans the newest MATERIALIZE_SCAN_CAP traces (a wedge cap); `traceIds`
 * pins are fetched explicitly, so pins are exact regardless of the cap. Called
 * on flow create and on selector change; returns the matched member count.
 */
export const materializeSelectorFlow = async (
  db: CoachDb,
  flowId: string,
  selector: FlowSelector,
): Promise<number> => {
  const scanned: TraceFacts[] = await db
    .select(TRACE_FACTS_SELECT)
    .from(traces)
    .orderBy(desc(traces.receivedAt), desc(traces.id))
    .limit(MATERIALIZE_SCAN_CAP);
  const rows = new Map(scanned.map((r) => [r.id, r]));
  const pinIds = (selector.traceIds ?? []).map((id) => id.toLowerCase()).filter((id) => !rows.has(id));
  if (pinIds.length > 0) {
    const pinned: TraceFacts[] = await db.select(TRACE_FACTS_SELECT).from(traces).where(inArray(traces.id, pinIds));
    for (const r of pinned) rows.set(r.id, r);
  }
  const matched = new Set(
    [...rows.values()].filter((r) => matchesFlowSelector(r, selector)).map((r) => r.id),
  );
  const existing = await db
    .select({ traceId: flowTraces.traceId })
    .from(flowTraces)
    .where(and(eq(flowTraces.flowId, flowId), eq(flowTraces.assignedBy, 'selector')));
  const existingIds = new Set(existing.map((r) => r.traceId));
  const toDelete = [...existingIds].filter((id) => !matched.has(id));
  const toInsert = [...matched].filter((id) => !existingIds.has(id));
  if (toDelete.length > 0) {
    await db
      .delete(flowTraces)
      .where(
        and(
          eq(flowTraces.flowId, flowId),
          eq(flowTraces.assignedBy, 'selector'),
          inArray(flowTraces.traceId, toDelete),
        ),
      );
  }
  if (toInsert.length > 0) {
    await db
      .insert(flowTraces)
      .values(toInsert.map((traceId) => ({ flowId, traceId, assignedBy: 'selector' })))
      .onConflictDoNothing();
  }
  return matched.size;
};

/** How many of the newest traces a new/changed LLM-rule flow reconsiders (bounded backfill spend). */
export const LLM_BACKFILL_CAP = 100;

/**
 * Bounded LLM backfill for a new or changed rule-defined flow: clear the
 * classification watermark on the newest traces so the next sweep reconsiders
 * them. Returns how many traces were re-opened.
 */
export const resetClassificationForBackfill = async (db: CoachDb, cap = LLM_BACKFILL_CAP): Promise<number> => {
  const newest = db
    .select({ id: traces.id })
    .from(traces)
    .orderBy(desc(traces.receivedAt), desc(traces.id))
    .limit(cap);
  const updated = await db
    .update(traces)
    .set({ classifiedAt: null })
    .where(inArray(traces.id, newest))
    .returning({ id: traces.id });
  return updated.length;
};

/** Count of traces still awaiting the classify sweep — surfaced on the flows list so scope gaps are visible. */
export const countUnclassified = async (db: CoachDb): Promise<number> => {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traces)
    .where(isNull(traces.classifiedAt));
  return rows[0]?.n ?? 0;
};
