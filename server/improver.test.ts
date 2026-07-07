import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * Self-healing loop — fix generation. Seeds one deviation + example directly
 * (isolating the improver from discovery), then drives the loop: generate a fix
 * (mock provider), confirm it persists on the deviation, and toggle the
 * open/resolved status. Guards the endpoint → run → improver → persist → read
 * wiring and the status transitions — not the fix's prose (mock output isn't a
 * real fix doc).
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

const DEV_ID = 'dev_looptest0001';
const TRACE_ID = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

let home: string;
let app: FastifyInstance;
let baseUrl: string;

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
  home = await mkdtemp(path.join(tmpdir(), 'glassray-improver-'));
  const runtime = await bootstrap(home);
  // Seed one deviation + example directly so the fix test doesn't depend on discovery.
  await runtime.client.exec(
    `INSERT INTO deviations (id, run_id, label, description, rule, severity, example_count, status)
     VALUES ('${DEV_ID}', 'run_seed', 'Leaks PII', 'Agent echoes raw PII back to the user',
             'Never echo raw PII (SSNs, card numbers) back to the user', 'major', 1, 'open');
     INSERT INTO deviation_examples (id, deviation_id, trace_id, label, description, severity, evidence)
     VALUES ('dex_seed0001', '${DEV_ID}', '${TRACE_ID}', 'Leaked SSN', 'Returned an SSN verbatim',
             'major', 'user asked for their record; agent replied "your SSN is 123-45-6789"');`,
  );
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('self-healing loop — fix generation (mock)', () => {
  it('404s when generating a fix for an unknown deviation', async () => {
    const res = await fetch(`${baseUrl}/api/deviations/dev_missing/fix`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('generates a fix, runs it to done, and persists it on the deviation', async () => {
    const before = await fetch(`${baseUrl}/api/deviations/${DEV_ID}`);
    const beforeBody = (await before.json()) as { deviation: { fixMarkdown: string | null; status: string } };
    expect(beforeBody.deviation.fixMarkdown).toBeNull();

    const start = await fetch(`${baseUrl}/api/deviations/${DEV_ID}/fix`, { method: 'POST' });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);

    const done = await waitForRun(runId);
    expect(done.status).toBe('done');
    expect(done.stats?.fixChars).toBeGreaterThan(0);

    const after = await fetch(`${baseUrl}/api/deviations/${DEV_ID}`);
    const afterBody = (await after.json()) as {
      deviation: { fixMarkdown: string | null; fixModel: string | null; fixGeneratedAt: string | null };
    };
    expect(typeof afterBody.deviation.fixMarkdown).toBe('string');
    expect(afterBody.deviation.fixMarkdown!.length).toBeGreaterThan(0);
    expect(afterBody.deviation.fixGeneratedAt).not.toBeNull();
  });

  it('surfaces hasFix in the list once a fix exists', async () => {
    const list = await fetch(`${baseUrl}/api/deviations`);
    const body = (await list.json()) as { items: Array<{ id: string; hasFix: boolean }> };
    const seeded = body.items.find((d) => d.id === DEV_ID);
    expect(seeded?.hasFix).toBe(true);
  });

  it('resolves and reopens a deviation', async () => {
    const resolve = await fetch(`${baseUrl}/api/deviations/${DEV_ID}/resolve`, { method: 'POST' });
    expect(resolve.status).toBe(200);
    let detail = (await (await fetch(`${baseUrl}/api/deviations/${DEV_ID}`)).json()) as {
      deviation: { status: string };
    };
    expect(detail.deviation.status).toBe('resolved');

    const reopen = await fetch(`${baseUrl}/api/deviations/${DEV_ID}/reopen`, { method: 'POST' });
    expect(reopen.status).toBe(200);
    detail = (await (await fetch(`${baseUrl}/api/deviations/${DEV_ID}`)).json()) as { deviation: { status: string } };
    expect(detail.deviation.status).toBe('open');
  });
});
