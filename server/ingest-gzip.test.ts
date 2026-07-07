import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * M10 regression suite: gzip request ingest. The @glassray/tracing SDK (and OTLP
 * HTTP exporters) gzip payloads once they pass ~8 KiB and send
 * `content-encoding: gzip`, so ingest must inflate before JSON-parsing. Without
 * the decoder these bodies 400. Verified end-to-end against the real built SDK;
 * this pins the wire behavior in CI.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** A valid OTLP/JSON envelope; `pad` bloats the input so the body clears the gzip threshold. */
const envelope = (traceId: string, pad = '') => ({
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
              status: {},
              attributes: [{ key: 'input.value', value: { stringValue: `hello ${pad}` } }],
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
  home = await mkdtemp(path.join(tmpdir(), 'glassray-gzip-'));
  const runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray M10 gzip ingest', () => {
  it('accepts a gzip-encoded OTLP body (as the SDK sends for payloads ≥ 8 KiB)', async () => {
    // A >8 KiB envelope, gzipped, exactly as the SDK transport would send it.
    const body = JSON.stringify(envelope('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x'.repeat(12_000)));
    const gz = gzipSync(Buffer.from(body, 'utf8'));
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        authorization: `Bearer ${apiKey}`,
      },
      body: gz,
    });
    expect(res.status).toBe(200);

    const list = (await (await fetch(`${baseUrl}/api/traces`)).json()) as { total: number };
    expect(list.total).toBe(1);
  });

  it('still accepts a plain (uncompressed) JSON body', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(envelope('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')),
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unsupported content-encoding with 400', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'snappy',
        authorization: `Bearer ${apiKey}`,
      },
      body: 'anything',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a body that lies about being gzip with 400 (not a 500)', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        authorization: `Bearer ${apiKey}`,
      },
      body: 'not actually gzip',
    });
    expect(res.status).toBe(400);
  });
});
