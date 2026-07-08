import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

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

  it('runs the flows bootstrap to done and persists durable flows (no duplicates on re-run)', async () => {
    const start = await fetch(`${baseUrl}/api/flows/run`, { method: 'POST' });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };
    const done = await waitForRun(runId);
    expect(done.status).toBe('done');
    expect(done.stats?.flowCount).toBeGreaterThanOrEqual(1);

    const list = await fetch(`${baseUrl}/api/flows`);
    const body = (await list.json()) as {
      items: Array<{ id: string; name: string; traceCount: number; classify: string; rule: string | null }>;
      unclassified: number;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const first = body.items[0]!;
    expect(first.traceCount).toBeGreaterThanOrEqual(1);
    expect(first.classify).toBe('llm');
    expect(first.rule).toBeTruthy();

    const detail = await fetch(`${baseUrl}/api/flows/${first.id}`);
    const detailBody = (await detail.json()) as {
      id: string;
      members: Array<{ traceId: string; assignedBy: string }>;
    };
    expect(detailBody.id).toBe(first.id);
    expect(detailBody.members.length).toBeGreaterThanOrEqual(1);
    expect(detailBody.members[0]!.assignedBy).toBe('llm');

    // Re-running the bootstrap must EXTEND the durable set, not duplicate it —
    // the mock re-proposes the same flow name, which is name-deduped to zero.
    const again = await fetch(`${baseUrl}/api/flows/run`, { method: 'POST' });
    const rerun = await waitForRun(((await again.json()) as { runId: string }).runId);
    expect(rerun.status).toBe('done');
    expect(rerun.stats?.flowCount).toBe(0);
    const after = (await (await fetch(`${baseUrl}/api/flows`)).json()) as { items: unknown[] };
    expect(after.items.length).toBe(body.items.length);
  });
});
