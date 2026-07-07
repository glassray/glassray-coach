import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * M8 regression suite: the activity timeline endpoint that powers the Overview
 * dashboard's volume sparkline. Ingests a few traces (one erroring) and asserts
 * the bucketed counts.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** Build a single-span OTLP/JSON envelope; `err` marks the span's status ERROR. */
const makeEnvelope = (traceId: string, err = false) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent' } }] },
      scopeSpans: [
        {
          spans: [
            {
              traceId,
              spanId: '00112233aabbccdd',
              name: 'run',
              kind: 1,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: err ? { code: 2 } : {},
            },
          ],
        },
      ],
    },
  ],
});

let home: string;
let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-timeline-'));
  const runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray M8 timeline', () => {
  it('is empty before anything is ingested', async () => {
    const body = (await (await fetch(`${baseUrl}/api/timeline`)).json()) as {
      points: unknown[];
      from: string | null;
      to: string | null;
    };
    expect(body.points).toEqual([]);
    expect(body.from).toBeNull();
    expect(body.to).toBeNull();
  });

  it('buckets ingested traces and counts errors', async () => {
    const ids = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccc'];
    await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(makeEnvelope(ids[0]!)),
    });
    await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(makeEnvelope(ids[1]!, true)),
    });
    await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(makeEnvelope(ids[2]!)),
    });

    const body = (await (await fetch(`${baseUrl}/api/timeline`)).json()) as {
      points: Array<{ t: string; traces: number; errors: number }>;
      from: string | null;
      to: string | null;
    };
    expect(body.points.length).toBeGreaterThan(0);
    const totalTraces = body.points.reduce((s, p) => s + p.traces, 0);
    const totalErrors = body.points.reduce((s, p) => s + p.errors, 0);
    expect(totalTraces).toBe(3);
    expect(totalErrors).toBe(1);
    expect(body.from).not.toBeNull();
    expect(body.to).not.toBeNull();
  });
});
