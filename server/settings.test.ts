import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * Dashboard settings: a PATCH persists to <home>/settings.json AND overrides the
 * env-configured provider/model at runtime (the whole point — pick the backend
 * from the UI, no restart). Env baseline is `mock`; the test flips it to `openai`
 * via the API and asserts both the persisted file and the effective /api/llm.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

let home: string;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-settings-'));
  app = await buildApp({ runtime: await bootstrap(home) });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

/** PATCH the settings endpoint. */
const patch = (body: unknown) =>
  fetch(`${baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('dashboard settings', () => {
  it('persists a change and overrides the env-configured provider', async () => {
    // Baseline reflects the env (mock).
    const before = (await (await fetch(`${baseUrl}/api/settings`)).json()) as { provider: string };
    expect(before.provider).toBe('mock');

    const res = await patch({ llmProvider: 'openai', heavyModelId: 'gpt-4o-custom', budgetUsd: 0 });
    expect(res.status).toBe(200);
    const after = (await res.json()) as { provider: string; heavyModelId: string; budgetUsd: number };
    expect(after.provider).toBe('openai');
    expect(after.heavyModelId).toBe('gpt-4o-custom');
    expect(after.budgetUsd).toBe(0);

    // The override reaches the LLM resolver — /api/llm now reports openai, not the env's mock.
    const llm = (await (await fetch(`${baseUrl}/api/llm`)).json()) as { provider: string };
    expect(llm.provider).toBe('openai');

    // And it's on disk for the next boot.
    const file = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')) as {
      llmProvider: string;
      heavyModelId: string;
    };
    expect(file.llmProvider).toBe('openai');
    expect(file.heavyModelId).toBe('gpt-4o-custom');
  });

  it('rejects an invalid provider with 400', async () => {
    const res = await patch({ llmProvider: 'not-a-provider' });
    expect(res.status).toBe(400);
  });
});
