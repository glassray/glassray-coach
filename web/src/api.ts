/**
 * Typed client for the Glassray Coach local REST API (served same-origin by the
 * Fastify server, proxied to :5899 in dev). The shapes below mirror the fixed
 * REST contract exactly.
 */

/** Status of a trace or span; null when the provider reported none. */
export type TraceStatus = "ok" | "error" | null;

/** Category of a span node, drives the badge shown in the tree. */
export type SpanKind = "agent" | "llm" | "tool" | "span";

/** GET /api/info — local server identity + how to point an exporter at it. */
export interface Info {
  name: string;
  version: string;
  ingestEndpoint: string;
  apiKey: string;
}

/** One row of GET /api/traces — a compact summary for the list table. */
export interface TraceListItem {
  id: string;
  name: string | null;
  agent: string | null;
  startedAt: string | null;
  durationMs: number | null;
  spanCount: number;
  status: TraceStatus;
  tokensIn: number | null;
  tokensOut: number | null;
  inputPreview: string | null;
}

/** GET /api/traces — a page of summaries plus the (filtered) total. */
export interface TraceListResponse {
  items: TraceListItem[];
  total: number;
}

/** Active filters for the trace list. */
export interface TraceFilters {
  q?: string;
  agent?: string;
  status?: "error" | "ok";
}

/** One bucket of the activity timeline (GET /api/timeline). */
export interface TimelinePoint {
  t: string;
  traces: number;
  errors: number;
}

/** GET /api/timeline — trace volume + errors bucketed over the captured range. */
export interface TimelineResponse {
  points: TimelinePoint[];
  from: string | null;
  to: string | null;
}

/** GET /api/stats — token / latency / cost rollups over all captured traces. */
export interface StatsResponse {
  totals: {
    traces: number;
    tokensIn: number;
    tokensOut: number;
    errors: number;
    avgDurationMs: number;
    p95DurationMs: number;
    estCostUsd: number;
  };
  byAgent: Array<{
    agent: string | null;
    provider: string | null;
    traces: number;
    tokensIn: number;
    tokensOut: number;
    avgDurationMs: number;
    estCostUsd: number;
  }>;
  agents: string[];
}

/** A node in the trace detail span tree; children nest recursively. */
export interface SpanNode {
  id: string;
  name: string;
  kind: SpanKind;
  startedAt: string | null;
  durationMs: number | null;
  status: TraceStatus;
  /** The OTLP span status.message (why it failed), when present. */
  statusMessage?: string | null;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** The span's flattened OTLP attributes, for the inspector's raw view. */
  attributes?: Record<string, unknown>;
  children: SpanNode[];
}

/** The fully expanded view returned by GET /api/traces/:id. */
export interface TraceView {
  name: string | null;
  agent: string | null;
  provider: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  spanCount: number;
  status: TraceStatus;
  tokensIn: number | null;
  tokensOut: number | null;
  inputPreview: string | null;
  outputPreview: string | null;
  tree: SpanNode | null;
}

/** GET /api/traces/:id — the trace id echoed back with its detail view. */
export interface TraceDetailResponse {
  id: string;
  view: TraceView;
}

/** Severity of a discovered deviation; drives the colored severity chip. */
export type Severity = "critical" | "major" | "minor";

/** GET /api/llm — which LLM provider backs analysis and whether it's usable. */
export interface LlmInfo {
  provider: string;
  ready: boolean;
  reason: string;
}

/** Handle returned by the run-triggering POST endpoints. */
export interface RunHandle {
  runId: string;
}

/** GET /api/runs/:id — status of one background discovery/flows/eval run. */
export interface RunStatus {
  id: string;
  kind: "discovery" | "flows" | "eval" | "improver";
  status: "running" | "done" | "error";
  error: string | null;
  stats: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Fields shared by the list row and the full deviation record. */
export interface DeviationBase {
  id: string;
  label: string;
  description: string;
  rule: string;
  severity: Severity;
  exampleCount: number;
  /** Loop state: `open` or `resolved`. */
  status: "open" | "resolved";
  createdAt: string;
}

/** One recurring deviation type, as listed by GET /api/deviations (adds whether a fix has been generated). */
export interface DeviationItem extends DeviationBase {
  hasFix: boolean;
}

/** The full deviation record from GET /api/deviations/:id — carries the generated fix markdown. */
export interface DeviationRecord extends DeviationBase {
  /** The generated paste-into-your-coding-agent fix, or null until "Generate fix" has run. */
  fixMarkdown: string | null;
  fixModel: string | null;
  fixGeneratedAt: string | null;
}

/** GET /api/deviations — every discovered deviation type plus the unpaged total. */
export interface DeviationListResponse {
  items: DeviationItem[];
  total: number;
}

/** One concrete trace exhibiting a deviation, with the quoted evidence. */
export interface DeviationExample {
  traceId: string;
  label: string;
  description: string;
  severity: Severity;
  evidence: string;
}

/** GET /api/deviations/:id — one deviation type with its example traces. */
export interface DeviationDetail {
  deviation: DeviationRecord;
  examples: DeviationExample[];
}

/** One discovered flow — a recurring behaviour that groups captured traces. */
export interface FlowItem {
  id: string;
  name: string;
  description: string;
  traceCount: number;
}

/** GET /api/flows — the discovered flows plus the run that produced them (null before any run). */
export interface FlowListResponse {
  items: FlowItem[];
  runId: string | null;
}

/** A member trace of a flow, as returned by GET /api/flows/:id. */
export interface FlowTraceRef {
  traceId: string;
  name: string | null;
  agent: string | null;
}

/** GET /api/flows/:id — one flow with its member traces. */
export interface FlowDetail {
  flow: FlowItem;
  traces: FlowTraceRef[];
}

/** One eval + its latest-run rollup, as listed by GET /api/evals. */
export interface EvalSummary {
  id: string;
  label: string;
  description: string;
  rule: string;
  /** Provenance: `deviation` (saved from a discovered type) or `manual`. */
  source: string;
  sourceDeviationId: string | null;
  createdAt: string;
  /** The most recent run that scored this eval (null before any run). */
  latestRunId: string | null;
  lastRunAt: string | null;
  scored: number;
  passed: number;
  failed: number;
  /** Traces failing in the latest run that were passing in the previous run. */
  regressionCount: number;
}

/** GET /api/evals — every eval with its rollup, plus the count. */
export interface EvalListResponse {
  items: EvalSummary[];
  total: number;
}

/** One per-trace verdict from an eval's latest run. */
export interface EvalResultRow {
  traceId: string;
  name: string | null;
  agent: string | null;
  /** When the scored trace was received — disambiguates identically-named traces. */
  receivedAt: string | null;
  verdict: "pass" | "fail";
  evidence: string;
  /** True when this trace is failing now but passed in the previous run. */
  regression: boolean;
}

/** One past run of an eval — a point on the pass-rate trend. */
export interface EvalRunPoint {
  runId: string;
  at: string | null;
  passed: number;
  failed: number;
  total: number;
}

/** GET /api/evals/:id — one eval's rollup, its per-trace verdicts, and run history. */
export interface EvalDetail extends EvalSummary {
  results: EvalResultRow[];
  history: EvalRunPoint[];
}

/** Per-model roll-up of Coach's own LLM usage (GET /api/usage). */
export interface ModelUsage {
  provider: string;
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** GET /api/usage — Coach's own LLM spend vs the budget, broken down by model + kind. */
export interface UsageSummary {
  /** The spend cap in USD, or null when unlimited (opt-out). */
  budgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  overBudget: boolean;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  byModel: ModelUsage[];
  byKind: Array<{ kind: string; calls: number; costUsd: number }>;
}

/** POST /api/replay body — an edited LLM request to re-issue as free text. */
export interface ReplayRequest {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
}

/** POST /api/replay response — the fresh completion + which backend/model produced it. */
export interface ReplayResponse {
  output: string;
  provider: string;
  model: string;
}

/**
 * Error carrying the HTTP status of a failed API response, so callers can branch
 * on it (e.g. 404 → "not found") without pattern-matching the message string —
 * which breaks once a helper surfaces the server's JSON `error` text instead.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Fetch JSON from the local API, throwing on any non-2xx response. */
const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok)
    throw new HttpError(res.status, `Request to ${path} failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
};

/** True when an error thrown by an API helper represents a 404 (vs a connectivity/5xx failure). */
export const isNotFoundError = (err: unknown): boolean =>
  err instanceof HttpError ? err.status === 404 : err instanceof Error && /\b404\b/.test(err.message);

/**
 * Thrown when a run-trigger POST is rejected with 409 because another run holds
 * the shared single-run lock. Carries the active run's id so the caller can
 * adopt (poll) it instead of dead-ending on an error.
 */
export class RunInProgressError extends HttpError {
  readonly runId: string | null;
  constructor(message: string, runId: string | null) {
    super(409, message);
    this.name = "RunInProgressError";
    this.runId = runId;
  }
}

/** POST JSON to the local API, throwing the server's `error` text when it sends one (e.g. 409 run-in-progress). */
const postJson = async <T>(path: string, body: unknown = {}): Promise<T> => {
  const res = await fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request to ${path} failed: ${res.status} ${res.statusText}`;
    let runId: string | null = null;
    try {
      const payload = (await res.json()) as { error?: unknown; runId?: unknown } | null;
      if (payload && typeof payload.error === "string" && payload.error) message = payload.error;
      if (payload && typeof payload.runId === "string") runId = payload.runId;
    } catch {
      /* keep the generic message */
    }
    if (res.status === 409) throw new RunInProgressError(message, runId);
    throw new HttpError(res.status, message);
  }
  return (await res.json()) as T;
};

/** PATCH JSON to the local API, throwing the server's `error` text on non-2xx. */
const patchJson = async <T>(path: string, body: unknown = {}): Promise<T> => {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request to ${path} failed: ${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: unknown } | null;
      if (payload && typeof payload.error === "string" && payload.error) message = payload.error;
    } catch {
      /* keep the generic message */
    }
    throw new HttpError(res.status, message);
  }
  return (await res.json()) as T;
};

/** DELETE a resource on the local API, throwing the server's `error` text on non-2xx. */
const delJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(path, { method: "DELETE", headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `Request to ${path} failed: ${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: unknown } | null;
      if (payload && typeof payload.error === "string" && payload.error) message = payload.error;
    } catch {
      /* keep the generic message */
    }
    throw new HttpError(res.status, message);
  }
  return (await res.json()) as T;
};

/** Load the local server's identity + exporter details (GET /api/info). */
export const fetchInfo = (): Promise<Info> => getJson<Info>("/api/info");

/** Load a page of trace summaries, newest-first per the server (GET /api/traces). */
export const fetchTraces = (
  filters: TraceFilters = {},
  limit = 50,
  offset = 0,
): Promise<TraceListResponse> => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (filters.q) params.set("q", filters.q);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.status) params.set("status", filters.status);
  return getJson<TraceListResponse>(`/api/traces?${params.toString()}`);
};

/** Fetch the token/latency/cost rollups. */
export const fetchStats = (): Promise<StatsResponse> => getJson<StatsResponse>("/api/stats");

/** Fetch the bucketed trace-volume + error activity series. */
export const fetchTimeline = (): Promise<TimelineResponse> =>
  getJson<TimelineResponse>("/api/timeline");

/** Load one trace's full detail view (GET /api/traces/:id). */
export const fetchTrace = (id: string): Promise<TraceDetailResponse> =>
  getJson<TraceDetailResponse>(`/api/traces/${encodeURIComponent(id)}`);

/** Load the LLM provider status backing discovery/flows analysis (GET /api/llm). */
export const fetchLlm = (): Promise<LlmInfo> => getJson<LlmInfo>("/api/llm");

/** The four analysis backends Coach can dispatch to. */
export type LlmProvider = "mock" | "claude-subscription" | "anthropic" | "openai";

/** The dashboard-editable settings view model (GET /api/settings). */
export interface CoachSettings {
  provider: LlmProvider;
  ready: boolean;
  reason: string;
  heavyModelId: string;
  lightModelId: string;
  /** Metered spend cap in USD; `0` = unlimited. */
  budgetUsd: number;
  /** Which providers are usable right now (key / OAuth present). */
  availability: Record<LlmProvider, boolean>;
}

/** A partial update to the settings — every field optional. */
export interface SettingsPatch {
  llmProvider?: LlmProvider;
  heavyModelId?: string;
  lightModelId?: string;
  budgetUsd?: number;
}

/** Load the effective LLM config + per-provider availability (GET /api/settings). */
export const fetchSettings = (): Promise<CoachSettings> => getJson<CoachSettings>("/api/settings");

/** Persist a settings change and get the new effective config back (PATCH /api/settings). */
export const updateSettings = (patch: SettingsPatch): Promise<CoachSettings> =>
  patchJson<CoachSettings>("/api/settings", patch);

/** Load every discovered deviation type (GET /api/deviations). */
export const fetchDeviations = (): Promise<DeviationListResponse> =>
  getJson<DeviationListResponse>("/api/deviations");

/** Load one deviation type with its examples (GET /api/deviations/:id). */
export const fetchDeviation = (id: string): Promise<DeviationDetail> =>
  getJson<DeviationDetail>(`/api/deviations/${encodeURIComponent(id)}`);

/** Load the discovered flows (GET /api/flows). */
export const fetchFlows = (): Promise<FlowListResponse> => getJson<FlowListResponse>("/api/flows");

/** Load one flow with its member traces (GET /api/flows/:id). */
export const fetchFlow = (id: string): Promise<FlowDetail> =>
  getJson<FlowDetail>(`/api/flows/${encodeURIComponent(id)}`);

/** Load the status of one background run (GET /api/runs/:id). */
export const fetchRun = (id: string): Promise<RunStatus> =>
  getJson<RunStatus>(`/api/runs/${encodeURIComponent(id)}`);

/** Cancel the in-flight run (POST /api/runs/:id/cancel); 409 if it isn't the active run. */
export const cancelRun = (id: string): Promise<Record<string, never>> =>
  postJson<Record<string, never>>(`/api/runs/${encodeURIComponent(id)}/cancel`);

/** Start a deviation-discovery run (POST /api/discovery/run); throws the server's error text on 409. */
export const runDiscovery = (sampleSize?: number): Promise<RunHandle> =>
  postJson<RunHandle>("/api/discovery/run", sampleSize != null ? { sampleSize } : {});

/** Start a flow-grouping run (POST /api/flows/run); throws the server's error text on 409. */
export const runFlows = (): Promise<RunHandle> => postJson<RunHandle>("/api/flows/run");

/** Load every saved eval with its latest-run rollup (GET /api/evals). */
export const fetchEvals = (): Promise<EvalListResponse> => getJson<EvalListResponse>("/api/evals");

/** Load one eval's rollup + per-trace verdicts (GET /api/evals/:id). */
export const fetchEval = (id: string): Promise<EvalDetail> =>
  getJson<EvalDetail>(`/api/evals/${encodeURIComponent(id)}`);

/** Save a discovered deviation as a repeatable eval (POST /api/evals). */
export const saveEvalFromDeviation = (deviationId: string): Promise<{ id: string }> =>
  postJson<{ id: string }>("/api/evals", { deviationId });

/** Start a fix-generation run for a deviation (POST /api/deviations/:id/fix); throws the server's error text on 409. */
export const generateDeviationFix = (id: string): Promise<RunHandle> =>
  postJson<RunHandle>(`/api/deviations/${encodeURIComponent(id)}/fix`);

/** Mark a deviation resolved (POST /api/deviations/:id/resolve). */
export const resolveDeviation = (id: string): Promise<{ status: string }> =>
  postJson<{ status: string }>(`/api/deviations/${encodeURIComponent(id)}/resolve`);

/** Reopen a resolved deviation (POST /api/deviations/:id/reopen). */
export const reopenDeviation = (id: string): Promise<{ status: string }> =>
  postJson<{ status: string }>(`/api/deviations/${encodeURIComponent(id)}/reopen`);

/** Create a hand-written eval from a label + rule (POST /api/evals). */
export const createEval = (input: {
  label: string;
  rule: string;
  description?: string;
}): Promise<{ id: string }> => postJson<{ id: string }>("/api/evals", input);

/** Start an eval-scoring run (POST /api/evals/:id/run); throws the server's error text on 409. */
export const runEval = (evalId: string, sampleSize?: number): Promise<RunHandle> =>
  postJson<RunHandle>(
    `/api/evals/${encodeURIComponent(evalId)}/run`,
    sampleSize != null ? { sampleSize } : {},
  );

/** Delete an eval and its stored verdicts (DELETE /api/evals/:id). */
export const deleteEval = (id: string): Promise<Record<string, never>> =>
  delJson<Record<string, never>>(`/api/evals/${encodeURIComponent(id)}`);

/** Re-issue an (edited) LLM request as free text (POST /api/replay); throws the server's error on 502. */
export const replaySpan = (req: ReplayRequest): Promise<ReplayResponse> =>
  postJson<ReplayResponse>("/api/replay", req);

/** Fetch Coach's own LLM spend vs the budget (GET /api/usage). */
export const fetchUsage = (): Promise<UsageSummary> => getJson<UsageSummary>("/api/usage");

/** Clear the usage ledger (POST /api/usage/reset). */
export const resetUsage = (): Promise<Record<string, never>> =>
  postJson<Record<string, never>>("/api/usage/reset");

/**
 * Subscribe to the /api/tail SSE stream; invokes `onTrace` with each new trace
 * id as it lands. `onStatus` (optional) reports connection liveness so a "live"
 * badge can dim when the stream drops. A non-2xx response fails an EventSource
 * permanently (per spec), so on error we close and reconnect after a short
 * backoff. Returns an unsubscribe function that tears the connection down.
 */
export const subscribeTail = (
  onTrace: (id: string) => void,
  onStatus?: (live: boolean) => void,
): (() => void) => {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  /** (Re)open the stream, wiring message/open/error handlers with reconnect-on-drop. */
  const connect = (): void => {
    if (closed) return;
    source = new EventSource("/api/tail");
    source.onopen = () => onStatus?.(true);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { id?: string };
        if (payload && typeof payload.id === "string") onTrace(payload.id);
      } catch {
        /* ignore malformed frames */
      }
    };
    source.onerror = () => {
      onStatus?.(false);
      // A CLOSED stream never recovers on its own — reopen after a backoff.
      if (source && source.readyState === EventSource.CLOSED && !closed) {
        source.close();
        retry = setTimeout(connect, 3000);
      }
    };
  };
  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
};
