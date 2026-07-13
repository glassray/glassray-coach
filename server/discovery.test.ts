import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap, type CoachDb } from './bootstrap.js';
import { codeFlowsSchema, reconcileCodeFlows } from './code-explore.js';

/*
 * M3 regression suite: discovery + flows on the deterministic `mock` provider.
 * Boots a hermetic coach (temp GLASSRAY_HOME, ephemeral port), ingests a few
 * varied OTLP traces, then drives both background passes to `done` and asserts
 * the persisted deviations / flows surface through the read API.
 */

/** Force the offline mock backend for the whole file (no network, deterministic). */
process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** Build a minimal single-span OTLP/JSON envelope with a given id / name / input. */
const makeEnvelope = (traceId: string, name: string, input: string) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: `agent-${name}` } }] },
      scopeSpans: [
        {
          scope: { name: 'test-scope' },
          spans: [
            {
              traceId,
              spanId: '00112233aabbccdd',
              name,
              kind: 1,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001500000000',
              status: {},
              attributes: [{ key: 'input.value', value: { stringValue: input } }],
            },
          ],
        },
      ],
    },
  ],
});

/** Four distinct traces (varying names + inputs) so clustering has real material. */
const TRACES = [
  makeEnvelope('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'book-appointment', 'Book me a slot on Tuesday'),
  makeEnvelope('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'book-appointment', 'Reschedule my Friday visit'),
  makeEnvelope('cccccccccccccccccccccccccccccccc', 'answer-question', 'What are the clinic hours?'),
  makeEnvelope('dddddddddddddddddddddddddddddddd', 'answer-question', 'Do you accept my insurance?'),
];

let home: string;
let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;
let db: CoachDb;

/** Poll GET /api/runs/:id until it leaves `running`, or throw after the deadline. */
const waitForRun = async (runId: string): Promise<{ status: string; stats: Record<string, number> | null }> => {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = (await res.json()) as { status: string; stats: Record<string, number> | null };
    if (body.status === 'done' || body.status === 'error') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish in time`);
};

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-m3-'));
  const runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  db = runtime.db;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  for (const envelope of TRACES) {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray M3 discovery + flows (mock)', () => {
  it('reports the mock provider as ready via GET /api/llm', async () => {
    const res = await fetch(`${baseUrl}/api/llm`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; ready: boolean };
    expect(body.provider).toBe('mock');
    expect(body.ready).toBe(true);
  });

  it('runs discovery to done and surfaces deviations with an example citing a traceId', async () => {
    const start = await fetch(`${baseUrl}/api/discovery/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);

    const done = await waitForRun(runId);
    expect(done.status).toBe('done');
    expect(done.stats?.deviationCount).toBeGreaterThanOrEqual(1);

    const list = await fetch(`${baseUrl}/api/deviations`);
    const body = (await list.json()) as {
      items: Array<{ id: string; label: string; rule: string; exampleCount: number }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const first = body.items[0]!;
    expect(first.exampleCount).toBeGreaterThanOrEqual(1);
    expect(typeof first.rule).toBe('string');

    const detail = await fetch(`${baseUrl}/api/deviations/${first.id}`);
    const detailBody = (await detail.json()) as {
      deviation: { id: string };
      examples: Array<{ traceId: string; evidence: string }>;
    };
    expect(detailBody.deviation.id).toBe(first.id);
    expect(detailBody.examples.length).toBeGreaterThanOrEqual(1);
    const knownIds = new Set(TRACES.flatMap((e) => e.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId));
    expect(knownIds.has(detailBody.examples[0]!.traceId)).toBe(true);
  });

  it('never 409s under concurrency: same-key runs dedup to one run or serialize, all complete', async () => {
    // Two concurrent discovery POSTs share the dedup key. While the first run
    // is still live the second must join it (same runId); a mock run can also
    // finish before the second arrives, which legitimately mints a new run —
    // either way both callers get a pollable 202 that reaches `done`.
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/api/discovery/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      fetch(`${baseUrl}/api/discovery/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const aBody = (await a.json()) as { runId: string };
    const bBody = (await b.json()) as { runId: string };
    for (const runId of new Set([aBody.runId, bBody.runId])) {
      expect(runId).toMatch(/^run_/);
      expect((await waitForRun(runId)).status).toBe('done');
    }

    // Queue released: a fresh run is a NEW run id and completes.
    const again = await fetch(`${baseUrl}/api/discovery/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(again.status).toBe(202);
    const { runId } = (await again.json()) as { runId: string };
    expect(runId).not.toBe(aBody.runId);
    expect((await waitForRun(runId)).status).toBe('done');
  });

  it('runs the code-discover pass to done — mock reads no code, so it mints nothing', async () => {
    // Under the offline mock provider no source is read; the run must still
    // complete cleanly (route + queue wiring), discovering zero flows.
    const start = await fetch(`${baseUrl}/api/flows/run`, { method: 'POST' });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };
    const done = await waitForRun(runId);
    expect(done.status).toBe('done');
    expect(done.stats?.flowCount).toBe(0);
    expect(done.stats?.ruleCount).toBe(0);
  });

  it('reconciles a code-explore result into durable flows + code-anchored evals', async () => {
    // Feed the reconcile a synthetic explore result (parsed through the real
    // schema) — a single-agent flow with a rule, plus a system-wide rule — and
    // assert both land with source:"code" anchors and the flow's selector.
    const result = codeFlowsSchema.parse({
      flows: [
        {
          name: 'Trace digestion',
          description: 'Summarises each trace into a one-line digest with a language code and a topic.',
          agentNames: ['trace-digest'],
          codeAnchors: [{ file: 'src/watcher/digest.ts', symbol: 'generateDigest', line: 108 }],
          rules: [
            {
              name: 'Summary in plain English',
              text: 'The summary is always written in plain English regardless of source language',
              anchors: [{ file: 'src/watcher/digest.ts', symbol: 'SYSTEM' }],
            },
          ],
        },
      ],
      system: {
        context: 'A background worker that digests agent traces.',
        rules: [{ text: 'Never invent facts not present in the trace', anchors: [{ file: 'src/watcher/digest.ts' }] }],
      },
    });

    const reconciled = await reconcileCodeFlows(db, { runId: 'run_codeexplore_test', result });
    expect(reconciled).toEqual({ flowCount: 1, ruleCount: 2 });

    // The flow: a deterministic single-agent selector, provenance = discovery.
    const list = (await (await fetch(`${baseUrl}/api/flows`)).json()) as {
      items: Array<{ id: string; name: string; classify: string; selector: { agent?: string } | null; createdBy: string }>;
    };
    const flow = list.items.find((f) => f.name === 'Trace digestion');
    expect(flow).toBeTruthy();
    expect(flow!.classify).toBe('selector');
    expect(flow!.selector?.agent).toBe('trace-digest');
    expect(flow!.createdBy).toBe('discovery');

    // The flow's rule is a code-anchored eval (source:"code").
    const detail = (await (await fetch(`${baseUrl}/api/flows/${flow!.id}`)).json()) as {
      evals: Array<{ name: string; source: string; anchors: Array<{ file: string; symbol?: string }> | null }>;
    };
    expect(detail.evals.length).toBe(1);
    expect(detail.evals[0]!.source).toBe('code');
    expect(detail.evals[0]!.anchors?.[0]?.file).toBe('src/watcher/digest.ts');

    // The system-wide rule landed as a GLOBAL code eval (no flow binding).
    const evalsList = (await (await fetch(`${baseUrl}/api/evals`)).json()) as {
      items: Array<{ name: string; text: string; source: string; flowId: string | null }>;
    };
    const globalRule = evalsList.items.find((e) => e.text.startsWith('Never invent facts'));
    expect(globalRule).toBeTruthy();
    expect(globalRule!.source).toBe('code');
    expect(globalRule!.flowId).toBeNull();

    // A re-reconcile of the same result EXTENDS, not duplicates: name-colliding
    // flow skipped, text-duplicate global rule skipped → nothing new.
    const again = await reconcileCodeFlows(db, { runId: 'run_codeexplore_test2', result });
    expect(again).toEqual({ flowCount: 0, ruleCount: 0 });
  });
});
