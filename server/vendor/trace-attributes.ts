/*
 * Source: packages/shared/src/schemas/trace-attributes.ts
 * Vendored for Glassray Coach — refresh by re-copying from the main app.
 */

/*
 * The Glassray trace-attribute contract (APP-14550 §4) — the single source of
 * truth for the OTLP span/resource attribute names the `@glassray/tracing` SDK
 * emits and the ingest normalizer (`normalize.ts` `fromOtlp`) reads back.
 * Standards-first: OTel GenAI semconv names for LLM content, OpenInference
 * `input.value`/`output.value` for generic I/O, `glassray.*` reserved for the
 * APP-14691 metadata convention.
 *
 * Isomorphic and dependency-free — attribute names and alias ladders as plain
 * data.
 */

/** Every attribute name in the contract, by symbolic name. */
export const TRACE_ATTR = {
  // ── OTel GenAI semconv (current generation) ────────────────────────────────
  /** Operation discriminator: `invoke_agent` / `chat` / `execute_tool` (see TRACE_OPERATION). */
  GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
  /** Human-readable agent name on the root/agent span. */
  GEN_AI_AGENT_NAME: "gen_ai.agent.name",
  /** LLM provider (current spelling). */
  GEN_AI_PROVIDER_NAME: "gen_ai.provider.name",
  /** LLM provider (deprecated alias — SDK emits both for one release; ingest reads both). */
  GEN_AI_SYSTEM: "gen_ai.system",
  /** Requested model id on an `llm` span. */
  GEN_AI_REQUEST_MODEL: "gen_ai.request.model",
  GEN_AI_USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  GEN_AI_USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  /** Chat input as a JSON string of OTel role+parts messages. */
  GEN_AI_INPUT_MESSAGES: "gen_ai.input.messages",
  /** Chat output as a JSON string of OTel role+parts messages. */
  GEN_AI_OUTPUT_MESSAGES: "gen_ai.output.messages",
  /** System/instructions content accompanying `gen_ai.input.messages`. */
  GEN_AI_SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  /** Tool/function name on an `execute_tool` span. */
  GEN_AI_TOOL_NAME: "gen_ai.tool.name",
  /** Older spelling of the session/conversation grouping id. */
  GEN_AI_CONVERSATION_ID: "gen_ai.conversation.id",

  // ── OpenInference generic I/O (any span kind) ──────────────────────────────
  INPUT_VALUE: "input.value",
  OUTPUT_VALUE: "output.value",

  // ── Cross-cutting OTel names ───────────────────────────────────────────────
  /** Session/conversation grouping id (emerging OTel convention; resource-level preferred). */
  SESSION_ID: "session.id",
  /** Error detail set beside an OTLP error status code. */
  ERROR_MESSAGE: "error.message",

  // ── Glassray vocabulary ────────────────────────────────────────────────────
  /** Explicit span kind (`agent`/`llm`/`tool`/`retriever`/`workflow`) when not inferable from `gen_ai.operation.name`. */
  GLASSRAY_SPAN_KIND: "glassray.span.kind",
  /** Stamped `true` on spans still open when the root settled (auto-closed by the SDK). */
  GLASSRAY_SPAN_AUTO_CLOSED: "glassray.span.auto_closed",
  // APP-14691 metadata convention — resource-level defaults, root-span override wins.
  GLASSRAY_CUSTOMER: "glassray.customer",
  GLASSRAY_ENVIRONMENT: "glassray.environment",
  GLASSRAY_AGENT: "glassray.agent",
  GLASSRAY_FLOW: "glassray.flow",
  /** Honored standard alias for `glassray.environment`. */
  DEPLOYMENT_ENVIRONMENT_NAME: "deployment.environment.name",
} as const;

/** `gen_ai.operation.name` values the SDK emits, per span kind. */
export const TRACE_OPERATION = {
  INVOKE_AGENT: "invoke_agent",
  CHAT: "chat",
  EXECUTE_TOOL: "execute_tool",
} as const;

/** Values `glassray.span.kind` may carry. */
export const GLASSRAY_SPAN_KINDS = ["agent", "llm", "tool", "retriever", "workflow"] as const;
export type GlassraySpanKind = (typeof GLASSRAY_SPAN_KINDS)[number];

/*
 * §4.3 v0 alias ladders, priority order — what the normalizer reads. The v0
 * set is our SDK's names plus the most common wild shapes; the longer
 * fast-follow ladders (Vercel AI SDK `ai.*`, OpenInference `llm.*`, Traceloop
 * `traceloop.*`) are documented in docs/trace-ingestion-sdk.md and land with
 * the span-processor entry point, not here.
 */

/** Prefix of the deprecated-but-ubiquitous OpenLLMetry indexed prompt family (`gen_ai.prompt.0.role`, …). */
export const GEN_AI_PROMPT_PREFIX = "gen_ai.prompt.";
/** Prefix of the matching indexed completion family (`gen_ai.completion.0.content`, …). */
export const GEN_AI_COMPLETION_PREFIX = "gen_ai.completion.";

/** LLM provider, priority order — current spelling first, the deprecated `gen_ai.system` alias second. */
export const TRACE_PROVIDER_LADDER = [
  TRACE_ATTR.GEN_AI_PROVIDER_NAME,
  TRACE_ATTR.GEN_AI_SYSTEM,
] as const;
/** Input token count, priority order — current semconv key first, deprecated `prompt_tokens` spelling second. */
export const TRACE_TOKENS_IN_LADDER = [
  TRACE_ATTR.GEN_AI_USAGE_INPUT_TOKENS,
  "gen_ai.usage.prompt_tokens",
] as const;
/** Output token count, priority order — mirror of the input ladder (`completion_tokens` is the deprecated alias). */
export const TRACE_TOKENS_OUT_LADDER = [
  TRACE_ATTR.GEN_AI_USAGE_OUTPUT_TOKENS,
  "gen_ai.usage.completion_tokens",
] as const;
/** Tool/function name on a tool span, priority order (semconv key first, bare `tool.name` fallback). */
export const TRACE_TOOL_NAME_LADDER = [TRACE_ATTR.GEN_AI_TOOL_NAME, "tool.name"] as const;
/** Session/conversation grouping id, priority order — `session.id` first, the older `gen_ai.conversation.id` second. */
export const TRACE_SESSION_LADDER = [
  TRACE_ATTR.SESSION_ID,
  TRACE_ATTR.GEN_AI_CONVERSATION_ID,
] as const;

/**
 * §4.2 metadata convention → `trace_tags` keys. Each tag key lists its source
 * attributes in priority order; the value is read resource-level as the
 * per-process default with root-span override (root wins).
 */
export const TRACE_METADATA_ATTRS = {
  customer: [TRACE_ATTR.GLASSRAY_CUSTOMER],
  environment: [TRACE_ATTR.GLASSRAY_ENVIRONMENT, TRACE_ATTR.DEPLOYMENT_ENVIRONMENT_NAME],
  agent: [TRACE_ATTR.GLASSRAY_AGENT],
  flow: [TRACE_ATTR.GLASSRAY_FLOW],
} as const;
export type TraceMetadataTagKey = keyof typeof TRACE_METADATA_ATTRS;
