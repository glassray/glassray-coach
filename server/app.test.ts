import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/** Fixed 32-hex traceId used across the tests. */
const TRACE_ID = '0123456789abcdef0123456789abcdef';

/** Minimal single-span OTLP/JSON envelope. */
const ENVELOPE = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'test-agent' } }],
      },
      scopeSpans: [
        {
          scope: { name: 'test-scope' },
          spans: [
            {
              traceId: TRACE_ID,
              spanId: '0011223344556677',
              name: 'root-span',
              kind: 1,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001500000000',
              status: {},
              attributes: [],
            },
          ],
        },
      ],
    },
  ],
};

let home: string;
let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-test-'));
  const runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray server', () => {
  it('rejects ingest with a wrong API key (401)', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer glsk_local_definitely_wrong',
      },
      body: JSON.stringify(ENVELOPE),
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with a non-loopback Host header (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/info',
      headers: { host: 'evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests with a non-loopback Origin header (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/info',
      headers: { host: '127.0.0.1:5899', origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a minimal OTLP envelope with the local key (200 {})', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(ENVELOPE),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('accepts the same envelope on the alias ingest path', async () => {
    const res = await fetch(`${baseUrl}/api/public/otel/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(ENVELOPE),
    });
    expect(res.status).toBe(200);
  });

  it('lists the ingested trace newest-first via GET /api/traces', async () => {
    const res = await fetch(`${baseUrl}/api/traces`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; spanCount: number | null; agent: string | null }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(TRACE_ID);
    expect(body.items[0]?.spanCount).toBe(1);
  });

  it('returns a computed view via GET /api/traces/:id', async () => {
    const res = await fetch(`${baseUrl}/api/traces/${TRACE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; view: Record<string, unknown> };
    expect(body.id).toBe(TRACE_ID);
    expect(body.view).toBeTypeOf('object');
    for (const key of ['name', 'agent', 'spanCount', 'status', 'durationMs', 'tree']) {
      expect(body.view).toHaveProperty(key);
    }
    expect(body.view.spanCount).toBe(1);
  });

  it('rejects non-JSON content types on ingest (415)', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${apiKey}` },
      body: 'not json',
    });
    expect(res.status).toBe(415);
  });

  it('404s an unknown trace id', async () => {
    const res = await fetch(`${baseUrl}/api/traces/${'f'.repeat(32)}`);
    expect(res.status).toBe(404);
  });

  it('reports name, version, ingest endpoint and key via GET /api/info', async () => {
    const res = await fetch(`${baseUrl}/api/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      ingestEndpoint: string;
      apiKey: string;
    };
    expect(body.name).toBe('glassray');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.ingestEndpoint).toBe(`${baseUrl}/v1/traces`);
    expect(body.apiKey).toBe(apiKey);
    expect(body.apiKey).toMatch(/^glsk_local_[0-9a-f]{48}$/);
  });
});
