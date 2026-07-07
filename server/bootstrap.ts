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
  output_preview text
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
  run_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  trace_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flows_run_id_idx ON flows (run_id);
CREATE TABLE IF NOT EXISTS flow_traces (
  flow_id text NOT NULL,
  trace_id text NOT NULL,
  PRIMARY KEY (flow_id, trace_id)
);
CREATE TABLE IF NOT EXISTS evals (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  rule text NOT NULL,
  source text NOT NULL,
  source_deviation_id text,
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
  // 'running' at boot was interrupted by a crash/restart and will never finish
  // (its in-process runner promise is gone). Mark it errored so the dashboard's
  // poll loop and the MCP wait-for-run don't hang on a permanently-'running' row.
  await client.exec(
    `UPDATE runs SET status = 'error', finished_at = now(), error = 'interrupted by a server restart' WHERE status = 'running';`,
  );
  const db = drizzle(client, { schema });
  return { home, apiKey, client, db };
};
