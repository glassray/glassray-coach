import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Glassray } from '@glassray/tracing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';

/*
 * M10 integration suite: a real @glassray/tracing round trip. The published SDK
 * (a coach devDependency) instruments a tiny agent pointed at a live Coach; we
 * then assert Coach ingested and normalized the trace — proving the OTLP wire
 * format, gzip, bearer auth, and the AGENT → LLM → TOOL shape stay compatible.
 * Locks the integration against drift on either side.
 */

process.env.GLASSRAY_LLM_PROVIDER = 'mock';

let home: string;
let app: FastifyInstance;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-coach-sdk-'));
  const runtime = await bootstrap(home);
  apiKey = runtime.apiKey;
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('glassray-coach M10 real SDK round trip', () => {
  it('ingests + normalizes a trace produced by @glassray/tracing', async () => {
    // Point the SDK at Coach (a bare origin exercises the SDK's own
    // `/api/public/otel/v1/traces` path append against Coach's alias route).
    const glassray = new Glassray({
      endpoint: baseUrl,
      apiKey,
      environment: 'local',
      agent: 'roundtrip-agent',
    });

    // A large tool output pushes the body past the SDK's 8 KiB gzip threshold,
    // so this also covers gzip decode on the ingest side.
    const big = 'x'.repeat(12_000);
    await glassray.trace('checkout-flow', { customer: 'acme' }, async (t) => {
      await t.llm('plan', { model: 'claude-opus-4-8', provider: 'anthropic' }, async () => ({
        content: 'here is the plan',
        usage: { input_tokens: 900, output_tokens: 210 },
      }));
      await t.tool('charge-card', async () => ({ ok: true, receipt: big }));
      return 'done';
    });
    await glassray.flush();
    expect(glassray.stats().sent).toBe(1);

    // Coach should have the trace with a 3-node AGENT → LLM → TOOL tree.
    const list = (await (await fetch(`${baseUrl}/api/traces`)).json()) as {
      total: number;
      items: Array<{ id: string; name: string | null; agent: string | null; spanCount: number }>;
    };
    expect(list.total).toBe(1);
    const row = list.items[0]!;
    expect(row.name).toBe('checkout-flow');
    expect(row.agent).toBe('roundtrip-agent');
    expect(row.spanCount).toBe(3);

    const { view } = (await (await fetch(`${baseUrl}/api/traces/${row.id}`)).json()) as {
      view: {
        provider: string | null;
        tree: { kind: string; children: Array<{ kind: string; name: string; model: string | null }> };
      };
    };
    expect(view.provider).toBe('anthropic');
    expect(view.tree.kind).toBe('agent');
    const kinds = view.tree.children.map((c) => c.kind).sort();
    expect(kinds).toEqual(['llm', 'tool']);
    const llm = view.tree.children.find((c) => c.kind === 'llm')!;
    expect(llm.model).toBe('claude-opus-4-8');
  });
});
