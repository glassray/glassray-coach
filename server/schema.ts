import { boolean, doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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

/** A repeatable pass/fail check built from a plain-language `rule` (saved from a deviation, or hand-written). */
export const evals = pgTable('evals', {
  /** Prefixed random-hex id (`eval_…`). */
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  /** The plain-language rule each trace is scored against (pass = complies, fail = violates). */
  rule: text('rule').notNull(),
  /** Provenance: `deviation` (saved from a discovered type) or `manual` (hand-written). */
  source: text('source').notNull(),
  /** The deviation this eval was saved from, when `source = 'deviation'`. */
  sourceDeviationId: text('source_deviation_id'),
  /** The flow this eval is scoped to (runs sample that flow's members); null = global (newest traces store-wide). */
  flowId: text('flow_id'),
  /** Whether the server auto-reruns this eval when its flow accrues new member traces. */
  autorun: boolean('autorun').notNull().default(true),
  /** How many new member traces (since the last run) trigger an automatic rerun. */
  autorunThreshold: integer('autorun_threshold').notNull().default(10),
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
