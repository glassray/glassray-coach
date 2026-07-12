import { doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * WHERE in the agent's code a rule is enforced — mirrors cloud `FlowRule.anchors`.
 * Coach only populates `file`; `symbol`/`line` are carried for artifact fidelity.
 */
export type Anchor = { file: string; symbol?: string; line?: number };

/** One row per trace, keyed by the 32-hex OTLP traceId; `raw` holds the full envelope, the rest are denormalized display fields. */
export const traces = pgTable('traces', {
  /** 32-char lowercase hex OTLP trace id. */
  id: text('id').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  /** Full OTLP JSON envelope as received (whole-trace-per-POST contract). */
  raw: jsonb('raw').notNull(),
  name: text('name'),
  agent: text('agent'),
  provider: text('provider'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  durationMs: integer('duration_ms'),
  spanCount: integer('span_count'),
  status: text('status'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  inputPreview: text('input_preview'),
  outputPreview: text('output_preview'),
  /** The run label this trace belongs to — the SDK `environment` (`glassray.environment`), or the ingest `?label=` override. Corpus key for run/compare. */
  runLabel: text('run_label'),
  /** Primary LLM model observed in the trace's spans (most output tokens wins) — feeds the "cost if metered" price book. */
  model: text('model'),
  /** Classification watermark: null = awaiting the background classify sweep; stamped once swept (matched or not). */
  classifiedAt: timestamp('classified_at', { withTimezone: true, mode: 'date' }),
});

/** One background job (`discovery` | `flows`); tracks lifecycle + a free-form `stats` blob. */
export const runs = pgTable('runs', {
  /** Prefixed random-hex id (`run_…`). */
  id: text('id').primaryKey(),
  /** Which pass this run drives: `discovery` or `flows`. */
  kind: text('kind').notNull(),
  /** Lifecycle: `running` → `done` / `error`. */
  status: text('status').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  /** Failure message when `status = 'error'`. */
  error: text('error'),
  /** Terminal summary counts (e.g. `{ deviationCount, exampleCount }` / `{ flowCount }`). */
  stats: jsonb('stats'),
});

/** A recurring deviation TYPE clustered from per-trace findings, plus the plain-language `rule`. */
export const deviations = pgTable('deviations', {
  /** Prefixed random-hex id (`dev_…`). */
  id: text('id').primaryKey(),
  /** The discovery run that produced this type. */
  runId: text('run_id').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  /** The plain-language rule the agent SHOULD follow (not a restatement of the failure). */
  rule: text('rule').notNull(),
  /** Worst severity across the members (`critical` | `major` | `minor`). */
  severity: text('severity').notNull(),
  /** Number of per-trace example findings rolled into this type. */
  exampleCount: integer('example_count').notNull(),
  /** Loop state: `open` (default) or `resolved` (the user confirmed a fix landed). */
  status: text('status').notNull().default('open'),
  /** Generated fix: a paste-into-your-coding-agent markdown instruction doc (null until "Generate fix"). */
  fixMarkdown: text('fix_markdown'),
  /** The model that produced `fixMarkdown`. */
  fixModel: text('fix_model'),
  /** When `fixMarkdown` was generated. */
  fixGeneratedAt: timestamp('fix_generated_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** One per-trace finding that belongs to a `deviations` type, citing the trace it came from. */
export const deviationExamples = pgTable('deviation_examples', {
  /** Prefixed random-hex id (`dex_…`). */
  id: text('id').primaryKey(),
  /** The deviation type this example rolls up into. */
  deviationId: text('deviation_id').notNull(),
  /** The trace this finding was observed in (32-hex OTLP id). */
  traceId: text('trace_id').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  severity: text('severity').notNull(),
  evidence: text('evidence').notNull(),
});

/**
 * A durable, named agent behaviour with a membership definition: either a
 * deterministic `selector` query, a plain-language `rule` classified by the
 * background LLM sweep, or both. Flows persist across sessions — they are the
 * scope evals run against.
 */
export const flows = pgTable('flows', {
  /** Prefixed random-hex id (`flow_…`). */
  id: text('id').primaryKey(),
  /** The discover/clustering run that produced this flow; null for CRUD-created flows. */
  runId: text('run_id'),
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** Legacy denormalized member count — list endpoints compute live counts; kept for old rows. */
  traceCount: integer('trace_count').notNull().default(0),
  /** Deterministic membership query (`FlowSelector` jsonb); null = LLM-rule or static membership only. */
  selector: jsonb('selector'),
  /** Plain-language membership rule the LLM classify sweep matches traces against. */
  rule: text('rule'),
  /** How membership is decided: `selector` (deterministic only) or `llm` (rule-classified by the sweep). */
  classify: text('classify').notNull().default('selector'),
  /** Lifecycle: `active` (classified + listed) or `archived`. */
  status: text('status').notNull().default('active'),
  /** Provenance: `user` (dashboard), `claude` (CLI agent), or `discovery` (clustering bootstrap). */
  createdBy: text('created_by').notNull().default('user'),
  /** Stable artifact identity (the `glassray.yaml` flow id); null until exported/imported. */
  slug: text('slug'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** Membership join: which traces belong to which flow (composite-keyed, no duplicates), with assignment provenance. */
export const flowTraces = pgTable(
  'flow_traces',
  {
    flowId: text('flow_id').notNull(),
    traceId: text('trace_id').notNull(),
    /** How this membership was decided: `selector` | `llm` | `manual`. */
    assignedBy: text('assigned_by').notNull().default('selector'),
    /** LLM assignment confidence (`high` | `low`); null for selector/manual assignments. */
    confidence: text('confidence'),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.flowId, t.traceId] })],
);

/**
 * An assertion RULE over a flow's traces — a repeatable pass/fail check built
 * from a plain-language `text` predicate (saved from a deviation, or
 * hand-written). Historically "evals"; the table name stays for datadir
 * compatibility. Every rule is active — it gates `check` and runs in `compare`.
 * Field names/meanings mirror cloud's canonical `FlowRule` primitive: `name`
 * (title), `text` (the judged predicate), `source` (`code` = read from a file
 * anchor, `promoted` = authored), and `anchors` (WHERE in code it's enforced).
 * Acceptance is git review of `glassray.yaml`, not an in-app promote.
 */
export const evals = pgTable('evals', {
  /** Prefixed random-hex id (`eval_…`). */
  id: text('id').primaryKey(),
  /** Short plain-language TITLE of the rule (cloud `FlowRule.name`). */
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** The plain-language rule each trace is scored against (pass = complies, fail = violates) — cloud `FlowRule.text`. */
  text: text('text').notNull(),
  /** Provenance (cloud `FlowRule.source`): `code` (read from a file anchor) or `promoted` (authored). */
  source: text('source').notNull(),
  /** The deviation this eval was promoted from, when it began as a discovered type. */
  sourceDeviationId: text('source_deviation_id'),
  /** The flow this eval is scoped to (runs sample that flow's members); null = global (newest traces store-wide). */
  flowId: text('flow_id'),
  /** WHERE in code the rule is enforced (cloud `FlowRule.anchors`); Coach populates only `file`. Null = authored/custom. */
  anchors: jsonb('anchors').$type<Anchor[]>(),
  /** VESTIGIAL: the retired lifecycle column, kept to avoid a destructive migration. Set to a constant on insert; never read for gating. */
  state: text('state').notNull().default('active'),
  /** How many new member traces (since the last run) trigger an automatic rerun of a watched rule. */
  autorunThreshold: integer('autorun_threshold').notNull().default(10),
  /** Pass-rate gate for `glassray check` (0..1); null = 1.0 (any failure breaches). */
  threshold: doublePrecision('threshold'),
  /** Preferred judge model id for runs of this rule; null = the light-tier default. */
  judgeModel: text('judge_model'),
  /** Stable artifact identity (the `glassray.yaml` rule id); null until exported/imported. */
  slug: text('slug'),
  /** When this eval's most recent run STARTED (stamped at run start — the autorun watermark). */
  lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** One Coach LLM call's token/cost usage — the ledger the budget guard sums over. */
export const llmUsage = pgTable('llm_usage', {
  /** Prefixed random-hex id (`use_…`). */
  id: text('id').primaryKey(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  /** What the call was for: `discovery` | `eval` | `flows` | `replay` | `improver`. */
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  /** Estimated USD cost — 0 for the free `mock` / `claude-subscription` paths. */
  costUsd: doublePrecision('cost_usd').notNull(),
});

/**
 * A durable EXPERIMENT: one question ("can we switch to Haiku?") with a
 * baseline vs candidate comparison and a generated report + verdict. `compare`
 * is the mechanism inside it; the report is what you keep. Experiments are
 * records — never part of `glassray.yaml`.
 */
export const experiments = pgTable('experiments', {
  /** Prefixed random-hex id (`exp_…`). */
  id: text('id').primaryKey(),
  /** The flow whose rules form the suite; null = global rules. */
  flowId: text('flow_id'),
  /** The plain-language question the experiment answers. */
  question: text('question').notNull(),
  /** Lifecycle: `open` (created) → `running` (report generating) → `concluded`. */
  status: text('status').notNull().default('open'),
  /** Suggested outcome once concluded: `go` | `no-go` | `undecided`; null until then. */
  verdict: text('verdict'),
  /** The run label of the baseline corpus; null until a report runs. */
  baselineLabel: text('baseline_label'),
  /** The run label of the candidate corpus; null until a report runs. */
  candidateLabel: text('candidate_label'),
  /** The compare run this experiment wrapped; null until a report runs. */
  runId: text('run_id'),
  /** The generated report (compare result + prose summary + failing examples); null until concluded. */
  report: jsonb('report'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  /** When the experiment was concluded (report generated); null while open/running. */
  concludedAt: timestamp('concluded_at', { withTimezone: true, mode: 'date' }),
});

/** One per-trace verdict produced by scoring an eval's rule during a run. */
export const evalResults = pgTable('eval_results', {
  /** Prefixed random-hex id (`evr_…`). */
  id: text('id').primaryKey(),
  /** The eval this verdict scores. */
  evalId: text('eval_id').notNull(),
  /** The run that produced this verdict (ties a batch of verdicts together). */
  runId: text('run_id').notNull(),
  /** The trace scored (32-hex OTLP id). */
  traceId: text('trace_id').notNull(),
  /** `pass` = the trace complies with the rule; `fail` = it violates the rule. */
  verdict: text('verdict').notNull(),
  /** The quoted evidence from the trace justifying the verdict. */
  evidence: text('evidence').notNull(),
  scoredAt: timestamp('scored_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
