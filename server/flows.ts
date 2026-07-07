import { desc } from 'drizzle-orm';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { failRun, finishRun, isRunLive } from './discovery.js';
import { generateStructuredTracked } from './usage.js';
import { newId } from './ids.js';
import { flowTraces, flows, traces } from './schema.js';

/*
 * Local FLOW labeling — cluster recent traces into a small set of named,
 * recurring agent workflows (by intent). No embeddings (Coach ships no embedding
 * provider by default): one LLM pass over a compact per-trace line (id + root
 * name + agent + a one-line intent from the input preview) does the clustering.
 */

/** Flow-clustering system prompt. */
const FLOW_SYSTEM_PROMPT =
  'You group agent execution traces into a small set of recurring FLOWS — named agent workflows defined by their intent (what the user is trying to accomplish). Traces that pursue the same underlying goal belong to the same flow. Give each flow a short, human-readable name.';

/** Output of the flow-clustering pass — named flows, each citing its member trace ids. */
const FlowSchema = z.object({
  flows: z
    .array(
      z.object({
        name: z.string().describe('Short, human-readable flow name (the recurring workflow)'),
        description: z.string().describe('One- or two-sentence description of what this flow does'),
        memberTraceIds: z
          .array(z.string())
          .describe('The trace ids (verbatim from the list) that belong to this flow'),
      }),
    )
    .describe('The recurring flows the traces cluster into'),
});

/** Max traces fed into one flow-clustering pass (keeps the prompt bounded). */
const MAX_FLOW_TRACES = 200;

/** Per-trace intent cap — the one-line summary drawn from the input preview. */
const INTENT_CAP = 200;

/** Collapse a preview to a single bounded line for the clustering prompt. */
const oneLineIntent = (preview: string | null): string => {
  if (!preview) return '—';
  const flat = preview.replace(/\s+/g, ' ').trim();
  return flat.length > INTENT_CAP ? `${flat.slice(0, INTENT_CAP)}…` : flat || '—';
};

/**
 * Run flow labeling: load the newest traces, cluster them into named flows via
 * one LLM pass, and persist `flows` + `flow_traces`. Marks the run `done` (or
 * `error`, re-throwing) via the shared run-lifecycle helpers.
 */
export const runFlows = async (
  db: CoachDb,
  opts: { runId: string; signal?: AbortSignal },
): Promise<{ flowCount: number }> => {
  try {
    const rows = await db
      .select({
        id: traces.id,
        name: traces.name,
        agent: traces.agent,
        inputPreview: traces.inputPreview,
      })
      .from(traces)
      .orderBy(desc(traces.receivedAt), desc(traces.id))
      .limit(MAX_FLOW_TRACES);

    if (rows.length === 0) {
      await finishRun(db, opts.runId, { flowCount: 0, tracesScanned: 0 });
      return { flowCount: 0 };
    }

    const knownIds = new Set(rows.map((r) => r.id));
    const listing = rows
      .map((r) => `- ${r.id} | name: ${r.name ?? '—'} | agent: ${r.agent ?? '—'} | intent: ${oneLineIntent(r.inputPreview)}`)
      .join('\n');

    const { object } = await generateStructuredTracked(db, 'flows', {
      schema: FlowSchema,
      system: FLOW_SYSTEM_PROMPT,
      prompt: `Here are recent agent traces, one per line (\`- <traceId> | name | agent | intent\`):\n\n${listing}\n\nCluster them into a small set of recurring flows. For each flow give a short name, a one- or two-sentence description, and the list of member trace ids (copied verbatim from the lines above). Every trace should belong to a flow.`,
      tier: 'heavy',
      temperature: 0,
      signal: opts.signal,
    });

    // If the run was canceled or timed out while the model was clustering, stop
    // before persisting — don't write flows for a run the user already abandoned
    // (matching the guard in discovery.ts / evals.ts).
    if (!(await isRunLive(db, opts.runId))) return { flowCount: 0 };

    // Persist each flow with its valid, de-duplicated members. Unknown / hallucinated
    // ids are dropped so `flow_traces` only ever references real local traces.
    let flowCount = 0;
    for (const flow of object.flows) {
      const members = [...new Set(flow.memberTraceIds.map((id) => id.toLowerCase()))].filter((id) =>
        knownIds.has(id),
      );
      // A flow whose member ids the model fully hallucinated has no real traces
      // behind it — skip it so `GET /api/flows` never shows a 0-trace flow.
      if (members.length === 0) continue;
      const flowId = newId('flow_');
      await db.insert(flows).values({
        id: flowId,
        runId: opts.runId,
        name: flow.name,
        description: flow.description,
        traceCount: members.length,
      });
      await db.insert(flowTraces).values(members.map((traceId) => ({ flowId, traceId })));
      flowCount += 1;
    }

    await finishRun(db, opts.runId, { flowCount, tracesScanned: rows.length });
    return { flowCount };
  } catch (err) {
    await failRun(db, opts.runId, err instanceof Error ? err.message : String(err)).catch(() => {});
    throw err;
  }
};
