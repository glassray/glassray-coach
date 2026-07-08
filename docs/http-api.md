# Glassray Coach HTTP API

The full HTTP surface of the single Coach process (`http://127.0.0.1:<port>`, default
`5899`). Only the two ingest routes take auth — the local bearer key
(`$GLASSRAY_HOME/local-api-key`); every other route is unauthenticated **by design**:
the server binds `127.0.0.1` only, and every route enforces a loopback Host/Origin
guard (403 otherwise) as a DNS-rebinding defense — do not port-forward it to
untrusted networks. Long-running verbs reply `202 { runId, status }` and queue a
background run (a FIFO — one run executes at a time) — poll `GET /api/runs/:id`.
Back to the [README](../README.md).

## Ingest

| Route                             | Auth       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `POST /v1/traces`                 | Bearer key | OTLP/JSON envelope (`{ resourceSpans: [...] }`), 16 MiB cap, `application/json` — **`content-encoding: gzip`/`deflate`/`br` accepted** (the `@glassray/tracing` SDK gzips payloads ≥ 8 KiB). Spans are **merged into the stored trace by spanId** — a standard OTLP batch exporter that flushes one trace across several POSTs accumulates (incoming spans replace same-id stored spans, new ones append, and stored spans absent from the incoming batch are carried over), so a trace stays whole; the whole-trace-per-POST SDK path is unaffected (same spanIds ⇒ replacement). One malformed trace in a batch is skipped and logged (the batch's other traces still land); a wholly-malformed batch returns `400`; a datastore failure returns `503`. Replies `{}`. |
| `POST /api/public/otel/v1/traces` | Bearer key | Alias of the above (matches the Helix cloud ingest path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/info`                   | —          | `{ name, version, ingestEndpoint, apiKey }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Traces

| Route                                              | Description                                                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/traces?limit&offset&q&agent&status&flow` | `{ items, total }`, newest-first (offset paginated). `q` = case-insensitive substring on name/agent, `agent` = exact match, `status` = `error`\|`ok`, `flow` = only that flow's member traces.    |
| `GET /api/traces/:id`                              | `{ id, view }` — recomputed from the stored raw envelope on every read.                                                                                                                           |
| `GET /api/tail`                                    | SSE feed: `data: {"id":"<traceId>"}` per ingested trace, heartbeat every 25s.                                                                                                                     |
| `GET /api/stats`                                   | Totals (traces, tokens, errors, avg/p95 latency, est. cost) + a per-agent breakdown + the known-agents list — powers the Overview KPIs and the CLI's `stats`.                                     |
| `GET /api/timeline`                                | `{ points: [{ t, traces, errors }], from, to }` — trace volume + errors bucketed into a fixed-width activity series (≥1-minute buckets) ending at the latest trace (the Overview activity chart). |

## Runs & queue

| Route                       | Description                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `GET /api/runs?limit`       | `{ items }` — recent runs of every kind (discovery / flows / eval / improver / classify), newest first (default 20, max 200).                                                                                                                                                                                                                                                                      |
| `GET /api/runs/:id`         | `{ id, kind, status, error, stats, startedAt, finishedAt }`. Status lifecycle: `queued → running → done`\|`error`. While a **discovery or eval** run is `running`, its `stats` carries live progress `{ scanned, total }` (other kinds don't publish progress; terminal stats replace it on finish, and an eval run's terminal stats record `judgeModel`).                                         |
| `POST /api/runs/:id/cancel` | Cancels a **queued or active** run — a queued run is dropped from the FIFO, an active run's provider call is aborted (`409` if the run is neither).                                                                                                                                                                                                                                                |

## Flows

A flow's deterministic `selector` matches on agent / name / intent / status / pinned
trace ids, AND-combined; its plain-language `rule` is classified by the debounced
background sweep on the light tier — idempotent via a `classified_at` watermark and
budget-guarded.

| Route                      | Description                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `POST /api/flows/run`      | The **discover bootstrap** → `202 { runId, status }`: clusters the newest traces (≤ 200, heavy tier) into new rule-defined (`classify: 'llm'`) flows, name-deduped against the active set — it only ever adds.             |
| `GET /api/flows?status`    | `{ items, unclassified }` — flows with parsed selectors + live member counts (`status` = `active` (default)\|`archived`\|`all`); `unclassified` = traces still awaiting the classify sweep.                                |
| `POST /api/flows`          | `{ name, description?, selector?, rule?, classify?, createdBy? }` → `201 { id, memberCount, llmBackfill }`. Needs a selector, a rule, or both; `classify: 'llm'` needs a rule. A new rule-defined flow re-opens the newest ~100 traces for the sweep (`llmBackfill`). |
| `GET /api/flows/:id`       | The definition + its newest members (≤ 100, with `assignedBy`/`confidence`) + the evals scoped to it.                                                                                                                      |
| `PATCH /api/flows/:id`     | Partial update (`name`/`description`/`selector`/`rule`/`classify`/`status: active\|archived`) → the updated detail. A changed selector re-materializes memberships; a new/changed llm rule triggers the bounded backfill.  |
| `DELETE /api/flows/:id`    | Hard delete — memberships go with it; attached evals detach (become global).                                                                                                                                               |
| `GET /api/flows/:id/audit` | Classification-quality view: a newest-members sample, the low-confidence LLM assignments, and `counts { members, lowConfidence, unclassifiedStoreWide }`.                                                                  |

## Deviations & fixes

| Route                                          | Description                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `POST /api/discovery/run`                      | `{ sampleSize?, flowId? }` → `202 { runId, status: queued\|running }`. Runs **queue** — never `409`-busy; a duplicate request returns the run already queued/active for the same scope. A `flowId` scopes the sample to that flow's members (`404` if unknown). |
| `GET /api/deviations` · `/api/deviations/:id`  | Recurring deviation types + their per-trace examples (label, severity, evidence, trace link). Each carries a `status` (`open`\|`resolved`); the list adds `hasFix`, the detail adds the generated `fixMarkdown` (+ `fixModel`, `fixGeneratedAt`). |
| `POST /api/deviations/:id/fix`                 | Generate a fix for the deviation → `202 { runId, status }` (queued; `404` if the deviation is unknown). The finished run stores `fixMarkdown` on the deviation row.                                                                               |
| `POST /api/deviations/:id/resolve` · `/reopen` | Flip the deviation's `status` between `resolved` and `open`.                                                                                                                                                                                      |

## Evals

| Route                     | Description                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `GET /api/evals` · `/api/evals/:id` | Saved rules with their latest pass/fail rollup + regression count; the detail adds the per-trace verdicts (regressions first) and the run history.                                                                                                                                                                                   |
| `POST /api/evals`         | `{ deviationId, flowId? }` (save a deviation — idempotent) or `{ label, rule, description?, flowId?, autorun?, autorunThreshold? }` (hand-written) → `201 { id }`. A `flowId` scopes runs to that flow's members; `autorun` (default on) reruns the eval once the flow accrues `autorunThreshold` (default 10) new members since its last run. |
| `PATCH /api/evals/:id`    | `{ flowId?, autorun?, autorunThreshold? }` → the updated detail (`flowId: null` detaches the eval — the rule itself is immutable).                                                                                                                                                                                                             |
| `POST /api/evals/:id/run` | `{ sampleSize?, model? }` → `202 { runId, status }` (queued). Sample size: explicit override > the flow selector's `limit` > 20; `model` overrides the judge for this run (recorded in the run's `stats.judgeModel`).                                                                                                                          |
| `DELETE /api/evals/:id`   | Remove an eval and its stored verdicts.                                                                                                                                                                                                                                                                                                        |

## Settings, LLM & usage

| Route                                       | Description                                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `GET /api/llm`                              | `{ provider, ready, reason }` — what discovery/flows will use.                                                                                                                        |
| `POST /api/replay`                          | `{ prompt, system?, model?, temperature? }` → `{ output, provider, model }` — re-issue an edited LLM call as free text (`402` if the spend cap is reached, `502` if the provider is unreachable). |
| `GET /api/usage`                            | Coach's own LLM spend vs the budget, broken down by model + kind.                                                                                                                     |
| `POST /api/usage/reset`                     | Clear the usage ledger.                                                                                                                                                               |
| `GET /api/settings` · `PATCH /api/settings` | Read / update the persisted dashboard settings (LLM provider, heavy/light model ids, budget). Saved to `$GLASSRAY_HOME/settings.json` (`chmod 0600`); API keys are never stored here. |

## Static

| Route    | Description                                                                            |
| -------- | ---------------------------------------------------------------------------------------|
| `GET /*` | The built SPA (`web/dist`) with SPA fallback; a plain-text hint if the UI isn't built. |
