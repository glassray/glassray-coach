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
  `Set up Glassray Coach tracing for the AI agent in this repo. A Coach server (the local AI-agent trace debugger) was running when this prompt was generated:

  Ingest endpoint  ${ingestEndpoint}
  API key          ${apiKey}

Do the following, in order:

1. Run \`npx @glassray/coach init\` here to install the glassray skill, then follow it for every Coach interaction.
2. Verify the server: run \`npx @glassray/coach status\`. If no server answers, STOP and ask me to run \`npx @glassray/coach start\` — never work against a dead server (the header above may be stale).
3. Let Coach map the flows from the code: add \`codeRoot: <agent package path>\` to \`glassray.yaml\`, run \`npx @glassray/coach flows discover --code-root <path>\`, and review what it created (\`flows list\`, \`evals list\`) — Coach reads the source and writes flows + code-anchored rules directly into the server. Tighten selectors to the exact runtime names your traces will carry; add anything it missed via \`flows create\` / \`evals create\`.
4. Wire tracing to the endpoint above:
   - Node/TypeScript: add the \`@glassray/tracing\` package; construct one \`new Glassray({ endpoint, apiKey })\` at startup (endpoint + key from env vars — put them in a gitignored env file, never in code), and wrap each agent run with \`glassray.trace(...)\`, capturing steps with \`t.llm(...)\` / \`t.tool(...)\`.
   - Anything else: point an OTLP exporter at the endpoint with protocol \`http/json\` and header \`Authorization=Bearer <key>\`.
   Tag every trace with agent, environment, customer, and flow.
5. Verify ONE trace end-to-end before finishing: instrument the primary flow first, ask me to run the agent once, and confirm with \`npx @glassray/coach traces list\` that it landed with the right tags and classified into its flow. Fix the wiring if it didn't. Only then instrument the remaining flows.
6. Snapshot server state to git with \`npx @glassray/coach pull\` and commit \`glassray.yaml\`.

Done means, verifiably: \`flows list\` matches the behaviours you found in the code, \`evals list\` is non-empty, and \`traces list\` shows a correctly tagged trace. Finish with a coverage report: behaviours found vs instrumented vs skipped (and why) — partial coverage is fine, silent partial coverage is not. From then on I should only have to run my agent.`;
