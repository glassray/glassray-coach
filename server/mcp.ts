/**
 * glassray MCP server — a stdio Model Context Protocol bridge that lets a
 * coding agent (Claude Code / Cursor) read the local Coach traces and trigger
 * analysis. The Coach HTTP server owns the single PGlite datadir (PGlite is
 * single-connection), so this process NEVER opens the database — every tool
 * proxies to the RUNNING Coach server over loopback HTTP. stdout carries the
 * MCP JSON-RPC channel exclusively; all human-readable output goes to stderr.
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** Default dashboard/ingest port, mirrored from the CLI / server. */
const DEFAULT_PORT = 5899;

/** Milliseconds between run-status polls while waiting on a discovery/flows run. */
const POLL_INTERVAL_MS = 1_500;

/** Upper bound on how long run_discovery / run_flows wait for the run to finish. */
const POLL_TIMEOUT_MS = 120_000;

/** Promise-based sleep. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Outcome of one loopback API call — parsed JSON on success, HTTP/network detail on failure; never throws. */
type ApiResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; message: string; body: unknown };

/** Successful/failed tool payload in MCP content form (text content carrying JSON or a message). */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Wraps any JSON value as a successful text tool result. */
const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** Wraps a message as an isError tool result (API failures surface here, never as thrown errors). */
const errorResult = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Calls the local Coach HTTP API, mapping network + HTTP errors into a plain result (never throws). */
const callApi = async (base: string, path: string, init?: RequestInit): Promise<ApiResult> => {
  try {
    const res = await fetch(`${base}${path}`, init);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const apiError =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      return { ok: false, status: res.status, message: apiError, body };
    }
    return { ok: true, body };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, message: `cannot reach the Coach server at ${base}: ${detail}`, body: null };
  }
};

/** Probes GET /api/info; returns the info payload when a Coach answers, null otherwise. */
const probeInfo = async (base: string): Promise<{ version?: string } | null> => {
  const res = await callApi(base, '/api/info', { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) return null;
  const info = res.body as { name?: string; version?: string } | null;
  return info?.name === 'glassray' ? info : null;
};

/** Pulls a `runId` string out of an API response body when present (409s and 202s both carry one). */
const extractRunId = (body: unknown): string | undefined => {
  if (typeof body === 'object' && body !== null && 'runId' in body) {
    const runId = (body as { runId: unknown }).runId;
    if (typeof runId === 'string' && runId.length > 0) return runId;
  }
  return undefined;
};

/** POSTs a run-starting endpoint, then polls GET /api/runs/:id to completion (bounded); shared by run_discovery / run_flows. */
const startAndAwaitRun = async (base: string, path: string, body: unknown): Promise<ToolResult> => {
  const started = await callApi(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!started.ok) {
    if (started.status === 409) {
      const runId = extractRunId(started.body);
      return jsonResult({
        note: `a run is already in progress${runId ? ` (${runId})` : ''} — Coach runs one analysis at a time; retry once it finishes`,
        ...(runId ? { runId } : {}),
      });
    }
    return errorResult(started.message);
  }
  const runId = extractRunId(started.body);
  if (!runId) return errorResult('run started but the server returned no runId');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const polled = await callApi(base, `/api/runs/${encodeURIComponent(runId)}`);
    if (!polled.ok) return errorResult(`run ${runId} started but polling it failed: ${polled.message}`);
    const run = polled.body as { status?: string; error?: string | null };
    if (run.status === 'done') return jsonResult(polled.body);
    if (run.status === 'error') {
      return errorResult(`run ${runId} failed: ${run.error ?? 'unknown error'}\n${JSON.stringify(polled.body, null, 2)}`);
    }
  }
  return errorResult(
    `run ${runId} did not finish within ${POLL_TIMEOUT_MS / 1_000}s — it may still complete in the background; check its output tools (list_deviations / list_flows) later`,
  );
};

/** Builds the MCP server named "glassray", proxies every tool to the Coach HTTP API, and serves it over stdio. */
export const runMcpServer = async (opts: { port: number }): Promise<void> => {
  const base = `http://127.0.0.1:${opts.port}`;

  // The Coach HTTP server owns the PGlite datadir — it must already be up.
  const info = await probeInfo(base);
  if (info === null) {
    console.error(`No Coach server on :${opts.port} — run \`coach\` first, then restart this MCP server.`);
    process.exit(1);
  }

  const server = new McpServer({ name: 'glassray', version: info.version ?? '0.0.0' });

  server.registerTool(
    'list_traces',
    {
      description:
        "List recent traces from Glassray Coach — the local trace store for this project's AI agent. Each item is one agent run: id, name, agent, status (ok|error), durationMs, tokensIn/tokensOut, and an inputPreview. Filter with q (substring on name/agent), agent (exact), or status; then use get_trace on an id to read exactly what that run did.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Max traces to return (default 20).'),
        q: z.string().optional().describe('Case-insensitive substring match on trace name or agent.'),
        agent: z.string().optional().describe('Exact agent name filter.'),
        status: z.enum(['error', 'ok']).optional().describe('Only error or only ok traces.'),
      },
    },
    async ({ limit, q, agent, status }) => {
      const params = new URLSearchParams({ limit: String(limit ?? 20) });
      if (q) params.set('q', q);
      if (agent) params.set('agent', agent);
      if (status) params.set('status', status);
      const res = await callApi(base, `/api/traces?${params.toString()}`);
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'get_trace',
    {
      description:
        "Fetch one Coach trace's full view: the nested span tree with every LLM call and tool span — inputs, outputs, models, tokens, and errors. This is the ground truth of what the agent actually did in that run; read it when debugging a specific behavior or verifying a fix.",
      inputSchema: {
        id: z.string().describe('The trace id (from list_traces).'),
      },
    },
    async ({ id }) => {
      const res = await callApi(base, `/api/traces/${encodeURIComponent(id)}`);
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'get_stats',
    {
      description:
        "Aggregate rollups over every trace Coach has captured from this project's agent: totals (trace count, tokens in/out, error count, avg/p95 latency, estimated cost) plus per-agent breakdowns and the list of known agents.",
    },
    async () => {
      const res = await callApi(base, '/api/stats');
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'list_deviations',
    {
      description:
        "List the deviation types Coach's discovery pass found across this project's agent traces — recurring failure patterns, each with a label, description, plain-language rule, severity, example count, a status (open|resolved), and hasFix (whether a fix has been generated). Use get_deviation for the per-trace evidence; run run_discovery first if this is empty.",
    },
    async () => {
      const res = await callApi(base, '/api/deviations');
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'get_deviation',
    {
      description:
        'Fetch one deviation type plus its per-trace examples with evidence — which agent runs exhibited this recurring failure and the concrete spans/behavior that show it. The deviation also carries fixMarkdown (a generated fix, once propose_fix has run) and status. Follow the example traceIds into get_trace to see the full runs.',
      inputSchema: {
        id: z.string().describe('The deviation id (from list_deviations).'),
      },
    },
    async ({ id }) => {
      const res = await callApi(base, `/api/deviations/${encodeURIComponent(id)}`);
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'propose_fix',
    {
      description:
        "Generate a fix for one deviation and wait for it (up to ~2 minutes). The fix is a markdown instruction doc addressed to YOU, the coding agent, running inside this repo: it tells you what to grep for, the likely files (as guesses to confirm), the ordered edits (across prompt / tools / guardrails / orchestration / code), and acceptance criteria. Returns the deviation with its fixMarkdown. This is step 2 of the loop: run_discovery → propose_fix → apply the edits → save_eval(deviationId) → run_eval → get_eval (watch regressionCount) → resolve_deviation once the traces pass.",
      inputSchema: {
        id: z.string().describe('The deviation id (from list_deviations).'),
      },
    },
    async ({ id }) => {
      const run = await startAndAwaitRun(base, `/api/deviations/${encodeURIComponent(id)}/fix`, {});
      if (run.isError) return run;
      // Fix generated (or a run was already in flight) — return the deviation carrying its fixMarkdown.
      const res = await callApi(base, `/api/deviations/${encodeURIComponent(id)}`);
      return res.ok ? jsonResult(res.body) : run;
    },
  );

  server.registerTool(
    'resolve_deviation',
    {
      description:
        "Mark a deviation resolved (or reopen it) — the final step of the loop, once you've applied a fix and an eval confirms the traces now pass. Use reopen:true to move it back to open.",
      inputSchema: {
        id: z.string().describe('The deviation id (from list_deviations).'),
        reopen: z.boolean().optional().describe('Set true to reopen a resolved deviation instead of resolving it.'),
      },
    },
    async ({ id, reopen }) => {
      const action = reopen ? 'reopen' : 'resolve';
      const res = await callApi(base, `/api/deviations/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'list_flows',
    {
      description:
        "List the flows from Coach's latest flows run — clusters of similar agent runs (name, description, trace count) that show the recurring journeys this project's agent takes. Run run_flows first if this is empty.",
    },
    async () => {
      const res = await callApi(base, '/api/flows');
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'run_discovery',
    {
      description:
        "Kick off Coach's deviation discovery — an LLM pass over a sample of recent agent traces that clusters recurring failures into deviation types — and wait for it to finish (up to ~2 minutes), returning the run stats. If a run is already in progress it reports that instead. Read the results with list_deviations / get_deviation.",
      inputSchema: {
        sampleSize: z.number().int().min(1).max(200).optional().describe('How many recent traces to sample (server default when omitted).'),
      },
    },
    async ({ sampleSize }) => startAndAwaitRun(base, '/api/discovery/run', sampleSize !== undefined ? { sampleSize } : {}),
  );

  server.registerTool(
    'run_flows',
    {
      description:
        "Kick off Coach's flow grouping — clusters this project's agent traces into recurring flows/journeys — and wait for it to finish (up to ~2 minutes), returning the run stats. If a run is already in progress it reports that instead. Read the results with list_flows.",
    },
    async () => startAndAwaitRun(base, '/api/flows/run', {}),
  );

  server.registerTool(
    'list_evals',
    {
      description:
        'List the saved evals — repeatable pass/fail checks, each a plain-language rule scored against recent traces. Every item carries its latest-run rollup: passed, failed, scored, and regressionCount (traces that passed last run and now fail). Use this to watch whether a fixed problem is staying fixed.',
    },
    async () => {
      const res = await callApi(base, '/api/evals');
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'get_eval',
    {
      description:
        "Fetch one eval's rule plus the per-trace verdicts from its latest run — each trace's pass/fail, the quoted evidence, and whether it is a regression (passed the previous run, fails now). Follow a verdict's traceId into get_trace to see the full run.",
      inputSchema: {
        id: z.string().describe('The eval id (from list_evals).'),
      },
    },
    async ({ id }) => {
      const res = await callApi(base, `/api/evals/${encodeURIComponent(id)}`);
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'save_eval',
    {
      description:
        'Create a repeatable eval. Either save an existing deviation as an eval (pass its deviationId) or write a rule by hand (pass label + rule, optional description). Returns the new eval id — then call run_eval to score it against recent traces.',
      inputSchema: {
        deviationId: z.string().optional().describe('Save this discovered deviation (from list_deviations) as an eval.'),
        label: z.string().optional().describe('Short name for a hand-written eval (required unless deviationId is given).'),
        rule: z
          .string()
          .optional()
          .describe('The plain-language rule the agent should follow (required unless deviationId is given).'),
        description: z.string().optional().describe('Optional context for a hand-written eval.'),
      },
    },
    async ({ deviationId, label, rule, description }) => {
      const body = deviationId
        ? { deviationId }
        : { label, rule, ...(description ? { description } : {}) };
      if (!deviationId && (!label || !rule)) {
        return errorResult('save_eval needs either deviationId, or both label and rule.');
      }
      const res = await callApi(base, '/api/evals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  server.registerTool(
    'run_eval',
    {
      description:
        "Score an eval against recent traces — an LLM pass that marks each sampled trace pass/fail against the eval's rule — and wait for it to finish (up to ~2 minutes), returning the run stats. If a run is already in progress it reports that instead. Read the verdicts + regressions with get_eval.",
      inputSchema: {
        id: z.string().describe('The eval id (from list_evals).'),
        sampleSize: z.number().int().min(1).max(200).optional().describe('How many recent traces to score (server default when omitted).'),
      },
    },
    async ({ id, sampleSize }) =>
      startAndAwaitRun(base, `/api/evals/${encodeURIComponent(id)}/run`, sampleSize !== undefined ? { sampleSize } : {}),
  );

  server.registerTool(
    'get_usage',
    {
      description:
        "Coach's own LLM spend vs. its budget: spentUsd / budgetUsd / remainingUsd / overBudget, plus a per-model and per-kind breakdown. Analysis runs (discovery / eval / flows / replay) are metered and refused once the budget is reached — check this before kicking off expensive runs on a metered provider. Free `mock` / `claude-subscription` runs accrue $0.",
    },
    async () => {
      const res = await callApi(base, '/api/usage');
      return res.ok ? jsonResult(res.body) : errorResult(res.message);
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`glassray mcp: serving stdio, proxying ${base} (coach v${info.version ?? '?'})`);
};

/** Parses GLASSRAY_PORT (set by `glassray mcp`) into a port, falling back to the default on absence or garbage. */
const resolvePort = (): number => {
  const raw = process.env.GLASSRAY_PORT;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : DEFAULT_PORT;
};

// Entrypoint guard: `glassray mcp` runs this file directly via `node --import tsx server/mcp.ts`.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runMcpServer({ port: resolvePort() });
