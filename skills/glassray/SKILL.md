---
name: glassray
description: "Drive Glassray Coach — the local AI-agent flow-improvement loop — from the CLI: derive a flow + assertion rules from the codebase, author glassray.yaml with a run recipe, pin inputs, then prove a change held with run/compare (pass rates + cost). Use when working on an AI agent that sends traces to a local Coach (glassray) server, when asked to set up glassray for a flow, or when asked about the agent's quality, failures, rules/evals, or a model swap."
license: MIT
compatibility: "Requires the @glassray/coach CLI and a running local Coach server (npx @glassray/coach start)"
metadata:
  author: glassray
  homepage: "https://glassray.ai/docs/coach/cli"
---

# Glassray Coach — the harness contract

You are the intelligence of this loop. Coach's server stays lean — it ingests
traces, scores rules, diffs corpora, and gates. **You** derive the flow and its
rules from the codebase, author `glassray.yaml`, write the runner, pin the
inputs, and drive the change-with-confidence loop:

```sh
glassray run <flow> --label baseline    # score the world before the change
# … make the change (e.g. swap Sonnet → Haiku) …
glassray run <flow> --label candidate
glassray compare <flow> baseline candidate   # pass-rate deltas + cost deltas
# commit glassray.yaml, git push — the git review of the file IS the approval
```

CLI output contract: stdout is the API's JSON verbatim, errors/status go to
stderr; exit 0 = ok, 1 = API error, 2 = no server. Every command takes
`--port <n>` if Coach isn't on the default 5899.

## 1 · Connect

Run `glassray status` and read its output — it prints whether a server answers
on the port. Any data command (e.g. `glassray stats`) exits 2 when no server is
up. If there is no server, ask the user to run `npx @glassray/coach start` in
their own terminal — **never start it yourself**. Do not run `glassray start`
or `glassray reset`.

## 2 · Inventory first — durable state IS the memory

```sh
glassray flows list
glassray evals list
cat glassray.yaml 2>/dev/null
```

Flows, rules, and the artifact file persist across sessions. **Never re-create
what already exists** — extend or tighten it. If `glassray.yaml` already
defines the flow you were about to set up, you are resuming previous work.

## 3 · Set up a flow — from the codebase, not from traffic

This is what cloud Glassray does from production traffic; you do it from code:

1. **Discover the flow.** Locate the flow's code: the entry point, its model
   call(s), the system prompt, and the agent name the tracing uses (the
   `service.name` / `TraceMeta.agent`). One flow = one behaviour.
2. **Derive rules from the prompt's implicit contract.** Every constraint the
   system prompt states or assumes is a candidate assertion rule — "always
   answer in English", "factual, never invent", "topic is a 1-4 word label".
   Every rule is active; tie each to the file its expectation is written in with
   an `anchors:` entry (e.g. `watcher/digest.ts`) — that makes it `source: code`.
   A rule you can't tie to a file is authored/custom (omit `anchors`, `source:
   promoted`). Acceptance is the git review of `glassray.yaml`.
3. **Author `glassray.yaml`** — the flow (membership selector = the agent
   name), the rules, and the local-only `run` recipe:

```yaml
version: 1
flows:
  - id: digest
    description: per-trace summary + language + topic
    membership:
      selector: { agent: trace-digest }
    run:                                  # LOCAL-ONLY — never becomes server state
      command: node glassray/run-digest.mjs
      inputs: glassray/inputs/digest/
rules:
  - id: english-summary
    flow: digest
    text: PASS if the summary is plain English and invents nothing not in the input.
    anchors:
      - file: src/digest.ts        # WHERE the expectation lives (omit = authored/custom)
  - id: topic-sensible
    flow: digest
    text: PASS if `topic` is a sensible 1-4 word English label.
    anchors:
      - file: src/digest.ts
```

4. **Write the runner** (`run.command`). It must: read every input file in
   `run.inputs`, call the **real** flow code wrapped in `@glassray/tracing`,
   set the trace `environment` to `process.env.GLASSRAY_RUN_LABEL`, and
   **flush the tracer before exit** (traces that don't land before the process
   exits are lost — `glassray run` will report zero and fail). Coach passes
   the runner three env vars: `GLASSRAY_ENDPOINT` (point the SDK here),
   `GLASSRAY_API_KEY`, and `GLASSRAY_RUN_LABEL`. Skeleton:

```js
// glassray/run-digest.mjs
import { readdir, readFile } from 'node:fs/promises';
import { init, flush } from '@glassray/tracing';   // reads GLASSRAY_ENDPOINT / GLASSRAY_API_KEY
import { runDigest } from '../src/digest.js';       // the REAL flow code

const t = init({ agent: 'trace-digest', environment: process.env.GLASSRAY_RUN_LABEL });
for (const file of await readdir('glassray/inputs/digest/')) {
  const { input } = JSON.parse(await readFile(`glassray/inputs/digest/${file}`, 'utf8'));
  await runDigest(input);                           // traced by the SDK wrapper
}
await flush();                                      // MUST flush before exit
```

5. **Instrument tracing if missing.** Prefer a thin traced runner over editing
   app code: wrap the flow's entry function in the runner script rather than
   threading the SDK through the application.
6. **Pin inputs.** No cloud: synthesize a representative set — one JSON file
   per input in `run.inputs` (`{ "input": … }`), covering the flow's real
   variety (languages, lengths, edge cases; ~10–30 is plenty). Have cloud:
   `glassray pull --traces <flow> -n 30` writes real production inputs there
   for you (and ingests the real traces as the `production` baseline corpus).

Acceptance for this section: `glassray run <flow> --label baseline` works with
no further hand-editing.

## 4 · The loop — prove the change held

```sh
glassray push                             # sync glassray.yaml's rules into the server
glassray run digest --label baseline      # score the pre-change world
# … make the change (model swap, prompt edit, refactor) …
glassray run digest --label candidate
glassray compare digest baseline candidate
```

Read the compare report: per-rule `passRate` baseline → candidate with
`deltaPassRate` and `regressed`, plus each side's tokens, **`estCostIfMeteredUsd`**
(the price-book cost — honest even on the free subscription provider; this is
the "is it cheaper?" number), and latency. Then:

- Regressions → fix the change or accept the trade-off knowingly.
- Green → commit `glassray.yaml`, the runner, and the inputs; `git push`. Every
  rule is already active (it autoruns on new traffic and gates `glassray
  check`); the **git review of `glassray.yaml`** is the approval — there is no
  in-app promote.

With a linked cloud project the baseline can be production itself:
`glassray compare digest production candidate` (after `pull --traces`).

Caveats you must respect: if tracing scrubbed or truncated inputs, a pulled
trace can **score** the baseline but not faithfully **re-run** the candidate —
`pull --traces` warns and skips pinning those. If the flow has side effects or
live state, old inputs won't reproduce it: degrade to "score the real
baseline; candidate from fresh traffic", and say so.

## 5 · CI: the check gate

`glassray check --fixtures` runs every rule over the committed
golden set (`glassray pull --as-fixtures` freezes it) and exits non-zero on
any pass rate below the rule's `threshold` (default 1.0). Deterministic — same
committed inputs — so a red means *the change you just made* broke it. Live
members drift; never treat live numbers as the regression gate.

## 6 · Self-correct

Audit your own hypotheses periodically:

```sh
glassray flows audit <id>     # members that don't belong → tighten the selector
glassray evals get <id>       # verdicts flip-flopping on unchanged behaviour → sharpen the rule text
```

A vague rule gets rewritten by editing its `text` in `glassray.yaml` and
`glassray push` (the plan shows `~ update`). `glassray evals update` moves flow
binding, `--source-file` (the rule's code anchor), and gate tuning only.

## 7 · Reference

Management — for the user, mostly:

| Command | Notes |
| --- | --- |
| `glassray status` / `glassray doctor` | Is a server up; environment checks. |
| `glassray init [--force]` | Install this skill into `./.agents/skills/` + `./.claude/skills/`. |
| `glassray start` / `glassray reset` | The user runs these — never you. |

The loop (stdout = API JSON; long verbs take `--no-wait --timeout`):

| Command | Notes |
| --- | --- |
| `glassray run <flow> --label <x> [--file glassray.yaml]` | Spawn the flow's `run.command` with `GLASSRAY_ENDPOINT` / `GLASSRAY_API_KEY` / `GLASSRAY_RUN_LABEL`; fails if zero traces land. |
| `glassray compare [<flow>] <baseline> <candidate> [--sample]` | Bare corpora are run labels; prefixed: `label:` `agent:` `flow:` `fixtures:<dir>`. Report = pass-rate deltas + cost. |
| `glassray pull [--from local\|cloud] [--out]` | Serialize flows + rules into glassray.yaml. Local-only sections (`run`, fixtures/inputs paths) always survive the pull. `--from cloud` also applies the pulled rules to the local server. |
| `glassray pull --traces <flow> [-n 30]` | Ingest real cloud traces as the `production` corpus + pin their extracted inputs into `glassray/inputs/<flow>/`. |
| `glassray pull --as-fixtures [--flow --limit --dir]` | Freeze golden traces for the `check` gate. |
| `glassray push [--file --dry-run --prune]` | Reconcile glassray.yaml into the target (plan on stderr; prune = archive extras). |
| `glassray check [--fixtures --dir --sample --timeout]` | Run every rule; exit 1 on a threshold breach. |
| `glassray link <project> [--endpoint --token] \| link --show` | Record the cloud project + auth for the cloud pulls. |

Data + rules:

| Command | Notes |
| --- | --- |
| `glassray traces list [--q --agent --status --flow --label --limit --offset]` / `get <id>` / `tail` | `--label` filters one run's corpus. |
| `glassray stats` / `glassray usage` | Rollups incl. `estCostIfMeteredUsd`; Coach's own LLM spend. |
| `glassray flows list/get/create/update/delete/audit/discover` | Durable flows; `audit` = classification quality. |
| `glassray evals list` / `get <id>` | Rules with `name`, `text`, `anchors` (+ `source` code\|promoted), gate `threshold`, latest verdicts + history. |
| `glassray evals create --name --text [--flow --source-file --threshold --judge --autorun-threshold]` | Hand-written rule (authored/promoted unless `--source-file` sets a code anchor). |
| `glassray evals create --deviation <id> [--flow]` | Save a discovered deviation as an authored (**promoted**) rule (idempotent). |
| `glassray evals update <id> [--flow\|--no-flow --source-file --threshold\|--no-threshold --judge\|--no-judge --autorun-threshold]` | Binding + anchor + gates. |
| `glassray evals run <id> [--sample --model]` / `delete <id>` | One-off scoring; delete removes verdicts. |
| `glassray deviations list/get/resolve` · `discovery run` · `fix <id>` | The discovery → fix loop (secondary to the rule loop). |
| `glassray runs list/get/cancel` | Background-run queue visibility. |

Key JSON fields to read:

- `run` prints `{ flow, label, traces }`; the count is the traces that landed
  for this invocation — zero is a runner bug (not exporting to
  `GLASSRAY_ENDPOINT`, or not flushing before exit).
- A finished compare run's `stats`: `rules[]` with per-side
  `{ scored, passed, failed, passRate }`, `deltaPassRate`, `regressed`;
  `baseline`/`candidate` with `tokensIn/Out`, `estCostUsd` (real spend, may be
  $0), `estCostIfMeteredUsd` (price book — the honest number),
  `avgDurationMs`; `costIfMeteredDeltaUsd` (negative = cheaper); `regressions`.
- `evals get <id>`: `passed`/`failed`/`regressionCount`; `results[]` sorted
  regressions → failures → passes; `history[]` oldest → newest.
- Run-starting commands return `202 { runId, status }` — never 409-busy;
  `runs get <id>` shows `queued → running → done|error` with live
  `{ scanned, total }` progress.

Model-switch recipe (the canonical use): author/confirm the flow + rules, pin
inputs, `run <flow> --label baseline`, swap the model in code,
`run <flow> --label <new-model>`, `compare <flow> baseline <new-model>` — read
`deltaPassRate` per rule and `estCostIfMeteredUsd` per side. To keep judging
constant across the comparison, set `judge:` on the rules in `glassray.yaml`.
