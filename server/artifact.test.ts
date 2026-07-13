import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { bootstrap, type CoachRuntime } from './bootstrap.js';

/*
 * Portable-rule-artifact regression suite (docs/portable-rule-artifact.md), on
 * the deterministic `mock` provider. Boots a hermetic coach, ingests traces,
 * builds a flow + rules through the API, then exercises the whole loop:
 * export (slug stamping + file shape) → import (plan / apply / prune /
 * idempotency) → fixtures corpus pinning → the compare run.
 */

/** Force the offline mock backend for the whole file (no network, deterministic). */
process.env.GLASSRAY_LLM_PROVIDER = 'mock';

/** Build a minimal single-span OTLP/JSON envelope with a given id / agent / input. */
const makeEnvelope = (traceId: string, agent: string, input: string) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: agent } }] },
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
              attributes: [{ key: 'input.value', value: { stringValue: input } }],
            },
          ],
        },
      ],
    },
  ],
});

/** Two agents so compare has a baseline and a candidate corpus. */
const TRACES = [
  makeEnvelope('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'digest-old', 'ticket one'),
  makeEnvelope('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'digest-old', 'ticket two'),
  makeEnvelope('c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', 'digest-new', 'ticket three'),
  makeEnvelope('d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'digest-new', 'ticket four'),
];

let home: string;
let runtime: CoachRuntime;
let app: FastifyInstance;
let baseUrl: string;
let flowId: string;

/** POST JSON to the hermetic app and return the parsed body (asserting the expected status). */
const post = async (pathname: string, body: unknown, expectStatus = 200): Promise<any> => {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

/** Poll GET /api/runs/:id until it settles, or throw after the deadline. */
const waitForRun = async (runId: string): Promise<any> => {
  for (let i = 0; i < 200; i++) {
    const body = await get(`/api/runs/${runId}`);
    if (body.status === 'done' || body.status === 'error') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not finish in time`);
};

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-artifact-'));
  runtime = await bootstrap(home);
  app = await buildApp({ runtime });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  for (const envelope of TRACES) {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}` },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
  }
  flowId = (
    await post(
      '/api/flows',
      { name: 'Trace digest', description: 'per-trace summary', selector: { agent: 'digest-old' } },
      201,
    )
  ).id;
  await post(
    '/api/evals',
    { name: 'English summary', text: 'PASS if plain English.', flowId, anchors: [{ file: 'src/digest.ts' }], threshold: 0.95, judgeModel: 'judge-x' },
    201,
  );
  await post('/api/evals', { name: 'Topic sensible', text: 'PASS if topic sensible.', flowId }, 201);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rm(home, { recursive: true, force: true });
});

describe('artifact export', () => {
  it('serializes flows + rules with stable slugs, anchors, judges, and thresholds', async () => {
    const { artifact, yaml } = await get('/api/export');
    expect(artifact.version).toBe(1);
    expect(artifact.flows).toHaveLength(1);
    expect(artifact.flows[0]).toMatchObject({
      id: 'trace-digest',
      name: 'Trace digest',
      membership: { selector: { agent: 'digest-old' } },
    });
    const bySlug = new Map(artifact.rules.map((r: any) => [r.id, r]));
    expect(bySlug.get('english-summary')).toMatchObject({
      flow: 'trace-digest',
      source: 'code',
      anchors: [{ file: 'src/digest.ts' }],
      judge: 'judge-x',
      threshold: 0.95,
      text: 'PASS if plain English.',
    });
    // A custom (hand-written) rule is authored (`promoted`) and carries no anchors.
    expect((bySlug.get('topic-sensible') as any).source).toBe('promoted');
    expect((bySlug.get('topic-sensible') as any).anchors).toBeUndefined();
    expect(yaml).toContain('id: english-summary');

    // Export stamped the derived slugs back onto the rows (durable identity).
    const evalsList = await get('/api/evals');
    expect(evalsList.items.map((e: any) => e.slug).sort()).toEqual(['english-summary', 'topic-sensible']);
  });
});

describe('artifact import (push)', () => {
  it('plans all-noop for an unmodified export', async () => {
    const { artifact } = await get('/api/export');
    const plan = await post('/api/import', { artifact, apply: false });
    expect(plan.applied).toBe(false);
    expect(plan.summary).toMatchObject({ create: 0, update: 0, prune: 0 });
  });

  it('plans and applies create / update / anchor changes, then converges to noop', async () => {
    const { artifact } = await get('/api/export');
    const english = artifact.rules.find((r: any) => r.id === 'english-summary');
    const topic = artifact.rules.find((r: any) => r.id === 'topic-sensible');
    english.threshold = 1;
    topic.anchors = [{ file: 'src/topic.ts' }]; // custom → file-anchored is an ordinary update
    artifact.rules.push({
      id: 'language-correct',
      flow: 'trace-digest',
      text: 'PASS if the language code is right.',
      anchors: [{ file: 'src/digest.ts' }],
    });

    const plan = await post('/api/import', { artifact, apply: false });
    expect(plan.summary).toMatchObject({ create: 1, update: 2, prune: 0 });

    const applied = await post('/api/import', { artifact, apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.summary).toMatchObject({ create: 1, update: 2 });

    const evalsList = await get('/api/evals');
    const byLabel = new Map<string, any>(evalsList.items.map((e: any) => [e.slug, e]));
    expect(byLabel.get('english-summary').threshold).toBe(1);
    expect(byLabel.get('topic-sensible').anchors).toEqual([{ file: 'src/topic.ts' }]);
    expect(byLabel.get('topic-sensible').source).toBe('code');
    expect(byLabel.get('language-correct')).toMatchObject({ anchors: [{ file: 'src/digest.ts' }], source: 'code', flowId });

    // Idempotent: a second apply of the same file is all-noop.
    const replan = await post('/api/import', { artifact, apply: false });
    expect(replan.summary).toMatchObject({ create: 0, update: 0, prune: 0 });
  });

  it('prune deletes unmentioned rules only under prune:true', async () => {
    const { artifact } = await get('/api/export');
    artifact.rules = artifact.rules.filter((r: any) => r.id !== 'topic-sensible');

    // Without prune: the row survives untouched.
    const noPrune = await post('/api/import', { artifact, apply: true });
    expect(noPrune.skippedPrunes).toBe(1);
    let items = (await get('/api/evals')).items;
    expect(items.find((e: any) => e.slug === 'topic-sensible')).toBeDefined();

    // With prune: the rule is DELETED (no archived state) — and no longer a prune candidate after.
    await post('/api/import', { artifact, apply: true, prune: true });
    items = (await get('/api/evals')).items;
    expect(items.find((e: any) => e.slug === 'topic-sensible')).toBeUndefined();
    const replan = await post('/api/import', { artifact, apply: false });
    expect(replan.summary.prune).toBe(0);
  });

  it('accepts the YAML document form and rejects a malformed one', async () => {
    const { yaml } = await get('/api/export');
    const plan = await post('/api/import', { yaml, apply: false });
    expect(plan.summary).toMatchObject({ create: 0, update: 0 });
    await post('/api/import', { yaml: 'version: 2\n', apply: false }, 400);
  });

  it('rejects a legacy `state` lifecycle key instead of silently activating the rule', async () => {
    // A repo carrying an old artifact entry (retired proposed/watched/archived
    // lifecycle) must fail loudly — not be stripped and imported as a gating rule.
    const legacyYaml = [
      'version: 1',
      'flows: []',
      'rules:',
      '  - id: legacy-rule',
      '    text: PASS if fine.',
      '    state: archived',
      '',
    ].join('\n');
    const rejected = await post('/api/import', { yaml: legacyYaml, apply: false }, 400);
    expect(rejected.error).toContain('retired');

    // The same guard applies when the rule is passed as a parsed object, not YAML.
    await post(
      '/api/import',
      { artifact: { version: 1, rules: [{ id: 'legacy-rule', text: 'PASS if fine.', state: 'proposed' }] }, apply: false },
      400,
    );
  });

  it('imports a fresh file into an empty concept-space (the pull-on-another-target path)', async () => {
    const file = {
      version: 1,
      flows: [
        {
          id: 'new-flow',
          description: 'brand new',
          membership: { rule: 'traces that do the new thing' },
        },
      ],
      rules: [
        { id: 'new-rule', flow: 'new-flow', text: 'PASS always.', anchors: [{ file: 'src/new.ts' }] },
      ],
    };
    const applied = await post('/api/import', { artifact: file, apply: true });
    expect(applied.summary.create).toBe(2);
    // The LLM membership rule flags the classify backfill.
    expect(applied.llmDefinitionChanged).toBe(true);
    const flowsList = await get('/api/flows?status=all');
    const created = flowsList.items.find((f: any) => f.slug === 'new-flow');
    expect(created).toMatchObject({ name: 'New flow', classify: 'llm' });
  });
});

describe('the local-only run recipe (harness loop 1.1)', () => {
  it('round-trips through parse → import → merged export, and import never creates server state from it', async () => {
    const fileYaml = [
      'version: 1',
      'flows:',
      '  - id: trace-digest',
      '    description: per-trace summary',
      '    membership:',
      '      selector: { agent: digest-old }',
      '    run:',
      '      command: node glassray/run-digest.mjs',
      '      inputs: glassray/inputs/trace-digest/',
      'rules: []',
      '',
    ].join('\n');

    // Parse keeps the recipe.
    const parsed = await post('/api/artifact/parse', { yaml: fileYaml });
    expect(parsed.artifact.flows[0].run).toEqual({
      command: 'node glassray/run-digest.mjs',
      inputs: 'glassray/inputs/trace-digest/',
    });

    // Importing a file with a run block plans no flow change (run is invisible
    // to the diff) and applying creates no server state from it.
    const plan = await post('/api/import', { yaml: fileYaml, apply: false });
    const flowAction = plan.actions.find((a: any) => a.kind === 'flow' && a.id === 'trace-digest');
    expect(flowAction.op).toBe('noop');
    await post('/api/import', { yaml: fileYaml, apply: true });

    // A fresh export has no run (the server never stored it)…
    const fresh = await get('/api/export');
    expect(fresh.artifact.flows.find((f: any) => f.id === 'trace-digest').run).toBeUndefined();

    // …but the merged export (what `glassray pull` uses) re-attaches it from
    // the base file, so the file round-trips unchanged.
    const merged = await post('/api/export', { baseYaml: fileYaml });
    expect(merged.artifact.flows.find((f: any) => f.id === 'trace-digest').run).toEqual({
      command: 'node glassray/run-digest.mjs',
      inputs: 'glassray/inputs/trace-digest/',
    });
    expect(merged.yaml).toContain('command: node glassray/run-digest.mjs');

    // And the merged yaml still parses + re-plans as noop for the flow.
    const replan = await post('/api/import', { yaml: merged.yaml, apply: false });
    expect(replan.actions.find((a: any) => a.kind === 'flow' && a.id === 'trace-digest').op).toBe('noop');
  });
});

describe('fixtures corpus pinning', () => {
  it('GET /api/flows/:id/fixtures returns the stored envelopes, and a pinned run scores exactly them', async () => {
    const fixtures = await get(`/api/flows/${flowId}/fixtures`);
    expect(fixtures.flow.slug).toBe('trace-digest');
    expect(fixtures.items).toHaveLength(2);
    expect(fixtures.items[0].raw.resourceSpans).toBeDefined();

    const evalId = (await get('/api/evals')).items.find((e: any) => e.slug === 'english-summary').id;
    const traceIds = fixtures.items.map((i: any) => i.traceId);
    const accepted = await post(`/api/evals/${evalId}/run`, { traceIds }, 202);
    const run = await waitForRun(accepted.runId);
    expect(run.status).toBe('done');
    expect(run.stats.scored).toBe(2);

    const detail = await get(`/api/evals/${evalId}`);
    expect(detail.results.map((r: any) => r.traceId).sort()).toEqual([...traceIds].sort());
  });
});

describe('compare', () => {
  it('scores the watched suite over both corpora and reports per-rule rates + corpus stats', async () => {
    const accepted = await post(
      '/api/compare',
      { baseline: { agent: 'digest-old' }, candidate: { agent: 'digest-new' }, flowId },
      202,
    );
    const run = await waitForRun(accepted.runId);
    expect(run.status).toBe('done');
    expect(run.kind).toBe('compare');
    const report = run.stats;
    // The flow's rules (topic-sensible was pruned/deleted above; english-summary remains).
    expect(report.rules.length).toBeGreaterThanOrEqual(1);
    for (const rule of report.rules) {
      // The mock judge always passes — both sides are 2/2.
      expect(rule.baseline).toMatchObject({ scored: 2, passed: 2 });
      expect(rule.candidate).toMatchObject({ scored: 2, passed: 2 });
      expect(rule.deltaPassRate).toBe(0);
      expect(rule.regressed).toBe(false);
    }
    expect(report.baseline.traces).toBe(2);
    expect(report.candidate.traces).toBe(2);
    expect(report.regressions).toBe(0);
  });

  it('rejects a compare with no rules in scope', async () => {
    const empty = (await post('/api/flows', { name: 'Empty scope', selector: { agent: 'nobody' } }, 201)).id;
    const accepted = await post(
      '/api/compare',
      { baseline: { agent: 'digest-old' }, candidate: { agent: 'digest-new' }, flowId: empty },
      202,
    );
    const run = await waitForRun(accepted.runId);
    expect(run.status).toBe('error');
    expect(run.error).toContain('no rules to compare');
  });
});

describe('rule source', () => {
  it('a deviation saved as a rule lands authored (promoted, no anchors), active', async () => {
    const disc = await post('/api/discovery/run', {}, 202);
    expect((await waitForRun(disc.runId)).status).toBe('done');
    const deviation = (await get('/api/deviations')).items[0];
    const { id } = await post('/api/evals', { deviationId: deviation.id }, 201);
    const detail = await get(`/api/evals/${id}`);
    expect(detail.anchors).toBeNull();
    expect(detail.source).toBe('promoted');
  });
});
