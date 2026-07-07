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
    if (body.status !== 'running') return body;
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

  it('serializes overlapping runs via the single-run lock and releases it', async () => {
    // Fire two runs concurrently. Each is accepted (202) or rejected while the
    // other holds the lock (409); a mock run drains in microtasks so it usually
    // serializes to 202 + 202, but the lock must NEVER admit a crash or a stuck
    // state — and any 409 must carry the in-progress error.
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/api/flows/run`, { method: 'POST' }),
      fetch(`${baseUrl}/api/discovery/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ]);
    for (const res of [a, b]) {
      expect([202, 409]).toContain(res.status);
      const body = (await res.json()) as { runId?: string; error?: string };
      if (res.status === 202) {
        expect(body.runId).toMatch(/^run_/);
        expect((await waitForRun(body.runId!)).status).toBe('done');
      } else {
        expect(body.error).toMatch(/in progress/);
      }
    }
    // Lock released: a fresh run still starts and completes.
    const again = await fetch(`${baseUrl}/api/flows/run`, { method: 'POST' });
    expect(again.status).toBe(202);
    const { runId } = (await again.json()) as { runId: string };
    expect((await waitForRun(runId)).status).toBe('done');
  });

  it('runs flows to done and surfaces at least one flow with member traces', async () => {
    const start = await fetch(`${baseUrl}/api/flows/run`, { method: 'POST' });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };
    const done = await waitForRun(runId);
    expect(done.status).toBe('done');
    expect(done.stats?.flowCount).toBeGreaterThanOrEqual(1);

    const list = await fetch(`${baseUrl}/api/flows`);
    const body = (await list.json()) as {
      items: Array<{ id: string; name: string; traceCount: number }>;
      runId: string | null;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const first = body.items[0]!;
    expect(first.traceCount).toBeGreaterThanOrEqual(1);

    const detail = await fetch(`${baseUrl}/api/flows/${first.id}`);
    const detailBody = (await detail.json()) as {
      flow: { id: string };
      traces: Array<{ traceId: string; agent: string | null }>;
    };
    expect(detailBody.flow.id).toBe(first.id);
    expect(detailBody.traces.length).toBeGreaterThanOrEqual(1);
  });
});
