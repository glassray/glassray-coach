import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as schema from './schema.js';
import { loadSettings } from './settings.js';

/** Drizzle database handle bound to the coach schema. */
export type CoachDb = PgliteDatabase<typeof schema>;

/** Everything a running coach server needs: data home, local API key, PGlite client, drizzle db. */
export type CoachRuntime = {
  home: string;
  apiKey: string;
  client: PGlite;
  db: CoachDb;
};

/** Resolves the Glassray data directory: $GLASSRAY_HOME or ~/.glassray. */
export const resolveHome = (): string =>
  process.env.GLASSRAY_HOME ?? path.join(homedir(), '.glassray');

/** Boot DDL — idempotent raw SQL in lieu of drizzle-kit migrations; must stay in sync with schema.ts. */
const BOOTSTRAP_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS traces (
  id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL,
  name text,
  agent text,
  provider text,
  started_at timestamptz,
  duration_ms integer,
  span_count integer,
  status text,
  tokens_in integer,
  tokens_out integer,
  input_preview text,
  output_preview text,
  run_label text,
  model text,
  classified_at timestamptz
);
CREATE INDEX IF NOT EXISTS traces_received_at_idx ON traces (received_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  stats jsonb
);
CREATE INDEX IF NOT EXISTS runs_kind_started_at_idx ON runs (kind, started_at DESC);
CREATE TABLE IF NOT EXISTS deviations (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  rule text NOT NULL,
  severity text NOT NULL,
  example_count integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  fix_markdown text,
  fix_model text,
  fix_generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deviations_created_at_idx ON deviations (created_at DESC);
CREATE INDEX IF NOT EXISTS deviations_run_id_idx ON deviations (run_id);
-- Backfill the fix/status columns on data dirs created before the self-healing loop.
ALTER TABLE deviations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE deviations ADD COLUMN IF NOT EXISTS fix_markdown text;
ALTER TABLE deviations ADD COLUMN IF NOT EXISTS fix_model text;
ALTER TABLE deviations ADD COLUMN IF NOT EXISTS fix_generated_at timestamptz;
CREATE TABLE IF NOT EXISTS deviation_examples (
  id text PRIMARY KEY,
  deviation_id text NOT NULL,
  trace_id text NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL,
  evidence text NOT NULL
);
CREATE INDEX IF NOT EXISTS deviation_examples_deviation_id_idx ON deviation_examples (deviation_id);
CREATE TABLE IF NOT EXISTS flows (
  id text PRIMARY KEY,
  run_id text,
  name text NOT NULL,
  description text NOT NULL,
  trace_count integer NOT NULL DEFAULT 0,
  selector jsonb,
  rule text,
  classify text NOT NULL DEFAULT 'selector',
  status text NOT NULL DEFAULT 'active',
  created_by text NOT NULL DEFAULT 'user',
  slug text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flows_run_id_idx ON flows (run_id);
CREATE TABLE IF NOT EXISTS flow_traces (
  flow_id text NOT NULL,
  trace_id text NOT NULL,
  assigned_by text NOT NULL DEFAULT 'selector',
  confidence text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, trace_id)
);
CREATE INDEX IF NOT EXISTS flow_traces_trace_id_idx ON flow_traces (trace_id);
CREATE TABLE IF NOT EXISTS evals (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  rule text NOT NULL,
  source text NOT NULL,
  source_deviation_id text,
  flow_id text,
  source_file text,
  state text NOT NULL DEFAULT 'active',
  autorun_threshold integer NOT NULL DEFAULT 10,
  threshold double precision,
  judge_model text,
  slug text,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evals_created_at_idx ON evals (created_at DESC);
CREATE TABLE IF NOT EXISTS eval_results (
  id text PRIMARY KEY,
  eval_id text NOT NULL,
  run_id text NOT NULL,
  trace_id text NOT NULL,
  verdict text NOT NULL,
  evidence text NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_results_eval_id_idx ON eval_results (eval_id);
CREATE INDEX IF NOT EXISTS eval_results_run_id_idx ON eval_results (run_id);
CREATE TABLE IF NOT EXISTS llm_usage (
  id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  cost_usd double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_usage_at_idx ON llm_usage (at DESC);
-- ── Durable-flows revamp (0.2) upgrade for pre-existing datadirs ─────────────
-- Each block is guarded on a marker column so its one-time backfill runs exactly
-- once; the plain ALTERs below the blocks are idempotent on their own.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'flows' AND column_name = 'selector') THEN
    ALTER TABLE flows ADD COLUMN selector jsonb;
    ALTER TABLE flows ADD COLUMN rule text;
    ALTER TABLE flows ADD COLUMN classify text NOT NULL DEFAULT 'selector';
    ALTER TABLE flows ADD COLUMN status text NOT NULL DEFAULT 'active';
    ALTER TABLE flows ADD COLUMN created_by text NOT NULL DEFAULT 'user';
    ALTER TABLE flows ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    -- Legacy clustered flows were discovery output defined only by their description.
    UPDATE flows SET created_by = 'discovery', classify = 'llm', rule = description WHERE run_id IS NOT NULL;
    -- Only the newest clustering run's set stays active (the old UI showed exactly that);
    -- earlier runs' duplicates are archived rather than deleted.
    UPDATE flows SET status = 'archived'
      WHERE run_id IS NOT NULL
        AND run_id <> (SELECT run_id FROM flows WHERE run_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'flow_traces' AND column_name = 'assigned_by') THEN
    ALTER TABLE flow_traces ADD COLUMN assigned_by text NOT NULL DEFAULT 'selector';
    ALTER TABLE flow_traces ADD COLUMN confidence text;
    ALTER TABLE flow_traces ADD COLUMN assigned_at timestamptz NOT NULL DEFAULT now();
    -- Every pre-revamp membership came from the LLM clustering pass.
    UPDATE flow_traces SET assigned_by = 'llm';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'traces' AND column_name = 'classified_at') THEN
    ALTER TABLE traces ADD COLUMN classified_at timestamptz;
    -- Treat pre-revamp history as already swept, so upgrading never triggers a
    -- (potentially expensive) LLM sweep over the whole store. New flows opt into
    -- a bounded backfill instead.
    UPDATE traces SET classified_at = now();
  END IF;
END $$;
ALTER TABLE flows ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE flows ALTER COLUMN trace_count SET DEFAULT 0;
ALTER TABLE evals ADD COLUMN IF NOT EXISTS flow_id text;
ALTER TABLE evals ADD COLUMN IF NOT EXISTS autorun_threshold integer NOT NULL DEFAULT 10;
ALTER TABLE evals ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
CREATE INDEX IF NOT EXISTS flow_traces_trace_id_idx ON flow_traces (trace_id);
CREATE INDEX IF NOT EXISTS traces_unclassified_idx ON traces (received_at) WHERE classified_at IS NULL;
-- ── Rule lifecycle (0.3): the eval \`autorun\` boolean becomes a rule \`state\` ──
-- One-time backfill for pre-state datadirs: an autorun eval was a watched rule,
-- a non-autorun one a proposed rule. Fresh datadirs get \`state\` from the CREATE
-- TABLE above and never had \`autorun\`; the legacy column is left in place.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'evals' AND column_name = 'state') THEN
    ALTER TABLE evals ADD COLUMN state text NOT NULL DEFAULT 'watched';
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'evals' AND column_name = 'autorun') THEN
      UPDATE evals SET state = CASE WHEN autorun THEN 'watched' ELSE 'proposed' END;
    END IF;
  END IF;
END $$;
-- Rules-by-source (retire the proposed/watched/archived lifecycle): a rule now
-- carries WHERE it came from (a repo path, null = custom) instead of a state.
-- The legacy state column is left in place (vestigial — never read for
-- gating) to avoid a destructive migration.
ALTER TABLE evals ADD COLUMN IF NOT EXISTS source_file text;
-- Portable-rule-artifact columns (idempotent on their own).
ALTER TABLE evals ADD COLUMN IF NOT EXISTS threshold double precision;
ALTER TABLE evals ADD COLUMN IF NOT EXISTS judge_model text;
ALTER TABLE evals ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS slug text;
-- Harness-loop columns: the run-label corpus key + the primary observed model
-- (pre-existing rows stay null; both repopulate on re-ingest).
ALTER TABLE traces ADD COLUMN IF NOT EXISTS run_label text;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS model text;
CREATE INDEX IF NOT EXISTS traces_run_label_idx ON traces (run_label) WHERE run_label IS NOT NULL;
`;

/** Reads the local API key from <home>/local-api-key, generating one (glsk_local_ + 48 hex, mode 0600) on first boot. */
export const ensureApiKey = async (home: string): Promise<string> => {
  const keyPath = path.join(home, 'local-api-key');
  try {
    const existing = (await readFile(keyPath, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // No key file yet — generate below.
  }
  const key = `glsk_local_${randomBytes(24).toString('hex')}`;
  // Write 0600 then atomically rename into place. `writeFile`'s `mode` only
  // applies when it CREATES the file, so writing straight to an existing (e.g.
  // empty, wrong-mode) key path would leave the old permissions; a fresh temp
  // file + rename guarantees the final file is always owner-only, with no
  // window where a partially-written or wrong-mode key is observable.
  const tmpPath = `${keyPath}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmpPath, `${key}\n`, { mode: 0o600 });
  await rename(tmpPath, keyPath);
  return key;
};

/** Creates the data dirs, ensures the API key, opens PGlite (with pgvector) and applies the boot DDL. */
export const bootstrap = async (home = resolveHome()): Promise<CoachRuntime> => {
  const dataDir = path.join(home, 'data', 'db');
  // PGlite does not create parent directories itself.
  await mkdir(dataDir, { recursive: true });
  const apiKey = await ensureApiKey(home);
  // Load dashboard-set overrides (provider / models / budget) before serving,
  // so the LLM resolvers and budget check see them from the first request.
  await loadSettings(home);
  const client = new PGlite(dataDir, { extensions: { vector } });
  await client.waitReady;
  await client.exec(BOOTSTRAP_SQL);
  // Reconcile orphaned runs: the server is single-process, so any run still
  // 'running' (or waiting 'queued' in the in-memory FIFO) at boot was
  // interrupted by a crash/restart and will never finish. Mark it errored so
  // the dashboard's poll loop and the CLI's wait-for-run don't hang on a
  // permanently-live row.
  await client.exec(
    `UPDATE runs SET status = 'error', finished_at = now(), error = 'interrupted by a server restart' WHERE status IN ('running', 'queued');`,
  );
  const db = drizzle(client, { schema });
  return { home, apiKey, client, db };
};
