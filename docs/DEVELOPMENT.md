# Developing Glassray Coach

Contributor reference: running from a clone, configuration, layout, and publishing. The user-facing docs live at
[glassray.ai/docs/coach](https://glassray.ai/docs/coach/overview); the HTTP routes in [http-api.md](./http-api.md).

This repo is a plain npm project (use `npm`, not `pnpm`); it is also consumed by the Glassray monorepo as a git
submodule, so keep it free of external workspace dependencies.

## Commands

```sh
npm run dev         # tsx watch server/index.ts (API on :5899)
npm run dev:ui      # Vite dev server for web/ — proxies /api + /v1 to :5899
npm start           # run the server once (tsx server/index.ts) — what `glassray-coach start` wraps
npm run typecheck   # tsc --noEmit (server + web)
npm test            # vitest (hermetic: temp GLASSRAY_HOME, ephemeral port)
npm run test:egress # airgap proof: boot on mock, ingest + discover + flows, assert zero non-loopback sockets
npm run build:ui    # vite build web -> web/dist (served statically by the server)
```

## Environment variables

Everything has a working default — a fresh checkout runs with none of these set. The CLI's `--port` / `--data-dir`
flags set `GLASSRAY_PORT` / `GLASSRAY_HOME` for you; set the vars directly when running `npm run dev` / `npm start`.

| Variable                               | Default                                                  | What it does                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLASSRAY_HOME`                        | `~/.glassray`                                            | Data directory (DB + local API key).                                                                                                        |
| `GLASSRAY_PORT` (or `PORT`)            | `5899`                                                   | Port the server binds on `127.0.0.1`.                                                                                                       |
| `GLASSRAY_LLM_PROVIDER`                | `claude-subscription` if `~/.claude` exists, else `mock` | Analysis backend (see the README's provider table).                                                                                         |
| `GLASSRAY_HEAVY_MODEL_ID`              | `claude-opus-4-8` (`gpt-4o` on openai)                   | Heavy-tier model id — applies to **every** provider.                                                                                        |
| `GLASSRAY_LIGHT_MODEL_ID`              | `claude-sonnet-4-6` (`gpt-4o-mini` on openai)            | Light-tier model id — applies to **every** provider.                                                                                        |
| `GLASSRAY_LLM_BUDGET_USD`              | `50`                                                     | Metered spend cap; `0` = unlimited.                                                                                                         |
| `GLASSRAY_RUN_TIMEOUT_MS`              | `600000`                                                 | Backstop timeout (ms) for a background run — a stalled run is marked errored so the queue advances and the UI stops spinning; `0` disables. |
| `GLASSRAY_CLASSIFY_DEBOUNCE_MS`        | `5000`                                                   | Debounce (ms) between the last ingest and the background classify sweep, so a burst of traces triggers one sweep rather than one per POST.  |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | —                                                        | Required by the matching metered provider.                                                                                                  |
| `GLASSRAY_NO_UPDATE_CHECK`             | —                                                        | Disable the npm update check entirely (also honors `NO_UPDATE_NOTIFIER` and `CI`).                                                          |

Dashboard **Settings** persist provider / model ids / budget to `$GLASSRAY_HOME/settings.json` (`chmod 0600`;
API keys stay in the env) and override the environment. Every metered analysis call is checked against the
budget; at the cap, new runs stop with a clear error until you raise it or `POST /api/usage/reset`. The free
`mock` / `claude-subscription` paths accrue `$0` and are never blocked. Every network SDK is dynamically imported
inside its own provider branch — the `mock` path pulls in nothing beyond zod and node builtins (airgap-safe).

### Update check

Human-facing CLI commands (the landing screen, `start`, `status`, `init`) print a one-line notice when a newer
`@glassray/coach` is known — a detached background child refreshes a cache under `$GLASSRAY_HOME` from
registry.npmjs.org at most once every 24 hours (3s timeout, silent on failure; skipped for non-TTY stdout), and
`glassray-coach doctor` performs the one live, awaited check. Opt-outs: `GLASSRAY_NO_UPDATE_CHECK=1`,
`NO_UPDATE_NOTIFIER`, `CI`. The only data transmitted is the package name in a single HTTPS GET — never from the
server or the data commands, so trace data stays zero-egress.

## Data directory

Everything lives under `$GLASSRAY_HOME` (default `~/.glassray`):

- `data/db/` — the PGlite database (with the `vector` extension loaded).
- `local-api-key` — the ingest bearer key (`glsk_local_` + 48 hex), generated once, `chmod 0600`.
- `update-check.json` — the update-check cache.

The schema is bootstrapped at server start with idempotent `CREATE TABLE IF NOT EXISTS` SQL
(`server/bootstrap.ts`) — there are no migration files; upgrades are guarded one-time backfills in the same file.

## Layout

- `server/app.ts` — the Fastify app + run queue, booted by `index.ts` + `bootstrap.ts`; `ingest.ts` / `tail.ts` / `security.ts` — OTLP ingest/upsert, the SSE hub, loopback + bearer guards.
- `server/llm.ts` — the multi-provider LLM core + free-text span replay (`generateText`).
- `server/classify.ts` / `flows.ts` — flow selector schema + inline/background classification; flow CRUD and audit; `code-explore.ts` — code-based flow discovery (a read-only Read/Grep/Glob agent over `codeRoot`, reconciled into flows + code-anchored rules).
- `server/discovery.ts` / `evals.ts` / `improver.ts` — deviation discovery, the flow-scoped assertion rules (every rule active — autoruns + gates `glassray-coach check`; provenance `source: code | promoted` + `anchors`), the fix generator; `settings.ts` / `schema.ts` — persisted dashboard settings, the Drizzle schema.
- `server/artifact.ts` / `compare.ts` — the portable rule artifact (`glassray.yaml` export + terraform-style import) and the two-corpus compare run; `experiments.ts` — the durable experiment record + generated report over a compare; `pricing.ts` carries the model price book behind "cost if metered".
- `server/vendor/` — trace analysis (`buildTraceView`: OTLP normalizer + span-tree + attribute ladders) vendored from hosted Glassray — **refresh by re-copying**, never depend on it.
- `web/` — the Vite React SPA (nav: Overview / Flows / Rules / Experiments / Deviations / Traces, plus Settings), dependency-free CSS charts (`components/charts.tsx`), tail-driven refresh (`useTailRefresh.ts`).
- `skills/glassray/SKILL.md` — the agent skill `glassray-coach init` installs (shipped in the npm package); `bin/` — the zero-dependency CLI (`glassray.mjs` dispatch, `commands.mjs` data commands, `ui.mjs` + `landing.mjs` branding); `test/egress-proof.mjs` — the airgap proof (socket-layer preload).

The discovery and fix prompts are ports of hosted Glassray's evaluators, adapted to work from traces alone; the
eval judge and the flow prompts are Coach-original.

## Publishing

Published to npm as **[`@glassray/coach`](https://www.npmjs.com/package/@glassray/coach)** (scoped, made public
via `publishConfig.access: public`) with a `glassray-coach` bin. Releases are **automated**: a maintainer runs
`npm run release` (release-it) locally to gate/bump/tag/push + open the GitHub release, and the pushed `v*` tag
triggers `.github/workflows/release.yml`, which re-runs the gates and does the `npm publish` via **npm trusted
publishing (OIDC)** — no npm token anywhere, with a provenance attestation. The full runbook and one-time
trusted-publisher setup are in **[`RELEASING.md`](../RELEASING.md)**:

```sh
npm run release:dry   # rehearsal — changes nothing
npm run release       # gates, bump, tag, push, GitHub release; CI publishes
```

`prepack` builds the SPA into `web/dist`; the `files` whitelist then ships `bin/`, the runtime `server/*.ts`
(tests excluded via `!server/**/*.test.ts`), `skills/`, `web/dist/`, `examples/`, `README.md`, and `LICENSE` —
verify with `npm pack --dry-run`. The server runs the TypeScript directly via `tsx` (a runtime **dependency**,
not dev), so there is no compile step. Smoke-test a release in a clean directory: `npx @glassray/coach@latest start`.
