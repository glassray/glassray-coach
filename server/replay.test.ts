import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * M7 regression suite: the span-replay endpoint on the deterministic `mock`
 * backend. POST /api/replay re-issues an (edited) LLM request as free text; the
 * mock echoes the prompt so the round-trip is assertable offline.
 */

/** Force the offline mock backend for the whole file (no network, deterministic). */
process.env.GLASSRAY_LLM_PROVIDER = 'mock';

let home: string;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-m7-'));
  const runtime = await bootstrap(home);
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray M7 replay (mock)', () => {
  it('re-issues an edited LLM request and echoes the prompt (mock)', async () => {
    const res = await fetch(`${baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 'Be terse.', prompt: 'What is 2 + 2?', model: 'my-model', temperature: 0.2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string; provider: string; model: string };
    expect(body.provider).toBe('mock');
    expect(body.model).toBe('my-model'); // explicit override echoed back
    expect(body.output).toContain('[mock replay]');
    expect(body.output).toContain('What is 2 + 2?'); // prompt round-tripped
  });

  it('falls back to the provider default model when none is given', async () => {
    const res = await fetch(`${baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model.length).toBeGreaterThan(0);
  });

  it('rejects an empty prompt with 400', async () => {
    const res = await fetch(`${baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(res.status).toBe(400);
  });
});
