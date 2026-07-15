import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CoachDb } from './bootstrap.js';
import { materializeSelectorFlow, parseSelector, type FlowSelector } from './classify.js';
import { newId } from './ids.js';
import { evals, flowTraces, flows, traces, type Anchor } from './schema.js';

/*
 * Durable FLOWS — named, persistent agent behaviours, each with a membership
 * definition (a deterministic `selector` and/or a plain-language `rule` for the
 * LLM classify sweep). This module owns flow CRUD and the detail/audit reads.
 * DISCOVERY of flows from the agent's source lives in `code-explore.ts` (it
 * writes flow rows through the same tables); traces attach to those flows via
 * the classify sweep (`classify.ts`).
 */

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

/** Extra cap on low-confidence members surfaced beyond the newest-window (the actionable subset). */
const DETAIL_LOW_CONF_CAP = 100;

/** An assertion rule attached to a flow, as listed in the flow's detail. */
export type FlowRuleRef = {
  id: string;
  name: string;
  text: string;
  /** WHERE in code this rule is enforced (cloud `FlowRule.anchors`); null = authored/custom. */
  anchors: Anchor[] | null;
  /** Provenance (cloud `FlowRule.source`): `code` or `promoted`. */
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
  /** The denormalized member columns the detail table renders (shared by both member reads). */
  const memberColumns = {
    traceId: flowTraces.traceId,
    name: traces.name,
    agent: traces.agent,
    status: traces.status,
    receivedAt: traces.receivedAt,
    assignedBy: flowTraces.assignedBy,
    confidence: flowTraces.confidence,
    assignedAt: flowTraces.assignedAt,
  };
  const [newest, lowConf, attachedEvals, counts] = await Promise.all([
    db
      .select(memberColumns)
      .from(flowTraces)
      .leftJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(eq(flowTraces.flowId, id))
      .orderBy(desc(flowTraces.assignedAt), desc(flowTraces.traceId))
      .limit(DETAIL_MEMBER_CAP),
    // Low-confidence assignments are the actionable subset — surface EVERY one
    // even when it falls outside the newest-window cap, so a stale mis-match on
    // a busy flow can't become invisible in the dashboard.
    db
      .select(memberColumns)
      .from(flowTraces)
      .leftJoin(traces, eq(flowTraces.traceId, traces.id))
      .where(and(eq(flowTraces.flowId, id), eq(flowTraces.confidence, 'low')))
      .orderBy(desc(flowTraces.assignedAt), desc(flowTraces.traceId))
      .limit(DETAIL_LOW_CONF_CAP),
    db
      .select({
        id: evals.id,
        name: evals.name,
        text: evals.text,
        anchors: evals.anchors,
        source: evals.source,
        threshold: evals.threshold,
        lastRunAt: evals.lastRunAt,
      })
      .from(evals)
      .where(eq(evals.flowId, id))
      .orderBy(desc(evals.createdAt)),
    memberCounts(db, [id]),
  ]);
  // One chronological list: the newest members plus any low-confidence
  // assignment beyond that window, deduped so nothing actionable is hidden.
  const shown = new Set(newest.map((m) => m.traceId));
  const members = [...newest, ...lowConf.filter((m) => !shown.has(m.traceId))].sort(
    (a, b) => (b.assignedAt?.getTime() ?? 0) - (a.assignedAt?.getTime() ?? 0),
  );
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
