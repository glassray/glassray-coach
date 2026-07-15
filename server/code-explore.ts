import { existsSync } from 'node:fs';
import path from 'node:path';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { materializeSelectorFlow } from './classify.js';
import { failRun, finishRun, isRunLive } from './discovery.js';
import { createManualEval } from './evals.js';
import { newId } from './ids.js';
import { resolveLlm, resolveLlmConfig, runToolAgent } from './llm.js';
import { slugify } from './artifact.js';
import { evals, flows, traces, type Anchor } from './schema.js';

/*
 * CODE-BASED FLOW DISCOVERY — the local analogue of cloud's headless
 * `code-explore` (apps/worker/src/code-explore/). Instead of clustering recent
 * TRACES into flows (the online model, where prod traffic is the signal), Coach
 * points Claude at the agent's OWN SOURCE — a `codeRoot` on disk — and reads the
 * flows straight out of the code: one flow per agent graph / chain entry point,
 * each carrying the rules its prompts and guardrails actually enforce, anchored
 * to the file they were read from (`source: 'code'`). Traces are attached to the
 * discovered flows afterwards by the normal classify sweep (selector / LLM
 * rule) — define from code, monitor with traffic. Runs on the local
 * `claude-subscription` provider (~/.claude) with read-only Read/Grep/Glob tools
 * rooted at `codeRoot` (the base the agent starts from — it can follow imports
 * beyond it; there is no `Bash`, so it stays read-only). `mock` discovers
 * nothing (no code is read).
 */

/** How many distinct trace agent tags are surfaced to the explorer as seed targets. */
const SEED_AGENT_LIMIT = 40;

/**
 * One code anchor as the model emits it — the object form, or a bare
 * `"src/graph.ts:123"` / `"ClassName.method"` string (the model sometimes emits
 * a string instead of the object). A string is best-effort split into
 * `{ file, symbol?, line? }`. Mirrors cloud's tolerant `CodeAnchorSchema`.
 */
const anchorSchema = z.union([
  z.object({
    file: z.string().default(''),
    symbol: z.string().default(''),
    line: z.number().int().positive().optional(),
  }),
  z.string().transform((s) => {
    const withLine = s.match(/^(.*?):(\d+)$/);
    const file = withLine ? withLine[1]! : s;
    const line = withLine ? Number(withLine[2]) : undefined;
    const symbol = file.split(/[\\/]/).pop() || file;
    return line !== undefined ? { file, symbol, line } : { file, symbol };
  }),
]);

/** A tolerant anchor array: missing → `[]`, a bad element is dropped, empties filtered — one malformed anchor must not fail the whole scan. */
const anchorArray = () =>
  z
    .array(anchorSchema.catch({ file: '', symbol: '' }))
    .default([])
    .transform((a) => a.filter((x) => x.file || x.symbol));

/** One expected behaviour / rule the flow's code enforces, read from the code (== an eval on the target). */
const ruleSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'A SHORT, plain-language title for the rule — the scannable headline (3-8 words, e.g. "Retrieve before answering", "Decline empty plans"). Accurate but concise; NOT a full sentence, and NOT just the first words of `text`.',
    ),
  text: z
    .string()
    .describe(
      'The rule as ONE plain sentence a non-engineer can read, while staying exactly true to the code — the `snippet` carries the verbatim ground truth, `text` carries the meaning. No function names, constants, or jargon in `text` (e.g. code `if not sources: return DEFAULT_ERROR_MESSAGE` → text "When no retrieved source supports a claim, the answer must refuse instead of asserting it").',
    ),
  snippet: z
    .string()
    .optional()
    .describe(
      'The exact code the rule is read from, quoted VERBATIM — a prompt line, a comment, or the enforcing condition/statement (e.g. `if not sources: return DEFAULT_ERROR_MESSAGE`). ONLY when the rule maps to a literal line or two of source; copy it exactly, never paraphrase. OMIT entirely for rules inferred from control flow across multiple places (the anchors are the ground truth there).',
    ),
  anchors: anchorArray().describe('Where the rule is enforced in the code (file / symbol / line).'),
});

/** One discovered flow as read from the code. Extra fields the model may emit (edges, roles, examples) are ignored. */
const codeFlowSchema = z.object({
  name: z.string().describe("Short, human-readable flow name (e.g. 'Trace digestion')"),
  description: z.string().describe('One or two sentences: what this flow does, as read from the code'),
  agentNames: z
    .array(z.string())
    .default([])
    .describe('The exact agent / node / class names that make up this flow in the code (matched against trace agent tags).'),
  codeAnchors: anchorArray().describe('Concrete file / symbol locations where this flow is defined or wired up.'),
  rules: z.array(ruleSchema).default([]).describe('The flow\'s expected behaviours, one rule per directive, each with a code anchor.'),
});

/** System-wide intent read from the repo — product context + rules that apply to every flow. */
const systemIntentSchema = z
  .object({
    context: z.string().default(''),
    rules: z.array(ruleSchema).default([]),
  })
  .default({ context: '', rules: [] });

/** The explorer's full result — the flows plus the system-level intent. */
const codeFlowsSchema = z.object({
  flows: z.array(codeFlowSchema).default([]),
  system: systemIntentSchema,
});

type CodeFlow = z.infer<typeof codeFlowSchema>;
type CodeRule = z.infer<typeof ruleSchema>;
type CodeFlows = z.infer<typeof codeFlowsSchema>;

/** The explorer's system instruction — what the code-explorer is for (ported from cloud's `EXPLORE_SYSTEM_PROMPT`, trimmed to Coach's fields). */
const EXPLORE_SYSTEM_PROMPT = `You are a code-explorer reading an AI-agent codebase to map its FLOWS — the distinct AI-connected, end-to-end flows of the agent system (one per agent graph / chain entry point, not per low-level step).

You have read-only tools (Read, Grep, Glob) rooted at the repository. Use them to find where each flow is defined and which agents compose it.

## Reading order — read prompt-first and targeted, do NOT crawl
1. Orient cheaply: read the root README / docs and grep for the agent/prompt sites (SYSTEM_PROMPT / *_PROMPT / "You are" constants). The docs orient you; the code decides.
2. Grep to the prompt constants, don't crawl: a flow's rules, tone, and guardrails live in its prompt, not scattered across the repo. Read those files.
3. Read each flow's prompt file fully, then move on — no re-reading, no whole-repo sweep. A handful of targeted reads, not dozens.

For each flow, capture:
- a short name and a one/two-sentence description read from the code,
- the EXACT agent / node / class names that make it up (these get matched against the agent tags on real traces),
- concrete code anchors (file + defining symbol, and the line when you know it),
- its RULES — the explicit expected behaviours the flow's code enforces (must / must-not / ordering / guardrail / validation / branch conditions). Be EXHAUSTIVE and GRANULAR: one rule per directive, never a single summary of several. A prompt / guardrail block / checklist that states several directives yields ONE rule per directive — treat every "must / must not / always / never / only / do not" and every numbered instruction as its own rule. Think of each rule as a TEST CASE: a specific expected behaviour you could write a pass/fail check for. A prompt with five directives should produce ~five rules, not one. For EACH rule give: a SHORT, plain-language TITLE — the scannable headline (\`name\`, 3-8 words, e.g. "Retrieve before answering", "Decline empty plans"); accurate but concise, NOT a full sentence and NOT just the first words of \`text\`; the rule as ONE plain sentence a non-engineer can read while staying exactly true to the code (\`text\` — no function names or jargon; the snippet carries the ground truth. Code \`if not sources: return DEFAULT_ERROR_MESSAGE\` → text "When no retrieved source supports a claim, the answer must refuse instead of asserting it"); the VERBATIM code snippet it's read from when the rule maps to a literal line or two (\`snippet\` — copy exactly, omit for rules inferred from control flow across places); and the enforcing code \`anchors\` (file / symbol / line). Read every rule from what the code ACTUALLY does — never invent; a rule with no real code anchor is a smell. Emit an empty rules list only when the flow's own code genuinely states none.

ALSO capture the SYSTEM-LEVEL intent (the 'system' object): context (what this product / agent system is and who it's for, from the README / docs — empty string if nothing usable) and rules (SYSTEM-WIDE expectations that apply to every flow — tone / style, global guardrails, out-of-scope — read from the system prompts, anchored where possible). Don't duplicate a per-flow rule here.

Skip flows where no AI runs (static pages, plain CRUD / config). When you are done, emit ONLY the final JSON object — no prose, no markdown fences.`;

/** Build the explorer user prompt: the repo label, the trace agent tags (seed targets), and the known flows to refresh (dedup). */
const buildExplorePrompt = (input: {
  repoLabel: string;
  agentNames: readonly string[];
  knownFlows: readonly { name: string; description: string }[];
}): string => {
  const agents =
    input.agentNames.length > 0
      ? input.agentNames.map((n) => `- ${n}`).join('\n')
      : '(none — cold start: discover flows from the framework graph / chain definitions)';
  const known =
    input.knownFlows.length > 0
      ? `\n\n## Flows already known — do NOT re-propose these (only add genuinely new ones)\n${input.knownFlows
          .map((f) => `- "${f.name}" — ${f.description}`)
          .join('\n')}`
      : '';
  return `Repository: ${input.repoLabel}

## Agent tags seen in real traces (your primary seed targets)
${agents}${known}

## Your task
Explore the repository (use Read / Grep / Glob) and produce the FLOWS plus the SYSTEM-LEVEL intent as described. Confirm each flow's defining file(s) and the agents that compose it; read the README for the system context and the system prompts for the system-wide rules.

Return ONLY a JSON object of the form:
{
  "flows": [
    {
      "name": "Trace digestion",
      "description": "Summarises each incoming trace into a one-line digest with a language code and a topic.",
      "agentNames": ["trace-digest"],
      "codeAnchors": [{ "file": "src/watcher/digest.ts", "symbol": "generateDigest", "line": 108 }],
      "rules": [
        { "name": "Summary in plain English",
          "text": "The summary is always written in plain English regardless of the trace's source language",
          "snippet": "Write the summary in English.",
          "anchors": [{ "file": "src/watcher/digest.ts", "symbol": "SYSTEM" }] }
      ]
    }
  ],
  "system": {
    "context": "A one-line description of the product, from the README.",
    "rules": [
      { "text": "Never invent facts not present in the trace", "anchors": [{ "file": "src/watcher/digest.ts", "symbol": "SYSTEM" }] }
    ]
  }
}`;
};

/** Map a model-emitted anchor list to the stored `Anchor[]` shape (Coach populates file + optional symbol/line); null when empty. */
const toAnchors = (raw: CodeRule['anchors']): Anchor[] | null => {
  const cleaned: Anchor[] = raw
    .filter((a) => a.file)
    .map((a) => ({
      file: a.file,
      ...(a.symbol ? { symbol: a.symbol } : {}),
      ...(typeof a.line === 'number' ? { line: a.line } : {}),
    }));
  return cleaned.length > 0 ? cleaned : null;
};

/** Filler words a truncated title must not end on, so a fallback never reads as cut off ("…locked down to only"). */
const TRAILING_FILLER = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'with', 'only', 'that', 'in', 'on', 'by', 'from', 'as', 'is', 'are', 'its', 'their',
]);

/**
 * Derive a short rule title from its text when the model omitted `name`: the
 * first ~8 words, trimmed of trailing punctuation and dangling filler words so
 * the fallback reads as a headline rather than a sentence chopped mid-phrase.
 */
const titleFromText = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 8);
  while (words.length > 3 && TRAILING_FILLER.has(words[words.length - 1].replace(/[^a-z]/gi, '').toLowerCase())) {
    words.pop();
  }
  const title = words.join(' ').replace(/[\s—,:;.-]+$/, '').trim();
  return title.length > 0 ? title.charAt(0).toUpperCase() + title.slice(1) : 'Rule';
};

/** What a reconcile produced: how many NEW flows + rules landed on the target. */
export type ReconcileResult = { flowCount: number; ruleCount: number };

/**
 * Persist a code-explore result into the durable `flows` + `evals` tables. Each
 * new flow becomes a durable flow (a single-agent flow gets a deterministic
 * `{ agent }` selector so its traces attach for free; a multi/zero-agent flow
 * gets an LLM classify `rule` from its description). Each flow rule + every
 * system-wide rule becomes an eval carrying its code `anchors` — so
 * `sourceFromAnchors` stamps `source: 'code'` and the file link round-trips
 * through `glassray.yaml`. Name-colliding flows and text-duplicate global rules
 * are skipped, so a re-run EXTENDS the set rather than duplicating it (to
 * refresh a flow after the code changed, delete it and re-discover). Exported
 * for direct unit testing without a live model.
 */
export const reconcileCodeFlows = async (
  db: CoachDb,
  opts: { runId: string; result: CodeFlows },
): Promise<ReconcileResult> => {
  const existing = await db.select({ name: flows.name }).from(flows).where(eq(flows.status, 'active'));
  const takenNames = new Set(existing.map((f) => f.name.trim().toLowerCase()));

  let flowCount = 0;
  let ruleCount = 0;

  for (const flow of opts.result.flows) {
    const key = flow.name.trim().toLowerCase();
    if (!key || takenNames.has(key)) continue;
    takenNames.add(key);

    const singleAgent = flow.agentNames.length === 1 ? flow.agentNames[0]!.trim() : null;
    const selector = singleAgent ? { agent: singleAgent } : null;
    const rule = selector ? null : flow.description;
    const flowId = newId('flow_');
    await db.insert(flows).values({
      id: flowId,
      runId: opts.runId,
      name: flow.name,
      description: flow.description,
      selector,
      rule,
      classify: selector ? 'selector' : 'llm',
      createdBy: 'discovery',
      slug: slugify(flow.name),
    });
    // Attach existing traces for a selector flow immediately; a rule flow's
    // members are filled in by the next classify sweep.
    if (selector) await materializeSelectorFlow(db, flowId, selector);
    flowCount += 1;

    for (const r of flow.rules) {
      await createManualEval(db, {
        name: r.name?.trim() || titleFromText(r.text),
        text: r.text,
        flowId,
        anchors: toAnchors(r.anchors),
      });
      ruleCount += 1;
    }
  }

  // System-wide rules → GLOBAL evals (flowId null), deduped by text against
  // existing global rules so a re-run doesn't pile up copies.
  const globalRows = await db.select({ text: evals.text }).from(evals).where(isNull(evals.flowId));
  const globalTexts = new Set(globalRows.map((r) => r.text.trim().toLowerCase()));
  for (const r of opts.result.system.rules) {
    const t = r.text.trim().toLowerCase();
    if (!t || globalTexts.has(t)) continue;
    globalTexts.add(t);
    await createManualEval(db, {
      name: r.name?.trim() || titleFromText(r.text),
      text: r.text,
      anchors: toAnchors(r.anchors),
    });
    ruleCount += 1;
  }

  return { flowCount, ruleCount };
};

/**
 * Run the DISCOVER pass over the agent's own source at `codeRoot`: read the
 * flows + their rules out of the code with a tool-using Claude agent, then
 * reconcile them into the durable flows + evals. Replaces the old
 * trace-clustering bootstrap (that model lives in cloud Glassray, where prod
 * traces are the signal). Marks the run `done` (or `error`, re-throwing).
 *
 * Provider gate: real discovery needs the local `claude-subscription` path
 * (~/.claude) since it drives read-only file tools; `mock` discovers nothing
 * (no code is read); a metered provider fails with a clear message.
 */
export const runCodeDiscover = async (
  db: CoachDb,
  opts: { runId: string; signal?: AbortSignal; codeRoot: string | null },
): Promise<ReconcileResult> => {
  try {
    const provider = resolveLlm().provider;

    // Mock: nothing to read offline — a clean, empty run (never mints bogus flows).
    if (provider === 'mock') {
      await finishRun(db, opts.runId, { flowCount: 0, ruleCount: 0, filesRead: 0 });
      return { flowCount: 0, ruleCount: 0 };
    }
    if (provider !== 'claude-subscription') {
      throw new Error(
        'Code discovery runs on the local claude-subscription provider (~/.claude); it is not available for metered providers yet.',
      );
    }
    if (!opts.codeRoot || !existsSync(opts.codeRoot)) {
      throw new Error(
        `No readable codeRoot to scan (${opts.codeRoot ?? 'unset'}). Add \`codeRoot: <path>\` to glassray.yaml — the repo root Claude should read.`,
      );
    }

    // Seed targets: the distinct trace agent tags Coach has already seen (so the
    // explorer can tie code flows to real node names), plus the flows already
    // known (refresh-not-duplicate).
    const [agentRows, knownFlows] = await Promise.all([
      db
        .select({ agent: traces.agent })
        .from(traces)
        .where(sql`${traces.agent} is not null`)
        .groupBy(traces.agent)
        .orderBy(desc(sql`count(*)`))
        .limit(SEED_AGENT_LIMIT),
      db
        .select({ name: flows.name, description: flows.description })
        .from(flows)
        .where(eq(flows.status, 'active')),
    ]);
    const agentNames = agentRows.map((r) => r.agent).filter((a): a is string => a !== null);

    let filesRead = 0;
    const { object } = await runToolAgent({
      cwd: opts.codeRoot,
      system: EXPLORE_SYSTEM_PROMPT,
      prompt: buildExplorePrompt({ repoLabel: path.basename(opts.codeRoot), agentNames, knownFlows }),
      schema: codeFlowsSchema,
      model: resolveLlmConfig().heavyModelId,
      signal: opts.signal,
      onProgress: (n) => {
        filesRead = n;
      },
    });

    // Canceled/timed out while the agent was reading — stop before persisting.
    if (!(await isRunLive(db, opts.runId))) return { flowCount: 0, ruleCount: 0 };

    const reconciled = await reconcileCodeFlows(db, { runId: opts.runId, result: object });
    await finishRun(db, opts.runId, { ...reconciled, filesRead });
    return reconciled;
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};

/** Exposed for tests: the internal explore-result type + its schema. */
export type { CodeFlow, CodeFlows };
export { codeFlowsSchema };
