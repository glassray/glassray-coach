import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap, type CoachRuntime } from './bootstrap.js';

/*
 * The harness-driven local loop (docs/portable-rule-artifact.md v2), end to
 * end on the mock provider: run labels persist from the SDK `environment`
 * attribute and filter the trace list; `glassray run <flow> --label <x>`
 * spawns the recipe with the three env vars and counts what lands; compare
 * resolves `{ label }` corpora and prices each side through the model price
 * book (the "is it cheaper?" fix); the ingest `?label=` override tags
 * cloud-pulled traces.
 */

/** Force the offline mock backend for the whole file (no network, deterministic). */
process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** Repo root (this file lives in coach/server/). */
const COACH_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A single-llm-span envelope carrying the run label (resource-level
 * `glassray.environment`), a model id, and token counts — the facts the label
 * persistence + price-book pricing read.
 */
const makeEnvelope = (
  traceId: string,
  opts: { label?: string; model: string; tokensIn: number; tokensOut: number },
) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'digest-bot' } },
          ...(opts.label ? [{ key: 'glassray.environment', value: { stringValue: opts.label } }] : []),
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'test-scope' },
          spans: [
            {
              traceId,
              spanId: '00112233aabbccdd',
              name: 'digest',
              kind: 1,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001500000000',
              status: {},
              attributes: [
                { key: 'input.value', value: { stringValue: 'summarize this ticket' } },
                { key: 'gen_ai.request.model', value: { stringValue: opts.model } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: opts.tokensIn } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: opts.tokensOut } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

let home: string;
let workDir: string;
let runtime: CoachRuntime;
let app: FastifyInstance;
let baseUrl: string;
let port: number;

/** POST JSON to the hermetic app and return the parsed body (asserting the expected status). */
const post = async (pathname: string, body: unknown, expectStatus = 200, headers: Record<string, string> = {}): Promise<any> => {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  expect(res.status, `POST ${pathname}`).toBe(expectStatus);
  return res.json();
};

/** GET JSON from the hermetic app. */
const get = async (pathname: string): Promise<any> => {
  const res = await fetch(`${baseUrl}${pathname}`);
  expect(res.status, `GET ${pathname}`).toBe(200);
  return res.json();
};

/** Ingest one envelope through the authed OTLP route (optionally with the ?label= override). */
const ingest = async (envelope: unknown, label?: string): Promise<void> => {
  const qs = label ? `?label=${encodeURIComponent(label)}` : '';
  const res = await fetch(`${baseUrl}/v1/traces${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}` },
    body: JSON.stringify(envelope),
  });
  expect(res.status).toBe(200);
};

/** Poll GET /api/runs/:id until it settles, or throw after the deadline. */
const waitForRun = async (runId: string): Promise<any> => {
  for (let i = 0; i < 200; i++) {
    const body = await get(`/api/runs/${runId}`);
    if (body.status === 'done' || body.status === 'error') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish in time`);
};

/** Spawn the real CLI against the hermetic server, capturing output + exit code. */
const runCli = (args: string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(COACH_ROOT, 'bin', 'glassray.mjs'), ...args, '--port', String(port)],
      { cwd, env: { ...process.env, GLASSRAY_HOME: home } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-loop-'));
  workDir = await mkdtemp(path.join(tmpdir(), 'glassray-loop-repo-'));
  runtime = await bootstrap(home);
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  port = Number(new URL(baseUrl).port);

  // Baseline corpus: two Sonnet traces. Candidate corpus: two Haiku traces —
  // same token shape so the price-book delta is purely the model swap.
  await ingest(makeEnvelope('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', { label: 'baseline', model: 'claude-sonnet-4-6', tokensIn: 100_000, tokensOut: 20_000 }));
  await ingest(makeEnvelope('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', { label: 'baseline', model: 'claude-sonnet-4-6', tokensIn: 100_000, tokensOut: 20_000 }));
  await ingest(makeEnvelope('c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', { label: 'haiku', model: 'claude-haiku-4-5', tokensIn: 100_000, tokensOut: 20_000 }));
  await ingest(makeEnvelope('d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', { label: 'haiku', model: 'claude-haiku-4-5', tokensIn: 100_000, tokensOut: 20_000 }));
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('run labels (1.3)', () => {
  it('persists the SDK environment as run_label and filters the trace list by it', async () => {
    const baseline = await get('/api/traces?label=baseline');
    const haiku = await get('/api/traces?label=haiku');
    expect(baseline.total).toBe(2);
    expect(haiku.total).toBe(2);
    // Disjoint sets, each row carrying its label.
    const baselineIds = new Set(baseline.items.map((t: any) => t.id));
    expect(haiku.items.every((t: any) => !baselineIds.has(t.id))).toBe(true);
    expect(baseline.items.every((t: any) => t.runLabel === 'baseline')).toBe(true);
  });

  it('persists the primary llm model on the trace row', async () => {
    const { items } = await get('/api/traces?label=haiku&limit=1');
    const detail = await get(`/api/traces/${items[0].id}`);
    expect(detail.view.tree.model ?? detail.view.tree.children?.[0]?.model).toBeDefined();
  });

  it('the ingest ?label= override wins over the envelope environment (the cloud-pull tag)', async () => {
    await ingest(
      makeEnvelope('e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5', { label: 'ignored-env', model: 'claude-sonnet-4-6', tokensIn: 10, tokensOut: 5 }),
      'production',
    );
    const production = await get('/api/traces?label=production');
    expect(production.total).toBe(1);
    expect(production.items[0].id).toBe('e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5');
  });
});

describe('compare by label + the cost fix (1.4)', () => {
  it('resolves { label } corpora and prices both sides through the price book', async () => {
    await post('/api/evals', { name: 'English summary', text: 'PASS if plain English.' }, 201);
    const accepted = await post(
      '/api/compare',
      { baseline: { label: 'baseline' }, candidate: { label: 'haiku' } },
      202,
    );
    const run = await waitForRun(accepted.runId);
    expect(run.status).toBe('done');
    const report = run.stats;
    expect(report.baseline.traces).toBe(2);
    expect(report.candidate.traces).toBe(2);
    // Sonnet 100k/20k ×2 = 2×(0.3 + 0.3) = $1.20; Haiku ×2 = 2×(0.1 + 0.1) = $0.40.
    expect(report.baseline.estCostIfMeteredUsd).toBeCloseTo(1.2, 5);
    expect(report.candidate.estCostIfMeteredUsd).toBeCloseTo(0.4, 5);
    expect(report.costIfMeteredDeltaUsd).toBeCloseTo(-0.8, 5);
    // Per-rule deltas exist (mock judge passes everything → delta 0).
    expect(report.rules.length).toBeGreaterThanOrEqual(1);
    expect(report.rules[0].deltaPassRate).toBe(0);
  });

  it('mirrors the price-book cost into GET /api/stats byAgent', async () => {
    const stats = await get('/api/stats');
    expect(stats.totals.estCostIfMeteredUsd).toBeGreaterThan(0);
    const agent = stats.byAgent.find((a: any) => a.agent === 'digest-bot');
    expect(agent.estCostIfMeteredUsd).toBeGreaterThan(0);
  });
});

describe('glassray run (1.2)', () => {
  it('spawns the recipe with the three env vars, and the landed traces carry the label', async () => {
    // A harness-style runner: records its env, then POSTs one trace tagged
    // with GLASSRAY_RUN_LABEL to GLASSRAY_ENDPOINT (what @glassray/tracing does).
    const runner = `
      import { writeFileSync } from 'node:fs';
      const { GLASSRAY_ENDPOINT, GLASSRAY_API_KEY, GLASSRAY_RUN_LABEL } = process.env;
      writeFileSync('env-seen.json', JSON.stringify({ GLASSRAY_ENDPOINT, GLASSRAY_API_KEY, GLASSRAY_RUN_LABEL }));
      const envelope = ${JSON.stringify(makeEnvelope('f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6', { model: 'claude-haiku-4-5', tokensIn: 10, tokensOut: 5 }))};
      envelope.resourceSpans[0].resource.attributes.push({ key: 'glassray.environment', value: { stringValue: GLASSRAY_RUN_LABEL } });
      const res = await fetch(GLASSRAY_ENDPOINT + '/v1/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + GLASSRAY_API_KEY },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) { console.error('ingest failed', res.status); process.exit(1); }
    `;
    await writeFile(path.join(workDir, 'runner.mjs'), runner);
    await writeFile(
      path.join(workDir, 'glassray.yaml'),
      [
        'version: 1',
        'flows:',
        '  - id: digest',
        '    description: per-trace summary',
        '    membership:',
        '      selector: { agent: digest-bot }',
        '    run:',
        '      command: node runner.mjs',
        '      inputs: glassray/inputs/digest/',
        'rules: []',
        '',
      ].join('\n'),
    );

    const res = await runCli(['run', 'digest', '--label', 'candidate'], workDir);
    expect(res.stderr).toContain("1 traces landed for label 'candidate'");
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ flow: 'digest', label: 'candidate', traces: 1 });

    const envSeen = JSON.parse(await readFile(path.join(workDir, 'env-seen.json'), 'utf8'));
    expect(envSeen.GLASSRAY_ENDPOINT).toBe(`http://127.0.0.1:${port}`);
    expect(envSeen.GLASSRAY_API_KEY).toBe(runtime.apiKey);
    expect(envSeen.GLASSRAY_RUN_LABEL).toBe('candidate');

    const landed = await get('/api/traces?label=candidate');
    expect(landed.total).toBe(1);
  });

  it('fails (non-zero) when the recipe lands no traces', async () => {
    await writeFile(
      path.join(workDir, 'glassray.yaml'),
      ['version: 1', 'flows:', '  - id: noop', '    membership:', '      selector: { agent: digest-bot }', '    run:', '      command: node -e "process.exit(0)"', 'rules: []', ''].join('\n'),
    );
    const res = await runCli(['run', 'noop', '--label', 'empty-run'], workDir);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("no traces landed for label 'empty-run'");
    // 20s: the CLI legitimately spends its 5s ingest grace window before failing.
  }, 20_000);

  it('fails cleanly when the flow has no run recipe', async () => {
    await writeFile(
      path.join(workDir, 'glassray.yaml'),
      ['version: 1', 'flows:', '  - id: bare', '    membership:', '      selector: { agent: digest-bot }', 'rules: []', ''].join('\n'),
    );
    const res = await runCli(['run', 'bare', '--label', 'x'], workDir);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no run recipe');
  });
});

describe('compare CLI label resolution (1.4)', () => {
  it('`compare <flow> <baseline> <candidate>` maps bare labels to { label } corpora', async () => {
    // The flow must exist on the server with a watched rule for the suite.
    const flowId = (
      await post('/api/flows', { name: 'Digest', selector: { agent: 'digest-bot' } }, 201)
    ).id;
    await post('/api/evals', { name: 'Digest rule', text: 'PASS always.', flowId }, 201);
    const res = await runCli(['compare', 'digest', 'baseline', 'haiku'], workDir);
    expect(res.status).toBe(0);
    const run = JSON.parse(res.stdout);
    expect(run.stats.baseline.ref).toEqual({ label: 'baseline' });
    expect(run.stats.candidate.ref).toEqual({ label: 'haiku' });
    expect(res.stderr).toContain('cost if metered');
  });
});
