import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type CoachRuntime } from './bootstrap.js';
import { matchesFlowSelector, runClassifySweep, type FlowSelector } from './classify.js';
import { createRun } from './discovery.js';
import { autorunDueEvals, createManualEval, runEval } from './evals.js';
import { createFlow, updateFlow } from './flows.js';
import { evalResults, flowTraces, traces } from './schema.js';

/*
 * Classification correctness: the selector matcher's semantics, the sweep's
 * idempotence (watermark-stamped, membership never duplicated), flow-scoped
 * eval sampling, and the autorun new-member watermark. All on the mock provider
 * against a hermetic PGlite.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** A minimal trace fact row for matcher cases. */
const fact = (over: Partial<{ id: string; name: string | null; agent: string | null; status: string | null; inputPreview: string | null }> = {}) => ({
  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'smalltalk-reply',
  agent: 'support-bot',
  status: 'ok',
  inputPreview: 'Hi there, hello!',
  ...over,
});

describe('matchesFlowSelector', () => {
  it('ANDs present constraints and ignores absent ones', () => {
    const selector: FlowSelector = { agent: 'support-bot', nameContains: 'SMALL', q: 'hello' };
    expect(matchesFlowSelector(fact(), selector)).toBe(true);
    expect(matchesFlowSelector(fact({ agent: 'other-bot' }), selector)).toBe(false);
    expect(matchesFlowSelector(fact({ name: 'refund-flow' }), selector)).toBe(false);
    expect(matchesFlowSelector(fact({ inputPreview: 'refund please' }), selector)).toBe(false);
    expect(matchesFlowSelector(fact({ name: null }), selector)).toBe(false);
  });

  it('status constrains, pins always match, pins-only matches nothing else, {} matches all', () => {
    expect(matchesFlowSelector(fact({ status: 'error' }), { agent: 'support-bot', status: 'ok' })).toBe(false);
    // A pin overrides failing constraints.
    expect(
      matchesFlowSelector(fact({ agent: 'other-bot' }), {
        agent: 'support-bot',
        traceIds: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      }),
    ).toBe(true);
    // Pins-only: only the pinned ids are members — zero pins means zero members.
    const pinsOnly: FlowSelector = { traceIds: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] };
    expect(matchesFlowSelector(fact(), pinsOnly)).toBe(false);
    expect(matchesFlowSelector(fact({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), pinsOnly)).toBe(true);
    expect(matchesFlowSelector(fact(), { traceIds: [] })).toBe(false);
    // Empty selector (no traceIds key at all) = an "all traces" flow.
    expect(matchesFlowSelector(fact(), {})).toBe(true);
  });
});

let home: string;
let rt: CoachRuntime;

/** Insert one denormalized trace row (empty raw envelope — classification never reads it). */
const seedTrace = async (id: string, over: Partial<typeof traces.$inferInsert> = {}) => {
  await rt.db.insert(traces).values({
    id,
    raw: { resourceSpans: [] },
    name: 'smalltalk-reply',
    agent: 'support-bot',
    status: 'ok',
    inputPreview: 'Hi there!',
    ...over,
  });
};

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-classify-'));
  rt = await bootstrap(home);
}, 120_000);

afterAll(async () => {
  await rt.client.close();
  await rm(home, { recursive: true, force: true });
});

describe('classification pipeline (mock, hermetic)', () => {
  it('materializes selector members on create, sweeps idempotently, and scopes eval runs to the flow', async () => {
    await seedTrace('11111111111111111111111111111111');
    await seedTrace('22222222222222222222222222222222', { inputPreview: 'Hello!' });
    await seedTrace('33333333333333333333333333333333', {
      name: 'refund-request',
      agent: 'billing-bot',
      inputPreview: 'I want a refund',
    });

    // Create: selector members materialize immediately.
    const created = await createFlow(rt.db, {
      name: 'Small talk',
      selector: { agent: 'support-bot', q: 'h' },
    });
    expect(created.classify).toBe('selector');
    expect(created.memberCount).toBe(2);

    // Sweep once: stamps every unswept trace, adds no duplicate memberships.
    const sweep1 = await runClassifySweep(rt.db, { runId: await createRun(rt.db, 'classify') });
    expect(sweep1.swept).toBe(3);
    const unstamped = await rt.db.select({ id: traces.id }).from(traces).where(isNull(traces.classifiedAt));
    expect(unstamped.length).toBe(0);
    const members1 = await rt.db.select().from(flowTraces).where(eq(flowTraces.flowId, created.id));
    expect(members1.length).toBe(2);

    // Sweep again: nothing left to do, membership unchanged (idempotent, no re-spend).
    const sweep2 = await runClassifySweep(rt.db, { runId: await createRun(rt.db, 'classify') });
    expect(sweep2.swept).toBe(0);
    const members2 = await rt.db.select().from(flowTraces).where(eq(flowTraces.flowId, created.id));
    expect(members2.length).toBe(2);

    // A flow-scoped eval samples ONLY the flow's members.
    const evalId = await createManualEval(rt.db, {
      label: 'Greets warmly',
      rule: 'The agent should greet the user warmly.',
      flowId: created.id,
    });
    const result = await runEval(rt.db, { evalId, runId: await createRun(rt.db, 'eval') });
    expect(result.scored).toBe(2);
    const verdicts = await rt.db.select().from(evalResults).where(eq(evalResults.evalId, evalId));
    const scoredIds = new Set(verdicts.map((v) => v.traceId));
    expect(scoredIds.has('33333333333333333333333333333333')).toBe(false);
    expect(scoredIds.size).toBe(2);
  });

  it('autorun trips at the new-member threshold and re-arms only after new members arrive', async () => {
    const flow = await createFlow(rt.db, {
      name: 'Refunds',
      selector: { agent: 'billing-bot' },
    });
    const evalId = await createManualEval(rt.db, {
      label: 'No refunds promised',
      rule: 'The agent must not promise a refund.',
      flowId: flow.id,
      autorunThreshold: 2,
    });

    // One member (< threshold): not due.
    expect((await autorunDueEvals(rt.db)).map((d) => d.id)).not.toContain(evalId);

    // A second member crosses the threshold (never-run eval → counts all members).
    await seedTrace('44444444444444444444444444444444', {
      name: 'refund-request',
      agent: 'billing-bot',
      inputPreview: 'refund me',
    });
    await rt.db.insert(flowTraces).values({ flowId: flow.id, traceId: '44444444444444444444444444444444' });
    expect((await autorunDueEvals(rt.db)).map((d) => d.id)).toContain(evalId);

    // Running the eval stamps the watermark — no longer due until NEW members land.
    await runEval(rt.db, { evalId, runId: await createRun(rt.db, 'eval') });
    expect((await autorunDueEvals(rt.db)).map((d) => d.id)).not.toContain(evalId);
  });

  it('a re-classified trace whose facts changed LOSES stale selector memberships', async () => {
    // Trace 1111… is a "Small talk" member (agent=support-bot); change its agent
    // and re-open the watermark (what a merge re-ingest does) — the sweep must
    // reconcile it OUT of the flow, not just skip re-inserting.
    const traceId = '11111111111111111111111111111111';
    await rt.db.update(traces).set({ agent: 'renamed-bot', classifiedAt: null }).where(eq(traces.id, traceId));
    await runClassifySweep(rt.db, { runId: await createRun(rt.db, 'classify') });
    const rows = await rt.db
      .select()
      .from(flowTraces)
      .where(and(eq(flowTraces.traceId, traceId), eq(flowTraces.assignedBy, 'selector')));
    expect(rows.length).toBe(0);
  });

  it('switching a flow off llm sheds rule-derived members; selector mode requires a selector', async () => {
    const flow = await createFlow(rt.db, { name: 'Rule flow', rule: 'traces about rules', classify: 'llm' });
    await rt.db
      .insert(flowTraces)
      .values({ flowId: flow.id, traceId: '22222222222222222222222222222222', assignedBy: 'llm', confidence: 'high' });

    expect(await updateFlow(rt.db, flow.id, { classify: 'selector' })).toEqual({
      ok: false,
      reason: 'selector-needs-selector',
    });

    const switched = await updateFlow(rt.db, flow.id, { classify: 'selector', selector: { agent: 'support-bot' } });
    expect(switched).toEqual({ ok: true, llmDefinitionChanged: false });
    const llmRows = await rt.db
      .select()
      .from(flowTraces)
      .where(and(eq(flowTraces.flowId, flow.id), eq(flowTraces.assignedBy, 'llm')));
    expect(llmRows.length).toBe(0);
  });
});
