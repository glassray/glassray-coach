---
name: glassray
description: "Drive Glassray Coach — the local AI-agent trace debugger — from the CLI: inspect captured traces, define durable flows that scope your agent's behaviours, derive evals from the agent's own rules in code, and run the discover → fix → verify loop. Use when working on an AI agent that sends traces to a local Coach (glassray) server, or when asked about the agent's quality, failures, evals, or flows."
license: MIT
compatibility: "Requires the @glassray/coach CLI and a running local Coach server (npx @glassray/coach start)"
metadata:
  author: glassray
  homepage: "https://glassray.ai/docs/coach/cli"
---

# Glassray Coach

You drive a local Glassray Coach server through the `glassray` CLI. Output contract:
stdout is the API's JSON verbatim, errors go to stderr; exit 0 = ok, 1 = API error,
2 = no server running. Long verbs (`discovery run`, `fix`, `evals run`,
`flows discover`) block and poll their run to completion — pass `--no-wait` only when
you intend to poll `glassray runs get <runId>` yourself. Every command takes
`--port <n>` if Coach isn't on the default 5899.

## 1 · Connect

Run `glassray status` and read its output — it prints whether a server answers on
the port (the command itself always exits 0). Any data command (e.g. `glassray stats`)
exits 2 when no server is up. If there is no server, ask the user to run
`npx @glassray/coach start` in their own terminal — **never start it yourself**: the server
owns the terminal and the data directory. Do not run `glassray start` or
`glassray reset`.

## 2 · Inventory first — durable state IS the memory

Before creating anything:

```sh
glassray flows list
glassray evals list
```

Flows and evals persist across sessions — they are the cross-session memory of this
agent's behaviours and rules. **Never re-create a flow or eval that already exists**;
extend or tighten it instead. If a listed flow covers the behaviour you were about to
define, you are resuming a previous session's work, not starting over.

## 3 · Set up flows — one per behaviour

A flow is a durable, named agent behaviour with a membership definition: a
deterministic `selector` and/or a plain-language `rule` a background LLM sweep
classifies against. Find the agent's distinct behaviours, then scope each one:

- Read the agent's code — its tools, routes, intents, prompt branches.
- `glassray stats` — the agent names seen in traffic.
- `glassray traces list --limit 20` — what the traffic actually looks like.

Create one flow per behaviour with the **tightest selector that scopes it**:

```sh
glassray flows create --name "Smalltalk" \
  --description "Greeting and chit-chat turns" \
  --selector '{"agent":"support-bot","nameContains":"smalltalk","limit":20}'
```

Selector fields (JSON, AND-combined): `agent` (exact), `nameContains`
(case-insensitive substring on the root trace name), `q` (substring on the input
preview — the user's intent), `status` (`ok`|`error`), `traceIds` (explicit 32-hex
pins — always members), `limit` (how many newest members an eval run samples,
default 20). An empty selector matches every trace. Selectors are free and instant —
matched inline at every ingest.

Use a plain-language `--rule` (with `--classify llm`) **only when no selector
discriminates** — e.g. "the user is asking about order status" when names and agents
don't encode it. Rule flows cost light-tier LLM calls in the background sweep, and a
new or changed rule only backfills over the newest ~100 traces.

`glassray flows discover` bootstraps candidate flows by clustering existing traffic —
it only **adds** new, name-deduped, rule-defined flows. Review each candidate and
tighten it into a selector when one exists:

```sh
glassray flows update <id> --selector '{"agent":"support-bot","q":"refund"}' --classify selector
```

## 4 · Derive evals from the code — the agent's own rules

Read the agent's system prompts, guardrails, policy docs, and tool descriptions for
behavioural rules — "never mention competitors", "always answer in first person",
"escalate refunds over $100". Each one becomes a flow-scoped eval; run it once to
baseline:

```sh
glassray evals create --label "No competitor mentions" \
  --rule "The reply must never name or recommend a competitor product." \
  --flow <flowId>
glassray evals run <evalId>
```

A flow-scoped eval samples the flow's newest members (capped by the flow selector's
`limit`, default 20; `--sample` overrides per run). Autorun is on by default: once the
flow accrues ≥ 10 new member traces since the eval's last run (`--autorun-threshold`
tunes it), the server queues a rerun by itself — you don't have to remember.

## 5 · The improvement loop

```sh
glassray discovery run [--flow <flowId>]   # LLM judge finds recurring deviations
glassray deviations list                   # the newest discovery run's findings
glassray deviations get <id>               # rule, severity, per-trace evidence
glassray fix <id>                          # generates fixMarkdown, prints the deviation
```

The `fixMarkdown` is a set of instructions **addressed to you**: execute its repo
search plan (the grep commands), open the likely files, and apply the ordered edits
across prompt / tools / guardrails / code.

Then verify:

1. Have the user (or a test script) generate fresh traffic against the fixed agent.
2. Watch it land: `glassray traces tail` (NDJSON, one line per ingested trace).
3. Evals rerun automatically once enough new members accrue — or force it with
   `glassray evals run <evalId>`. The printed detail has the verdicts.
4. Green (`failed: 0`, `regressionCount: 0`) → `glassray deviations resolve <id>`.
   Reopen with `--reopen` if it recurs.

Optionally lock a deviation in directly: `glassray evals create --deviation <id>
[--flow <flowId>]` freezes its rule as a repeatable check (idempotent — re-saving the
same deviation returns the existing eval).

## 6 · Self-correct

Your flows and evals are hypotheses — audit them periodically:

```sh
glassray flows audit <id>
```

- `sample` contains traces that don't belong → the selector/rule is too loose;
  tighten it with `glassray flows update` and re-check.
- `counts.lowConfidence` piling up → the rule is ambiguous to the classifier;
  sharpen the wording or replace it with a selector.
- `counts.unclassifiedStoreWide` growing → the background sweep is behind (or the
  server was down); it self-heals on the next ingest or restart.

If your own eval rule proves too vague (verdicts flip-flop between runs on unchanged
behaviour), rewrite it: the rule itself is immutable, so `glassray evals delete <id>`
and re-create with sharper wording. `glassray evals update` only moves the flow
binding and autorun tuning.

## 7 · Reference

Management — for the user, mostly:

| Command | Notes |
| --- | --- |
| `glassray status` / `glassray doctor` | Is a server up; environment checks. |
| `glassray init [--force]` | Install this skill into `./.agents/skills/` + `./.claude/skills/`. |
| `glassray start` / `glassray reset` | The user runs these — never you. |

Data + runs (all print the API JSON; long verbs take `--no-wait --timeout`):

| Command | Notes |
| --- | --- |
| `glassray traces list [--q --agent --status --flow --limit --offset]` | `{ items, total }`, newest first. |
| `glassray traces get <id>` | Full span-tree view of one trace. |
| `glassray traces tail` | NDJSON stream of traces as they land. |
| `glassray stats` / `glassray usage` | Traffic rollups + agent names; Coach's own LLM spend. |
| `glassray flows list [--status active\|archived\|all]` | `{ items, unclassified }`. |
| `glassray flows get <id>` | Definition + newest members + attached evals. |
| `glassray flows create --name [--description --rule --classify --selector '<json>' --created-by]` | → `{ id, memberCount, llmBackfill }`. |
| `glassray flows update <id> [--name --description --rule\|--no-rule --classify --selector '<json>'\|--no-selector --status]` | Changed selector re-materializes members; new/changed llm rule backfills ~100 newest. |
| `glassray flows delete <id>` | Memberships go; attached evals become global. |
| `glassray flows audit <id>` | Member sample + low-confidence assignments + counts. |
| `glassray flows discover [--no-wait --timeout]` | Cluster traffic into NEW rule-defined flows. |
| `glassray evals list` / `glassray evals get <id>` | Rollups; detail adds verdicts + history. |
| `glassray evals create --deviation <id> [--flow]` | Freeze a deviation's rule (idempotent). |
| `glassray evals create --label --rule [--description --flow --no-autorun --autorun-threshold]` | Hand-written, optionally flow-scoped. |
| `glassray evals update <id> [--flow\|--no-flow --autorun\|--no-autorun --autorun-threshold]` | Binding + autorun only — the rule is immutable. |
| `glassray evals run <id> [--sample --model --no-wait --timeout]` | Prints the eval detail (verdicts) after the run. |
| `glassray evals delete <id>` | Removes its stored verdicts too. |
| `glassray deviations list` / `glassray deviations get <id>` | Newest discovery run's set; detail carries `fixMarkdown`. |
| `glassray deviations resolve <id> [--reopen]` | Flip open ↔ resolved. |
| `glassray discovery run [--sample --flow --no-wait --timeout]` | Find deviations, optionally flow-scoped. |
| `glassray fix <deviationId> [--no-wait --timeout]` | Generate the fix; prints the deviation with `fixMarkdown` after. |
| `glassray runs list [--limit]` / `runs get <id>` / `runs cancel <id>` | Queue visibility; cancel queued or active runs. |

Key JSON fields to read:

- Run-starting commands return `202 { runId, status: "queued"|"running" }` — never
  409-busy; a duplicate request for the same work returns the run already in flight.
  `runs get <id>`: `status` is `queued → running → done|error`; while a discovery or
  eval run is running, its `stats` carries live `{ scanned, total }` progress (other
  kinds don't publish progress); a finished eval run's `stats` records `judgeModel`.
- `evals get <id>`: `passed` / `failed` / `regressionCount`, `results[]` sorted
  regressions → failures → passes, each `{ traceId, verdict, evidence, regression }`;
  `history[]` oldest → newest `{ runId, at, passed, failed, total }` — the trend.
- `flows list`: `unclassified` = traces still awaiting the background sweep.
- `flows audit <id>`: `counts.{members, lowConfidence, unclassifiedStoreWide}`.

Model-switch recipe: when the user switches their agent's underlying model, change
nothing in Coach — the new traffic classifies into the same flows, and autorun reruns
each flow's evals once enough new members accrue. Compare pass rates and
`regressionCount` across runs in the eval's `history`; to keep the judging constant
across the comparison, pin the judge with `glassray evals run <id> --model <id>` (each
run's `stats.judgeModel` records what scored it).
