# Spec: harness-driven local loop — rules, experiments, cloud pull

Status: **design, ready to implement.** Scope: the `glassray-coach` repo (server + bin + skill + web), with cloud endpoints noted as contracts. Companion to [`portable-rule-artifact.md`](./portable-rule-artifact.md); this supersedes the earlier lifecycle model.

## Context

An engineer improves a flow (e.g. swap the trace-digest model Sonnet→Haiku) and proves behaviour held, from inside their coding agent. Two entry points:

- **No cloud** — the harness derives the flow + rules from the codebase, pins a synthetic input set, runs baseline and candidate locally.
- **Have cloud** — pull the flow + rules + real production traces; the traces are the baseline and the source of real inputs; only the candidate runs locally.

Coach stays lean: ingest + score rules + hold experiments. The harness (coding agent) does the understanding, instrumenting, and running.

## Two model decisions (read first)

1. **Rules are identified by their source, not a lifecycle.** Drop `proposed | watched | archived`. A rule is either **linked** to a file (the place the expectation is written — the agent sets this when it derives the rule) or **custom** (no file). Every rule in `glassray.yaml` is active. Acceptance is **git review of the file**, not an in-app promote. Gating strictness, if needed, is a per-rule `severity: warn | error`, not a state.

2. **Compare lives inside an experiment.** An **experiment** is the durable container for one question ("can we switch to Haiku?"): a baseline run, one or more candidate runs, the flow's rules, the compare, and a generated **report + verdict**. `compare` is the mechanism inside it; the report is what you keep and share. Experiments are *records* (not part of `glassray.yaml`); their outcome may change rules/code, and those go in the file.

Do **not** build metric-tracking / sweeps / significance testing — an experiment is "a named comparison with a report," not an ML experiment tracker.

## Target loop

```sh
glassray init                              # skill + starter glassray.yaml
# agent: reads code → writes flow + rules (source-linked) + run recipe, pins inputs, adds tracing

glassray experiment new "digest: sonnet → haiku"
glassray run digest --label baseline       # runs the recipe on pinned inputs, attaches to open experiment
# … switch Sonnet → Haiku …
glassray run digest --label haiku
glassray experiment report                 # compare + generated report + verdict
git push                                   # portable flows+rules → cloud
```

---

## Phase 1 — local loop (must-have)

### 1.1 Artifact: `run` recipe + source-linked rules
**File:** `server/artifact.ts`

- Add optional local-only `run` to a flow: `run: { command: string; inputs?: string }`. `flows`+`rules` are portable; `run`/inputs are local-only and **ignored by import against a target** (never become server state).
- On the rule: **remove `state`**; add optional `source: string` (file path, optionally with an anchor, e.g. `watcher/digest.ts#SYSTEM`). Absent = custom. Add optional `severity: z.enum(['warn','error']).default('error')`.

**Acceptance:** a rule with `source` and a flow with `run` round-trip through export/import; `state` is gone; `artifact.test.ts` updated.

### 1.2 Rule storage
**Files:** `server/schema.ts`, `server/evals.ts`, `server/bootstrap.ts`

- Replace the `state` column on `evals` with `source text` (nullable) and `severity text not null default 'error'` (idempotent migration; back-fill existing `state='watched'`→keep, others→keep as active). Every rule is active; there is no enabled flag.
- `GET /api/flows/:id` returns each rule’s `source` (or null) + `severity`.

**Acceptance:** rules list shows source; no lifecycle field remains.

### 1.3 CLI `glassray run <flow> --label <x>`
**Files:** `bin/commands.mjs`, `bin/glassray.mjs`

Spawn `run.command` with env `GLASSRAY_ENDPOINT`, `GLASSRAY_API_KEY`, `GLASSRAY_RUN_LABEL=<x>`, and — if an experiment is open — `GLASSRAY_EXPERIMENT_ID`. Await exit; report `<n> traces landed for label '<x>'` to stderr; non-zero on command failure or zero traces. The harness-authored runner reads `run.inputs`, calls the real flow wrapped in `@glassray/tracing`, sets the trace `environment` to the label, and flushes.

### 1.4 Run-label persistence + filter
**Files:** `server/schema.ts`, ingest in `server/app.ts`

Persist the OTLP `glassray.environment` as the trace’s run label (add `run_label text` nullable+indexed if not already stored). Add `?label=` to `GET /api/traces`.

### 1.5 Cost fix (the one real bug)
**Files:** `server/compare.ts`, `server/app.ts` (stats)

In `corpusStats`, replace `estimateCostUsd(provider,…)` with `estimateCostIfMetered(model,…)`, deriving the model from the trace’s primary `llm` span via `buildTraceView` (trace-row model is null). Report both `estCostUsd` and `estCostIfMeteredUsd` per side. Mirror `estCostIfMeteredUsd` into `/api/stats` `byAgent`.

**Acceptance:** compare shows a non-zero “if metered” cost per side on the free subscription provider (≈ $1.04 Sonnet vs $0.46 Haiku on the digest sample).

---

## Phase 2 — experiments (the container + report)

### 2.1 Experiment object
**Files:** `server/schema.ts`, new `server/experiments.ts`, `server/app.ts`

Table `experiments`: `id`, `flowId`, `question text`, `status` (`open|running|concluded`), `verdict` (`go|no-go|undecided`, nullable), `baselineLabel`, `candidateLabels jsonb`, `report jsonb` (the compare result + generated prose), `createdAt`, `concludedAt`.

Routes:
- `POST /api/experiments` `{ flowId, question }` → `201 { id }` (opens one; at most one `open` per flow).
- `GET /api/experiments?flowId` / `GET /api/experiments/:id` — list + detail (detail embeds the compare result + report).
- `POST /api/experiments/:id/report` `{ baseline, candidate }` (corpus refs, default = the two newest labels) → runs the existing `compare` over the flow’s rules, stores the result, generates the report + a suggested verdict, sets `status=concluded`.
- Runs created via `glassray run` while an experiment is open attach to it (`GLASSRAY_EXPERIMENT_ID`).

Reuse `runCompare` verbatim as the mechanism; the experiment just persists its result and wraps a report.

### 2.2 Report generation
**File:** `server/experiments.ts`

From the stored compare result, generate: a short prose summary (which rules held/regressed, the cost delta and why), the failing examples (top per regressed rule, with evidence), and a **suggested verdict** — `no-go` if any rule regressed below its `severity:error` threshold, else `go`. The human can override `verdict`. Keep the prose template-based + one light LLM pass; no new heavy machinery.

### 2.3 CLI
**Files:** `bin/commands.mjs`

- `glassray experiment new "<question>"` → open (records the flow from cwd’s `glassray.yaml`).
- `glassray experiment report [--baseline <l>] [--candidate <l>]` → generate + print the report; exit non-zero if verdict is `no-go` (usable as a gate).
- `glassray experiment list` / `show <id>`.

**Acceptance:** the Sonnet→Haiku loop produces a concluded experiment with a report naming the 2 regressions and the ~2.25× cost delta, retrievable by `experiment show`.

---

## Phase 3 — cloud pull

- `glassray pull [--from cloud]` — fetch flow + rules (portable artifact shape) into `glassray.yaml`; never overwrite local `run`/inputs.
- `glassray pull --traces <flow> -n N` — fetch N real traces, ingest them as a labeled corpus (`production`), and extract each trace’s input into `run.inputs` so the candidate re-runs the real inputs.
- **Cloud contract (dependency):** `GET /api/flows/:id/traces?limit=N` returning OTLP envelopes, auth via `link`.
- Caveats to encode: input-capture fidelity (scrubbed/truncated inputs can score the baseline but not re-run); non-replayable flows degrade to “score baseline, candidate from fresh traffic”.

---

## Phase 4 — skill (the harness contract)
**File:** `skills/glassray/SKILL.md`

Rewrite so the coding agent, from the codebase, does what cloud does from traffic:
1. **Discover** the flow (code, model call, system prompt, agent name).
2. **Derive rules from the code**, each with a `source` pointing at the file the expectation lives in; expectations you can’t tie to a file are `custom`.
3. **Author** `glassray.yaml` (flow + rules + `run` recipe) and write the runner (reads `run.inputs`, wraps the model call in `@glassray/tracing`, sets `environment` from `GLASSRAY_RUN_LABEL`, flushes).
4. **Instrument** tracing if missing.
5. **Drive** an experiment: `experiment new` → `run baseline` → help make the change → `run candidate` → `experiment report` → on `go`, apply the change and update rules; commit + `git push`.

---

## Phase 5 — web
**Files:** `web/src/components/*`

- **Experiments is its own top-level surface** — the experiment list and the experiment detail/report live under `#/experiments`, not inside a flow. `GET /api/experiments` (no `flowId`) = the global list; `#/experiments/:id` = the detail.
- **Flow page** (cloud-like *layout*, local *content*): a tabbed layout (Behaviours · How it's built · Traces) with a **"Built from" rail** — only the local-meaningful facts: `Agent`, `Source` file, `Model`, `Recipe`. **Drop the cloud/monitoring rail fields** — no Health, Repo (you're in the repo), Inputs count, Last-run, or Volume; those are production concepts. Rules render as behaviours grouped by their last-check result (failing/passing, with icons), each showing its `source` file or a `custom` tag — no state pills. The flow only **references** its experiments — a light rail panel (count + recent, each linking out to `#/experiments/:id`); it never embeds the compare/report.
- **Experiment list** (`#/experiments`): experiment **cards** (verdict-accented) with the question, flow tag, per-rule delta chips, and cost delta — a distinct surface, not flow sub-rows.
- **Experiment detail** (`#/experiments/:id`): reached by clicking an experiment — the compare table + the generated **report** (prose, cost, failing examples) + export.
- Remove: Overview monitoring dashboard, Deviations, Discovery, promote/state UI.

## What NOT to build
- No rule lifecycle/state, no in-app promote (git review is the gate).
- No local discovery/deviations/monitoring (cloud’s job).
- No experiment metric-tracking/sweeps/significance — a named comparison with a report, nothing more.
- No SDK changes (reuse `environment` for the label).

## Test plan
- `artifact.test.ts`: source-linked + custom rules round-trip; `run` ignored on import; no `state`.
- `compare`/experiment test: two labeled corpora → pass-rate deltas + non-zero `estCostIfMeteredUsd`; report names regressions and suggests `no-go`.
- CLI test: `run` sets the three env vars + attaches to the open experiment; `experiment report` exits non-zero on `no-go`.
- Manual end-to-end on trace-digest (reproduces the 2 regressions + ~2.25× cost).
