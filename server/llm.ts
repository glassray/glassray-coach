import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getSettings } from './settings.js';

/*
 * Self-contained, multi-provider structured-generation core for Glassray Coach.
 *
 * Dispatched on `GLASSRAY_LLM_PROVIDER`; when unset it defaults to
 * `claude-subscription` if a local `~/.claude` OAuth exists, else `mock`. Four
 * backends:
 *   - `mock`               — deterministic, dependency-free, offline. Builds a
 *                            schema-valid object straight from the zod schema
 *                            (the CI / airgap path). No network, no LLM SDK.
 *   - `claude-subscription`— the local `~/.claude` OAuth via the Claude Agent SDK
 *                            (`query`), dynamically imported so it never becomes a
 *                            hard dependency; zero API key.
 *   - `anthropic`          — metered Vercel AI SDK + `@ai-sdk/anthropic`
 *                            (`ANTHROPIC_API_KEY`).
 *   - `openai`             — metered Vercel AI SDK + `@ai-sdk/openai`
 *                            (`OPENAI_API_KEY`).
 *
 * Every network SDK is DYNAMICALLY imported inside its branch, so the `mock`
 * path pulls in nothing beyond zod + node builtins.
 */

/** The four structured-generation backends Coach can dispatch to. */
export type LlmProvider = 'mock' | 'claude-subscription' | 'anthropic' | 'openai';

/** Model tier: `heavy` for the clustering/labeling passes, `light` for per-trace judging. */
export type LlmTier = 'heavy' | 'light';

/** Token usage reported by one generation (0/0 for the mock backend). */
export type LlmUsage = { tokensIn: number; tokensOut: number };

/** Zero usage — the mock backend and the fallback when a backend reports none. */
const NO_USAGE: LlmUsage = { tokensIn: 0, tokensOut: 0 };

/** Inputs for one structured generation, independent of the backend. */
export type GenerateStructuredArgs<T> = {
  /** Zod schema the returned object must satisfy. */
  schema: z.ZodType<T>;
  /** System-role instruction text. */
  system: string;
  /** The user prompt. */
  prompt: string;
  /** Which model tier to run (defaults to `heavy`). */
  tier?: LlmTier;
  /** Sampling temperature (defaults to 0 for determinism). */
  temperature?: number;
  /** Abort signal — when a run is canceled/timed out, stops the in-flight provider call. */
  signal?: AbortSignal;
};

/** True when a local `~/.claude` OAuth directory exists (the subscription path's prerequisite). */
const hasClaudeHome = (): boolean => existsSync(path.join(homedir(), '.claude'));

/** Resolve the active provider: dashboard setting wins, then env, then subscription-if-local-OAuth-else-mock. */
const resolveProvider = (): LlmProvider => {
  const raw = getSettings().llmProvider ?? process.env.GLASSRAY_LLM_PROVIDER;
  if (raw === 'mock' || raw === 'claude-subscription' || raw === 'anthropic' || raw === 'openai') {
    return raw;
  }
  return hasClaudeHome() ? 'claude-subscription' : 'mock';
};

/** Resolve the model id for a tier: dashboard setting wins, then env override, then a provider-appropriate default. */
const resolveModelId = (provider: LlmProvider, tier: LlmTier): string => {
  const s = getSettings();
  const override =
    tier === 'light'
      ? (s.lightModelId ?? process.env.GLASSRAY_LIGHT_MODEL_ID)
      : (s.heavyModelId ?? process.env.GLASSRAY_HEAVY_MODEL_ID);
  if (override && override.length > 0) return override;
  if (provider === 'openai') return tier === 'light' ? 'gpt-4o-mini' : 'gpt-4o';
  return tier === 'light' ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
};

/** Diagnostic snapshot of the configured LLM backend — surfaced at GET /api/llm. */
export type LlmStatus = { provider: LlmProvider; ready: boolean; reason: string };

/** Report the active provider and whether it is usable (key present / OAuth present / always for mock). */
export const resolveLlm = (): LlmStatus => {
  const provider = resolveProvider();
  switch (provider) {
    case 'mock':
      return { provider, ready: true, reason: 'Deterministic mock provider — no network, offline-safe.' };
    case 'claude-subscription':
      return hasClaudeHome()
        ? { provider, ready: true, reason: 'Using the local ~/.claude subscription (no API key needed).' }
        : {
            provider,
            ready: false,
            reason: 'No ~/.claude found — sign in with the Claude CLI or set GLASSRAY_LLM_PROVIDER.',
          };
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY
        ? { provider, ready: true, reason: 'Anthropic API key configured.' }
        : { provider, ready: false, reason: 'ANTHROPIC_API_KEY is not set.' };
    case 'openai':
      return process.env.OPENAI_API_KEY
        ? { provider, ready: true, reason: 'OpenAI API key configured.' }
        : { provider, ready: false, reason: 'OPENAI_API_KEY is not set.' };
  }
};

/** The full effective LLM config — provider + readiness + the resolved model ids per tier — for the settings UI. */
export const resolveLlmConfig = (): LlmStatus & { heavyModelId: string; lightModelId: string } => {
  const status = resolveLlm();
  return {
    ...status,
    heavyModelId: resolveModelId(status.provider, 'heavy'),
    lightModelId: resolveModelId(status.provider, 'light'),
  };
};

/** Which providers are usable right now (key present / OAuth present / always for mock) — powers the settings picker. */
export const providerAvailability = (): Record<LlmProvider, boolean> => ({
  mock: true,
  'claude-subscription': hasClaudeHome(),
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  openai: Boolean(process.env.OPENAI_API_KEY),
});

// ── shared JSON parsing (subscription path) ──────────────────────────────────

/** Strip ```json … ``` (or bare ```) fences from a model response, returning the inner text. */
const stripCodeFences = (text: string): string => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1] ?? text;
};

/** Extract the outermost `{ … }` span, JSON-parse it, and zod-validate against `schema`. */
const parseJsonObject = <T>(text: string, schema: z.ZodType<T>): T => {
  const stripped = stripCodeFences(text).trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model output.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Model output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Model output did not match the required schema: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

// ── mock backend (deterministic, offline, schema-driven) ─────────────────────

/** A JSON-Schema node (as produced by `z.toJSONSchema`) — loosely typed for the walker. */
type JsonSchemaNode = Record<string, unknown>;

/** Context threaded through the mock walker: candidate trace ids + finding indexes pulled from the prompt. */
type MockContext = { traceIds: string[]; indexes: number[]; defs: Record<string, JsonSchemaNode> };

/** Collect the unique lowercase 32-hex trace ids mentioned in a prompt (for `memberTraceIds`). */
const extractTraceIds = (text: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b[0-9a-f]{32}\b/gi)) {
    const id = m[0].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
};

/** Collect the leading `N.` list indexes from a numbered prompt (for grouping `memberIndexes`). */
const extractLeadingIndexes = (text: string): number[] => {
  const out = new Set<number>();
  for (const m of text.matchAll(/^\s*(\d+)\.\s/gm)) {
    if (m[1] !== undefined) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
};

/** Deterministic placeholder string keyed by field name so mock output reads sensibly. */
const mockString = (key: string | null): string => {
  switch (key) {
    case 'reasoning':
      return 'Mock reasoning: the trace was evaluated deterministically by the offline mock provider.';
    case 'label':
      return 'Mock deviation';
    case 'description':
      return 'Mock description of an observed issue in the trace.';
    case 'rule':
      return 'The agent should follow its intended behaviour and avoid this failure mode.';
    case 'evidence':
      return 'Mock evidence excerpt drawn from the trace.';
    case 'name':
      return 'Mock flow';
    default:
      return key ? `mock-${key}` : 'mock';
  }
};

/** Recursively build a minimal schema-valid value for one JSON-Schema node. */
const mockValue = (node: JsonSchemaNode, key: string | null, ctx: MockContext): unknown => {
  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop();
    return mockValue((name ? ctx.defs[name] : undefined) ?? {}, key, ctx);
  }
  const union = (node.anyOf ?? node.oneOf) as JsonSchemaNode[] | undefined;
  if (Array.isArray(union) && union.length > 0) {
    const nonNull = union.find((b) => b?.type !== 'null') ?? union[0]!;
    return mockValue(nonNull, key, ctx);
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (node.const !== undefined) return node.const;

  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  switch (type) {
    case 'object': {
      const obj: Record<string, unknown> = {};
      const props = (node.properties ?? {}) as Record<string, JsonSchemaNode>;
      for (const [propKey, propSchema] of Object.entries(props)) {
        obj[propKey] = mockValue(propSchema, propKey, ctx);
      }
      return obj;
    }
    case 'array': {
      // Context-sensitive arrays: cite the prompt's real trace ids / finding indexes.
      if (key === 'memberTraceIds') return ctx.traceIds;
      if (key === 'memberIndexes') return ctx.indexes.length > 0 ? ctx.indexes : [0];
      const items = (node.items ?? {}) as JsonSchemaNode;
      const min = typeof node.minItems === 'number' ? node.minItems : 1;
      return Array.from({ length: Math.max(1, min) }, () => mockValue(items, key, ctx));
    }
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return typeof node.minimum === 'number' ? node.minimum : 0;
    case 'string':
    default:
      return mockString(key);
  }
};

/** Per-field cap when echoing a replayed prompt back through the mock backend. */
const MOCK_ECHO_CAP = 400;

/** Deterministic canned completion for the mock backend — echoes the (bounded) prompt so replays are inspectable offline. */
const mockText = (system: string | undefined, prompt: string): string => {
  const echo = prompt.length > MOCK_ECHO_CAP ? `${prompt.slice(0, MOCK_ECHO_CAP)}…` : prompt;
  const sys = system && system.trim() ? `\n(system: ${system.trim().slice(0, 120)})` : '';
  return `[mock replay] deterministic offline completion — no model was called.${sys}\n\nEchoing the prompt you sent:\n${echo}`;
};

/** Build a canned, schema-valid object from `schema`, weaving in trace ids / indexes from the prompt. */
const mockObject = <T>(schema: z.ZodType<T>, promptText: string): T => {
  const jsonSchema = z.toJSONSchema(schema) as JsonSchemaNode;
  const defs = ((jsonSchema.$defs ?? jsonSchema.definitions) ?? {}) as Record<string, JsonSchemaNode>;
  const ctx: MockContext = {
    traceIds: extractTraceIds(promptText),
    indexes: extractLeadingIndexes(promptText),
    defs,
  };
  const value = mockValue(jsonSchema, null, ctx);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`mock LLM produced schema-invalid output: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

// ── subscription backend (Claude Agent SDK over ~/.claude) ───────────────────

/**
 * Per-call budget (ms) for a subscription generation before the abort
 * controller fires. Generous because the subscription path runs a full Agent
 * SDK turn per call — the heavy-tier clustering call over a large findings
 * list can legitimately take minutes.
 */
const SUBSCRIPTION_BUDGET_MS = 300_000;

/** Thrown when a subscription call exhausts SUBSCRIPTION_BUDGET_MS — deliberately NOT retried (a rerun would just spend the same budget again). */
class SubscriptionBudgetError extends Error {}

/** Run one Agent SDK completion under a timeout; return its success result text + token usage. */
const runAgentText = async (
  prompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ text: string; usage: LlmUsage }> => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  let budgetHit = false;
  const timer = setTimeout(() => {
    budgetHit = true;
    abort.abort();
  }, SUBSCRIPTION_BUDGET_MS);
  // Fold an external cancel/timeout signal into this call's controller, so a
  // canceled run aborts the in-flight query instead of draining it to completion.
  const onExternalAbort = () => abort.abort();
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let text = '';
  let usage: LlmUsage = NO_USAGE;
  try {
    const response = query({ prompt, options: { abortController: abort, model, tools: [] } });
    for await (const msg of response) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        text = msg.result;
        const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        if (u) usage = { tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0 };
      }
    }
  } catch (err) {
    if (budgetHit) {
      throw new SubscriptionBudgetError(
        `subscription LLM call exceeded its ${SUBSCRIPTION_BUDGET_MS / 1000}s budget — aborted`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
  if (!text) {
    if (budgetHit) {
      throw new SubscriptionBudgetError(
        `subscription LLM call exceeded its ${SUBSCRIPTION_BUDGET_MS / 1000}s budget — aborted`,
      );
    }
    throw new Error('Claude returned no result');
  }
  return { text, usage };
};

/** One structured generation over the subscription path: JSON-only prompt → parse + validate, retry once. */
const subscriptionStructured = async <T>(
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ object: T; usage: LlmUsage }> => {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const build = (hint = ''): string =>
    `${system}\n\n${prompt}\n\n---\n\nReturn ONLY a JSON object conforming to this JSON Schema, with no prose and no markdown code fences:\n\n${jsonSchema}${hint}`;
  try {
    const first = await runAgentText(build(), model, signal);
    return { object: parseJsonObject(first.text, schema), usage: first.usage };
  } catch (firstErr) {
    // A caller abort must not be retried — propagate it so the run stops promptly.
    signal?.throwIfAborted();
    // Neither is a blown per-call budget: the retry would spend it all again.
    if (firstErr instanceof SubscriptionBudgetError) throw firstErr;
    const hint = `\n\nYour previous response could not be used: ${
      firstErr instanceof Error ? firstErr.message : String(firstErr)
    }. Respond again with ONLY the JSON object — no prose, no code fences.`;
    const retry = await runAgentText(build(hint), model, signal);
    return { object: parseJsonObject(retry.text, schema), usage: retry.usage };
  }
};

// ── metered backends (Vercel AI SDK) ─────────────────────────────────────────

/** Normalize the Vercel AI SDK's usage object (field names vary by version) into our shape. */
const meteredUsage = (usage: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number } | undefined): LlmUsage => ({
  tokensIn: usage?.inputTokens ?? usage?.promptTokens ?? 0,
  tokensOut: usage?.outputTokens ?? usage?.completionTokens ?? 0,
});

/** One structured generation over a metered provider (anthropic / openai) via the Vercel AI SDK. */
const meteredStructured = async <T>(
  provider: 'anthropic' | 'openai',
  args: Required<Pick<GenerateStructuredArgs<T>, 'schema' | 'system' | 'prompt' | 'temperature'>>,
  model: string,
  signal?: AbortSignal,
): Promise<{ object: T; usage: LlmUsage }> => {
  const { generateObject } = await import('ai');
  const languageModel =
    provider === 'anthropic'
      ? (await import('@ai-sdk/anthropic')).anthropic(model)
      : (await import('@ai-sdk/openai')).openai(model);
  const { object, usage } = await generateObject({
    model: languageModel,
    // The AI SDK's schema slot accepts a zod schema; the generic `T` needs a cast.
    schema: args.schema as z.ZodType<Record<string, unknown>>,
    system: args.system,
    prompt: args.prompt,
    temperature: args.temperature,
    abortSignal: signal,
  });
  return { object: object as T, usage: meteredUsage(usage) };
};

/** What a structured generation returns: the object plus which backend/model produced it and its token usage. */
export type GeneratedObject<T> = { object: T; usage: LlmUsage; provider: LlmProvider; model: string };

/**
 * Run one structured generation against the active backend and return a
 * schema-validated object plus its token usage. The single entry point every
 * Coach LLM pass uses.
 */
export const generateStructured = async <T>({
  schema,
  system,
  prompt,
  tier = 'heavy',
  temperature = 0,
  signal,
}: GenerateStructuredArgs<T>): Promise<GeneratedObject<T>> => {
  const provider = resolveProvider();
  const model = resolveModelId(provider, tier);
  switch (provider) {
    case 'mock':
      // The mock backend is synchronous/offline, but still honor an already-fired
      // cancel so a canceled run stops promptly rather than finishing the sample.
      signal?.throwIfAborted();
      return { object: mockObject(schema, `${system}\n\n${prompt}`), usage: NO_USAGE, provider, model };
    case 'claude-subscription': {
      const r = await subscriptionStructured(schema, system, prompt, model, signal);
      return { object: r.object, usage: r.usage, provider, model };
    }
    case 'anthropic':
    case 'openai': {
      const r = await meteredStructured(provider, { schema, system, prompt, temperature }, model, signal);
      return { object: r.object, usage: r.usage, provider, model };
    }
  }
};

/** Inputs for one free-text generation (the trace-span replay path). */
export type GenerateTextArgs = {
  /** Optional system-role instruction. */
  system?: string;
  /** The user prompt to complete. */
  prompt: string;
  /** Explicit model id override; falls back to the tier default when absent. */
  model?: string;
  /** Which model tier to run (defaults to `heavy`). */
  tier?: LlmTier;
  /** Sampling temperature (defaults to 0). */
  temperature?: number;
  /** Abort signal — when a run is canceled/timed out, stops the in-flight provider call. */
  signal?: AbortSignal;
};

/** What a free-text generation returns: the completion plus which backend/model produced it and its token usage. */
export type GeneratedText = { text: string; usage: LlmUsage; provider: LlmProvider; model: string };

/**
 * Run one free-text (non-structured) generation against the active backend —
 * used by the span-replay debugger to re-issue an edited LLM call. The provider
 * is still fixed by env; only the model id within it can be overridden.
 */
export const generateText = async ({
  system,
  prompt,
  model,
  tier = 'heavy',
  temperature = 0,
  signal,
}: GenerateTextArgs): Promise<GeneratedText> => {
  const provider = resolveProvider();
  const resolvedModel = model && model.length > 0 ? model : resolveModelId(provider, tier);
  switch (provider) {
    case 'mock':
      signal?.throwIfAborted();
      return { text: mockText(system, prompt), usage: NO_USAGE, provider, model: resolvedModel };
    case 'claude-subscription': {
      const full = system && system.trim() ? `${system}\n\n${prompt}` : prompt;
      const r = await runAgentText(full, resolvedModel, signal);
      return { text: r.text, usage: r.usage, provider, model: resolvedModel };
    }
    case 'anthropic':
    case 'openai': {
      const { generateText: aiGenerateText } = await import('ai');
      const languageModel =
        provider === 'anthropic'
          ? (await import('@ai-sdk/anthropic')).anthropic(resolvedModel)
          : (await import('@ai-sdk/openai')).openai(resolvedModel);
      const { text, usage } = await aiGenerateText({
        model: languageModel,
        system,
        prompt,
        temperature,
        abortSignal: signal,
      });
      return { text, usage: meteredUsage(usage), provider, model: resolvedModel };
    }
  }
};
