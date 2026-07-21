![Glassray](https://glassray.ai/docs/images/glassray_cover.jpeg)

# Glassray Coach

[![npm](https://img.shields.io/npm/v/@glassray/coach.svg)](https://www.npmjs.com/package/@glassray/coach)

A fully self-contained **local** AI-agent debugger. One process, one embedded database, zero cloud: point any
OTLP-speaking agent at it, watch traces land live, then **discover** the recurring ways it misbehaves,
**generate a fix** for your coding agent, and **lock the rule in as an eval** — all on your own machine.
Coach is the local, try-before-cloud edition of [Glassray](https://glassray.ai).

## Quickstart

Requires **Node 20.6+**. Run it once, or install permanently:

```sh
npx @glassray/coach start     # no install

npm i -g @glassray/coach      # …or permanent: `glassray-coach` on your PATH
glassray-coach start          # (upgrade later when the CLI shows its ▲ notice)
```

Either boots the server on `http://127.0.0.1:5899/`, opens the dashboard, and — on a fresh store — offers to
set everything up: **run Claude Code right there** (headless, with `git commit`/`push` hard-blocked, so the
wiring lands as a diff you review), or take the **paste-into-your-coding-agent prompt** with your live ingest
endpoint and local API key baked in. Either way your agent does the whole setup: installs the skill,
discovers your flows and rules from the code (the code discovery needs an analysis model — zero-config with
Claude Code installed, see [the LLM provider](#the-llm-provider); on `mock` the agent derives them by hand
instead), wires tracing, and verifies the first trace lands. Then you just run your agent. (The dashboard's
empty state carries the same prompt behind a **Copy prompt** button, and flips to "Ready — run your agent"
once flows are configured.)

Prefer to instrument by hand? Point the [`@glassray/tracing`](https://github.com/glassray/glassray-tracing-js)
SDK (`GLASSRAY_ENDPOINT`) or any OTLP/HTTP exporter at Coach:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:5899"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer glsk_local_..."
```

No agent handy? The **Nimbus Outfitters** support-bot
([`examples/support-bot/`](https://github.com/glassray/glassray-coach/tree/main/examples/support-bot)) is a full
demo with planted failure modes and a walkthrough. Start it from a clone of this repo, with Coach already
running:

```sh
npm install && npm run build:ui
node bin/glassray.mjs start                    # if Coach isn't running yet
node examples/support-bot/support-bot.mjs      # sends 34 tickets through the buggy Nimbus agent
```

Or `node examples/send-otlp.mjs` sends a single sample trace. Something not working?
`glassray-coach doctor`.

## What you get

- **Live viewer + replay** — traces stream in as your agent runs; open the span waterfall, edit any LLM call, re-issue it.
- **Flows discovered from your code** — `glassray-coach flows discover` points a read-only agent (Read/Grep/Glob, rooted at your repo's `codeRoot`) at your agent's own source and maps its flows + rules straight from the code; new traffic then classifies into them in the background.
- **Durable flows** — or define one yourself. A flow is a named AI workflow your code is built to fulfill — "handle a support ticket", "produce the daily digest" — usually one or more agents working together. Coach matches traffic into it (a deterministic selector and/or a plain-language description) and keeps classifying fresh traces as they land; the rules that judge each run live inside the flow.
- **Deviation discovery** — an LLM judge clusters where runs went wrong into recurring **deviation types**, each with a plain-language rule.
- **Rules anchored to your code** — freeze any deviation or hand-written expectation into a repeatable pass/fail check. Every rule is active: it **reruns on its own** as fresh traffic lands, gates `glassray-coach check`, and carries its provenance — `code` (with `{ file, symbol, line }` anchors into your repo) or `promoted` (hand-written / saved from a deviation). Approval is git review of `glassray.yaml`, not an in-app toggle.
- **The portable rule artifact** — `glassray-coach pull` serializes your flows + rules into a versioned `glassray.yaml` (plus frozen golden traces with `--as-fixtures`); `glassray-coach push` reconciles it back terraform-style; `glassray-coach check --fixtures` is the deterministic CI gate.
- **The harness loop** — Coach discovers the flows + rules from your code (or your agent creates them against the server); your coding agent adds the `run` recipe to `glassray.yaml`. Then `glassray-coach run <flow> --label baseline`, make the change, `run --label candidate`, and `glassray-coach compare <flow> baseline candidate` proves behaviour held — per-rule pass-rate deltas plus an honest price-book **"cost if metered"** per side (never `$0/$0` on the free provider). With a linked cloud project, `glassray-coach pull --traces` makes real production traces the baseline and pins their inputs for the candidate run.
- **Experiments** — one durable record per question ("can we switch to Haiku?"): an experiment wraps the baseline/candidate compare and generates a report — which rules held or regressed, per-rule pass-rate deltas, and the cost delta. Data, not a verdict; you make the call.
- **Fix generation** — one paste-into-your-coding-agent instruction doc per deviation: search plan, likely files, ordered edits, acceptance criteria.
- **Agent-first CLI + skill** — every data command prints the API's JSON verbatim; `glassray-coach init` teaches your coding agent the whole loop.
- **Runs on your model** — your local `~/.claude` subscription (zero-config), a metered API key, or an offline deterministic `mock`; every metered call is budget-capped (`GLASSRAY_LLM_BUDGET_USD`, default $50).

The loop: **see** traces land → **map** your agent's flows + rules from its code (or find failures in the traffic) →
**fix** with your coding agent → **prove** the change held with an experiment as the rules rerun.

## The CLI

```sh
glassray-coach           # branded landing screen: server status, every command, guide links
glassray-coach <command> --help
```

`start` / `init` / `status` / `doctor` / `reset` manage the server. `reset` starts you over: it deletes the
entire data directory (`~/.glassray` unless `GLASSRAY_HOME` / `--data-dir` says otherwise) — traces, flows,
rules, settings, and the local ingest key — after a confirmation prompt (`--yes` skips it). The next `start`
boots on a fresh store and mints a new key, so re-point any agent still exporting with the old
`glsk_local_…` bearer. The data commands — `traces`, `flows`,
`evals`, `deviations` (`discover` runs deviation discovery), `experiments`, `fix`, `runs`, `stats`, `usage`, plus the loop verbs `pull`, `push`,
`run`, `compare`, `check`, and `link` — talk to a running Coach over loopback and
print the API's JSON **verbatim** (errors to stderr; exit `0` ok, `1` API error, `2` no server). Long verbs poll
their run to completion (`--no-wait` / `--timeout`). Full reference:
[glassray.ai/docs/coach/cli](https://glassray.ai/docs/coach/cli).

## Use it from your coding agent

The fastest path needs no typing at all: on an empty store, `glassray-coach start` offers to **run Claude Code
for you** (or hands you the same onboarding prompt the dashboard's empty state carries, live endpoint and key
baked in — Codex and Copilot take it as a paste). Your agent then
verifies the server, runs the code discovery, wires tracing, confirms a trace lands end-to-end, snapshots the
result with `glassray-coach pull`, and reports its coverage — behaviours found vs instrumented vs skipped.

Under the hood, `glassray-coach init` installs an **agent skill** (open [Agent Skills](https://agentskills.io)
format) into `./.agents/skills/` (Codex, VS Code, Copilot) and `./.claude/skills/` (Claude Code):

```sh
cd your-agent-repo && glassray-coach init    # or: npx skills add glassray/glassray-coach
```

The skill teaches the whole loop server-first — flows and rules live in the server (what the dashboard shows);
`glassray.yaml` is the committed snapshot (`pull` to write it, `push` to apply hand-edits or restore a fresh
server). You can also just ask your agent things like _"why is my agent failing?"_ or _"prove the model swap
held"_ — it drives discover → fix → verify and run → compare against the local Coach.

> **Migrating from 0.1:** the MCP server is removed — the CLI replaced it. `claude mcp remove glassray`, then `glassray-coach init`.

## The LLM provider

Chosen by `GLASSRAY_LLM_PROVIDER`, or from the dashboard's **Settings** page:

| Provider              | Needs                             | Notes                                                                              |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `claude-subscription` | a local `~/.claude` (Claude Code) | **Default when `~/.claude` exists.** Zero-config, no API key.                      |
| `anthropic`           | `ANTHROPIC_API_KEY`               | Metered.                                                                           |
| `openai`              | `OPENAI_API_KEY`                  | Metered.                                                                           |
| `mock`                | nothing                           | **Default with no `~/.claude`.** Deterministic, network-free — the airgap/CI path. |

## Privacy & security

Everything lives under `~/.glassray`. The server binds `127.0.0.1` only, with a loopback guard on every route —
nothing is uploaded, there is no account. Ingest (`POST /v1/traces`) is bearer-authed with your local key. The
CLI's npm update check (opt out: `GLASSRAY_NO_UPDATE_CHECK=1`) sends only the package name in one HTTPS request,
never from the server or the data commands.

## Docs

- **Guides** — [quickstart](https://glassray.ai/docs/coach/quickstart) · [the loop, worked end to end](https://glassray.ai/docs/coach/analyze) · [CLI & coding agents](https://glassray.ai/docs/coach/cli)
- **[HTTP API reference](https://github.com/glassray/glassray-coach/blob/main/docs/http-api.md)** — every route
- **[Development](https://github.com/glassray/glassray-coach/blob/main/docs/DEVELOPMENT.md)** — contributing, layout, env vars, publishing

## License

[MIT](./LICENSE)
