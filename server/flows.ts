import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import {
  materializeSelectorFlow,
  oneLineIntent,
  parseSelector,
  type FlowSelector,
} from './classify.js';
import { failRun, finishRun, isRunLive } from './discovery.js';
import { generateStructuredTracked } from './usage.js';
import { newId } from './ids.js';
import { evals, flowTraces, flows, traces } from './schema.js';

/*
 * Durable FLOWS — named, persistent agent behaviours, each with a membership
 * definition (a deterministic `selector` and/or a plain-language `rule` for the
 * LLM classify sweep). This module owns flow CRUD, the detail/audit reads, and
 * the DISCOVER bootstrap: an LLM clustering pass over recent traces that
 * *seeds* rule-defined flows for Claude/the user to tighten into selectors —
 * it adds to the durable set instead of replacing it.
 */

/** Flow-clustering system prompt (the discover bootstrap). */
const FLOW_SYSTEM_PROMPT =
  'You group agent execution traces into a small set of recurring FLOWS — named agent workflows defined by their intent (what the user is trying to accomplish). Traces that pursue the same underlying goal belong to the same flow. Give each flow a short, human-readable name and a one-sentence membership rule.';

/** Output of the flow-clustering pass — named flows, each with a membership rule + its member trace ids. */
const FlowSchema = z.object({
  flows: z
    .array(
      z.object({
        name: z.string().describe('Short, human-readable flow name (the recurring workflow)'),
        description: z.string().describe('One- or two-sentence description of what this flow does'),
        rule: z
          .string()
          .describe(
            'One-sentence membership rule: what makes a trace belong to this flow (used to classify future traces)',
          ),
        memberTraceIds: z
          .array(z.string())
          .describe('The trace ids (verbatim from the list) that belong to this flow'),
      }),
    )
    .describe('The recurring flows the traces cluster into'),
});

/** Max traces fed into one flow-clustering pass (keeps the prompt bounded). */
const MAX_FLOW_TRACES = 200;

/**
 * Run the DISCOVER bootstrap: cluster the newest traces into named flows and
 * persist any that are genuinely new as durable, rule-defined (`classify='llm'`)
 * flows. Existing active flows are shown to the model (and name-deduped on
 * persist) so repeated discovers extend the set rather than duplicating it.
 * Marks the run `done` (or `error`, re-throwing) via the lifecycle helpers.
 */
export const runFlows = async (
  db: CoachDb,
  opts: { runId: string; signal?: AbortSignal },
): Promise<{ flowCount: number }> => {
  try {
    const rows = await db
      .select({
        id: traces.id,
        name: traces.name,
        agent: traces.agent,
        inputPreview: traces.inputPreview,
      })
      .from(traces)
      .orderBy(desc(traces.receivedAt), desc(traces.id))
      .limit(MAX_FLOW_TRACES);

    if (rows.length === 0) {
      await finishRun(db, opts.runId, { flowCount: 0, tracesScanned: 0 });
      return { flowCount: 0 };
    }

    const existing = await db
      .select({ name: flows.name, description: flows.description })
      .from(flows)
      .where(eq(flows.status, 'active'));
    const existingNames = new Set(existing.map((f) => f.name.trim().toLowerCase()));
    const existingBlock =
      existing.length > 0
        ? `\n\nThese flows ALREADY exist — do NOT re-propose them; only propose NEW flows for traces that don't fit any of them:\n${existing.map((f) => `- ${f.name}: ${f.description}`).join('\n')}`
        : '';

    const knownIds = new Set(rows.map((r) => r.id));
    const listing = rows
      .map((r) => `- ${r.id} | name: ${r.name ?? '—'} | agent: ${r.agent ?? '—'} | intent: ${oneLineIntent(r.inputPreview)}`)
      .join('\n');

    const { object } = await generateStructuredTracked(db, 'flows', {
      schema: FlowSchema,
      system: FLOW_SYSTEM_PROMPT,
      prompt: `Here are recent agent traces, one per line (\`- <traceId> | name | agent | intent\`):\n\n${listing}${existingBlock}\n\nCluster them into a small set of recurring flows. For each flow give a short name, a one- or two-sentence description, a one-sentence membership rule (what makes a trace belong), and the list of member trace ids (copied verbatim from the lines above).`,
      tier: 'heavy',
      temperature: 0,
      signal: opts.signal,
    });

    // If the run was canceled or timed out while the model was clustering, stop
    // before persisting — don't write flows for a run the user already abandoned.
    if (!(await isRunLive(db, opts.runId))) return { flowCount: 0 };

    // Persist each genuinely-new flow with its valid, de-duplicated members.
    // Unknown / hallucinated trace ids are dropped; name collisions with an
    // existing active flow are skipped (the model was told not to re-propose).
    let flowCount = 0;
    for (const flow of object.flows) {
      if (existingNames.has(flow.name.trim().toLowerCase())) continue;
      const members = [...new Set(flow.memberTraceIds.map((id) => id.toLowerCase()))].filter((id) =>
        knownIds.has(id),
      );
      // A flow whose member ids the model fully hallucinated has no real traces
      // behind it — skip it so the flows list never shows a 0-trace flow.
      if (members.length === 0) continue;
      const flowId = newId('flow_');
      await db.insert(flows).values({
        id: flowId,
        runId: opts.runId,
        name: flow.name,
        description: flow.description,
        rule: flow.rule,
        classify: 'llm',
        createdBy: 'discovery',
        traceCount: members.length,
      });
      await db
        .insert(flowTraces)
        .values(members.map((traceId) => ({ flowId, traceId, assignedBy: 'llm', confidence: 'high' })))
        .onConflictDoNothing();
      existingNames.add(flow.name.trim().toLowerCase());
      flowCount += 1;
    }

    await finishRun(db, opts.runId, { flowCount, tracesScanned: rows.length });
    return { flowCount };
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};

// ── flow CRUD + reads ────────────────────────────────────────────────────────

/** Inputs for creating a flow — at least one of `selector` / `rule` must be present (route-validated). */
export type FlowInput = {
  name: string;
  description?: string;
  selector?: FlowSelector | null;
  rule?: string | null;
  classify?: 'selector' | 'llm';
  createdBy?: 'user' | 'claude';
};

/** A flow row shaped for list/detail responses (selector parsed, live member count). */
export type FlowSummary = {
  id: string;
  name: string;
  description: string;
  selector: FlowSelector | null;
  rule: string | null;
  classify: string;
  status: string;
  createdBy: string;
  /** Stable artifact identity (the `glassray.yaml` flow id); null until exported/imported. */
  slug: string | null;
  traceCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Create a durable flow and materialize its selector memberships. Defaults
 * `classify` from the definition: a selector-only flow classifies by selector,
 * a rule-bearing flow by LLM. Returns the new id + initial member count.
 */
export const createFlow = async (
  db: CoachDb,
  input: FlowInput,
): Promise<{ id: string; memberCount: number; classify: 'selector' | 'llm' }> => {
  const id = newId('flow_');
  const classify = input.classify ?? (input.rule ? 'llm' : 'selector');
  await db.insert(flows).values({
    id,
    runId: null,
    name: input.name,
    description: input.description ?? '',
    selector: input.selector ?? null,
    rule: input.rule ?? null,
    classify,
    createdBy: input.createdBy ?? 'user',
  });
  const memberCount = input.selector ? await materializeSelectorFlow(db, id, input.selector) : 0;
  return { id, memberCount, classify };
};

/** Patch shape for updating a flow — only present fields change. */
export type FlowPatch = {
  name?: string;
  description?: string;
  selector?: FlowSelector | null;
  rule?: string | null;
  classify?: 'selector' | 'llm';
  status?: 'active' | 'archived';
};

/** What updating a flow produced: applied (with the backfill flag), or a typed refusal. */
export type FlowUpdateResult =
  | { ok: true; llmDefinitionChanged: boolean }
  | { ok: false; reason: 'not-found' | 'llm-needs-rule' | 'selector-needs-selector' };

/**
 * Update a flow's definition. A changed selector re-materializes the flow's
 * selector memberships (a removed selector drops them; manual/LLM assignments
 * survive). A changed rule (or a switch to `llm`) drops the flow's LLM-assigned
 * memberships — they were derived under the old definition — and flags the
 * caller to trigger the bounded backfill. Refuses a patch whose effective state
 * would be `llm`-classified with no rule (the create-route invariant).
 */
export const updateFlow = async (db: CoachDb, id: string, patch: FlowPatch): Promise<FlowUpdateResult> => {
  const rows = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
  const existing = rows[0];
  if (!existing) return { ok: false, reason: 'not-found' };

  const wasLlm = existing.classify === 'llm';
  const isLlm = patch.classify !== undefined ? patch.classify === 'llm' : wasLlm;
  const effectiveRule = patch.rule !== undefined ? patch.rule : existing.rule;
  if (isLlm && (effectiveRule === null || effectiveRule.length === 0)) {
    return { ok: false, reason: 'llm-needs-rule' };
  }
  // A selector-classified flow with no selector can never gain a member —
  // refuse the shape (legacy discovery flows are classify='llm', unaffected).
  const effectiveSelector = patch.selector !== undefined ? patch.selector : parseSelector(existing.selector);
  if (!isLlm && effectiveSelector === null) {
    return { ok: false, reason: 'selector-needs-selector' };
  }

  const set: Partial<typeof flows.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.selector !== undefined) set.selector = patch.selector;
  if (patch.rule !== undefined) set.rule = patch.rule;
  if (patch.classify !== undefined) set.classify = patch.classify;
  if (patch.status !== undefined) set.status = patch.status;
  await db.update(flows).set(set).where(eq(flows.id, id));

  if (patch.selector !== undefined) {
    if (patch.selector === null) {
      await db
        .delete(flowTraces)
        .where(and(eq(flowTraces.flowId, id), eq(flowTraces.assignedBy, 'selector')));
    } else {
      await materializeSelectorFlow(db, id, patch.selector);
    }
  }

  const ruleChanged = patch.rule !== undefined && patch.rule !== existing.rule;
  const llmDefinitionChanged = (isLlm && !wasLlm) || (isLlm && ruleChanged);
  if (llmDefinitionChanged || (wasLlm && !isLlm)) {
    // Old-rule assignments are stale under the new definition — drop them so the
    // backfill re-derives membership; a switch AWAY from llm likewise sheds the
    // rule-derived members (the selector re-materialization defines them now).
    await db.delete(flowTraces).where(and(eq(flowTraces.flowId, id), eq(flowTraces.assignedBy, 'llm')));
  }
  return { ok: true, llmDefinitionChanged };
};

/**
 * Hard-delete a flow: memberships go with it, attached evals detach (become
 * global). Children are removed BEFORE the parent row — PGlite has no FK
 * constraints here, so a crash mid-way must not leave memberships/eval refs
 * pointing at a deleted flow. Returns false when not found.
 */
export const deleteFlow = async (db: CoachDb, id: string): Promise<boolean> => {
  const exists = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, id)).limit(1);
  if (!exists[0]) return false;
  await db.delete(flowTraces).where(eq(flowTraces.flowId, id));
  await db.update(evals).set({ flowId: null }).where(eq(evals.flowId, id));
  await db.delete(flows).where(eq(flows.id, id));
  return true;
};

/** Live member count per flow id (the denormalized `trace_count` is legacy — counts are computed). */
const memberCounts = async (db: CoachDb, flowIds: string[]): Promise<Map<string, number>> => {
  if (flowIds.length === 0) return new Map();
  const rows = await db
    .select({ flowId: flowTraces.flowId, n: sql<number>`count(*)::int` })
    .from(flowTraces)
    .where(inArray(flowTraces.flowId, flowIds))
    .groupBy(flowTraces.flowId);
  return new Map(rows.map((r) => [r.flowId, r.n]));
};

/** List flows (active by default; `all` / `archived` opt-in), newest-updated first, with live member counts. */
export const listFlows = async (
  db: CoachDb,
  status: 'active' | 'archived' | 'all' = 'active',
): Promise<FlowSummary[]> => {
  const rows = await db
    .select()
    .from(flows)
    .where(status === 'all' ? undefined : eq(flows.status, status))
    .orderBy(desc(flows.updatedAt), desc(flows.id));
  const counts = await memberCounts(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    selector: parseSelector(r.selector),
    rule: r.rule,
    classify: r.classify,
    status: r.status,
    createdBy: r.createdBy,
    slug: r.slug,
    traceCount: counts.get(r.id) ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
};

/** One member row in a flow's detail view. */
export type FlowMember = {
  traceId: string;
  name: string | null;
  agent: string | null;
  status: string | null;
  receivedAt: Date | null;
  assignedBy: string;
  confidence: string | null;
  assignedAt: Date;
};

/** Cap on members returned in a flow's detail view (newest first). */
const DETAIL_MEMBER_CAP = 100;

/** An assertion rule attached to a flow, as listed in the flow's detail. */
export type FlowRuleRef = {
  id: string;
  label: string;
  rule: string;
  /** The repo path this rule's expectation is written in; null = custom (hand-written). */
  sourceFile: string | null;
  /** Provenance: `deviation` or `manual`. */
  source: string;
  /** Pass-rate gate for `glassray check` (0..1); null = 1.0. */
  threshold: number | null;
  lastRunAt: Date | null;
};

/** Full flow detail: the definition (membership rule) plus its newest members and the assertion rules scoped to it. */
export const getFlowDetail = async (
  db: CoachDb,
  id: string,
): Promise<(FlowSummary & { members: FlowMember[]; evals: FlowRuleRef[] }) | null> => {
  const rows = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
  const flow = rows[0];
  if (!flow) return null;
  const [members, attachedEvals, counts] = await Promise.all([
    db
      .select({
        traceId: flowTraces.traceId,
        name: traces.name,
        agent: traces.agent,
        status: traces.status,
        receivedAt: traces.receivedAt,
        assignedBy: flowTraces.assignedBy,
        confidence: flowTraces.confidence,
        assignedAt: flowTraces.assignedAt,
      })
      .from(flowTraces)
      .leftJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(eq(flowTraces.flowId, id))
      .orderBy(desc(flowTraces.assignedAt), desc(flowTraces.traceId))
      .limit(DETAIL_MEMBER_CAP),
    db
      .select({
        id: evals.id,
        label: evals.label,
        rule: evals.rule,
        sourceFile: evals.sourceFile,
        source: evals.source,
        threshold: evals.threshold,
        lastRunAt: evals.lastRunAt,
      })
      .from(evals)
      .where(eq(evals.flowId, id))
      .orderBy(desc(evals.createdAt)),
    memberCounts(db, [id]),
  ]);
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    selector: parseSelector(flow.selector),
    rule: flow.rule,
    classify: flow.classify,
    status: flow.status,
    createdBy: flow.createdBy,
    slug: flow.slug,
    traceCount: counts.get(id) ?? 0,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    members,
    evals: attachedEvals,
  };
};

/** Sample sizes for the audit view. */
const AUDIT_SAMPLE_CAP = 20;

/**
 * Audit one flow's classification quality: a newest-members sample (with intent
 * previews), every low-confidence LLM assignment, and the store-wide count of
 * traces still awaiting classification. The skill points Claude here to decide
 * whether a flow's selector/rule needs tightening.
 */
export const auditFlow = async (
  db: CoachDb,
  id: string,
): Promise<{
  flowId: string;
  sample: Array<FlowMember & { inputPreview: string | null }>;
  lowConfidence: Array<FlowMember & { inputPreview: string | null }>;
  counts: { members: number; lowConfidence: number; unclassifiedStoreWide: number };
} | null> => {
  const rows = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, id)).limit(1);
  if (!rows[0]) return null;
  const memberSelect = {
    traceId: flowTraces.traceId,
    name: traces.name,
    agent: traces.agent,
    status: traces.status,
    receivedAt: traces.receivedAt,
    assignedBy: flowTraces.assignedBy,
    confidence: flowTraces.confidence,
    assignedAt: flowTraces.assignedAt,
    inputPreview: traces.inputPreview,
  };
  const [sample, lowConfidence, totals, unclassified] = await Promise.all([
    db
      .select(memberSelect)
      .from(flowTraces)
      .leftJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(eq(flowTraces.flowId, id))
      .orderBy(desc(flowTraces.assignedAt), desc(flowTraces.traceId))
      .limit(AUDIT_SAMPLE_CAP),
    db
      .select(memberSelect)
      .from(flowTraces)
      .leftJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(and(eq(flowTraces.flowId, id), eq(flowTraces.confidence, 'low')))
      .orderBy(desc(flowTraces.assignedAt), desc(flowTraces.traceId))
      .limit(AUDIT_SAMPLE_CAP),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(flowTraces)
      .where(eq(flowTraces.flowId, id)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(traces)
      .where(isNull(traces.classifiedAt)),
  ]);
  const lowCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(flowTraces)
    .where(and(eq(flowTraces.flowId, id), eq(flowTraces.confidence, 'low')));
  return {
    flowId: id,
    sample,
    lowConfidence,
    counts: {
      members: totals[0]?.n ?? 0,
      lowConfidence: lowCount[0]?.n ?? 0,
      unclassifiedStoreWide: unclassified[0]?.n ?? 0,
    },
  };
};
