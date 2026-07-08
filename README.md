![Glassray](https://glassray.ai/docs/images/glassray_cover.jpeg)

# Glassray Coach

[![npm](https://img.shields.io/npm/v/@glassray/coach.svg)](https://www.npmjs.com/package/@glassray/coach)

A fully self-contained **local** AI-agent debugger. One process, one embedded database, zero cloud: point any
OTLP-speaking agent at it, watch traces land live, then **discover** the recurring ways it misbehaves,
**generate a fix** for your coding agent, and **lock the rule in as an eval** — all on your own machine, in the
same warm-paper design language as the hosted Glassray dashboard (Coach is the local, try-before-cloud edition).

```sh
npx @glassray/coach start
```

> Coach lives in its own repo — [`glassray/glassray-coach`](https://github.com/glassray/glassray-coach) —
> and is consumed by the Glassray monorepo as a git submodule. It's a plain npm project (use `npm`, not `pnpm`)
> with zero `@helix/*` dependencies; the trace-analysis code it shares with the hosted app is vendored in (`server/vendor/`) and refreshed by re-copying.

## What you get

- **Ingest** — OTLP/JSON at `POST /v1/traces` (alias `/api/public/otel/v1/traces`), bearer-authed with a locally generated key.
- **Live viewer + replay** — a tail-fed dashboard (Overview KPIs + activity chart + deviation/eval rollups, span waterfall + inspector); edit any LLM span's model / system / prompt / temperature and re-issue it beside the original.
- **Discovery** — an LLM judge clusters where each run went wrong into recurring **deviation types**, each with a plain-language rule; flow-scopeable, honest when it finds nothing.
- **Durable flows** — behaviours defined by a deterministic selector and/or a plain-language rule; selectors match inline at ingest, rules via a debounced **background classification** sweep, and a discover pass bootstraps candidates from existing traffic.
- **Flow-scoped autorun evals** — freeze a deviation, a hand-written rule, or a single trace into a repeatable pass/fail check; runs sample the flow's newest members, autorun re-queues on fresh traffic, regressions (passed → fails) are flagged.
- **Fix generation** — one paste-into-your-coding-agent instruction doc per deviation: a goal, a grep-driven repo search plan, likely files, ordered edits across prompt / tools / guardrails / code, acceptance criteria.
- **Agent-first CLI + skill** — every data command prints the API's JSON verbatim; `glassray init` ships a skill that teaches your coding agent the whole loop.
- **PGlite store** — embedded Postgres + pgvector ([PGlite](https://pglite.dev)) via Drizzle; no external services.

The loop:
1. **See** — traces land live in the viewer as your agent runs.
2. **Find** — discovery clusters its recurring failures into deviation types.
3. **Scope** — pin the behaviours that matter as flows; freeze their rules as evals.
4. **Fix** — generate the fix doc; apply it in Claude Code / Cursor.
5. **Verify** — re-run the eval over fresh traces; mark the deviation resolved.

## Quickstart

Requires **Node 20.6+** (`glassray doctor` checks the Node version, the port, and data-dir writability for you).
Prefer a guided tour? See [`GETTING_STARTED.md`](./GETTING_STARTED.md). One command — no clone, no install:
Run once, or install permanently:

```sh
npx @glassray/coach start     # no install

npm i -g @glassray/coach      # …or permanent: `glassray` on your PATH
glassray start                # (upgrade later when the CLI shows its ▲ notice)
```

Either boots the server on `http://127.0.0.1:5899/` and prints the dashboard URL, the ingest endpoint, your local API key, and this copy-paste OTLP exporter block:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:5899"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer glsk_local_..."
```

Then open **Deviations → Run discovery**; on a deviation, **Generate fix** writes the paste-into-your-coding-agent
instructions and **Save as eval** locks its rule in (also available on any trace's detail view, or hand-write one
under **Evals**). Apply the fix, re-check the eval against fresh traces, **Mark resolved** — or run `glassray init` and let your coding agent drive (see below).

No agent handy? [`examples/send-otlp.mjs`](./examples/send-otlp.mjs) sends a realistic sample trace;
[`examples/support-bot/`](./examples/support-bot/) is the fuller demo — a simulated agent on the real
`@glassray/tracing` SDK with planted recurring failure modes, a walkthrough + demo script ([README](./examples/support-bot/README.md)).
To instrument a real agent, point the [`@glassray/tracing`](https://github.com/glassray/glassray-tracing-js) SDK (`GLASSRAY_ENDPOINT`) or any OTLP/HTTP exporter at Coach — the dashboard's empty state has copy-paste recipes for each.

### CLI

| Command                           | What it does                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `glassray start`                  | Start server + dashboard — `--port` (default 5899), `--data-dir`, `--no-open`.                                                                                     |
| `glassray init`                   | Install the agent skill into `./.agents/skills/` + `./.claude/skills/` (`--force` overwrites) — see below.                                                         |
| `glassray reset --yes`            | Wipe the data directory (asks for confirmation without `--yes`).                                                                                                   |
| `glassray status`                 | Show the data dir and probe whether a coach answers on the port.                                                                                                   |
| `glassray doctor`                 | Check Node version, port, and data-dir writability (creating the dir if missing, then cleaning up), with one-line fixes.                                           |
| `glassray` / `help` / `--version` | The branded landing screen — server status, every command, guide links; `help <command>` (or `<command> --help`) prints usage; `--version` prints the CLI version. |

Data + run commands talk to a **running** coach over loopback and print the API's JSON **verbatim** to
stdout (errors to stderr; exit `0` ok, `1` API error, `2` no server running); all honour `--port`. The
long verbs (`discovery run`, `fix`, `evals run`, `flows discover`) block and poll their run to completion —
`--no-wait` skips that, `--timeout` bounds it; afterwards `evals run` prints the eval detail (verdicts) and `fix` the deviation (with `fixMarkdown`).

| Command                                                                                                                          | What it does                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `glassray traces list [--q --agent --status --flow --limit --offset]` · `traces get <id>` · `traces tail`                          | List/filter traces, fetch one span-tree view, stream ingests as NDJSON.               |
| `glassray stats` · `usage`                                                                                                         | Traffic rollups + known agent names; Coach's own LLM spend vs the budget.             |
| `glassray flows list [--status active\|archived\|all]` · `flows get <id>` · `flows audit <id>`                                     | List flows (`{ items, unclassified }`), one flow's detail, its classification audit.  |
| `glassray flows create --name [--description --rule --classify --selector '<json>' --created-by]`                                  | Create a durable flow (selector and/or rule).                                         |
| `glassray flows update <id> [--name --description --rule\|--no-rule --classify --selector '<json>'\|--no-selector --status]`       | Update a flow's definition; `--status archived` retires it.                           |
| `glassray flows delete <id>` · `flows discover [--no-wait --timeout]`                                                              | Delete a flow; bootstrap new rule-defined flows from existing traffic.                |
| `glassray evals list` · `evals get <id>`                                                                                           | Rollups + regression counts; the detail adds per-trace verdicts + run history.        |
| `glassray evals create (--deviation <id> [--flow])` · `(--label --rule [--description --flow --no-autorun --autorun-threshold])`   | Freeze a deviation's rule, or hand-write one — optionally flow-scoped.                |
| `glassray evals update <id> [--flow\|--no-flow --autorun\|--no-autorun --autorun-threshold]`                                       | Move the flow binding / tune autorun (the rule itself is immutable).                  |
| `glassray evals run <id> [--sample --model --no-wait --timeout]` · `evals delete <id>`                                             | Score the sample against the rule; delete an eval and its verdicts.                   |
| `glassray deviations list` · `deviations get <id>` · `deviations resolve <id> [--reopen]`                                          | The newest discovery run's findings; flip a deviation open ↔ resolved.                |
| `glassray discovery run [--sample --flow --no-wait --timeout]`                                                                     | Run deviation discovery, optionally scoped to one flow's members.                     |
| `glassray fix <deviationId> [--no-wait --timeout]`                                                                                 | Generate the paste-into-your-coding-agent fix for a deviation.                        |
| `glassray runs list [--limit]` · `runs get <id>` · `runs cancel <id>`                                                              | Inspect the run queue; cancel a queued **or** active run.                             |

### Use it from your coding agent

The CLI is the agent surface. `glassray init` installs an **agent skill** — one SKILL.md in the open
[Agent Skills](https://agentskills.io) format — at both standard locations: `./.agents/skills/glassray/`
(OpenAI Codex, VS Code, GitHub Copilot) and `./.claude/skills/glassray/` (Claude Code). It teaches the agent to
inventory the durable flows/evals, scope your agent's behaviours as flows, derive evals from the rules already written into your prompts and guardrails, and run discover → fix → verify against the local Coach.

```sh
cd your-agent-repo && glassray init    # or: npx skills add glassray/glassray-coach
```

The latter is the community [`skills` CLI](https://github.com/vercel-labs/skills) — it installs the same skill
straight from this repo into 70+ agents (Claude Code, Cursor, Codex, Windsurf, Cline, …), picks agents interactively (`-g` for user-wide), and handles updates.

Then ask Claude Code _"set up glassray flows and evals for this agent"_ or _"which traces echoed a full
card number back to the customer?"_ — every command prints the API's JSON, so the agent reads exactly what the dashboard shows.

> **Migrating from 0.1:** the MCP server is removed — the CLI replaced it. `glassray mcp` prints a
> removal hint and exits `1`; deregister with `claude mcp remove glassray`, then `glassray init`.

## The LLM provider

Discovery, fix generation, evals, flows, and replay need a model — chosen by `GLASSRAY_LLM_PROVIDER`, or the
dashboard **Settings** page, which persists your provider / heavy + light model ids / budget to `settings.json` (`chmod 0600`; API keys stay in the env) and overrides the env:

| Provider              | Needs                             | Notes                                                                                         |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `claude-subscription` | a local `~/.claude` (Claude Code) | **Default when `~/.claude` exists.** Zero-config, no API key — dynamic-imports the Agent SDK. |
| `anthropic`           | `ANTHROPIC_API_KEY`               | Vercel AI SDK. Models via `GLASSRAY_HEAVY_MODEL_ID` / `GLASSRAY_LIGHT_MODEL_ID`.              |
| `openai`              | `OPENAI_API_KEY`                  | Vercel AI SDK (`gpt-4o` / `gpt-4o-mini`).                                                     |
| `mock`                | nothing                           | **Default with no `~/.claude`.** Deterministic, network-free — the airgap/CI path.            |

Every network SDK is dynamically imported inside its own branch — the `mock` path pulls in nothing beyond zod and node builtins, keeping the whole tool airgap-safe.

**Spend cap.** Every metered analysis call (discovery / fix / eval / flows / replay) is checked against
**`GLASSRAY_LLM_BUDGET_USD`** (default `$50`) — an API key can't quietly drain your balance while you test: at
the cap, new runs stop with a clear error until you raise it or reset (`0` = unlimited); the free `mock` /
`claude-subscription` paths accrue `$0` and are never blocked. **Overview → LLM usage** shows spend vs. budget per model (`GET /api/usage`; `POST /api/usage/reset` clears the ledger).

## Environment variables

Everything has a working default — a fresh checkout runs with none of these set. The CLI's `--port` / `--data-dir`
flags set `GLASSRAY_PORT` / `GLASSRAY_HOME` for you; set the vars directly when running `npm run dev` / `npm start` outside the CLI.

| Variable                               | Default                                                  | What it does                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLASSRAY_HOME`                        | `~/.glassray`                                            | Data directory (DB + local API key).                                                                                                        |
| `GLASSRAY_PORT` (or `PORT`)            | `5899`                                                   | Port the server binds on `127.0.0.1`.                                                                                                       |
| `GLASSRAY_LLM_PROVIDER`                | `claude-subscription` if `~/.claude` exists, else `mock` | Analysis backend (see above).                                                                                                               |
| `GLASSRAY_HEAVY_MODEL_ID`              | `claude-opus-4-8` (`gpt-4o` on openai)                   | Heavy-tier model id — applies to **every** provider.                                                                                        |
| `GLASSRAY_LIGHT_MODEL_ID`              | `claude-sonnet-4-6` (`gpt-4o-mini` on openai)            | Light-tier model id — applies to **every** provider.                                                                                        |
| `GLASSRAY_LLM_BUDGET_USD`              | `50`                                                     | Metered spend cap; `0` = unlimited.                                                                                                         |
| `GLASSRAY_RUN_TIMEOUT_MS`              | `600000`                                                 | Backstop timeout (ms) for a background run — a stalled run is marked errored so the queue advances and the UI stops spinning; `0` disables. |
| `GLASSRAY_CLASSIFY_DEBOUNCE_MS`        | `5000`                                                   | Debounce (ms) between the last ingest and the background classify sweep, so a burst of traces triggers one sweep rather than one per POST.  |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | —                                                        | Required by the matching metered provider.                                                                                                  |
| `GLASSRAY_NO_UPDATE_CHECK`             | —                                                        | Disable the npm update check entirely (also honors `NO_UPDATE_NOTIFIER` and `CI`).                                                          |

### Update check

Human-facing commands (the landing screen, `start`, `status`, `init`) print a one-line notice when a newer
`@glassray/coach` is known — a detached background child refreshes a local cache under `$GLASSRAY_HOME` from
registry.npmjs.org at most once every 24 hours (3s timeout, silent; a non-TTY stdout also skips it), and `glassray doctor` performs the one live, awaited check.
Opt out with `GLASSRAY_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER`, or `CI`. The only data transmitted is the package name in a single HTTPS GET — never from the server or the data commands, so trace data stays zero-egress.

## Data directory

Everything lives under `$GLASSRAY_HOME` (default `~/.glassray`):
- `data/db/` — the PGlite database (with the `vector` extension loaded).
- `local-api-key` — the ingest bearer key (`glsk_local_` + 48 hex), generated once, `chmod 0600`.

The schema is bootstrapped at server start with idempotent `CREATE TABLE IF NOT EXISTS` SQL (`server/bootstrap.ts`) — there are no migration files.

## HTTP surface

Ingest is `POST /v1/traces` (alias `POST /api/public/otel/v1/traces`) — OTLP/JSON, bearer-authed with the local
key. Everything else is unauthenticated **by design**: the server binds `127.0.0.1` only, and every route
enforces a loopback Host/Origin guard (403 otherwise) as a DNS-rebinding defense — do not port-forward it to untrusted networks. Full HTTP API reference: [docs/http-api.md](./docs/http-api.md).

## Development

```sh
npm run dev         # tsx watch server/index.ts (API on :5899)
npm run dev:ui      # Vite dev server for web/ — proxies /api + /v1 to :5899
npm start           # run the server once (tsx server/index.ts) — what `glassray start` wraps
npm run typecheck   # tsc --noEmit
npm test            # vitest (hermetic: temp GLASSRAY_HOME, ephemeral port)
npm run test:egress # airgap proof: boot on mock, ingest + discover + flows, assert zero non-loopback sockets
npm run build:ui    # vite build web -> web/dist (served statically by the server)
```

Layout:
- `server/app.ts` — the Fastify app + run queue, booted by `index.ts` + `bootstrap.ts`; `ingest.ts` / `tail.ts` / `security.ts` — OTLP ingest/upsert, the SSE hub, loopback + bearer guards.
- `server/llm.ts` — the multi-provider LLM core + free-text span replay (`generateText`).
- `server/classify.ts` / `flows.ts` — flow selector schema + inline/background classification; flow CRUD, audit, and the discover bootstrap.
- `server/discovery.ts` / `evals.ts` / `improver.ts` — spec-free deviation discovery, the flow-scoped autorun evals, the fix generator; `settings.ts` / `schema.ts` — persisted dashboard settings, the Drizzle schema.
- `server/vendor/` — trace analysis vendored from the main app (`buildTraceView(envelope, traceId)`: OTLP normalizer + span-tree + attribute ladders); each file names its source path — **refresh by re-copying**, never depend on it.
- `web/` — the Vite React SPA (nav: Overview / Traces / Deviations / Evals / Flows, plus Settings), dependency-free CSS charts (`components/charts.tsx`), tail-driven refresh (`useTailRefresh.ts`).
- `skills/glassray/SKILL.md` — the agent skill `glassray init` installs (shipped in the npm package); `bin/glassray.mjs` — the zero-dependency CLI; `test/egress-proof.mjs` — the airgap proof (socket-layer preload).

**Prompt lineage.** The discovery judge + grouping prompts are lifted spec-free from the platform worker's
`apps/worker/src/routes/deviations.ts` (minus the Intent-Spec machinery); the fix prompt (`improver.ts`) is a spec-free
port of the platform's Improver (`apps/worker/src/improver`) — the same paste-into-Claude-Code markdown contract, adapted to work from traces alone. The single-rule eval judge, the flow-clustering (discover) prompt, and the flow-classification prompt are Coach-original.

## Publishing

Published to npm as **[`@glassray/coach`](https://www.npmjs.com/package/@glassray/coach)** (scoped, made
public via `publishConfig.access: public`) with a `glassray` bin. To cut a release:

```sh
cd coach
npm login          # as a member of the @glassray org
npm version patch
npm publish        # runs `prepack` (builds web/dist), packs, publishes public
```

`prepack` builds the SPA into `web/dist`; the `files` whitelist then ships `bin/`, the runtime `server/*.ts`
(tests excluded via `!server/**/*.test.ts`), `skills/`, `web/dist/`, `examples/`, `README.md`, and `LICENSE` — verify with `npm pack --dry-run`.
The server runs the TypeScript directly via `tsx` (a runtime **dependency**, not dev), so there is no compile step. Smoke-test a release in a clean directory: `npx @glassray/coach@latest start`.
