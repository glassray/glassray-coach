import { desc, eq } from 'drizzle-orm';
import type { CoachDb } from './bootstrap.js';
import { failRun, finishRun, isRunLive } from './discovery.js';
import { deviationExamples, deviations } from './schema.js';
import { generateTextTracked } from './usage.js';

/*
 * Fix generation — the "self-healing loop" step. Given a discovered deviation
 * (a recurring failure + its plain-language rule + concrete example traces),
 * ask the model for ONE fix, written as a paste-into-your-coding-agent
 * instruction doc. This is a local port of the platform's Improver
 * (apps/worker/src/improver): same markdown contract, same "you can't see the
 * repo, so tell the agent what to grep for" constraint — Coach only sees traces,
 * never the agent's source. The fix is stored on the deviation row; the loop is
 * then closed by turning the deviation's rule into an eval and re-running it
 * (evals already track regressions).
 */

/**
 * System prompt for fix generation — ported from the platform Improver
 * (`IMPROVER_SYSTEM`). Enforces the output contract (six fixed markdown
 * sections) purely by instruction; the whole response IS the fix doc.
 */
const IMPROVER_SYSTEM = `You are a senior AI-engineering specialist. Write ONE self-contained fix for a recurring deviation in a developer's AI agent.

Your ENTIRE output is an instruction prompt the developer will paste into Claude Code (or a similar AI coding agent) running INSIDE their repository. Address it directly to that agent in the second person ("Search for…", "Open…", "Change…") — it is a set of instructions for the agent to execute in the repo, not a fix note for a human to read. You have NO access to the repo, so for every change tell the agent exactly what to search for first: concrete grep / ripgrep commands built from the cited agent names, tool names, and quoted strings in the evidence below.

NEVER assert an exact file path, class, function, or symbol as fact unless it appears verbatim in the evidence. Everything you infer about the repo's structure is a GUESS — label it as such and instruct the agent to confirm it by searching before editing.

These are AI-AGENT deviations, so the correct fix is often NOT application code. Consider the whole fix space and pick the smallest change that addresses the root cause: the agent's system prompt / instructions, tool definitions or tool wiring, input/output validation or guardrails, orchestration and control flow between agents, retrieval or context construction — and only then ordinary application code.

The fix MUST address EVERY example shape provided, not just the first.

Output ONLY the fix as markdown, using EXACTLY these sections in order and no preamble:

## Goal
The root cause and what a correct agent should do instead (restate the rule as the target behaviour).

## Repo search plan
The concrete grep / ripgrep commands to locate the relevant code, built from the cited names and quoted strings.

## Likely files & areas
Inferred locations — each explicitly labelled as a GUESS the agent must confirm by searching.

## Implementation steps
The ordered edits to make, smallest-change-first, spanning the whole fix space (prompt / tools / guardrails / orchestration / code).

## Example coverage
How the change addresses each example above — map each example to the part of the fix that resolves it.

## Acceptance criteria
A short checklist to verify the fix, ending with: re-run this deviation's rule as a Glassray eval and confirm the traces now pass.`;

/** Per-example evidence cap (chars) so a few long traces can't blow out the prompt. */
const EVIDENCE_CHAR_CAP = 600;

/** Max examples rendered into the fix prompt (worst-severity-first, matching the row order). */
const MAX_RENDERED_EXAMPLES = 20;

/** One example finding as the improver sees it: the trace it came from + its evidence. */
type ExampleShape = {
  traceId: string;
  label: string;
  description: string;
  severity: string;
  evidence: string;
};

/** Assemble the user prompt: the deviation (label/description/rule) + its example shapes, each capped. */
const buildImproverPrompt = (
  deviation: { label: string; description: string; rule: string; severity: string },
  examples: ExampleShape[],
): string => {
  const shapes = examples.slice(0, MAX_RENDERED_EXAMPLES).map((e, i) => {
    const evidence = e.evidence.length > EVIDENCE_CHAR_CAP ? `${e.evidence.slice(0, EVIDENCE_CHAR_CAP)}…` : e.evidence;
    return `Example ${i + 1} — trace ${e.traceId} [${e.severity}] ${e.label}\n${e.description}\nEvidence:\n${evidence}`;
  });
  const more = examples.length > MAX_RENDERED_EXAMPLES ? `\n\n(+${examples.length - MAX_RENDERED_EXAMPLES} more examples not shown)` : '';
  return [
    `DEVIATION (${deviation.severity})`,
    `Label: ${deviation.label}`,
    `Description: ${deviation.description}`,
    `Rule the agent SHOULD follow: ${deviation.rule}`,
    '',
    `EXAMPLES (${Math.min(examples.length, MAX_RENDERED_EXAMPLES)} shown)`,
    shapes.join('\n\n---\n\n') || '(no example traces recorded)',
    more,
  ].join('\n');
};

/**
 * Generate a fix for one deviation: load it + its examples, ask the model for a
 * single markdown instruction doc, and store it on the deviation row. Marks the
 * run `done` (or `error`, re-throwing) via the shared lifecycle helpers, and is
 * guarded by `isRunLive` so a cancel/timeout mid-generation doesn't persist.
 */
export const runImprover = async (
  db: CoachDb,
  opts: { deviationId: string; runId: string; signal?: AbortSignal },
): Promise<{ fixChars: number }> => {
  try {
    const rows = await db.select().from(deviations).where(eq(deviations.id, opts.deviationId)).limit(1);
    const deviation = rows[0];
    if (!deviation) throw new Error(`deviation ${opts.deviationId} not found`);

    const examples = await db
      .select({
        traceId: deviationExamples.traceId,
        label: deviationExamples.label,
        description: deviationExamples.description,
        severity: deviationExamples.severity,
        evidence: deviationExamples.evidence,
      })
      .from(deviationExamples)
      .where(eq(deviationExamples.deviationId, opts.deviationId))
      .orderBy(desc(deviationExamples.severity));

    const { text, model } = await generateTextTracked(db, 'improver', {
      system: IMPROVER_SYSTEM,
      prompt: buildImproverPrompt(deviation, examples),
      tier: 'heavy',
      temperature: 0,
      signal: opts.signal,
    });
    const markdown = text.trim();
    if (markdown.length === 0) throw new Error('the model returned an empty fix');

    // Canceled/timed out while generating → don't persist for an abandoned run.
    if (!(await isRunLive(db, opts.runId))) return { fixChars: 0 };

    await db
      .update(deviations)
      .set({ fixMarkdown: markdown, fixModel: model, fixGeneratedAt: new Date() })
      .where(eq(deviations.id, opts.deviationId));

    const result = { fixChars: markdown.length };
    await finishRun(db, opts.runId, result);
    return result;
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};
