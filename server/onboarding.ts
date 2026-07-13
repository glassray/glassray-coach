/**
 * The coding-agent onboarding prompt — the fastest path from an empty Coach to
 * traces landing. Built server-side (exposed on GET /api/info) so the CLI's
 * `start` output and the dashboard's empty state hand out the identical prompt,
 * with the live ingest endpoint and key already baked in.
 */

/** What the prompt needs from the running server. */
export interface AgentPromptInput {
  /** Full local ingest URL, e.g. `http://127.0.0.1:5899/v1/traces`. */
  ingestEndpoint: string;
  /** The local API key (`glsk_local_…`) traces must authenticate with. */
  apiKey: string;
}

/**
 * Render the paste-into-your-coding-agent prompt. Plain text, no ANSI — it is
 * copied into Claude Code / Codex / Copilot verbatim, so it must read as an
 * instruction to the agent, not to the human. One line per paragraph/list item
 * (no mid-sentence hard wraps): terminals and the dashboard panel both
 * soft-wrap to their own width, so hard breaks only fight the container.
 */
export const buildAgentPrompt = ({ ingestEndpoint, apiKey }: AgentPromptInput): string =>
  `Set up Glassray Coach tracing for the AI agent in this repo. A Coach server (the local AI-agent trace debugger) is already running:

  Ingest endpoint  ${ingestEndpoint}
  API key          ${apiKey}

Do the following, in order:

1. Run \`npx @glassray/coach init\` here to install the glassray skill, then follow it for every Coach interaction.
2. Read the codebase to find the agent: entry points, LLM calls, tool calls, and the distinct behaviours (flows) it implements.
3. Wire tracing to the endpoint above:
   - Node/TypeScript: add the \`@glassray/tracing\` package; construct one \`new Glassray({ endpoint, apiKey })\` at startup (endpoint + key from env vars — put them in a gitignored env file, never in code), and wrap each agent run with \`glassray.trace(...)\`, capturing steps with \`t.llm(...)\` / \`t.tool(...)\`.
   - Anything else: point an OTLP exporter at the endpoint with protocol \`http/json\` and header \`Authorization=Bearer <key>\`.
   Tag every trace with agent, environment, customer, and flow.
4. Create one flow per behaviour you found, and derive assertion rules from the agent's own system prompts, guardrails, and tool descriptions (the skill covers both).
5. Ask me to run the agent to generate real traffic, verify with \`npx @glassray/coach traces list\` that traces land with the right tags, and fix the wiring if they don't.

When you are done I should only have to run my agent — traces, flows, and rules should all appear in Coach on their own.`;
