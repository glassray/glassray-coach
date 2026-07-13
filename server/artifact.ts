import { eq } from 'drizzle-orm';
import YAML from 'yaml';
import { z } from 'zod';
import type { CoachDb } from './bootstrap.js';
import { flowSelectorSchema, parseSelector, type FlowSelector } from './classify.js';
import { createFlow, updateFlow } from './flows.js';
import { createManualEval, deleteEval, sourceFromAnchors } from './evals.js';
import { evals, flows } from './schema.js';

/*
 * The PORTABLE RULE ARTIFACT — `glassray.yaml`. One file, checked into the
 * agent's repo, is the source of truth a target (this local Coach, or cloud
 * Glassray) reconciles to. `exportArtifact` serializes the target's flows +
 * assertion rules into the file shape; `planImport`/`applyImport` diff the file
 * against the target dbt/terraform-style (create / update / prune) and apply
 * it idempotently. Identity is the `(kind, id-slug)` pair — never the server's
 * random-hex row id — so the same file maps onto different row ids per target.
 * See docs/portable-rule-artifact.md §3–4.
 */

/** A rule/flow slug: the stable, human-chosen identity in the artifact file. */
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slugs are lowercase kebab-case (a-z, 0-9, -)');

/**
 * The retired `proposed | watched | archived` rule/flow lifecycle. Declared ONLY
 * so an artifact carrying a legacy `state:` key fails loudly with a migration
 * message — rather than the key being silently stripped and the entry imported
 * as an active, gating rule (which `check` / `compare` would then run). Every
 * rule is now active; the accept gate is the git review of `glassray.yaml`.
 */
const retiredStateField = z
  .never({
    error:
      'the `state` lifecycle (proposed/watched/archived) was retired — every rule is now active and gated by the git review of glassray.yaml. Remove the `state` field to keep the entry (it becomes active), or delete the entry to drop it.',
  })
  .optional();

/** One flow entry in the artifact: membership (portable) + an optional run recipe (LOCAL-ONLY). */
const artifactFlowSchema = z
  .strictObject({
    id: slugSchema,
    /** Display name on the target; defaults to the title-cased slug on create. */
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).default(''),
    membership: z
      .object({
        /** The existing FlowSelector, verbatim — no new selector language. */
        selector: flowSelectorSchema.nullish(),
        /** Optional plain-language LLM classify predicate. */
        rule: z.string().trim().min(1).max(2000).nullish(),
      })
      .default({}),
    /**
     * LOCAL-ONLY: the harness-authored run recipe `glassray run <flow>`
     * executes. Lives only in the file — import plan/apply ignores it, and it
     * never becomes server state. The command is a black box the harness owns:
     * it reads `inputs`, calls the real flow wrapped in `@glassray/tracing`,
     * tags each trace with `GLASSRAY_RUN_LABEL`, and flushes before exit.
     */
    run: z
      .object({
        /** Runner invocation, e.g. `node glassray/run-digest.mjs`. */
        command: z.string().trim().min(1).max(500),
        /** Dir of pinned inputs the runner re-feeds, e.g. `glassray/inputs/digest/`. */
        inputs: z.string().trim().min(1).max(500).optional(),
      })
      .optional(),
    /** Retired lifecycle key — rejected, not stripped (see `retiredStateField`). */
    state: retiredStateField,
  })
  .refine((f) => f.membership.selector != null || f.membership.rule != null, {
    message: 'a flow needs a membership selector, a membership rule, or both',
  });

/** One code anchor: WHERE in the agent's repo a rule is enforced (cloud `FlowRule.anchors[]`). */
export const anchorSchema = z.object({
  file: z.string().trim().min(1).max(500),
  symbol: z.string().trim().min(1).max(200).optional(),
  line: z.number().int().min(0).optional(),
});

/** One assertion rule in the artifact (== an eval on the target) — mirrors cloud's canonical `FlowRule`. */
const artifactRuleSchema = z.strictObject({
  id: slugSchema,
  /** The flow slug this rule is scoped to; null/absent = global. */
  flow: slugSchema.nullish(),
  /** Short plain-language title (cloud `FlowRule.name`); defaults to the title-cased slug on create. */
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  /** The plain-language judged predicate (PASS/FAIL over one trace) — cloud `FlowRule.text`. */
  text: z.string().trim().min(1).max(2000),
  /** Provenance (cloud `FlowRule.source`): `code` (read from a file anchor) or `promoted` (authored); absent = promoted. */
  source: z.enum(['code', 'promoted']).nullish(),
  /** WHERE in code the rule is enforced (cloud `FlowRule.anchors`); absent = authored/custom. */
  anchors: z.array(anchorSchema).nullish(),
  /** Preferred judge model id; absent = the target's light-tier default. */
  judge: z.string().trim().min(1).max(200).nullish(),
  /** Pass-rate gate for `check` (0..1); absent = 1.0 (any failure breaches). */
  threshold: z.number().min(0).max(1).nullish(),
  /** Retired lifecycle key — rejected, not stripped (see `retiredStateField`). */
  state: retiredStateField,
});

/** The whole `glassray.yaml` document. */
export const artifactSchema = z.object({
  version: z.literal(1),
  /** Cloud project ref (resolved once linked); carried through verbatim locally. */
  project: z.string().trim().min(1).max(200).optional(),
  /**
   * LOCAL-ONLY: the repo root `glassray discover` reads to map flows from CODE,
   * relative to this file (`..` = the parent dir) or absolute. Lives only in the
   * file — never server state; import plan/apply ignores it (like `run`).
   */
  codeRoot: z.string().trim().min(1).max(500).optional(),
  flows: z.array(artifactFlowSchema).default([]),
  rules: z.array(artifactRuleSchema).default([]),
  /** Where golden traces live relative to the file (informational for the CLI). */
  fixtures: z.object({ path: z.string().trim().min(1).max(500) }).optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactFlow = z.infer<typeof artifactFlowSchema>;
export type ArtifactRule = z.infer<typeof artifactRuleSchema>;

/** Derive a kebab-case slug from a display name (fallback identity for never-exported rows). */
export const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'unnamed';
};

/** Title-case a slug into a display name for rows created from the file (`english-summary` → `English summary`). */
const nameFromSlug = (slug: string): string => {
  const words = slug.replace(/-/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Assign each row a unique slug: its stored slug wins, else the (deduped) slugified name. */
const assignSlugs = <T>(rows: T[], stored: (r: T) => string | null, name: (r: T) => string): Map<T, string> => {
  const taken = new Set(rows.map(stored).filter((s): s is string => s !== null));
  const out = new Map<T, string>();
  for (const row of rows) {
    const existing = stored(row);
    if (existing) {
      out.set(row, existing);
      continue;
    }
    const base = slugify(name(row));
    let slug = base;
    for (let i = 2; taken.has(slug); i += 1) slug = `${base}-${i}`;
    taken.add(slug);
    out.set(row, slug);
  }
  return out;
};

/**
 * Serialize the target's flows + rules into the artifact shape, STAMPING the
 * derived slug onto any row that didn't have one yet — so the identity used in
 * the exported file is durable on this target from now on (a later rename
 * can't fork it). Active flows only; every rule is portable (no lifecycle to
 * exclude).
 */
export const exportArtifact = async (db: CoachDb): Promise<Artifact> => {
  const flowRows = await db.select().from(flows).where(eq(flows.status, 'active')).orderBy(flows.createdAt, flows.id);
  const activeEvalRows = await db.select().from(evals).orderBy(evals.createdAt, evals.id);

  const flowSlugs = assignSlugs(flowRows, (r) => r.slug, (r) => r.name);
  const ruleSlugs = assignSlugs(activeEvalRows, (r) => r.slug, (r) => r.name);
  for (const [row, slug] of flowSlugs) {
    if (row.slug !== slug) await db.update(flows).set({ slug }).where(eq(flows.id, row.id));
  }
  for (const [row, slug] of ruleSlugs) {
    if (row.slug !== slug) await db.update(evals).set({ slug }).where(eq(evals.id, row.id));
  }

  const flowSlugById = new Map(flowRows.map((r) => [r.id, flowSlugs.get(r)!]));
  return {
    version: 1,
    flows: flowRows.map((r) => ({
      id: flowSlugs.get(r)!,
      name: r.name,
      description: r.description,
      membership: {
        ...(parseSelector(r.selector) !== null ? { selector: parseSelector(r.selector)! } : {}),
        ...(r.rule !== null ? { rule: r.rule } : {}),
      },
    })),
    rules: activeEvalRows.map((r) => ({
      id: ruleSlugs.get(r)!,
      ...(r.flowId !== null && flowSlugById.has(r.flowId) ? { flow: flowSlugById.get(r.flowId)! } : {}),
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      text: r.text,
      source: r.source === 'code' ? 'code' : 'promoted',
      ...(r.anchors !== null ? { anchors: r.anchors } : {}),
      ...(r.judgeModel !== null ? { judge: r.judgeModel } : {}),
      ...(r.threshold !== null ? { threshold: r.threshold } : {}),
    })),
    fixtures: { path: 'glassray/fixtures/' },
  };
};

/** Render an artifact as the `glassray.yaml` document text. */
export const artifactToYaml = (artifact: Artifact): string =>
  YAML.stringify(artifact, { lineWidth: 100 });

/**
 * Overlay a base file's LOCAL-ONLY sections onto a freshly exported/pulled
 * artifact: each flow keeps the base's `run` recipe (matched by slug), and the
 * top-level `project` / `fixtures` refs survive when the fresh artifact
 * doesn't carry its own. This is what keeps `glassray pull` from clobbering
 * the harness-authored recipe — the portable `flows`/`rules` sections always
 * come from the fresh source.
 */
export const mergeLocalOnly = (fresh: Artifact, base: Artifact): Artifact => {
  const baseRunBySlug = new Map(base.flows.filter((f) => f.run).map((f) => [f.id, f.run!]));
  return {
    ...fresh,
    ...(fresh.project === undefined && base.project !== undefined ? { project: base.project } : {}),
    ...(fresh.codeRoot === undefined && base.codeRoot !== undefined ? { codeRoot: base.codeRoot } : {}),
    flows: fresh.flows.map((f) => {
      const run = baseRunBySlug.get(f.id);
      return run !== undefined && f.run === undefined ? { ...f, run } : f;
    }),
    fixtures: fresh.fixtures ?? base.fixtures,
  };
};

/** Parse + validate a `glassray.yaml` document; throws with a readable message on a bad file. */
export const parseArtifactYaml = (text: string): Artifact => {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = artifactSchema.safeParse(doc);
  if (!parsed.success) throw new Error(`invalid glassray.yaml: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
};

/** One step of a reconcile plan. `prune` ARCHIVES a flow, but DELETES a rule (no archived state). */
export type PlanAction = {
  op: 'create' | 'update' | 'prune' | 'noop';
  kind: 'flow' | 'rule';
  /** The artifact slug identity. */
  id: string;
  /** Human summary of what changes (e.g. `threshold 0.95→1`); empty for create/noop. */
  changes: string[];
};

/** The plan plus everything `applyImport` needs to execute it without re-diffing. */
export type ImportPlan = {
  actions: PlanAction[];
  /** Actionable steps only (creates + updates + prunes). */
  summary: { create: number; update: number; prune: number; noop: number };
};

/** JSON-normalized selector equality (both sides parsed through the schema first). */
const sameSelector = (a: FlowSelector | null, b: FlowSelector | null): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A target flow/eval row joined with its effective slug. */
type SluggedFlow = { row: typeof flows.$inferSelect; slug: string };
type SluggedEval = { row: typeof evals.$inferSelect; slug: string };

/** Load the target's rows with their effective slugs (stored, else derived — mirroring export). */
const loadTarget = async (db: CoachDb): Promise<{ flows: SluggedFlow[]; rules: SluggedEval[] }> => {
  const flowRows = await db.select().from(flows).orderBy(flows.createdAt, flows.id);
  const evalRows = await db.select().from(evals).orderBy(evals.createdAt, evals.id);
  const flowSlugs = assignSlugs(flowRows, (r) => r.slug, (r) => r.name);
  const ruleSlugs = assignSlugs(evalRows, (r) => r.slug, (r) => r.name);
  return {
    flows: flowRows.map((row) => ({ row, slug: flowSlugs.get(row)! })),
    rules: evalRows.map((row) => ({ row, slug: ruleSlugs.get(row)! })),
  };
};

/**
 * Field-level diff for one flow entry against its target row. PORTABLE fields
 * only — the LOCAL-ONLY `run` recipe is deliberately never read here (or in
 * apply), so a push can never turn it into server state.
 */
const diffFlow = (file: ArtifactFlow, target: SluggedFlow): string[] => {
  const changes: string[] = [];
  const t = target.row;
  if (file.name !== undefined && file.name !== t.name) changes.push(`name ${JSON.stringify(t.name)}→${JSON.stringify(file.name)}`);
  if (file.description !== t.description) changes.push('description');
  if (!sameSelector(file.membership.selector ?? null, parseSelector(t.selector))) changes.push('selector');
  if ((file.membership.rule ?? null) !== t.rule) changes.push('membership rule');
  if (t.status !== 'active') changes.push('status archived→active');
  return changes;
};

/** Field-level diff for one rule entry against its target row (flow binding resolved via slugs). */
const diffRule = (file: ArtifactRule, target: SluggedEval, targetFlowSlugById: Map<string, string>): string[] => {
  const changes: string[] = [];
  const t = target.row;
  if (file.text !== t.text) changes.push('text');
  // Location is carried by anchors; `source` (code|promoted) is derived from
  // them, so comparing anchors captures a provenance change too.
  const fileAnchors = file.anchors ?? null;
  if (JSON.stringify(fileAnchors) !== JSON.stringify(t.anchors)) {
    changes.push(`anchors ${t.anchors?.[0]?.file ?? '(custom)'}→${fileAnchors?.[0]?.file ?? '(custom)'}`);
  }
  if (file.name !== undefined && file.name !== t.name) changes.push('name');
  if (file.description !== undefined && file.description !== t.description) changes.push('description');
  if ((file.judge ?? null) !== t.judgeModel) changes.push(`judge ${t.judgeModel ?? '(default)'}→${file.judge ?? '(default)'}`);
  if ((file.threshold ?? null) !== t.threshold) changes.push(`threshold ${t.threshold ?? 1}→${file.threshold ?? 1}`);
  const targetFlowSlug = t.flowId !== null ? (targetFlowSlugById.get(t.flowId) ?? null) : null;
  if ((file.flow ?? null) !== targetFlowSlug) changes.push(`flow ${targetFlowSlug ?? '(global)'}→${file.flow ?? '(global)'}`);
  return changes;
};

/**
 * Diff the artifact against the target — dbt/terraform-style, side-effect-free:
 * in file, not on target → create; in both, changed → update; on target (live),
 * not in file → prune (which `applyImport` only executes under `prune: true`;
 * a pruned flow is ARCHIVED, a pruned rule is DELETED — a rule has no archived
 * state to fall back to).
 */
export const planImport = async (db: CoachDb, artifact: Artifact): Promise<ImportPlan> => {
  const target = await loadTarget(db);
  const targetFlowsBySlug = new Map(target.flows.map((f) => [f.slug, f]));
  const targetRulesBySlug = new Map(target.rules.map((r) => [r.slug, r]));
  const targetFlowSlugById = new Map(target.flows.map((f) => [f.row.id, f.slug]));

  const actions: PlanAction[] = [];
  for (const flow of artifact.flows) {
    const existing = targetFlowsBySlug.get(flow.id);
    if (!existing) {
      actions.push({ op: 'create', kind: 'flow', id: flow.id, changes: [] });
      continue;
    }
    const changes = diffFlow(flow, existing);
    actions.push({ op: changes.length > 0 ? 'update' : 'noop', kind: 'flow', id: flow.id, changes });
  }
  for (const rule of artifact.rules) {
    const existing = targetRulesBySlug.get(rule.id);
    if (!existing) {
      actions.push({ op: 'create', kind: 'rule', id: rule.id, changes: [] });
      continue;
    }
    const changes = diffRule(rule, existing, targetFlowSlugById);
    actions.push({ op: changes.length > 0 ? 'update' : 'noop', kind: 'rule', id: rule.id, changes });
  }

  // Live target rows the file doesn't mention: prune candidates. Archived flows
  // are this target's local history — never re-flagged. Every rule is live, so
  // any rule missing from the file is a prune (delete) candidate.
  const fileFlowSlugs = new Set(artifact.flows.map((f) => f.id));
  const fileRuleSlugs = new Set(artifact.rules.map((r) => r.id));
  for (const f of target.flows) {
    if (f.row.status === 'active' && !fileFlowSlugs.has(f.slug)) {
      actions.push({ op: 'prune', kind: 'flow', id: f.slug, changes: ['archive on target'] });
    }
  }
  for (const r of target.rules) {
    if (!fileRuleSlugs.has(r.slug)) {
      actions.push({ op: 'prune', kind: 'rule', id: r.slug, changes: ['delete on target'] });
    }
  }

  const summary = { create: 0, update: 0, prune: 0, noop: 0 };
  for (const a of actions) summary[a.op] += 1;
  return { actions, summary };
};

/** What applying an import produced: the executed plan + whether an LLM classify backfill is due. */
export type ImportResult = ImportPlan & {
  applied: true;
  /** True when a flow's LLM membership definition changed — the caller schedules the classify sweep. */
  llmDefinitionChanged: boolean;
  /** True when `prune: false` left unmentioned live rows on the target (surfaced as a warning). */
  skippedPrunes: number;
};

/**
 * Execute the plan: create/update flows first (rules bind to them by slug),
 * then rules, then prunes (archive-only) when `prune` is set. Flow writes go
 * through `createFlow`/`updateFlow` so selector materialization and stale-LLM-
 * membership invariants hold; eval writes are direct column updates. Idempotent:
 * a second apply of the same file plans all-noop.
 */
export const applyImport = async (
  db: CoachDb,
  artifact: Artifact,
  opts: { prune: boolean },
): Promise<ImportResult> => {
  const plan = await planImport(db, artifact);
  const byKey = new Map(plan.actions.map((a) => [`${a.kind}:${a.id}`, a]));
  let llmDefinitionChanged = false;

  const target = await loadTarget(db);
  const targetFlowsBySlug = new Map(target.flows.map((f) => [f.slug, f]));
  const targetRulesBySlug = new Map(target.rules.map((r) => [r.slug, r]));

  // Flows first — rule creation below resolves flow slugs to row ids.
  const flowIdBySlug = new Map(target.flows.map((f) => [f.slug, f.row.id]));
  for (const flow of artifact.flows) {
    const action = byKey.get(`flow:${flow.id}`)!;
    if (action.op === 'create') {
      const created = await createFlow(db, {
        name: flow.name ?? nameFromSlug(flow.id),
        description: flow.description,
        selector: flow.membership.selector ?? null,
        rule: flow.membership.rule ?? null,
      });
      await db.update(flows).set({ slug: flow.id }).where(eq(flows.id, created.id));
      flowIdBySlug.set(flow.id, created.id);
      if (created.classify === 'llm') llmDefinitionChanged = true;
    } else if (action.op === 'update') {
      const existing = targetFlowsBySlug.get(flow.id)!;
      const rule = flow.membership.rule ?? null;
      const selector = flow.membership.selector ?? null;
      const result = await updateFlow(db, existing.row.id, {
        ...(flow.name !== undefined ? { name: flow.name } : {}),
        description: flow.description,
        selector,
        rule,
        classify: rule !== null ? 'llm' : 'selector',
        status: 'active',
      });
      if (!result.ok) throw new Error(`could not update flow ${flow.id}: ${result.reason}`);
      if (result.llmDefinitionChanged) llmDefinitionChanged = true;
      if (existing.row.slug !== flow.id) {
        await db.update(flows).set({ slug: flow.id }).where(eq(flows.id, existing.row.id));
      }
    }
  }

  for (const rule of artifact.rules) {
    const action = byKey.get(`rule:${rule.id}`)!;
    const flowId = rule.flow != null ? flowIdBySlug.get(rule.flow) : null;
    if (rule.flow != null && flowId === undefined) {
      throw new Error(`rule ${rule.id} references flow ${rule.flow}, which is neither in the file nor on the target`);
    }
    if (action.op === 'create') {
      await createManualEval(db, {
        name: rule.name ?? nameFromSlug(rule.id),
        text: rule.text,
        description: rule.description,
        flowId: flowId ?? undefined,
        anchors: rule.anchors ?? null,
        threshold: rule.threshold ?? undefined,
        judgeModel: rule.judge ?? undefined,
        slug: rule.id,
      });
    } else if (action.op === 'update') {
      const existing = targetRulesBySlug.get(rule.id)!;
      const anchors = rule.anchors ?? null;
      await db
        .update(evals)
        .set({
          text: rule.text,
          anchors,
          // Provenance is derived from anchors (a file-anchored rule is `code`).
          source: sourceFromAnchors(anchors),
          flowId: flowId ?? null,
          threshold: rule.threshold ?? null,
          judgeModel: rule.judge ?? null,
          slug: rule.id,
          ...(rule.name !== undefined ? { name: rule.name } : {}),
          ...(rule.description !== undefined ? { description: rule.description } : {}),
        })
        .where(eq(evals.id, existing.row.id));
    }
  }

  let skippedPrunes = 0;
  for (const action of plan.actions) {
    if (action.op !== 'prune') continue;
    if (!opts.prune) {
      skippedPrunes += 1;
      continue;
    }
    if (action.kind === 'flow') {
      const existing = targetFlowsBySlug.get(action.id);
      if (existing) await db.update(flows).set({ status: 'archived', updatedAt: new Date() }).where(eq(flows.id, existing.row.id));
    } else {
      // A rule has no archived state — a prune is a hard delete (with its verdicts).
      const existing = targetRulesBySlug.get(action.id);
      if (existing) await deleteEval(db, existing.row.id);
    }
  }

  return { ...plan, applied: true, llmDefinitionChanged, skippedPrunes };
};
