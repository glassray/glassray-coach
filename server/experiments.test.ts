import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap, type CoachRuntime } from './bootstrap.js';

/*
 * Experiments-as-a-first-class-object suite, on the deterministic `mock`
 * provider. Boots a hermetic coach, ingests two labeled corpora (baseline
 * Sonnet vs candidate Haiku), then: open an experiment → run its report
 * (compare over the rules) → assert it concludes with a verdict, an embedded
 * compare report, and a non-zero cost delta.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** A single-llm-span envelope carrying a run label, a model id, and token counts. */
const makeEnvelope = (traceId: string, label: string, model: string) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'digest-bot' } },
          { key: 'glassray.environment', value: { stringValue: label } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'test-scope' },
          spans: [
            {
              traceId,
              spanId: '00112233aabbccdd',
              name: 'digest',
              kind: 1,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001500000000',
              status: {},
              attributes: [
                { key: 'input.value', value: { stringValue: 'summarize this ticket' } },
                { key: 'gen_ai.request.model', value: { stringValue: model } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: 100_000 } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: 20_000 } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

let home: string;
let runtime: CoachRuntime;
let app: FastifyInstance;
let baseUrl: string;

const post = async (pathname: string, body: unknown, expectStatus = 200): Promise<any> => {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status, `POST ${pathname}`).toBe(expectStatus);
  return res.json();
};

const get = async (pathname: string): Promise<any> => {
  const res = await fetch(`${baseUrl}${pathname}`);
  expect(res.status, `GET ${pathname}`).toBe(200);
  return res.json();
};

const ingest = async (envelope: unknown): Promise<void> => {
  const res = await fetch(`${baseUrl}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}` },
    body: JSON.stringify(envelope),
  });
  expect(res.status).toBe(200);
};

const waitForRun = async (runId: string): Promise<any> => {
  for (let i = 0; i < 200; i++) {
    const body = await get(`/api/runs/${runId}`);
    if (body.status === 'done' || body.status === 'error') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish in time`);
};

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-exp-'));
  runtime = await bootstrap(home);
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  await ingest(makeEnvelope('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'baseline', 'claude-sonnet-4-6'));
  await ingest(makeEnvelope('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'baseline', 'claude-sonnet-4-6'));
  await ingest(makeEnvelope('c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'haiku', 'claude-haiku-4-5'));
  await ingest(makeEnvelope('d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'haiku', 'claude-haiku-4-5'));
  await post('/api/evals', { label: 'English summary', rule: 'PASS if plain English.' }, 201);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('experiments', () => {
  it('opens, lists, and reads back an experiment', async () => {
    const { id } = await post('/api/experiments', { question: 'Can we switch to Haiku?' }, 201);
    expect(id).toMatch(/^exp_/);
    const list = await get('/api/experiments');
    expect(list.items.some((e: any) => e.id === id)).toBe(true);
    const detail = await get(`/api/experiments/${id}`);
    expect(detail).toMatchObject({ question: 'Can we switch to Haiku?', status: 'open', verdict: null, report: null });
  });

  it('concludes with a verdict, an embedded compare report, and a cost delta', async () => {
    const { id } = await post('/api/experiments', { question: 'Digest Sonnet → Haiku?' }, 201);
    const accepted = await post(`/api/experiments/${id}/report`, { baseline: 'baseline', candidate: 'haiku' }, 202);
    expect(accepted).toMatchObject({ experimentId: id, baseline: 'baseline', candidate: 'haiku' });
    const run = await waitForRun(accepted.runId);
    expect(run.status).toBe('done');

    const detail = await get(`/api/experiments/${id}`);
    expect(detail.status).toBe('concluded');
    // The mock judge passes every trace → no regressions → a GO verdict.
    expect(detail.verdict).toBe('go');
    expect(detail.report.regressions).toBe(0);
    expect(detail.report.summary).toContain('Suggested verdict: go');
    // Sonnet 100k/20k ×2 = $1.20; Haiku ×2 = $0.40 → delta −0.80.
    expect(detail.report.costDeltaUsd).toBeCloseTo(-0.8, 5);
    expect(detail.report.compare.rules.length).toBeGreaterThanOrEqual(1);
    expect(detail.baselineLabel).toBe('baseline');
    expect(detail.candidateLabel).toBe('haiku');
  });

  it('defaults the corpora to the two newest labels when omitted', async () => {
    const { id } = await post('/api/experiments', { question: 'Default corpora?' }, 201);
    const accepted = await post(`/api/experiments/${id}/report`, {}, 202);
    // Newest label is `haiku` (candidate), second-newest `baseline`.
    expect(accepted.candidate).toBe('haiku');
    expect(accepted.baseline).toBe('baseline');
    const run = await waitForRun(accepted.runId);
    expect(run.status).toBe('done');
    const detail = await get(`/api/experiments/${id}`);
    expect(detail.status).toBe('concluded');
  });
});
