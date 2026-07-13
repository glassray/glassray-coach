/**
 * glassray resource commands — the agent-facing half of the CLI (imported by
 * bin/glassray.mjs). A zero-dependency plain-ESM loopback client for the Coach
 * HTTP API.
 *
 * Output contract (strict): stdout carries EXACTLY the API's JSON response,
 * pretty-printed with JSON.stringify(body, null, 2) — nothing else. All
 * human-readable messages (errors, progress) go to stderr. Exit codes:
 * 0 success · 1 API/validation error · 2 cannot reach a Coach server.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GUIDES, MODE_ERR, bold, cross, dim, link } from './ui.mjs';

/** Poll cadence for GET /api/runs/:id while a background run is still pending. */
const POLL_INTERVAL_MS = 1500;

/** Default wall-clock budget (seconds) for the waiting verbs; override with --timeout <s>. */
const DEFAULT_TIMEOUT_SEC = 180;

/** Flags every command tolerates: --port may sit anywhere in argv (the dispatcher already resolved it). */
const BASE_OPTIONS = { port: { type: 'string' } };

/** Shared flag set for the run-waiting verbs (--no-wait / --timeout <seconds>). */
const WAIT_OPTIONS = { 'no-wait': { type: 'boolean', default: false }, timeout: { type: 'string' } };

/** Per-resource usage one-liners echoed alongside validation errors. */
const USAGE = {
  traces:
    'glassray-coach traces list [--q <s>] [--agent <s>] [--status ok|error] [--flow <id>] [--label <s>] [--limit <n>] [--offset <n>] | get <id> | tail',
  stats: 'glassray-coach stats',
  usage: 'glassray-coach usage',
  flows:
    "glassray-coach flows list [--status active|archived|all] | get <id> | create --name <s> [--description <s>] [--rule <s>] [--classify selector|llm] [--selector '<json>'] [--created-by user|claude] | update <id> [--name <s>] [--description <s>] [--rule <s>|--no-rule] [--classify selector|llm] [--selector '<json>'|--no-selector] [--status active|archived] | delete <id> | audit <id> | discover [--code-root <path>] [--file glassray.yaml] [--no-wait] [--timeout <s>]",
  evals:
    'glassray-coach evals list | get <id> | create (--deviation <id> [--flow <id>]) or (--name <s> --text <s> [--description <s>] [--flow <id>] [--source-file <path>] [--threshold <0..1>] [--judge <model>] [--autorun-threshold <n>]) | update <id> [--flow <id>|--no-flow] [--source-file <path>|--no-source-file] [--threshold <0..1>|--no-threshold] [--judge <model>|--no-judge] [--autorun-threshold <n>] | run <id> [--sample <n>] [--model <s>] [--no-wait] [--timeout <s>] | delete <id>',
  deviations: 'glassray-coach deviations list | get <id> | resolve <id> [--reopen]',
  discovery: 'glassray-coach discovery run [--sample <n>] [--flow <id>] [--no-wait] [--timeout <s>]',
  fix: 'glassray-coach fix <deviationId> [--no-wait] [--timeout <s>]',
  runs: 'glassray-coach runs list [--limit <n>] | get <id> | cancel <id>',
  pull: 'glassray-coach pull [--from local|cloud] [--out glassray.yaml] | --as-fixtures [--flow <id>] [--limit <n>] [--dir glassray/fixtures] | --traces <flow> [-n <count>] [--inputs-dir glassray/inputs]',
  push: 'glassray-coach push [--file glassray.yaml] [--dry-run] [--prune] [--target local]',
  check: 'glassray-coach check [--fixtures] [--dir glassray/fixtures] [--sample <n>] [--timeout <s>]',
  run: 'glassray-coach run <flow> --label <name> [--file glassray.yaml]',
  compare:
    'glassray-coach compare [<flow>] <baseline> <candidate> [--flow <id>] [--sample <n>] [--no-wait] [--timeout <s>] — a bare corpus is a run label; prefixed forms: agent:<name> · flow:<id> · fixtures:<dir>',
  link: 'glassray-coach link <project> [--endpoint <url>] [--token <t>] | link --show',
};

/**
 * The active progress line's clear function (set while a waiting verb polls) —
 * every error exit calls it so a ✗ line never lands appended to a half-drawn
 * progress line.
 */
let clearActiveProgress = null;

/** Exit 1 with a red-✗ error line on stderr (API and validation failures). */
const fail = (message) => {
  clearActiveProgress?.();
  console.error(`${cross()} ${message}`);
  process.exit(1);
};

/** Exit 1 with a validation message plus the resource's usage line. */
const usageFail = (resource, message) => {
  console.error(`${cross()} ${message}`);
  console.error(`  usage: ${USAGE[resource]}`);
  console.error(`  more:  glassray-coach help ${resource}`);
  process.exit(1);
};

/** Exit 2 with a pointer to start the server — used whenever the loopback fetch itself fails. */
const failUnreachable = (port) => {
  clearActiveProgress?.();
  console.error(`${cross()} cannot reach a Coach server on port ${port} — run \`npx @glassray/coach start\` first`);
  console.error(`  quickstart: ${link(GUIDES.quickstart, MODE_ERR)}`);
  process.exit(2);
};

/**
 * Print one resource's help block (assembled from the same USAGE strings the
 * error paths use, so help can never drift from what actually parses). Used by
 * `glassray-coach help <resource>` and `glassray-coach <resource> --help`.
 */
export const printHelp = (resource) => {
  const variants = USAGE[resource].split(' | ');
  console.log('');
  console.log(`  ${bold(`glassray ${resource}`)}`);
  console.log('');
  for (const variant of variants) {
    console.log(`    ${variant.startsWith('glassray') ? variant : `glassray ${resource} ${variant}`}`);
  }
  console.log('');
  console.log(`    ${dim('Long verbs poll the run to done; --no-wait returns the 202 immediately; --timeout <s> bounds the wait (default 180s).')}`);
  console.log(`    ${dim('All commands take --port <n> (default 5899, or $GLASSRAY_PORT). stdout is the API JSON, verbatim.')}`);
  console.log(`    Docs: ${link(GUIDES.cli)}`);
  console.log('');
};

/** The ONE stdout writer: the API's JSON body, pretty-printed, nothing else. */
const printJson = (body) => {
  console.log(JSON.stringify(body, null, 2));
};

/**
 * Call the Coach API over loopback. A network failure exits 2; a non-2xx
 * response prints the API's error message to stderr and exits 1; otherwise the
 * parsed JSON body is returned.
 */
const api = async (port, pathname, init) => {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  } catch {
    failUnreachable(port);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  if (!res.ok) {
    fail(typeof body?.error === 'string' ? body.error : `${res.status} ${res.statusText} from ${pathname}`);
  }
  return body ?? {};
};

/** POST-JSON helper (every Coach POST body is application/json; `{}` keeps empty POSTs parseable). */
const post = (port, pathname, body = {}) =>
  api(port, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** PATCH-JSON helper. */
const patch = (port, pathname, body) =>
  api(port, pathname, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Strict per-command flag parsing; an unknown/malformed flag exits 1 with the resource usage. */
const parseFlags = (resource, args, options) => {
  try {
    return parseArgs({ args, options: { ...BASE_OPTIONS, ...options }, allowPositionals: true });
  } catch (err) {
    return usageFail(resource, err instanceof Error ? err.message : String(err));
  }
};

/** Require the id positional after a verb, or exit 1 with the resource usage. */
const requireId = (resource, positionals, what = '<id>') => {
  const id = positionals[0];
  if (id === undefined) usageFail(resource, `missing ${what}`);
  return id;
};

/** Parse an integer-valued flag (inclusive minimum) or exit 1. */
const toInt = (resource, flag, value, min = 0) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) usageFail(resource, `--${flag} must be an integer >= ${min} (got "${value}")`);
  return n;
};

/** Parse a 0..1 rate flag (e.g. --threshold 0.95) or exit 1. */
const toRate = (resource, flag, value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) usageFail(resource, `--${flag} must be a number between 0 and 1 (got "${value}")`);
  return n;
};

/** Parse a JSON-valued flag (e.g. --selector '{"agent":"x"}') or exit 1. */
const parseJsonFlag = (resource, flag, value) => {
  try {
    return JSON.parse(value);
  } catch {
    return usageFail(resource, `--${flag} must be valid JSON (got: ${value})`);
  }
};

/** Build a query string from the defined entries only ('' when none are set). */
const toQuery = (entries) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

/** Resolve the shared --no-wait/--timeout flags into { noWait, timeoutSec }. */
const waitOpts = (resource, values) => ({
  noWait: values['no-wait'] === true,
  timeoutSec: values.timeout !== undefined ? toInt(resource, 'timeout', values.timeout, 1) : DEFAULT_TIMEOUT_SEC,
});

/**
 * A single-line, in-place stderr progress indicator for the waiting verbs —
 * only on a TTY (non-TTY stderr keeps the one static "polling" line). The line
 * is deliberately uncolored so its width math stays exact.
 */
const makeProgress = () => {
  const active = process.stderr.isTTY === true;
  let lastLength = 0;
  const clear = () => {
    if (!active || lastLength === 0) return;
    process.stderr.write(`\r${' '.repeat(lastLength)}\r`);
    lastLength = 0;
    if (clearActiveProgress === clear) clearActiveProgress = null;
  };
  clearActiveProgress = clear;
  return {
    /** Rewrite the progress line in place. */
    update: (text) => {
      if (!active) return;
      const pad = text.length < lastLength ? ' '.repeat(lastLength - text.length) : '';
      process.stderr.write(`\r${text}${pad}`);
      lastLength = Math.max(lastLength, text.length);
    },
    /** Erase the progress line (always call before printing anything else). */
    clear,
  };
};

/**
 * Poll a background run until it settles, showing live `scanned N/M` progress
 * on a TTY. Returns the run row on 'done'. On 'error': the run's error goes to
 * stderr, the run JSON to stdout, exit 1. On timeout: stderr notes it may still
 * complete (point at `glassray-coach runs get`), exit 1.
 */
const waitForRun = async (port, runId, timeoutSec) => {
  const deadline = Date.now() + timeoutSec * 1000;
  const progress = makeProgress();
  for (;;) {
    const run = await api(port, `/api/runs/${encodeURIComponent(runId)}`);
    if (run.status === 'done') {
      progress.clear();
      return run;
    }
    if (run.status === 'error') {
      progress.clear();
      console.error(`${cross()} run ${runId} failed: ${run.error ?? 'unknown error'}`);
      printJson(run);
      process.exit(1);
    }
    // 'queued' and 'running' are both still-pending.
    if (Date.now() >= deadline) {
      progress.clear();
      console.error(
        `${cross()} run ${runId} did not finish within ${timeoutSec}s — it may still complete; check \`glassray-coach runs get ${runId}\``,
      );
      process.exit(1);
    }
    const scanned = run.stats?.scanned;
    const total = run.stats?.total;
    progress.update(
      `● ${run.kind ?? 'run'} ${run.status}${typeof scanned === 'number' && typeof total === 'number' ? ` — scanned ${scanned}/${total}` : ''} …`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

/**
 * POST an enqueue endpoint (202 { runId, status }) and wait for the run.
 * --no-wait prints the 202 body instead. When `after` is given, its result
 * replaces the finished run as the stdout payload (e.g. re-fetching the eval).
 */
const enqueueAndWait = async (port, pathname, body, { noWait, timeoutSec }, after) => {
  const accepted = await post(port, pathname, body);
  if (noWait) return printJson(accepted);
  console.error(dim(`run ${accepted.runId} ${accepted.status} — polling until done (timeout ${timeoutSec}s)`, MODE_ERR));
  const run = await waitForRun(port, accepted.runId, timeoutSec);
  printJson(after ? await after(run) : run);
};

/** Stream GET /api/tail (SSE) as ndjson on stdout until killed; comment/heartbeat frames are skipped. */
const tailTraces = async (port) => {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/tail`, { headers: { accept: 'text/event-stream' } });
  } catch {
    failUnreachable(port);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    fail(typeof body?.error === 'string' ? body.error : `${res.status} ${res.statusText} from /api/tail`);
  }
  console.error(`tailing traces on port ${port} — press Ctrl-C to stop`);
  const decoder = new TextDecoder();
  let buffer = '';
  // An abruptly killed server rejects the body iterator (ECONNRESET / terminated)
  // — that is the same "server went away" outcome as a clean close, not a crash.
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // An SSE frame's payload is its `data:` lines joined; comment lines (': …') carry none.
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data === '') continue;
        try {
          console.log(JSON.stringify(JSON.parse(data)));
        } catch {
          // Not JSON — skip rather than corrupt the ndjson stream.
        }
      }
    }
  } catch {
    // Fall through to the shared stream-closed exit below.
  }
  console.error('error: the tail stream closed — the Coach server stopped');
  process.exit(2);
};

/** `glassray-coach traces list|get <id>|tail` — trace listing, detail, and the live SSE tail. */
export const cmdTraces = async ({ port, args }) => {
  const verb = args[0];
  if (verb === 'list') {
    const { values } = parseFlags('traces', args.slice(1), {
      q: { type: 'string' },
      agent: { type: 'string' },
      status: { type: 'string' },
      flow: { type: 'string' },
      label: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
    });
    const query = toQuery({
      q: values.q,
      agent: values.agent,
      status: values.status,
      flow: values.flow,
      label: values.label,
      limit: values.limit,
      offset: values.offset,
    });
    return printJson(await api(port, `/api/traces${query}`));
  }
  if (verb === 'get') {
    const { positionals } = parseFlags('traces', args.slice(1), {});
    const id = requireId('traces', positionals);
    return printJson(await api(port, `/api/traces/${encodeURIComponent(id)}`));
  }
  if (verb === 'tail') return tailTraces(port);
  return usageFail('traces', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
};

/** `glassray-coach stats` — GET /api/stats. */
export const cmdStats = async ({ port, args }) => {
  parseFlags('stats', args, {});
  printJson(await api(port, '/api/stats'));
};

/** `glassray-coach usage` — GET /api/usage (LLM spend summary). */
export const cmdUsage = async ({ port, args }) => {
  parseFlags('usage', args, {});
  printJson(await api(port, '/api/usage'));
};

/** `glassray-coach flows …` — durable-flow CRUD, audit, and the flow-discovery run. */
export const cmdFlows = async ({ port, args }) => {
  const verb = args[0];
  switch (verb) {
    case 'list': {
      const { values } = parseFlags('flows', args.slice(1), { status: { type: 'string' } });
      return printJson(await api(port, `/api/flows${toQuery({ status: values.status })}`));
    }
    case 'get': {
      const { positionals } = parseFlags('flows', args.slice(1), {});
      const id = requireId('flows', positionals);
      return printJson(await api(port, `/api/flows/${encodeURIComponent(id)}`));
    }
    case 'create': {
      const { values } = parseFlags('flows', args.slice(1), {
        name: { type: 'string' },
        description: { type: 'string' },
        rule: { type: 'string' },
        classify: { type: 'string' },
        selector: { type: 'string' },
        'created-by': { type: 'string' },
      });
      if (values.name === undefined) usageFail('flows', 'create requires --name');
      const body = { name: values.name };
      if (values.description !== undefined) body.description = values.description;
      if (values.rule !== undefined) body.rule = values.rule;
      if (values.classify !== undefined) body.classify = values.classify;
      if (values.selector !== undefined) body.selector = parseJsonFlag('flows', 'selector', values.selector);
      if (values['created-by'] !== undefined) body.createdBy = values['created-by'];
      return printJson(await post(port, '/api/flows', body));
    }
    case 'update': {
      const { values, positionals } = parseFlags('flows', args.slice(1), {
        name: { type: 'string' },
        description: { type: 'string' },
        rule: { type: 'string' },
        'no-rule': { type: 'boolean', default: false },
        classify: { type: 'string' },
        selector: { type: 'string' },
        'no-selector': { type: 'boolean', default: false },
        status: { type: 'string' },
      });
      const id = requireId('flows', positionals);
      if (values.rule !== undefined && values['no-rule']) usageFail('flows', 'pass either --rule or --no-rule, not both');
      if (values.selector !== undefined && values['no-selector']) {
        usageFail('flows', 'pass either --selector or --no-selector, not both');
      }
      const body = {};
      if (values.name !== undefined) body.name = values.name;
      if (values.description !== undefined) body.description = values.description;
      if (values.rule !== undefined) body.rule = values.rule;
      if (values['no-rule']) body.rule = null;
      if (values.classify !== undefined) body.classify = values.classify;
      if (values.selector !== undefined) body.selector = parseJsonFlag('flows', 'selector', values.selector);
      if (values['no-selector']) body.selector = null;
      if (values.status !== undefined) body.status = values.status;
      return printJson(await patch(port, `/api/flows/${encodeURIComponent(id)}`, body));
    }
    case 'delete': {
      const { positionals } = parseFlags('flows', args.slice(1), {});
      const id = requireId('flows', positionals);
      return printJson(await api(port, `/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    }
    case 'audit': {
      const { positionals } = parseFlags('flows', args.slice(1), {});
      const id = requireId('flows', positionals);
      return printJson(await api(port, `/api/flows/${encodeURIComponent(id)}/audit`));
    }
    case 'discover': {
      // Discover flows FROM CODE: resolve the repo root to scan from glassray.yaml's
      // `codeRoot` (or --code-root), make it absolute, and hand it to the server.
      const { values } = parseFlags('flows', args.slice(1), {
        ...WAIT_OPTIONS,
        file: { type: 'string' },
        'code-root': { type: 'string' },
      });
      const body = {};
      if (values['code-root']) {
        body.codeRoot = path.resolve(values['code-root']);
      } else {
        const file = values.file ?? ARTIFACT_FILE;
        const text = await readArtifactFileText(file);
        if (text !== null) {
          try {
            const { artifact } = await post(port, '/api/artifact/parse', { yaml: text });
            if (artifact?.codeRoot) body.codeRoot = path.resolve(path.dirname(file), artifact.codeRoot);
          } catch {
            // Fall through with no codeRoot — the server resolves from its own cwd,
            // or returns a helpful 400 telling the user to set codeRoot.
          }
        }
      }
      return enqueueAndWait(port, '/api/flows/run', body, waitOpts('flows', values));
    }
    default:
      return usageFail('flows', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
  }
};

/** `glassray-coach evals …` — eval CRUD plus judged runs (run waits, then prints the eval with its verdicts). */
export const cmdEvals = async ({ port, args }) => {
  const verb = args[0];
  switch (verb) {
    case 'list': {
      parseFlags('evals', args.slice(1), {});
      return printJson(await api(port, '/api/evals'));
    }
    case 'get': {
      const { positionals } = parseFlags('evals', args.slice(1), {});
      const id = requireId('evals', positionals);
      return printJson(await api(port, `/api/evals/${encodeURIComponent(id)}`));
    }
    case 'create': {
      const { values } = parseFlags('evals', args.slice(1), {
        deviation: { type: 'string' },
        flow: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
        description: { type: 'string' },
        'source-file': { type: 'string' },
        threshold: { type: 'string' },
        judge: { type: 'string' },
        'autorun-threshold': { type: 'string' },
      });
      let body;
      if (values.deviation !== undefined) {
        if (
          values.name !== undefined ||
          values.text !== undefined ||
          values.description !== undefined ||
          values['source-file'] !== undefined ||
          values.threshold !== undefined ||
          values.judge !== undefined ||
          values['autorun-threshold'] !== undefined
        ) {
          usageFail('evals', '--deviation only combines with --flow (the deviation supplies the name/text; it lands as a promoted rule)');
        }
        body = { deviationId: values.deviation };
      } else {
        if (values.name === undefined || values.text === undefined) {
          usageFail('evals', 'create needs --deviation <id>, or both --name and --text');
        }
        body = { name: values.name, text: values.text };
        if (values.description !== undefined) body.description = values.description;
        // A --source-file path becomes the rule's single code anchor (source: 'code').
        if (values['source-file'] !== undefined) body.anchors = [{ file: values['source-file'] }];
        if (values.threshold !== undefined) body.threshold = toRate('evals', 'threshold', values.threshold);
        if (values.judge !== undefined) body.judgeModel = values.judge;
        if (values['autorun-threshold'] !== undefined) {
          body.autorunThreshold = toInt('evals', 'autorun-threshold', values['autorun-threshold'], 1);
        }
      }
      if (values.flow !== undefined) body.flowId = values.flow;
      return printJson(await post(port, '/api/evals', body));
    }
    case 'update': {
      const { values, positionals } = parseFlags('evals', args.slice(1), {
        flow: { type: 'string' },
        'no-flow': { type: 'boolean', default: false },
        'source-file': { type: 'string' },
        'no-source-file': { type: 'boolean', default: false },
        threshold: { type: 'string' },
        'no-threshold': { type: 'boolean', default: false },
        judge: { type: 'string' },
        'no-judge': { type: 'boolean', default: false },
        'autorun-threshold': { type: 'string' },
      });
      const id = requireId('evals', positionals);
      if (values.flow !== undefined && values['no-flow']) usageFail('evals', 'pass either --flow or --no-flow, not both');
      if (values['source-file'] !== undefined && values['no-source-file']) {
        usageFail('evals', 'pass either --source-file or --no-source-file, not both');
      }
      if (values.threshold !== undefined && values['no-threshold']) {
        usageFail('evals', 'pass either --threshold or --no-threshold, not both');
      }
      if (values.judge !== undefined && values['no-judge']) usageFail('evals', 'pass either --judge or --no-judge, not both');
      const body = {};
      if (values.flow !== undefined) body.flowId = values.flow;
      if (values['no-flow']) body.flowId = null;
      if (values['source-file'] !== undefined) body.anchors = [{ file: values['source-file'] }];
      if (values['no-source-file']) body.anchors = null;
      if (values.threshold !== undefined) body.threshold = toRate('evals', 'threshold', values.threshold);
      if (values['no-threshold']) body.threshold = null;
      if (values.judge !== undefined) body.judgeModel = values.judge;
      if (values['no-judge']) body.judgeModel = null;
      if (values['autorun-threshold'] !== undefined) {
        body.autorunThreshold = toInt('evals', 'autorun-threshold', values['autorun-threshold'], 1);
      }
      return printJson(await patch(port, `/api/evals/${encodeURIComponent(id)}`, body));
    }
    case 'run': {
      const { values, positionals } = parseFlags('evals', args.slice(1), {
        sample: { type: 'string' },
        model: { type: 'string' },
        ...WAIT_OPTIONS,
      });
      const id = requireId('evals', positionals);
      const body = {};
      if (values.sample !== undefined) body.sampleSize = toInt('evals', 'sample', values.sample, 1);
      if (values.model !== undefined) body.model = values.model;
      // After the run lands, the eval detail (with its verdicts) is the payload the caller wants.
      return enqueueAndWait(port, `/api/evals/${encodeURIComponent(id)}/run`, body, waitOpts('evals', values), () =>
        api(port, `/api/evals/${encodeURIComponent(id)}`),
      );
    }
    case 'delete': {
      const { positionals } = parseFlags('evals', args.slice(1), {});
      const id = requireId('evals', positionals);
      return printJson(await api(port, `/api/evals/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    }
    default:
      return usageFail('evals', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
  }
};

/** `glassray-coach deviations list|get <id>|resolve <id> [--reopen]`. */
export const cmdDeviations = async ({ port, args }) => {
  const verb = args[0];
  switch (verb) {
    case 'list': {
      parseFlags('deviations', args.slice(1), {});
      return printJson(await api(port, '/api/deviations'));
    }
    case 'get': {
      const { positionals } = parseFlags('deviations', args.slice(1), {});
      const id = requireId('deviations', positionals);
      return printJson(await api(port, `/api/deviations/${encodeURIComponent(id)}`));
    }
    case 'resolve': {
      const { values, positionals } = parseFlags('deviations', args.slice(1), {
        reopen: { type: 'boolean', default: false },
      });
      const id = requireId('deviations', positionals);
      const action = values.reopen ? 'reopen' : 'resolve';
      return printJson(await post(port, `/api/deviations/${encodeURIComponent(id)}/${action}`));
    }
    default:
      return usageFail('deviations', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
  }
};

/** `glassray-coach discovery run [--sample <n>] [--flow <id>]` — deviation discovery over recent traces. */
export const cmdDiscovery = async ({ port, args }) => {
  const verb = args[0];
  if (verb !== 'run') return usageFail('discovery', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
  const { values } = parseFlags('discovery', args.slice(1), {
    sample: { type: 'string' },
    flow: { type: 'string' },
    ...WAIT_OPTIONS,
  });
  const body = {};
  if (values.sample !== undefined) body.sampleSize = toInt('discovery', 'sample', values.sample, 1);
  if (values.flow !== undefined) body.flowId = values.flow;
  return enqueueAndWait(port, '/api/discovery/run', body, waitOpts('discovery', values));
};

/** `glassray-coach fix <deviationId>` — run the improver, then print the deviation (it carries fixMarkdown). */
export const cmdFix = async ({ port, args }) => {
  const { values, positionals } = parseFlags('fix', args, WAIT_OPTIONS);
  const id = requireId('fix', positionals, '<deviationId>');
  return enqueueAndWait(port, `/api/deviations/${encodeURIComponent(id)}/fix`, {}, waitOpts('fix', values), () =>
    api(port, `/api/deviations/${encodeURIComponent(id)}`),
  );
};

// ── the portable rule artifact: pull / push / check / compare ────────────────
// (glassray.yaml round-trips the flows + rules between the repo and a target;
// fixtures freeze golden traces; check is the CI gate; compare is the
// change-with-confidence A/B.)

/** Default artifact file name, relative to the cwd. */
const ARTIFACT_FILE = 'glassray.yaml';

/** Default fixtures directory, relative to the cwd (mirrors the artifact's `fixtures.path`). */
const FIXTURES_DIR = path.join('glassray', 'fixtures');

/** CLI-side name→slug, mirroring the server's `slugify` so fixture dirs and flow slugs agree. */
const slugifyName = (name) => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'unnamed';
};

/** A flow row's effective artifact slug (stored slug wins; else derived from the name). */
const flowSlug = (flow) => flow.slug ?? slugifyName(flow.name);

/** One dim status line on stderr (never stdout — that stays pure JSON). */
const note = (message) => console.error(dim(message, MODE_ERR));

/**
 * Read a fixtures directory (one subdir per flow slug, one `<traceId>.json`
 * OTLP envelope per trace). Returns `[{ slug, fixtures: [{ traceId, envelope }] }]`;
 * exits 1 when the directory doesn't exist or holds no fixtures.
 */
const readFixturesDir = async (resource, dir) => {
  let slugs;
  try {
    slugs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return fail(`no fixtures directory at ${dir} — run \`glassray-coach pull --as-fixtures\` first`);
  }
  const groups = [];
  for (const slug of slugs) {
    const files = (await readdir(path.join(dir, slug))).filter((f) => f.endsWith('.json'));
    const fixtures = [];
    for (const file of files) {
      const traceId = path.basename(file, '.json').toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(traceId)) {
        console.error(`${cross()} skipping ${path.join(dir, slug, file)} — file name is not a 32-hex trace id`);
        continue;
      }
      let envelope;
      try {
        envelope = JSON.parse(await readFile(path.join(dir, slug, file), 'utf8'));
      } catch {
        return fail(`${path.join(dir, slug, file)} is not valid JSON`);
      }
      fixtures.push({ traceId, envelope });
    }
    if (fixtures.length > 0) groups.push({ slug, fixtures });
  }
  if (groups.length === 0) return fail(`no fixtures found under ${dir} — run \`glassray-coach pull --as-fixtures\` first`);
  void resource;
  return groups;
};

/**
 * Re-ingest fixture envelopes so the server can score them: same trace ids ⇒
 * the merge-upsert is idempotent and the corpus is exactly the committed set.
 * Returns trace ids grouped by flow slug plus the flat union.
 */
const ingestFixtures = async (port, groups) => {
  const info = await api(port, '/api/info');
  const bySlug = new Map();
  const all = [];
  for (const group of groups) {
    const ids = [];
    for (const { traceId, envelope } of group.fixtures) {
      await api(port, '/v1/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.apiKey}` },
        body: JSON.stringify(envelope),
      });
      ids.push(traceId);
      all.push(traceId);
    }
    bySlug.set(group.slug, ids);
  }
  return { bySlug, all };
};

/** Default pinned-inputs directory for cloud-pulled traces (`run.inputs` per flow lives under here). */
const INPUTS_DIR = path.join('glassray', 'inputs');

/** Where `glassray-coach link` records the cloud project ref + auth (mirrors bin/glassray.mjs's home resolution). */
const linkFilePath = () =>
  path.join(process.env.GLASSRAY_HOME ?? path.join(homedir(), '.glassray'), 'cloud-link.json');

/** Read the cloud link, or exit 1 with the setup hint. */
const readLink = async () => {
  try {
    const parsed = JSON.parse(await readFile(linkFilePath(), 'utf8'));
    if (typeof parsed?.project === 'string' && typeof parsed?.endpoint === 'string') return parsed;
  } catch {
    // Fall through to the shared failure below.
  }
  return fail('no cloud project linked — run `glassray-coach link <project> [--endpoint <url>] [--token <t>]` first');
};

/**
 * GET a cloud endpoint under the linked project (bearer auth from the link
 * file, `GLASSRAY_CLOUD_TOKEN` as the override). Exit 1 with the API's error
 * on non-2xx, exit 2 when the endpoint is unreachable.
 */
const cloudGet = async (linkInfo, pathname) => {
  const token = process.env.GLASSRAY_CLOUD_TOKEN ?? linkInfo.token;
  let res;
  try {
    res = await fetch(`${linkInfo.endpoint.replace(/\/$/, '')}${pathname}`, {
      headers: {
        accept: 'application/json',
        'x-glassray-project': linkInfo.project,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    clearActiveProgress?.();
    console.error(`${cross()} cannot reach the linked cloud endpoint ${linkInfo.endpoint}`);
    process.exit(2);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  if (!res.ok) {
    fail(typeof body?.error === 'string' ? body.error : `${res.status} ${res.statusText} from cloud ${pathname}`);
  }
  return body ?? {};
};

/** Read the repo's existing artifact file text, or null when it doesn't exist yet. */
const readArtifactFileText = async (file) => {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Extract a trace's input for the pinned-inputs dir: the root span's input,
 * else the first `llm` descendant's, else the input preview. Null when the
 * trace carries none (scrubbed/truncated tracing — the fidelity caveat).
 */
const extractTraceInput = (view) => {
  const nonEmpty = (v) =>
    v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '') ? v : null;
  const rootInput = nonEmpty(view?.tree?.input);
  if (rootInput !== null) return rootInput;
  const stack = view?.tree ? [view.tree] : [];
  while (stack.length > 0) {
    const node = stack.shift();
    if (node?.kind === 'llm') {
      const input = nonEmpty(node.input);
      if (input !== null) return input;
    }
    if (Array.isArray(node?.children)) stack.push(...node.children);
  }
  return nonEmpty(view?.inputPreview);
};

/** `glassray-coach pull` — artifact (local or cloud), `--as-fixtures` golden traces, or `--traces` real cloud corpora. */
export const cmdPull = async ({ port, args }) => {
  const { values } = parseFlags('pull', args, {
    from: { type: 'string' },
    out: { type: 'string' },
    'as-fixtures': { type: 'boolean', default: false },
    flow: { type: 'string' },
    limit: { type: 'string', short: 'n' },
    dir: { type: 'string' },
    traces: { type: 'string' },
    'inputs-dir': { type: 'string' },
  });
  if (values.from !== undefined && values.from !== 'local' && values.from !== 'cloud') {
    usageFail('pull', `--from must be local or cloud (got "${values.from}")`);
  }

  // ── pull --traces <flow>: real cloud traces → local corpus + pinned inputs ──
  if (values.traces !== undefined) {
    const flowRef = values.traces;
    const n = values.limit !== undefined ? toInt('pull', 'limit', values.limit, 1) : 30;
    const linkInfo = await readLink();
    const body = await cloudGet(linkInfo, `/api/flows/${encodeURIComponent(flowRef)}/traces${toQuery({ limit: n })}`);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return fail(`the cloud flow "${flowRef}" returned no traces`);
    const info = await api(port, '/api/info');
    const inputsDir = path.join(values['inputs-dir'] ?? INPUTS_DIR, flowRef);
    await mkdir(inputsDir, { recursive: true });
    let ingested = 0;
    let inputsWritten = 0;
    const skipped = [];
    for (const item of items) {
      // Real production traces land as the `production` corpus (the ingest
      // ?label= override wins over whatever environment the trace carried).
      await api(port, '/v1/traces?label=production', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.apiKey}` },
        body: JSON.stringify(item.raw),
      });
      ingested += 1;
      const detail = await api(port, `/api/traces/${encodeURIComponent(item.traceId)}`);
      const input = extractTraceInput(detail.view);
      if (input === null) {
        // Fidelity caveat: scrubbed/truncated tracing can score the baseline
        // but can't faithfully re-feed the candidate — warn, don't pin.
        skipped.push(item.traceId);
        console.error(`${cross()} ${item.traceId}: no extractable input (scrubbed/truncated tracing?) — skipped from ${inputsDir}`);
        continue;
      }
      await writeFile(
        path.join(inputsDir, `${item.traceId}.json`),
        `${JSON.stringify({ traceId: item.traceId, input }, null, 2)}\n`,
      );
      inputsWritten += 1;
    }
    note(`ingested ${ingested} production trace(s) as corpus 'production'; pinned ${inputsWritten} input(s) into ${inputsDir}`);
    if (skipped.length > 0) note(`${skipped.length} trace(s) had no extractable input — they score the baseline but won't re-run`);
    return printJson({ flow: flowRef, ingested, label: 'production', inputsDir, inputsWritten, skippedInputs: skipped });
  }

  // ── pull --as-fixtures: freeze the matching flows' member traces ────────────
  if (values['as-fixtures']) {
    const dir = values.dir ?? FIXTURES_DIR;
    const limit = values.limit !== undefined ? toInt('pull', 'limit', values.limit, 1) : undefined;
    const flowIds = values.flow !== undefined
      ? [values.flow]
      : (await api(port, '/api/flows')).items.map((f) => f.id);
    if (flowIds.length === 0) return fail('no active flows to freeze fixtures for — create a flow first');
    const written = [];
    for (const flowId of flowIds) {
      const body = await api(port, `/api/flows/${encodeURIComponent(flowId)}/fixtures${toQuery({ limit })}`);
      if (body.items.length === 0) continue;
      const flowDir = path.join(dir, body.flow.slug);
      await mkdir(flowDir, { recursive: true });
      for (const item of body.items) {
        await writeFile(path.join(flowDir, `${item.traceId}.json`), `${JSON.stringify(item.raw, null, 2)}\n`);
      }
      written.push({ flow: body.flow.slug, traces: body.items.length, dir: flowDir });
      note(`froze ${body.items.length} trace(s) into ${flowDir}`);
    }
    if (written.length === 0) return fail('no member traces to freeze — the selected flows are empty');
    return printJson({ written });
  }

  // ── pull the artifact (local server by default, the linked cloud with --from cloud) ──
  if (values.flow !== undefined || values.dir !== undefined) {
    usageFail('pull', '--flow / --dir only combine with --as-fixtures');
  }
  const out = values.out ?? ARTIFACT_FILE;
  // The existing file's LOCAL-ONLY sections (run recipes, fixtures/inputs
  // paths, project ref) survive the pull — the server does the merge.
  const baseYaml = await readArtifactFileText(out);
  let body;
  if (values.from === 'cloud') {
    const linkInfo = await readLink();
    const cloud = await cloudGet(linkInfo, '/api/export');
    if (cloud.artifact === undefined && cloud.yaml === undefined) {
      return fail('the cloud export returned neither an artifact nor yaml — incompatible endpoint?');
    }
    body = await post(port, '/api/export', {
      ...(cloud.artifact !== undefined ? { artifact: cloud.artifact } : {}),
      ...(cloud.artifact === undefined && typeof cloud.yaml === 'string' ? { baseYaml: cloud.yaml } : {}),
      ...(baseYaml !== null ? { baseYaml } : {}),
    });
    // The pulled rules must exist on the LOCAL server too — that's what
    // run/compare/check score against. Apply (never prune) and report.
    const applied = await post(port, '/api/import', { artifact: body.artifact, apply: true });
    note(`applied to local: ${applied.summary.create} create, ${applied.summary.update} update, ${applied.summary.noop} unchanged`);
  } else {
    body = baseYaml !== null ? await post(port, '/api/export', { baseYaml }) : await api(port, '/api/export');
  }
  await writeFile(out, body.yaml);
  note(`wrote ${out} — ${body.artifact.flows.length} flow(s), ${body.artifact.rules.length} rule(s)`);
  return printJson(body.artifact);
};

/**
 * `glassray-coach run <flow> --label <x>` — execute the flow's harness-authored run
 * recipe from glassray.yaml. Coach stays dumb: it spawns `run.command` with
 * `GLASSRAY_ENDPOINT` / `GLASSRAY_API_KEY` / `GLASSRAY_RUN_LABEL` and counts
 * what lands under the label; the runner owns reading `run.inputs`, calling
 * the real flow under @glassray/tracing, and flushing before exit.
 */
export const cmdRun = async ({ port, args }) => {
  const { values, positionals } = parseFlags('run', args, {
    label: { type: 'string' },
    file: { type: 'string' },
  });
  const flowRef = requireId('run', positionals, '<flow>');
  if (values.label === undefined || values.label.trim() === '') usageFail('run', 'run requires --label <name>');
  const label = values.label.trim();
  const file = values.file ?? ARTIFACT_FILE;

  const yaml = await readArtifactFileText(file);
  if (yaml === null) return fail(`cannot read ${file} — author it (or \`glassray-coach pull\`) first`);
  const { artifact } = await post(port, '/api/artifact/parse', { yaml });
  const flow = artifact.flows.find((f) => f.id === flowRef);
  if (!flow) {
    return fail(`flow "${flowRef}" is not in ${file} — flows: ${artifact.flows.map((f) => f.id).join(', ') || '(none)'}`);
  }
  if (!flow.run?.command) {
    return fail(`flow "${flowRef}" has no run recipe — add \`run: { command: … }\` to it in ${file}`);
  }

  const info = await api(port, '/api/info');
  const countForLabel = async () =>
    (await api(port, `/api/traces${toQuery({ label, limit: 1 })}`)).total ?? 0;
  const before = await countForLabel();

  note(`running: ${flow.run.command}  (label '${label}')`);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(flow.run.command, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        GLASSRAY_ENDPOINT: `http://127.0.0.1:${port}`,
        GLASSRAY_API_KEY: info.apiKey,
        GLASSRAY_RUN_LABEL: label,
      },
    });
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) fail(`run command exited with code ${exitCode}`);

  // The runner flushes before exit; give ingest a short grace window anyway.
  let landed = 0;
  const deadline = Date.now() + 5_000;
  for (;;) {
    landed = (await countForLabel()) - before;
    if (landed > 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (landed <= 0) {
    fail(`no traces landed for label '${label}' — is the runner exporting to GLASSRAY_ENDPOINT and flushing before exit?`);
  }
  console.error(`✓ ${landed} traces landed for label '${label}'`);
  return printJson({ flow: flowRef, label, traces: landed });
};

/** `glassray-coach link <project> [--endpoint <url>] [--token <t>]` — record the cloud project ref + auth in $GLASSRAY_HOME. */
export const cmdLink = async ({ args }) => {
  const { values, positionals } = parseFlags('link', args, {
    endpoint: { type: 'string' },
    token: { type: 'string' },
    show: { type: 'boolean', default: false },
  });
  const file = linkFilePath();
  if (values.show) {
    const linkInfo = await readLink();
    return printJson({ project: linkInfo.project, endpoint: linkInfo.endpoint, hasToken: Boolean(linkInfo.token) });
  }
  const project = requireId('link', positionals, '<project>');
  const endpoint = values.endpoint ?? 'https://app.glassray.ai';
  const record = { project, endpoint, ...(values.token !== undefined ? { token: values.token } : {}) };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  note(`linked ${project} at ${endpoint}${values.token !== undefined ? '' : ' (no token stored — set GLASSRAY_CLOUD_TOKEN at pull time)'}`);
  return printJson({ project, endpoint, hasToken: values.token !== undefined });
};

/** `glassray-coach push [--file <file>] [--dry-run] [--prune] [--target local]` — reconcile the file into a target. */
export const cmdPush = async ({ port, args }) => {
  const { values } = parseFlags('push', args, {
    file: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    target: { type: 'string' },
  });
  if (values.target !== undefined && values.target !== 'local') {
    return fail(`--target ${values.target} is not available yet — only the local Coach target exists today`);
  }
  const file = values.file ?? ARTIFACT_FILE;
  let yaml;
  try {
    yaml = await readFile(file, 'utf8');
  } catch {
    return fail(`cannot read ${file} — run \`glassray-coach pull\` first, or pass --file <path>`);
  }
  const body = await post(port, '/api/import', { yaml, apply: !values['dry-run'], prune: values.prune });
  // The terraform-style plan, one line per action, on stderr.
  for (const action of body.actions) {
    if (action.op === 'noop') continue;
    const mark = action.op === 'create' ? '+' : action.op === 'update' ? '~' : '-';
    const detail = action.changes.length > 0 ? ` (${action.changes.join(', ')})` : '';
    console.error(`${mark} ${action.op} ${action.kind} ${action.id}${detail}`);
  }
  const { summary } = body;
  note(
    `${values['dry-run'] ? 'plan only (--dry-run): ' : ''}${summary.create} create, ${summary.update} update, ${summary.prune} prune, ${summary.noop} unchanged`,
  );
  if (!values.prune && summary.prune > 0) {
    note(`${summary.prune} item(s) exist on the target but not in ${file} — left alone; pass --prune to archive them`);
  }
  return printJson(body);
};

/**
 * `glassray-coach check [--fixtures] [--dir <dir>] [--sample <n>] [--timeout <s>]` —
 * run every rule and exit non-zero on any pass-rate below its threshold
 * (default 1.0). Every rule is active — there is no lifecycle gate. With
 * --fixtures the corpus is the committed golden set (hermetic, deterministic —
 * the CI gate); without, the flow's live members.
 */
export const cmdCheck = async ({ port, args }) => {
  const { values } = parseFlags('check', args, {
    fixtures: { type: 'boolean', default: false },
    dir: { type: 'string' },
    sample: { type: 'string' },
    timeout: { type: 'string' },
  });
  const timeoutSec = values.timeout !== undefined ? toInt('check', 'timeout', values.timeout, 1) : DEFAULT_TIMEOUT_SEC;
  const sampleSize = values.sample !== undefined ? toInt('check', 'sample', values.sample, 1) : undefined;

  const evalList = await api(port, '/api/evals');
  const suite = evalList.items;
  if (suite.length === 0) {
    return fail('no rules to check — add a rule first (glassray-coach evals create --name <s> --text <s>)');
  }

  // Fixtures mode: re-ingest the committed set, then pin each rule's corpus to it.
  let fixtureIds = null;
  if (values.fixtures) {
    const dir = values.dir ?? FIXTURES_DIR;
    const groups = await readFixturesDir('check', dir);
    fixtureIds = await ingestFixtures(port, groups);
    note(`ingested ${fixtureIds.all.length} fixture trace(s) from ${dir}`);
  } else if (values.dir !== undefined) {
    usageFail('check', '--dir only combines with --fixtures');
  }

  // Flow slug lookup so a flow-scoped rule scores its own fixture set.
  const flowsBySlug = values.fixtures ? (await api(port, '/api/flows?status=all')).items : [];
  const slugByFlowId = new Map(flowsBySlug.map((f) => [f.id, flowSlug(f)]));

  const results = [];
  let breaches = 0;
  for (const rule of suite) {
    const body = {};
    if (sampleSize !== undefined) body.sampleSize = sampleSize;
    if (fixtureIds !== null) {
      const slug = rule.flowId !== null ? slugByFlowId.get(rule.flowId) : null;
      const ids = slug !== null && slug !== undefined ? (fixtureIds.bySlug.get(slug) ?? []) : fixtureIds.all;
      if (ids.length === 0) {
        breaches += 1;
        results.push({ id: rule.id, slug: rule.slug, name: rule.name, scored: 0, passed: 0, failed: 0, passRate: null, threshold: rule.threshold ?? 1, breach: true, reason: 'no fixtures for this rule’s flow' });
        console.error(`${cross()} ${rule.name} — no fixtures for its flow (expected ${path.join(values.dir ?? FIXTURES_DIR, slug ?? '<flow>')})`);
        continue;
      }
      body.traceIds = ids;
    }
    const accepted = await post(port, `/api/evals/${encodeURIComponent(rule.id)}/run`, body);
    const run = await waitForRun(port, accepted.runId, timeoutSec);
    const scored = typeof run.stats?.scored === 'number' ? run.stats.scored : 0;
    const passed = typeof run.stats?.passed === 'number' ? run.stats.passed : 0;
    const failed = typeof run.stats?.failed === 'number' ? run.stats.failed : 0;
    const passRate = scored > 0 ? passed / scored : null;
    const threshold = rule.threshold ?? 1;
    // Nothing scored is a breach too: a gate that silently checks nothing isn't a gate.
    const breach = passRate === null || passRate < threshold;
    if (breach) breaches += 1;
    results.push({ id: rule.id, slug: rule.slug, name: rule.name, scored, passed, failed, passRate, threshold, breach });
    const pct = passRate === null ? 'nothing scored' : `${passed}/${scored} passing (${Math.round(passRate * 100)}%)`;
    console.error(`${breach ? cross() : '✓'} ${rule.name} — ${pct}, gate ≥${Math.round(threshold * 100)}%`);
  }

  printJson({ rules: results, breaches, corpus: values.fixtures ? 'fixtures' : 'live' });
  process.exit(breaches > 0 ? 1 : 0);
};

/**
 * Parse a compare corpus positional into a corpusRef. A BARE token is a run
 * label (`baseline`, `haiku`, `production` — the `glassray-coach run` output);
 * prefixed forms name the other corpus kinds: `label:<x>`, `agent:<name>`,
 * `flow:<id>`, `fixtures:<dir>`.
 */
const parseCorpusSpec = async (port, spec) => {
  const sep = spec.indexOf(':');
  if (sep === -1) {
    if (spec.trim() === '') usageFail('compare', 'a corpus cannot be empty');
    return { label: spec };
  }
  const kind = spec.slice(0, sep);
  const value = spec.slice(sep + 1);
  if (kind === 'label' && value) return { label: value };
  if (kind === 'agent' && value) return { agent: value };
  if (kind === 'flow' && value) return { flowId: value };
  if (kind === 'fixtures' && value) {
    const groups = await readFixturesDir('compare', value);
    const { all } = await ingestFixtures(port, groups);
    note(`ingested ${all.length} fixture trace(s) from ${value}`);
    return { traceIds: all };
  }
  return usageFail('compare', `corpus must be a run label, label:<x>, agent:<name>, flow:<id>, or fixtures:<dir> (got "${spec}")`);
};

/** Resolve a flow reference (server id, artifact slug, or name) to the server's flow id, or exit 1. */
const resolveFlowRef = async (port, ref) => {
  const { items } = await api(port, '/api/flows?status=all');
  const match =
    items.find((f) => f.id === ref) ??
    items.find((f) => f.slug === ref) ??
    items.find((f) => slugifyName(f.name) === ref || f.name === ref);
  if (!match) return fail(`no flow matches "${ref}" — known: ${items.map((f) => f.slug ?? f.id).join(', ') || '(none)'}`);
  return match.id;
};

/** Render the compare report (a finished run's stats) as human lines on stderr. */
const printCompareSummary = (stats) => {
  if (!stats || !Array.isArray(stats.rules)) return;
  const pct = (rate) => (typeof rate === 'number' ? `${Math.round(rate * 100)}%` : '—');
  for (const rule of stats.rules) {
    const delta =
      typeof rule.deltaPassRate === 'number'
        ? ` (${rule.deltaPassRate >= 0 ? '+' : ''}${Math.round(rule.deltaPassRate * 100)}pts)`
        : '';
    console.error(`${rule.regressed ? cross() : '✓'} ${rule.name}: ${pct(rule.baseline?.passRate)} → ${pct(rule.candidate?.passRate)}${delta}`);
  }
  const money = (v) => (typeof v === 'number' ? `$${v.toFixed(4)}` : '—');
  if (stats.baseline && stats.candidate) {
    // The headline is the price-book cost — honest even when the corpus ran on
    // a free provider; the raw provider estimate follows in parentheses.
    console.error(
      dim(
        `cost if metered: ${money(stats.baseline.estCostIfMeteredUsd)} → ${money(stats.candidate.estCostIfMeteredUsd)}` +
          `${typeof stats.costIfMeteredDeltaUsd === 'number' ? ` (Δ ${money(stats.costIfMeteredDeltaUsd)})` : ''}` +
          ` · est spend ${money(stats.baseline.estCostUsd)} → ${money(stats.candidate.estCostUsd)}` +
          ` · tokens ${stats.baseline.tokensIn}/${stats.baseline.tokensOut} → ${stats.candidate.tokensIn}/${stats.candidate.tokensOut}` +
          ` · avg latency ${stats.baseline.avgDurationMs}ms → ${stats.candidate.avgDurationMs}ms`,
        MODE_ERR,
      ),
    );
  }
};

/**
 * `glassray-coach compare [<flow>] <baseline> <candidate> [--sample <n>]` — the A/B
 * over the rule suite. Three positionals scope the suite to one flow
 * (by slug, id, or name); two run every global rule. Bare corpora are run
 * labels — the canonical model-swap invocation is
 * `glassray-coach compare digest baseline haiku`.
 */
export const cmdCompare = async ({ port, args }) => {
  const { values, positionals } = parseFlags('compare', args, {
    flow: { type: 'string' },
    sample: { type: 'string' },
    ...WAIT_OPTIONS,
  });
  if (positionals.length !== 2 && positionals.length !== 3) {
    usageFail('compare', 'compare needs <baseline> <candidate>, optionally preceded by <flow>');
  }
  const flowRef = positionals.length === 3 ? positionals[0] : values.flow;
  if (positionals.length === 3 && values.flow !== undefined) {
    usageFail('compare', 'pass the flow as the first positional or as --flow, not both');
  }
  const [baselineSpec, candidateSpec] = positionals.slice(-2);
  const body = {
    baseline: await parseCorpusSpec(port, baselineSpec),
    candidate: await parseCorpusSpec(port, candidateSpec),
  };
  if (flowRef !== undefined) body.flowId = await resolveFlowRef(port, flowRef);
  if (values.sample !== undefined) body.sampleSize = toInt('compare', 'sample', values.sample, 1);
  return enqueueAndWait(port, '/api/compare', body, waitOpts('compare', values), (run) => {
    printCompareSummary(run.stats);
    return run;
  });
};

/** `glassray-coach runs list [--limit <n>]|get <id>|cancel <id>` — background-run inspection and cancel. */
export const cmdRuns = async ({ port, args }) => {
  const verb = args[0];
  switch (verb) {
    case 'list': {
      const { values } = parseFlags('runs', args.slice(1), { limit: { type: 'string' } });
      return printJson(await api(port, `/api/runs${toQuery({ limit: values.limit })}`));
    }
    case 'get': {
      const { positionals } = parseFlags('runs', args.slice(1), {});
      const id = requireId('runs', positionals);
      return printJson(await api(port, `/api/runs/${encodeURIComponent(id)}`));
    }
    case 'cancel': {
      const { positionals } = parseFlags('runs', args.slice(1), {});
      const id = requireId('runs', positionals);
      return printJson(await post(port, `/api/runs/${encodeURIComponent(id)}/cancel`));
    }
    default:
      return usageFail('runs', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
  }
};
