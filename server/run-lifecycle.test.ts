import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type CoachRuntime } from './bootstrap.js';
import { createRun, failRun, finishRun, isRunLive, updateRunProgress } from './discovery.js';
import { runs } from './schema.js';

/*
 * Run-lifecycle guards behind the cancel + timeout hardening: the finalisers are
 * `running`-guarded so a run already resolved (canceled by the user, or the
 * timeout backstop) is NOT resurrected by a late-completing runner. Also covers
 * the mid-run progress publish + the liveness gate that stops a late persist.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

let home: string;
let rt: CoachRuntime;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-runlife-'));
  rt = await bootstrap(home);
}, 120_000);

afterAll(async () => {
  await rt.client.close();
  await rm(home, { recursive: true, force: true });
});

/** Read one run row back. */
const getRun = async (id: string) =>
  (await rt.db.select().from(runs).where(eq(runs.id, id)).limit(1))[0];

describe('run lifecycle guards', () => {
  it('publishes progress and reports liveness while running', async () => {
    const id = await createRun(rt.db, 'discovery');
    expect(await isRunLive(rt.db, id)).toBe(true);
    await updateRunProgress(rt.db, id, 3, 10);
    expect((await getRun(id))?.stats).toEqual({ scanned: 3, total: 10 });
  });

  it('does not resurrect a canceled run when a late finisher completes', async () => {
    const id = await createRun(rt.db, 'discovery');
    // The user cancels (or the timeout fires): the run is finalized as errored.
    await failRun(rt.db, id, 'canceled');
    expect(await isRunLive(rt.db, id)).toBe(false);

    // The abandoned runner finishes later and calls finishRun — it must be a no-op.
    await finishRun(rt.db, id, { deviationCount: 2, exampleCount: 5, tracesScanned: 10 });
    const row = await getRun(id);
    expect(row?.status).toBe('error');
    expect(row?.error).toBe('canceled');
  });

  it('a stale progress update after finalize is ignored', async () => {
    const id = await createRun(rt.db, 'discovery');
    await finishRun(rt.db, id, { deviationCount: 0, exampleCount: 0, tracesScanned: 4 });
    // A late progress write from the abandoned runner must not clobber the terminal stats.
    await updateRunProgress(rt.db, id, 1, 4);
    const row = await getRun(id);
    expect(row?.status).toBe('done');
    expect(row?.stats).toEqual({ deviationCount: 0, exampleCount: 0, tracesScanned: 4 });
  });
});
