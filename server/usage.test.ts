import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap, type CoachRuntime } from './bootstrap.js';
import { llmUsage } from './schema.js';
import { BudgetExceededError, assertBudget, getSpentUsd, resolveBudgetUsd } from './usage.js';

/*
 * M9 regression suite: LLM usage metering + the spend cap. On the free `mock`
 * provider every call records $0, so the budget is never tripped in normal use;
 * the cap is exercised by seeding a metered-cost row directly.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** Single-span OTLP/JSON envelope so discovery has a trace to judge. */
const envelope = (traceId: string) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent' } }] },
      scopeSpans: [{ spans: [{ traceId, spanId: '00112233aabbccdd', name: 'run', kind: 1, status: {} }] }],
    },
  ],
});

let home: string;
let runtime: CoachRuntime;
let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;

/** Poll GET /api/runs/:id until it leaves `running`. */
const waitForRun = async (runId: string): Promise<{ status: string }> => {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = (await res.json()) as { status: string };
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish`);
};

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-m9-'));
  runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  await fetch(`${baseUrl}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(envelope('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray M9 usage + budget', () => {
  it('resolves the budget from the environment (default / override / unlimited)', () => {
    const saved = process.env.GLASSRAY_LLM_BUDGET_USD;
    try {
      delete process.env.GLASSRAY_LLM_BUDGET_USD;
      expect(resolveBudgetUsd()).toBe(50);
      process.env.GLASSRAY_LLM_BUDGET_USD = '25';
      expect(resolveBudgetUsd()).toBe(25);
      process.env.GLASSRAY_LLM_BUDGET_USD = '0';
      expect(resolveBudgetUsd()).toBe(Infinity);
      process.env.GLASSRAY_LLM_BUDGET_USD = 'nonsense';
      expect(resolveBudgetUsd()).toBe(50);
    } finally {
      if (saved === undefined) delete process.env.GLASSRAY_LLM_BUDGET_USD;
      else process.env.GLASSRAY_LLM_BUDGET_USD = saved;
    }
  });

  it('records mock analysis as $0 usage and surfaces it via GET /api/usage', async () => {
    const start = await fetch(`${baseUrl}/api/discovery/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { runId } = (await start.json()) as { runId: string };
    expect((await waitForRun(runId)).status).toBe('done');

    const usage = (await (await fetch(`${baseUrl}/api/usage`)).json()) as {
      calls: number;
      spentUsd: number;
      overBudget: boolean;
      budgetUsd: number | null;
      byModel: Array<{ provider: string; costUsd: number }>;
    };
    expect(usage.calls).toBeGreaterThan(0); // judge + grouping ran
    expect(usage.spentUsd).toBe(0); // mock is free
    expect(usage.overBudget).toBe(false);
    expect(usage.budgetUsd).toBe(50);
    expect(usage.byModel.every((m) => m.provider === 'mock' && m.costUsd === 0)).toBe(true);
  });

  it('trips the budget once metered spend reaches the cap', async () => {
    const saved = process.env.GLASSRAY_LLM_BUDGET_USD;
    process.env.GLASSRAY_LLM_BUDGET_USD = '1';
    try {
      // A metered spend row above the $1 cap (as if an anthropic run had happened).
      await runtime.db.insert(llmUsage).values({
        id: 'use_seeded',
        kind: 'discovery',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        tokensIn: 100_000,
        tokensOut: 20_000,
        costUsd: 3,
      });
      expect(await getSpentUsd(runtime.db)).toBeGreaterThanOrEqual(3);
      await expect(assertBudget(runtime.db)).rejects.toBeInstanceOf(BudgetExceededError);
    } finally {
      if (saved === undefined) delete process.env.GLASSRAY_LLM_BUDGET_USD;
      else process.env.GLASSRAY_LLM_BUDGET_USD = saved;
    }
  });

  it('clears the ledger via POST /api/usage/reset', async () => {
    const res = await fetch(`${baseUrl}/api/usage/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    const usage = (await (await fetch(`${baseUrl}/api/usage`)).json()) as { calls: number; spentUsd: number };
    expect(usage.calls).toBe(0);
    expect(usage.spentUsd).toBe(0);
  });
});
