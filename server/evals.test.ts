import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap, type CoachRuntime } from './bootstrap.js';
import { getEvalDetail } from './evals.js';
import { evalResults, evals, runs } from './schema.js';

/*
 * M6 regression suite: deviations → repeatable evals on the deterministic `mock`
 * provider. Boots a hermetic coach, ingests traces, discovers a deviation, saves
 * it as an eval, and scores traces against it. The mock always votes `pass`, so
 * the run-scoring path is asserted through the API; the regression math (a trace
 * failing now that passed last run) is asserted by seeding verdicts directly.
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

/** Three traces so an eval run has real material to score. */
const TRACES = [
  makeEnvelope('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'book-appointment', 'Book me a slot on Tuesday'),
  makeEnvelope('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'answer-question', 'What are the clinic hours?'),
  makeEnvelope('c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'answer-question', 'Do you accept my insurance?'),
];

let home: string;
let runtime: CoachRuntime;
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
  home = await mkdtemp(path.join(tmpdir(), 'glassray-m6-'));
  runtime = await bootstrap(home);
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

describe('glassray M6 evals (mock)', () => {
  it('saves a discovered deviation as an eval and lists it', async () => {
    // Discover first so there is a deviation to save.
    const disc = await fetch(`${baseUrl}/api/discovery/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(disc.status).toBe(202);
    expect((await waitForRun(((await disc.json()) as { runId: string }).runId)).status).toBe('done');

    const devList = (await (await fetch(`${baseUrl}/api/deviations`)).json()) as {
      items: Array<{ id: string; label: string; rule: string }>;
    };
    const deviation = devList.items[0]!;
    expect(deviation.id).toMatch(/^dev_/);

    const saved = await fetch(`${baseUrl}/api/evals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviationId: deviation.id }),
    });
    expect(saved.status).toBe(201);
    const { id } = (await saved.json()) as { id: string };
    expect(id).toMatch(/^eval_/);

    const list = (await (await fetch(`${baseUrl}/api/evals`)).json()) as {
      items: Array<{ id: string; label: string; rule: string; source: string; scored: number }>;
      total: number;
    };
    expect(list.total).toBeGreaterThanOrEqual(1);
    const savedEval = list.items.find((e) => e.id === id)!;
    expect(savedEval.source).toBe('deviation');
    expect(savedEval.rule).toBe(deviation.rule);
    expect(savedEval.scored).toBe(0); // not run yet
  });

  it('creates a manual eval, scores traces to done, and exposes per-trace verdicts', async () => {
    const created = await fetch(`${baseUrl}/api/evals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Always greets the user', rule: 'The agent must greet the user before answering.' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const run = await fetch(`${baseUrl}/api/evals/${id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(run.status).toBe(202);
    const { runId } = (await run.json()) as { runId: string };
    const done = await waitForRun(runId);
    expect(done.status).toBe('done');
    // The mock always votes `pass`, so every sampled trace passes.
    expect(done.stats?.scored).toBe(TRACES.length);
    expect(done.stats?.passed).toBe(TRACES.length);
    expect(done.stats?.failed).toBe(0);

    const detail = (await (await fetch(`${baseUrl}/api/evals/${id}`)).json()) as {
      id: string;
      scored: number;
      passed: number;
      failed: number;
      regressionCount: number;
      results: Array<{ traceId: string; verdict: string; regression: boolean }>;
    };
    expect(detail.id).toBe(id);
    expect(detail.scored).toBe(TRACES.length);
    expect(detail.results.every((r) => r.verdict === 'pass')).toBe(true);
    expect(detail.regressionCount).toBe(0);
  });

  it('queues an eval run alongside a concurrent discovery run — both complete, never 409', async () => {
    const created = await fetch(`${baseUrl}/api/evals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Queue probe', rule: 'noop' }),
    });
    const { id } = (await created.json()) as { id: string };
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/api/evals/${id}/run`, {
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
    for (const res of [a, b]) {
      expect(res.status).toBe(202);
      const body = (await res.json()) as { runId: string; status: string };
      expect(['queued', 'running']).toContain(body.status);
      expect((await waitForRun(body.runId)).status).toBe('done');
    }
  });

  it('saving the same deviation twice returns the existing eval (idempotent, no duplicate)', async () => {
    const deviation = (
      (await (await fetch(`${baseUrl}/api/deviations`)).json()) as { items: Array<{ id: string }> }
    ).items[0]!;
    const first = (await (
      await fetch(`${baseUrl}/api/evals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviationId: deviation.id }),
      })
    ).json()) as { id: string };
    const second = (await (
      await fetch(`${baseUrl}/api/evals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviationId: deviation.id }),
      })
    ).json()) as { id: string };
    expect(second.id).toBe(first.id);
  });

  it('releases the shared lock when an eval run 404s (no leaked lock)', async () => {
    // The 404 path must not leave the run lock reserved — a later run can start.
    const missing = await fetch(`${baseUrl}/api/evals/eval_does_not_exist/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
    const disc = await fetch(`${baseUrl}/api/discovery/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(disc.status).toBe(202);
    expect((await waitForRun(((await disc.json()) as { runId: string }).runId)).status).toBe('done');
  });

  it('flags a trace failing now that passed last run as a regression', async () => {
    // Seed two runs directly (the mock can't produce a `fail`): trace X flips
    // pass→fail (a regression), trace Y stays failing (not a regression), trace
    // Z is newly passing.
    const { db } = runtime;
    const evalId = 'eval_regression_probe';
    await db.insert(evals).values({
      id: evalId,
      label: 'Regression probe',
      description: '',
      rule: 'The agent must not hallucinate.',
      source: 'manual',
    });
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-01-02T00:00:00Z');
    await db.insert(runs).values([
      { id: 'run_reg_old', kind: 'eval', status: 'done', startedAt: older },
      { id: 'run_reg_new', kind: 'eval', status: 'done', startedAt: newer },
    ]);
    await db.insert(evalResults).values([
      { id: 'evr_o_x', evalId, runId: 'run_reg_old', traceId: 'traceX', verdict: 'pass', evidence: 'ok' },
      { id: 'evr_o_y', evalId, runId: 'run_reg_old', traceId: 'traceY', verdict: 'fail', evidence: 'bad' },
      { id: 'evr_n_x', evalId, runId: 'run_reg_new', traceId: 'traceX', verdict: 'fail', evidence: 'now bad' },
      { id: 'evr_n_y', evalId, runId: 'run_reg_new', traceId: 'traceY', verdict: 'fail', evidence: 'still bad' },
      { id: 'evr_n_z', evalId, runId: 'run_reg_new', traceId: 'traceZ', verdict: 'pass', evidence: 'ok' },
    ]);

    const detail = await getEvalDetail(db, evalId);
    expect(detail).not.toBeNull();
    expect(detail!.latestRunId).toBe('run_reg_new');
    expect(detail!.scored).toBe(3);
    expect(detail!.failed).toBe(2);
    expect(detail!.passed).toBe(1);
    // Only traceX regressed (pass → fail); traceY was already failing.
    expect(detail!.regressionCount).toBe(1);
    // Regressions sort to the very top of the results.
    expect(detail!.results[0]!.traceId).toBe('traceX');
    expect(detail!.results[0]!.regression).toBe(true);
    // Run history is oldest→newest with the right pass/fail split per run.
    expect(detail!.history.map((h) => h.runId)).toEqual(['run_reg_old', 'run_reg_new']);
    expect(detail!.history[0]).toMatchObject({ passed: 1, failed: 1, total: 2 });
    expect(detail!.history[1]).toMatchObject({ passed: 1, failed: 2, total: 3 });
  });

  it('deletes an eval and its results', async () => {
    const created = await fetch(`${baseUrl}/api/evals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Doomed', rule: 'noop' }),
    });
    const { id } = (await created.json()) as { id: string };
    const del = await fetch(`${baseUrl}/api/evals/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const gone = await fetch(`${baseUrl}/api/evals/${id}`);
    expect(gone.status).toBe(404);
  });
});
