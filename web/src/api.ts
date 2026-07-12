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
  /** The run label this trace belongs to (`glassray run --label`), or null. */
  runLabel: string | null;
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
  /** Only traces that are members of this flow. */
  flow?: string;
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
    /** Price-book estimate keyed by each trace's primary model — honest even on free providers. */
    estCostIfMeteredUsd: number;
  };
  byAgent: Array<{
    agent: string | null;
    provider: string | null;
    traces: number;
    tokensIn: number;
    tokensOut: number;
    avgDurationMs: number;
    estCostUsd: number;
    estCostIfMeteredUsd: number;
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

/** Handle returned by the 202 run-triggering POST endpoints — the run's id + its queue state. */
export interface RunHandle {
  runId: string;
  /** `queued` while waiting in the server's FIFO, `running` once it holds the slot. */
  status: "queued" | "running";
}

/** GET /api/runs/:id — status of one background discovery/flows/eval/classify/compare run. */
export interface RunStatus {
  id: string;
  kind: "discovery" | "flows" | "eval" | "improver" | "classify" | "compare";
  status: "queued" | "running" | "done" | "error";
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

/** How a flow assigns members: a deterministic selector query or a plain-language LLM rule. */
export type FlowClassify = "selector" | "llm";

/** A flow's lifecycle state — archived flows drop out of classification and the default list. */
export type FlowStatus = "active" | "archived";

/** A flow's deterministic membership query — optional fields, AND-combined; `traceIds` are pins. */
export interface FlowSelector {
  /** Exact match on the trace's agent. */
  agent?: string;
  /** Case-insensitive substring match on the trace's root name. */
  nameContains?: string;
  /** Case-insensitive substring match on the trace's input preview (user intent). */
  q?: string;
  /** Only ok or only error traces. */
  status?: "ok" | "error";
  /** Explicit trace-id pins — always members, regardless of the constraints. */
  traceIds?: string[];
  /** How many of the flow's newest members an eval run samples (default 20). */
  limit?: number;
}

/** One durable flow — a named agent behaviour with its membership definition + live member count. */
export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  selector: FlowSelector | null;
  rule: string | null;
  classify: FlowClassify;
  status: FlowStatus;
  /** Who created the flow: `user`, `claude`, or the `discovery` bootstrap. */
  createdBy: string;
  /** Stable artifact identity (the `glassray.yaml` flow id); null until exported/imported. */
  slug: string | null;
  traceCount: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/flows — the durable flows plus how many traces still await the classify sweep. */
export interface FlowListResponse {
  items: FlowSummary[];
  unclassified: number;
}

/** A member trace of a flow with its assignment provenance, as returned by GET /api/flows/:id. */
export interface FlowMember {
  traceId: string;
  name: string | null;
  agent: string | null;
  status: TraceStatus;
  receivedAt: string | null;
  /** How this trace got in: the deterministic selector, the LLM sweep, or a manual pin. */
  assignedBy: "selector" | "llm" | "manual";
  /** LLM assignments carry a confidence; selector/manual ones are null. */
  confidence: "high" | "low" | null;
  assignedAt: string;
}

/** An assertion rule attached to a flow, as listed in the flow's detail. */
export interface FlowEvalRef {
  id: string;
  label: string;
  rule: string;
  /** The repo path this rule's expectation is written in; null = custom (hand-written). */
  sourceFile: string | null;
  /** Provenance: `deviation` or `manual`. */
  source: string;
  /** Pass-rate gate for `glassray check` (0..1); null = 1.0. */
  threshold: number | null;
  lastRunAt: string | null;
}

/** GET /api/flows/:id — the full flow definition with its newest members and attached evals. */
export interface FlowDetail extends FlowSummary {
  members: FlowMember[];
  evals: FlowEvalRef[];
}

/** Inputs for creating a flow (POST /api/flows) — at least one of `selector` / `rule` required. */
export interface FlowCreateInput {
  name: string;
  description?: string;
  selector?: FlowSelector | null;
  rule?: string | null;
  classify?: FlowClassify;
}

/** POST /api/flows response — the new id, its materialized member count, and any LLM backfill size. */
export interface FlowCreateResponse {
  id: string;
  memberCount: number;
  llmBackfill: number;
}

/** Partial definition update for PATCH /api/flows/:id — `null` clears selector/rule. */
export interface FlowPatch {
  name?: string;
  description?: string;
  selector?: FlowSelector | null;
  rule?: string | null;
  classify?: FlowClassify;
  status?: FlowStatus;
}

/** A flow member enriched with its trace's input preview, for the audit sample. */
export interface FlowAuditMember extends FlowMember {
  inputPreview: string | null;
}

/** GET /api/flows/:id/audit — classification-quality snapshot for one flow. */
export interface FlowAudit {
  flowId: string;
  /** Newest-members sample with intent previews. */
  sample: FlowAuditMember[];
  /** Every low-confidence LLM assignment. */
  lowConfidence: FlowAuditMember[];
  counts: { members: number; lowConfidence: number; unclassifiedStoreWide: number };
}

/** One eval (assertion rule) + its latest-run rollup, as listed by GET /api/evals. */
export interface EvalSummary {
  id: string;
  label: string;
  description: string;
  rule: string;
  /** Provenance: `deviation` (saved from a discovered type) or `manual`. */
  source: string;
  sourceDeviationId: string | null;
  /** The flow this eval is scoped to (runs sample its members); null = global. */
  flowId: string | null;
  /** The repo path this rule's expectation is written in; null = custom (hand-written). */
  sourceFile: string | null;
  /** New member traces (since the last run) needed to trigger an automatic rerun of a flow-scoped rule. */
  autorunThreshold: number;
  /** Pass-rate gate for `glassray check` (0..1); null = 1.0. */
  threshold: number | null;
  /** Preferred judge model for this rule's runs; null = the light-tier default. */
  judgeModel: string | null;
  /** Stable artifact identity (the `glassray.yaml` rule id); null until exported/imported. */
  slug: string | null;
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
  /** What these tokens WOULD cost on a metered key (the price book) — honest even at $0 actual. */
  costIfMeteredUsd: number;
}

/** GET /api/usage — Coach's own LLM spend vs the budget, broken down by model + kind. */
export interface UsageSummary {
  /** The spend cap in USD, or null when unlimited (opt-out). */
  budgetUsd: number | null;
  spentUsd: number;
  /** What the recorded tokens WOULD have cost on metered API keys (price-book estimate). */
  spentIfMeteredUsd: number;
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

/** POST JSON to the local API, throwing the server's `error` text on non-2xx. */
const postJson = async <T>(path: string, body: unknown = {}): Promise<T> => {
  const res = await fetch(path, {
    method: "POST",
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
  if (filters.flow) params.set("flow", filters.flow);
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

/** Load the durable flows, active by default (GET /api/flows?status=). */
export const fetchFlows = (status: FlowStatus | "all" = "active"): Promise<FlowListResponse> =>
  getJson<FlowListResponse>(`/api/flows?status=${status}`);

/** Load one flow's full definition + members + attached evals (GET /api/flows/:id). */
export const fetchFlow = (id: string): Promise<FlowDetail> =>
  getJson<FlowDetail>(`/api/flows/${encodeURIComponent(id)}`);

/** Create a durable flow from a selector and/or rule (POST /api/flows). */
export const createFlow = (input: FlowCreateInput): Promise<FlowCreateResponse> =>
  postJson<FlowCreateResponse>("/api/flows", input);

/** Update a flow's definition/status and get the fresh detail back (PATCH /api/flows/:id). */
export const updateFlow = (id: string, patch: FlowPatch): Promise<FlowDetail> =>
  patchJson<FlowDetail>(`/api/flows/${encodeURIComponent(id)}`, patch);

/** Delete a flow (memberships go with it; attached evals become global) (DELETE /api/flows/:id). */
export const deleteFlow = (id: string): Promise<Record<string, never>> =>
  delJson<Record<string, never>>(`/api/flows/${encodeURIComponent(id)}`);

/** Load one flow's classification-quality audit (GET /api/flows/:id/audit). */
export const fetchFlowAudit = (id: string): Promise<FlowAudit> =>
  getJson<FlowAudit>(`/api/flows/${encodeURIComponent(id)}/audit`);

/** Load the status of one background run (GET /api/runs/:id). */
export const fetchRun = (id: string): Promise<RunStatus> =>
  getJson<RunStatus>(`/api/runs/${encodeURIComponent(id)}`);

/** Load recent background runs, newest-first (GET /api/runs?limit=100). */
export const fetchRuns = async (): Promise<RunStatus[]> =>
  (await getJson<{ items: RunStatus[] }>("/api/runs?limit=100")).items;

/** Cancel the in-flight run (POST /api/runs/:id/cancel); 409 if it isn't the active run. */
export const cancelRun = (id: string): Promise<Record<string, never>> =>
  postJson<Record<string, never>>(`/api/runs/${encodeURIComponent(id)}/cancel`);

/** Start a deviation-discovery run, optionally scoped to one flow's members (POST /api/discovery/run → 202). */
export const runDiscovery = (sampleSize?: number, flowId?: string): Promise<RunHandle> =>
  postJson<RunHandle>("/api/discovery/run", {
    ...(sampleSize != null ? { sampleSize } : {}),
    ...(flowId ? { flowId } : {}),
  });

/** Start the discover-flows bootstrap — adds durable flows, never replaces (POST /api/flows/run → 202). */
export const runFlows = (): Promise<RunHandle> => postJson<RunHandle>("/api/flows/run");

/** Load every saved eval with its latest-run rollup (GET /api/evals). */
export const fetchEvals = (): Promise<EvalListResponse> => getJson<EvalListResponse>("/api/evals");

/** Load one eval's rollup + per-trace verdicts (GET /api/evals/:id). */
export const fetchEval = (id: string): Promise<EvalDetail> =>
  getJson<EvalDetail>(`/api/evals/${encodeURIComponent(id)}`);

/** Save a discovered deviation as a repeatable eval, optionally scoped to a flow (POST /api/evals). */
export const saveEvalFromDeviation = (deviationId: string, flowId?: string): Promise<{ id: string }> =>
  postJson<{ id: string }>("/api/evals", { deviationId, ...(flowId ? { flowId } : {}) });

/** Start a fix-generation run for a deviation (POST /api/deviations/:id/fix); throws the server's error text on 409. */
export const generateDeviationFix = (id: string): Promise<RunHandle> =>
  postJson<RunHandle>(`/api/deviations/${encodeURIComponent(id)}/fix`);

/** Mark a deviation resolved (POST /api/deviations/:id/resolve). */
export const resolveDeviation = (id: string): Promise<{ status: string }> =>
  postJson<{ status: string }>(`/api/deviations/${encodeURIComponent(id)}/resolve`);

/** Reopen a resolved deviation (POST /api/deviations/:id/reopen). */
export const reopenDeviation = (id: string): Promise<{ status: string }> =>
  postJson<{ status: string }>(`/api/deviations/${encodeURIComponent(id)}/reopen`);

/** Create a hand-written rule from a label + rule text (+ optional flow scope / source file / gate tuning) (POST /api/evals). */
export const createEval = (input: {
  label: string;
  rule: string;
  description?: string;
  flowId?: string;
  sourceFile?: string | null;
  autorunThreshold?: number;
  threshold?: number;
  judgeModel?: string;
}): Promise<{ id: string }> => postJson<{ id: string }>("/api/evals", input);

/** Patch a rule's flow binding / source file / gate tuning and get the fresh detail back (PATCH /api/evals/:id). */
export const updateEval = (
  id: string,
  patch: {
    flowId?: string | null;
    sourceFile?: string | null;
    autorunThreshold?: number;
    threshold?: number | null;
    judgeModel?: string | null;
  },
): Promise<EvalDetail> => patchJson<EvalDetail>(`/api/evals/${encodeURIComponent(id)}`, patch);

/** Start an eval-scoring run with optional sample-size / judge-model overrides (POST /api/evals/:id/run → 202). */
export const runEval = (evalId: string, sampleSize?: number, model?: string): Promise<RunHandle> =>
  postJson<RunHandle>(`/api/evals/${encodeURIComponent(evalId)}/run`, {
    ...(sampleSize != null ? { sampleSize } : {}),
    ...(model ? { model } : {}),
  });

/** Delete an eval and its stored verdicts (DELETE /api/evals/:id). */
export const deleteEval = (id: string): Promise<Record<string, never>> =>
  delJson<Record<string, never>>(`/api/evals/${encodeURIComponent(id)}`);

/** How a compare side names its corpus: pinned trace ids, a run label, an agent tag, or a flow's members. */
export type CorpusRef = { traceIds: string[] } | { label: string } | { agent: string } | { flowId: string };

/** One rule's two-sided compare result (an entry of the finished run's stats.rules). */
export interface CompareRuleResult {
  id: string;
  slug: string | null;
  label: string;
  baseline: { scored: number; passed: number; failed: number; passRate: number | null };
  candidate: { scored: number; passed: number; failed: number; passRate: number | null };
  /** candidate − baseline pass rate; null when either side scored nothing. */
  deltaPassRate: number | null;
  regressed: boolean;
}

/** Aggregate facts about one compare side's traces. */
export interface CompareCorpusStats {
  ref: CorpusRef;
  traces: number;
  tokensIn: number;
  tokensOut: number;
  /** Provider-blended estimate of real spend — 0 for free-provider corpora. */
  estCostUsd: number;
  /** Price-book estimate keyed by each trace's primary model — the honest "is it cheaper?" number. */
  estCostIfMeteredUsd: number;
  avgDurationMs: number;
}

/** The full compare report, as stored in the finished run's stats blob. */
export interface CompareReport {
  flowId: string | null;
  sampleSize: number;
  rules: CompareRuleResult[];
  baseline: CompareCorpusStats;
  candidate: CompareCorpusStats;
  /** candidate − baseline price-book cost: negative = the change is cheaper. */
  costIfMeteredDeltaUsd: number;
  regressions: number;
}

/** Start a compare run over two corpora (POST /api/compare → 202). */
export const runCompare = (input: {
  baseline: CorpusRef;
  candidate: CorpusRef;
  flowId?: string;
  sampleSize?: number;
}): Promise<RunHandle> => postJson<RunHandle>("/api/compare", input);

/** Load the newest finished compare run (best-effort — null when none exists). */
export const fetchLastCompare = async (): Promise<RunStatus | null> => {
  const { items } = await getJson<{ items: RunStatus[] }>("/api/runs?limit=100");
  return items.find((r) => r.kind === "compare" && r.status === "done") ?? null;
};

/** One regressed rule surfaced in an experiment report (rule-level). */
export interface ExperimentFailingRule {
  ruleId: string;
  ruleLabel: string;
  baselinePassRate: number | null;
  candidatePassRate: number | null;
  deltaPassRate: number | null;
  candidateFailed: number;
  candidateScored: number;
}

/** The generated experiment report: the compare result + prose + suggested verdict. */
export interface ExperimentReport {
  verdict: "go" | "no-go" | "undecided";
  summary: string;
  regressions: number;
  costDeltaUsd: number;
  failing: ExperimentFailingRule[];
  /** The full compare report, embedded so the detail renders without a second fetch. */
  compare: CompareReport;
}

/** One durable experiment — a question with a baseline/candidate compare + generated report. */
export interface Experiment {
  id: string;
  flowId: string | null;
  question: string;
  status: "open" | "running" | "concluded";
  verdict: "go" | "no-go" | "undecided" | null;
  baselineLabel: string | null;
  candidateLabel: string | null;
  runId: string | null;
  report: ExperimentReport | null;
  createdAt: string;
  concludedAt: string | null;
}

/** GET /api/experiments — every experiment plus the count. */
export interface ExperimentListResponse {
  items: Experiment[];
  total: number;
}

/** POST /api/experiments/:id/report response — the compare run's handle + the resolved corpora. */
export interface ExperimentReportHandle extends RunHandle {
  experimentId: string;
  baseline: string;
  candidate: string;
}

/** Load every experiment, optionally one flow's (GET /api/experiments). */
export const fetchExperiments = (flowId?: string): Promise<ExperimentListResponse> =>
  getJson<ExperimentListResponse>(`/api/experiments${flowId ? `?flowId=${encodeURIComponent(flowId)}` : ""}`);

/** Load one experiment with its embedded report (GET /api/experiments/:id). */
export const fetchExperiment = (id: string): Promise<Experiment> =>
  getJson<Experiment>(`/api/experiments/${encodeURIComponent(id)}`);

/** Open a new experiment for a question (POST /api/experiments). */
export const createExperiment = (input: { flowId?: string | null; question: string }): Promise<{ id: string }> =>
  postJson<{ id: string }>("/api/experiments", input);

/** Conclude an experiment: run the compare + generate the report (POST /api/experiments/:id/report → 202). */
export const runExperimentReport = (
  id: string,
  corpora: { baseline?: string; candidate?: string } = {},
): Promise<ExperimentReportHandle> =>
  postJson<ExperimentReportHandle>(`/api/experiments/${encodeURIComponent(id)}/report`, corpora);

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
