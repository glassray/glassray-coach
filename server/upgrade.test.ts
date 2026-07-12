import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type CoachRuntime } from './bootstrap.js';
import { evals, flowTraces, flows, runs, traces } from './schema.js';

/*
 * In-place upgrade of a PRE-REVAMP (0.1) datadir: seed the old schema exactly as
 * the 0.1 bootstrap created it, then run the current bootstrap over the same
 * directory and assert the one-time backfills — legacy clustered flows survive
 * (newest run active, older runs archived, rule = description), memberships get
 * `llm` provenance, history is stamped classified (no surprise sweep), and
 * orphaned queued/running runs are failed.
 */

/** The 0.1 shape of the tables this revamp alters (verbatim from the old BOOTSTRAP_SQL). */
const LEGACY_DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE traces (
  id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL,
  name text, agent text, provider text,
  started_at timestamptz, duration_ms integer, span_count integer, status text,
  tokens_in integer, tokens_out integer, input_preview text, output_preview text
);
CREATE TABLE runs (
  id text PRIMARY KEY, kind text NOT NULL, status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error text, stats jsonb
);
CREATE TABLE flows (
  id text PRIMARY KEY, run_id text NOT NULL, name text NOT NULL, description text NOT NULL,
  trace_count integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE flow_traces (
  flow_id text NOT NULL, trace_id text NOT NULL, PRIMARY KEY (flow_id, trace_id)
);
CREATE TABLE evals (
  id text PRIMARY KEY, label text NOT NULL, description text NOT NULL, rule text NOT NULL,
  source text NOT NULL, source_deviation_id text, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO traces (id, raw, name, agent) VALUES
  ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{"resourceSpans":[]}', 'old-trace', 'old-bot');
INSERT INTO runs (id, kind, status) VALUES ('run_orphan', 'flows', 'running');
INSERT INTO flows (id, run_id, name, description, trace_count, created_at) VALUES
  ('flow_old', 'run_a', 'Booking', 'Books appointments', 1, now() - interval '1 hour'),
  ('flow_new', 'run_b', 'Questions', 'Answers questions', 1, now());
INSERT INTO flow_traces (flow_id, trace_id) VALUES
  ('flow_new', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
INSERT INTO evals (id, label, description, rule, source) VALUES
  ('eval_old', 'Old eval', '', 'Be nice', 'manual');
`;

let home: string;
let rt: CoachRuntime;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'glassray-upgrade-'));
  const dataDir = path.join(home, 'data', 'db');
  await mkdir(dataDir, { recursive: true }); // PGlite does not create parent directories itself
  const legacy = new PGlite(dataDir, { extensions: { vector } });
  await legacy.waitReady;
  await legacy.exec(LEGACY_DDL);
  await legacy.close();
  rt = await bootstrap(home);
}, 120_000);

afterAll(async () => {
  await rt.client.close();
  await rm(home, { recursive: true, force: true });
});

describe('0.1 → 0.2 datadir upgrade', () => {
  it('keeps only the newest clustering run active and marks legacy flows as LLM discovery output', async () => {
    const rows = await rt.db.select().from(flows).orderBy(flows.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const oldFlow = byId.get('flow_old')!;
    const newFlow = byId.get('flow_new')!;
    expect(oldFlow.status).toBe('archived');
    expect(newFlow.status).toBe('active');
    for (const f of [oldFlow, newFlow]) {
      expect(f.createdBy).toBe('discovery');
      expect(f.classify).toBe('llm');
      expect(f.rule).toBe(f.description);
      expect(f.selector).toBeNull();
    }
  });

  it('backfills membership provenance, stamps history as classified, and fails orphaned runs', async () => {
    const membership = (await rt.db.select().from(flowTraces).where(eq(flowTraces.flowId, 'flow_new')))[0]!;
    expect(membership.assignedBy).toBe('llm');

    const trace = (await rt.db.select().from(traces).where(eq(traces.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')))[0]!;
    expect(trace.classifiedAt).not.toBeNull();

    const orphan = (await rt.db.select().from(runs).where(eq(runs.id, 'run_orphan')))[0]!;
    expect(orphan.status).toBe('error');
  });

  it('gives legacy evals the flow-scoping + source-file defaults', async () => {
    const ev = (await rt.db.select().from(evals).where(eq(evals.id, 'eval_old')))[0]!;
    expect(ev.flowId).toBeNull();
    // A legacy eval lands custom (no source file) — every rule is active now; the
    // `state` column is retained only vestigially (the legacy migration set it).
    expect(ev.sourceFile).toBeNull();
    expect(ev.autorunThreshold).toBe(10);
    expect(ev.threshold).toBeNull();
    expect(ev.judgeModel).toBeNull();
    expect(ev.slug).toBeNull();
    expect(ev.lastRunAt).toBeNull();
  });
});
