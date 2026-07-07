import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * Correctness regressions for ingest robustness:
 *  - a trace re-POSTed across several batches (standard OTLP BatchSpanProcessor
 *    behavior) must MERGE by spanId, not replace — no earlier span is dropped;
 *  - a malformed span must not 500 with raw zod internals, and must not reject a
 *    batch's other, valid traces.
 * Plus the boot reconciliation of runs orphaned by a crash/restart.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** A one-span scopeSpans group for `traceId`, with an optional parent + status. */
const span = (
  traceId: string,
  spanId: string,
  name: string,
  parentSpanId?: string,
  extra: Record<string, unknown> = {},
) => ({
  resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent' } }] },
  scopeSpans: [
    {
      spans: [
        {
          traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name,
          kind: 1,
          startTimeUnixNano: '1700000000000000000',
          endTimeUnixNano: '1700000001000000000',
          status: {},
          attributes: [],
          ...extra,
        },
      ],
    },
  ],
});

const post = (baseUrl: string, apiKey: string, body: unknown) =>
  fetch(`${baseUrl}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

let home: string;
let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-merge-'));
  const runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('ingest span merge', () => {
  const TRACE = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

  it('merges spans re-POSTed for the same traceId instead of replacing them', async () => {
    // Batch 1: a root + one child (as a BatchSpanProcessor would flush mid-run).
    const r1 = await post(baseUrl, apiKey, {
      resourceSpans: [span(TRACE, 'aa00000000000001', 'root'), span(TRACE, 'aa00000000000002', 'child-1', 'aa00000000000001')],
    });
    expect(r1.status).toBe(200);

    // Batch 2: a later child of the same trace, in a separate POST.
    const r2 = await post(baseUrl, apiKey, {
      resourceSpans: [span(TRACE, 'aa00000000000003', 'child-2', 'aa00000000000001')],
    });
    expect(r2.status).toBe(200);

    // All three spans survive — the second batch did not truncate the trace.
    const view = (await (await fetch(`${baseUrl}/api/traces/${TRACE}`)).json()) as {
      view: { spanCount: number; name: string | null };
    };
    expect(view.view.spanCount).toBe(3);
    expect(view.view.name).toBe('root');
  });

  it('re-POSTing the same spanId replaces (no duplicate), keeping the count stable', async () => {
    // Whole-trace-per-POST SDK path: same spanIds ⇒ pure replacement.
    await post(baseUrl, apiKey, {
      resourceSpans: [span(TRACE, 'aa00000000000001', 'root-renamed')],
    });
    const view = (await (await fetch(`${baseUrl}/api/traces/${TRACE}`)).json()) as {
      view: { spanCount: number; name: string | null };
    };
    expect(view.view.spanCount).toBe(3);
    expect(view.view.name).toBe('root-renamed');
  });
});

describe('ingest span merge — concurrency', () => {
  const TRACE2 = 'c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9';

  it('does not drop spans when batches for one trace arrive concurrently', async () => {
    const N = 8;
    // N separate POSTs, each adding a DISTINCT span to the SAME trace, fired at
    // once. Without the per-trace lock the read-modify-write merges interleave —
    // overlapping reads of the stored raw let the later write clobber earlier
    // spans. The lock serializes them, so every span must survive.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        post(baseUrl, apiKey, { resourceSpans: [span(TRACE2, `bb0000000000000${i}`, `span-${i}`)] }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    const view = (await (await fetch(`${baseUrl}/api/traces/${TRACE2}`)).json()) as {
      view: { spanCount: number };
    };
    expect(view.view.spanCount).toBe(N);
  });
});

describe('ingest robustness to malformed spans', () => {
  it('returns 400 (not 500) when every span in the batch is malformed', async () => {
    const res = await post(baseUrl, apiKey, {
      resourceSpans: [span('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'bb00000000000001', 'bad', undefined, { attributes: 'NOT_AN_ARRAY' })],
    });
    expect(res.status).toBe(400);
  });

  it('still ingests the valid traces in a batch that also contains a malformed one', async () => {
    const good = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
    const bad = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
    const res = await post(baseUrl, apiKey, {
      resourceSpans: [
        span(good, 'cc00000000000001', 'ok-root'),
        span(bad, 'dd00000000000001', 'bad', undefined, { attributes: 'NOT_AN_ARRAY' }),
      ],
    });
    expect(res.status).toBe(200);
    // The good trace landed; the malformed one was skipped.
    expect((await (await fetch(`${baseUrl}/api/traces/${good}`)).json()) as unknown).toHaveProperty('id', good);
    expect((await fetch(`${baseUrl}/api/traces/${bad}`)).status).toBe(404);
  });
});

describe('boot reconciliation of orphaned runs', () => {
  it("marks a run left 'running' by a crash as 'error' on the next boot", async () => {
    // Simulate a crash mid-run: a run row stuck 'running' with no finish.
    const home2 = await mkdtemp(path.join(tmpdir(), 'glassray-reap-'));
    const rt1 = await bootstrap(home2);
    await rt1.client.exec(
      `INSERT INTO runs (id, kind, status) VALUES ('run_orphan', 'discovery', 'running');`,
    );
    await rt1.client.close();

    // Re-boot on the same data dir — the orphaned run must be reconciled.
    const rt2 = await bootstrap(home2);
    const app2 = await buildApp({ runtime: rt2 });
    const url2 = await app2.listen({ port: 0, host: '127.0.0.1' });
    const run = (await (await fetch(`${url2}/api/runs/run_orphan`)).json()) as {
      status: string;
      finishedAt: string | null;
    };
    expect(run.status).toBe('error');
    expect(run.finishedAt).not.toBeNull();

    await app2.close();
    await rm(home2, { recursive: true, force: true });
  }, 120_000);
});
