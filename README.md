# Glassray Coach

A fully self-contained **local** AI-agent debugger. One process, one embedded
database, zero cloud: point any OTLP-speaking agent at it, watch traces land live,
then run **deviation discovery** and **flow** analysis over them on your own machine.

- **Ingest** — OTLP/JSON over HTTP at `POST /v1/traces` (alias:
  `POST /api/public/otel/v1/traces`), bearer-authed with a locally generated key.
- **Overview** — a live dashboard landing: a trace-volume-over-time chart (error share
  highlighted), headline KPIs (traces / error rate / tokens / est. cost / p95 latency), a
  deviation-severity distribution, an eval health rollup, recent traces, and an **LLM
  usage** meter (Coach's own metered spend vs. the budget, per model) — all
  auto-refreshing on the tail feed.
- **View** — a Vite React SPA (in `web/`) served by the same Fastify process, with a
  live `/api/tail` SSE feed and a full span-tree waterfall + inspector. The sidebar nav
  is **Overview · Traces · Deviations · Evals**; **Flows** lives as a card at the bottom
  of the Overview (still reachable at `#/flows`).
- **Discover** — an LLM judge finds where each agent run went wrong, then clusters the
  findings into recurring **deviation types** (each with a plain-language rule).
  Discovery, eval, and flow runs show **live progress** and can be **cancelled**
  mid-flight; a run that finds no deviations reports that honestly.
- **Evals** — turn any deviation, a hand-written rule, or a single trace (a **Save as
  eval** button on the trace detail, pre-filled from that trace) into a **repeatable**
  pass/fail check; re-run it over new traces and watch for **regressions** (a trace that
  passed last run and now fails).
- **Flows** — groups your traces into the recurring **workflows** your agents run.
- **Replay** — open any **LLM span** in the viewer, edit its model / system / prompt /
  temperature, and re-issue it through the same local LLM core — the fresh completion
  lands beside the original. The viewer becomes a debugger.
- **Store** — [PGlite](https://pglite.dev) (embedded Postgres + pgvector) via Drizzle.

Same warm-paper design language as the hosted Glassray dashboard. Coach is the
local, try-before-cloud edition — the analysis runs against your `~/.claude`
subscription (zero-config, no API key) or a metered key, or a deterministic `mock`
provider that makes the whole tool **fully airgap-safe**.

> Coach is a standalone npm project. It is deliberately **not** part of the repo's
> pnpm workspace — use `npm` here, not `pnpm`. It has zero `@helix/*` dependencies;
> code it shares with the main app is vendored in (`server/vendor/`) and refreshed by
> re-copying, so this folder lifts into its own public repo unchanged.

## Quickstart

Requires **Node 20.6+** (`node --version`; `glassray doctor` checks this,
the port, and data-dir writability for you). Uses `npm`, not `pnpm` (see the note
below).

```sh
cd coach
npm install
npm run build:ui        # build the SPA (optional for API-only use)
node bin/glassray.mjs   # = "glassray start"
```

`start` boots the server on `http://127.0.0.1:5899/`, prints the dashboard URL, the
ingest endpoint, your local API key, and a copy-paste OTLP exporter block:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:5899"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer glsk_local_..."
```

Then open **Deviations** and click **Run discovery**, or **Flows** → **Run flows**. Save a
deviation as an **eval**, **Save as eval** straight from a trace's detail view, or write
one under **Evals** — then re-check it against new traces.

No agent handy? `node examples/send-otlp.mjs` sends a realistic sample trace, or reach
for the fuller [`examples/support-bot/`](./examples/support-bot/) — an instrumented
simulated agent with planted recurring failure modes plus a step-by-step walkthrough (see
[`examples/support-bot/README.md`](./examples/support-bot/README.md)). See
[`examples/`](./examples/) for both. To instrument a real agent, use the
[`@glassray/tracing`](https://github.com/glassray/glassray-tracing-js) SDK (point it at
Coach with `GLASSRAY_ENDPOINT`) or any OTLP/HTTP exporter — the dashboard's empty state
has copy-paste recipes for each.

### CLI

| Command | What it does |
| --- | --- |
| `glassray start` | Start server + dashboard (default command). Flags: `--port` (default 5899), `--data-dir`, `--no-open`. |
| `glassray mcp` | Run a stdio MCP server for coding agents, proxying a **running** coach over loopback. Honours `--port`. See below. |
| `glassray reset --yes` | Wipe the data directory (asks for confirmation without `--yes`). |
| `glassray status` | Show the data dir and probe whether a coach answers on the port. |
| `glassray doctor` | Check Node version, port availability, and data-dir writability, with one-line fixes. Creates the data dir if missing (then cleans it up). |

### Use it from your coding agent (MCP)

With a coach already running, register it as an MCP server so Claude Code / Cursor
can debug your agent against the real captured traces:

```sh
claude mcp add glassray -- node <path-to>/coach/bin/glassray.mjs mcp
```

The MCP server proxies the running coach over loopback (it never opens the
database itself), exposing read tools (`list_traces`, `get_trace`, `get_stats`,
`list_deviations`, `get_deviation`, `list_flows`, `list_evals`, `get_eval`,
`get_usage`) and action tools (`run_discovery`, `run_flows`, `save_eval`,
`run_eval`).

## The LLM provider

Discovery and flows need a model. The provider is chosen by `GLASSRAY_LLM_PROVIDER`:

| Provider | Needs | Notes |
| --- | --- | --- |
| `claude-subscription` | a local `~/.claude` (Claude Code) | **Default when `~/.claude` exists.** Zero-config, no API key — dynamic-imports the Agent SDK. |
| `anthropic` | `ANTHROPIC_API_KEY` | Vercel AI SDK. Models via `GLASSRAY_HEAVY_MODEL_ID` / `GLASSRAY_LIGHT_MODEL_ID`. |
| `openai` | `OPENAI_API_KEY` | Vercel AI SDK (`gpt-4o` / `gpt-4o-mini`). |
| `mock` | nothing | **Default with no `~/.claude`.** Deterministic, network-free — the airgap/CI path. |

Every network SDK is dynamically imported inside its own branch, so the `mock` path
pulls in nothing beyond zod and node builtins.

### Spend cap

So a metered API key can't quietly drain your balance while you test, every analysis
call (discovery / eval / flows / replay) is metered and checked against a budget —
**`GLASSRAY_LLM_BUDGET_USD`, default `$50`**. Once the accrued metered spend reaches it,
new runs stop with a clear error until you raise the cap or reset. The free `mock` /
`claude-subscription` paths accrue `$0` and are never blocked. Set `GLASSRAY_LLM_BUDGET_USD=0`
for unlimited. The **Overview → LLM usage** card shows spend vs. budget and a per-model
breakdown (`GET /api/usage`; `POST /api/usage/reset` clears the ledger).

## Environment variables

Everything has a working default — a fresh checkout runs with none of these set.
The CLI's `--port` / `--data-dir` flags set `GLASSRAY_PORT` / `GLASSRAY_HOME` for
you; set them directly when running `npm run dev` / `npm start` outside the CLI.

| Variable | Default | What it does |
| --- | --- | --- |
| `GLASSRAY_HOME` | `~/.glassray` | Data directory (DB + local API key). |
| `GLASSRAY_PORT` (or `PORT`) | `5899` | Port the server binds on `127.0.0.1`. |
| `GLASSRAY_LLM_PROVIDER` | `claude-subscription` if `~/.claude` exists, else `mock` | Analysis backend (see above). |
| `GLASSRAY_HEAVY_MODEL_ID` | `claude-opus-4-8` (`gpt-4o` on openai) | Heavy-tier model id — applies to **every** provider. |
| `GLASSRAY_LIGHT_MODEL_ID` | `claude-sonnet-4-6` (`gpt-4o-mini` on openai) | Light-tier model id — applies to **every** provider. |
| `GLASSRAY_LLM_BUDGET_USD` | `50` | Metered spend cap; `0` = unlimited. |
| `GLASSRAY_RUN_TIMEOUT_MS` | `300000` | Backstop timeout (ms) for a background run — a stalled run is marked errored so the single-run lock frees and the UI stops spinning; `0` disables. |
| `ANTHROPIC_API_KEY` | — | Required by the `anthropic` provider. |
| `OPENAI_API_KEY` | — | Required by the `openai` provider. |

## Data directory

Everything lives under `$GLASSRAY_HOME` (default `~/.glassray`):

- `data/db/` — the PGlite database (with the `vector` extension loaded).
- `local-api-key` — the ingest bearer key (`glsk_local_` + 48 hex), generated once,
  `chmod 0600`.

The schema is bootstrapped at server start with idempotent `CREATE TABLE IF NOT
EXISTS` SQL (`server/bootstrap.ts`) — there are no migration files.

## HTTP surface

| Route | Auth | Description |
| --- | --- | --- |
| `POST /v1/traces` | Bearer key | OTLP/JSON envelope (`{ resourceSpans: [...] }`), 16 MiB cap, `application/json` — **`content-encoding: gzip`/`deflate`/`br` accepted** (the `@glassray/tracing` SDK gzips payloads ≥ 8 KiB). Spans are **merged into the stored trace by spanId** — a standard OTLP batch exporter that flushes one trace across several POSTs accumulates (incoming spans replace same-id stored spans, new ones append, and stored spans absent from the incoming batch are carried over), so a trace stays whole; the whole-trace-per-POST SDK path is unaffected (same spanIds ⇒ replacement). One malformed trace in a batch is skipped and logged (the batch's other traces still land); a wholly-malformed batch returns `400`; a datastore failure returns `503`. Replies `{}`. |
| `POST /api/public/otel/v1/traces` | Bearer key | Alias of the above (matches the Helix cloud ingest path). |
| `GET /api/info` | — | `{ name, version, ingestEndpoint, apiKey }`. |
| `GET /api/traces?limit&offset&q&agent&status` | — | `{ items, total }`, newest-first (offset paginated). `q` = case-insensitive substring on name/agent, `agent` = exact match, `status` = `error`\|`ok`. |
| `GET /api/stats` | — | Totals (traces, tokens, errors, avg/p95 latency, est. cost) + a per-agent breakdown + the known-agents list — powers the Overview KPIs and the MCP `get_stats` tool. |
| `GET /api/timeline` | — | `{ points: [{ t, traces, errors }], from, to }` — trace volume + errors bucketed into a fixed-width activity series (≥1-minute buckets) ending at the latest trace (the Overview activity chart). |
| `GET /api/traces/:id` | — | `{ id, view }` — recomputed from the stored raw envelope on every read. |
| `GET /api/tail` | — | SSE feed: `data: {"id":"<traceId>"}` per ingested trace, heartbeat every 25s. |
| `GET /api/llm` | — | `{ provider, ready, reason }` — what discovery/flows will use. |
| `POST /api/discovery/run` | — | `{ sampleSize? }` → `{ runId }` (`409` if a run is already in progress). |
| `POST /api/flows/run` | — | → `{ runId }` (same single-run lock). |
| `GET /api/runs/:id` | — | `{ id, kind, status, error, stats, startedAt, finishedAt }`. While a run is `running`, its `stats` carries live progress `{ scanned, total }` (terminal stats replace it on finish). |
| `POST /api/runs/:id/cancel` | — | Cancels the in-flight run (`409` if it isn't the active run). |
| `GET /api/deviations` · `/api/deviations/:id` | — | Recurring deviation types + their per-trace examples (label, severity, evidence, trace link). |
| `GET /api/flows` · `/api/flows/:id` | — | Discovered flows + their member traces. |
| `GET /api/evals` · `/api/evals/:id` | — | Saved rules with their latest pass/fail rollup + regression count; the detail adds the per-trace verdicts. |
| `POST /api/evals` | — | `{ deviationId }` (save a deviation) or `{ label, rule, description? }` (hand-written) → `{ id }`. |
| `POST /api/evals/:id/run` | — | `{ sampleSize? }` → `{ runId }` (same single-run lock). |
| `DELETE /api/evals/:id` | — | Remove an eval and its stored verdicts. |
| `POST /api/replay` | — | `{ prompt, system?, model?, temperature? }` → `{ output, provider, model }` — re-issue an edited LLM call as free text (`402` if the spend cap is reached, `502` if the provider is unreachable). |
| `GET /api/usage` | — | Coach's own LLM spend vs the budget, broken down by model + kind. |
| `POST /api/usage/reset` | — | Clear the usage ledger. |
| `GET /*` | — | The built SPA (`web/dist`) with SPA fallback; a plain-text hint if the UI isn't built. |

The read/analysis API is unauthenticated **by design**: the server binds `127.0.0.1`
only, and every route enforces a loopback Host/Origin guard (403 otherwise) as a
DNS-rebinding defense. Do not port-forward it to untrusted networks.

## Development

```sh
npm run dev        # tsx watch server/index.ts (API on :5899)
npm run dev:ui     # Vite dev server for web/ — proxies /api + /v1 to :5899
npm start          # run the server once (tsx server/index.ts) — what `glassray start` wraps
npm run typecheck  # tsc --noEmit
npm test           # vitest (hermetic: temp GLASSRAY_HOME, ephemeral port)
npm run test:egress # airgap proof: boot on mock, ingest + discover + flows, assert zero non-loopback sockets
npm run build:ui   # vite build web -> web/dist (served statically by the server)
```

Layout:

- `server/` — Fastify app (`app.ts`), boot (`index.ts`, `bootstrap.ts`), Drizzle
  schema (`schema.ts`), ingest/upsert (`ingest.ts`), SSE hub (`tail.ts`), loopback +
  bearer guards (`security.ts`), the multi-provider LLM core (`llm.ts`), the
  spec-free discovery + flow passes (`discovery.ts`, `flows.ts`), the repeatable
  rule-scoring evals (`evals.ts`), free-text span replay (`llm.ts` `generateText`),
  and the stdio MCP proxy (`mcp.ts`).
- `server/vendor/` — trace analysis vendored from the main app
  (`buildTraceView(envelope, traceId)`: OTLP normalizer + span-tree + attribute
  ladders). Each file names its source path; **refresh by re-copying from the main
  app** rather than depending on it.
- `web/` — the Vite React SPA (nav: Overview / Traces / Deviations / Evals; Flows is a
  card on the Overview, at `#/flows`), with dependency-free CSS charts
  (`components/charts.tsx`) and live tail-driven refresh (`useTailRefresh.ts`).
- `bin/glassray.mjs` — the zero-dependency CLI.
- `test/egress-proof.mjs` — the airgap proof (socket-layer preload).

**Prompts & platform lineage.** The discovery judge + grouping prompts are lifted
spec-free from the main platform worker's `apps/worker/src/routes/deviations.ts` (dropping
the Intent-Spec checklist/flow machinery). The single-rule eval judge and the
flow-grouping prompt are Coach-original.

## Publishing

Coach ships to npm as **`@glassray/coach`** (scoped, public) with a `glassray` bin — so
users run `npx @glassray/coach` (or `npm i -g @glassray/coach`, then `glassray start`).

```sh
cd coach
npm login              # as a member of the @glassray org
npm version patch      # bump the version
npm publish            # runs `prepack` (builds web/dist), packs, publishes public
```

- `prepack` builds the SPA into `web/dist`; the `files` whitelist then ships `bin/`, the
  runtime `server/*.ts` (tests excluded via `!server/**/*.test.ts`), `web/dist/`,
  `examples/`, `README.md`, and `LICENSE` — verify with `npm pack --dry-run`.
- `publishConfig.access: public` makes the scoped package public (scoped packages are
  private by default).
- The server runs the TypeScript directly via `tsx` (a runtime **dependency**, not dev),
  so there is no separate compile step. Smoke-test a release in a clean directory:
  `npx @glassray/coach@latest`.
