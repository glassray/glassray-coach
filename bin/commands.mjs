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
    'glassray traces list [--q <s>] [--agent <s>] [--status ok|error] [--flow <id>] [--limit <n>] [--offset <n>] | get <id> | tail',
  stats: 'glassray stats',
  usage: 'glassray usage',
  flows:
    "glassray flows list [--status active|archived|all] | get <id> | create --name <s> [--description <s>] [--rule <s>] [--classify selector|llm] [--selector '<json>'] [--created-by user|claude] | update <id> [--name <s>] [--description <s>] [--rule <s>|--no-rule] [--classify selector|llm] [--selector '<json>'|--no-selector] [--status active|archived] | delete <id> | audit <id> | discover [--no-wait] [--timeout <s>]",
  evals:
    'glassray evals list | get <id> | create (--deviation <id> [--flow <id>]) or (--label <s> --rule <s> [--description <s>] [--flow <id>] [--no-autorun] [--autorun-threshold <n>]) | update <id> [--flow <id>|--no-flow] [--autorun|--no-autorun] [--autorun-threshold <n>] | run <id> [--sample <n>] [--model <s>] [--no-wait] [--timeout <s>] | delete <id>',
  deviations: 'glassray deviations list | get <id> | resolve <id> [--reopen]',
  discovery: 'glassray discovery run [--sample <n>] [--flow <id>] [--no-wait] [--timeout <s>]',
  fix: 'glassray fix <deviationId> [--no-wait] [--timeout <s>]',
  runs: 'glassray runs list [--limit <n>] | get <id> | cancel <id>',
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
  console.error(`  more:  glassray help ${resource}`);
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
 * `glassray help <resource>` and `glassray <resource> --help`.
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
 * complete (point at `glassray runs get`), exit 1.
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
        `${cross()} run ${runId} did not finish within ${timeoutSec}s — it may still complete; check \`glassray runs get ${runId}\``,
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

/** `glassray traces list|get <id>|tail` — trace listing, detail, and the live SSE tail. */
export const cmdTraces = async ({ port, args }) => {
  const verb = args[0];
  if (verb === 'list') {
    const { values } = parseFlags('traces', args.slice(1), {
      q: { type: 'string' },
      agent: { type: 'string' },
      status: { type: 'string' },
      flow: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
    });
    const query = toQuery({
      q: values.q,
      agent: values.agent,
      status: values.status,
      flow: values.flow,
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

/** `glassray stats` — GET /api/stats. */
export const cmdStats = async ({ port, args }) => {
  parseFlags('stats', args, {});
  printJson(await api(port, '/api/stats'));
};

/** `glassray usage` — GET /api/usage (LLM spend summary). */
export const cmdUsage = async ({ port, args }) => {
  parseFlags('usage', args, {});
  printJson(await api(port, '/api/usage'));
};

/** `glassray flows …` — durable-flow CRUD, audit, and the flow-discovery run. */
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
      const { values } = parseFlags('flows', args.slice(1), WAIT_OPTIONS);
      return enqueueAndWait(port, '/api/flows/run', {}, waitOpts('flows', values));
    }
    default:
      return usageFail('flows', verb === undefined ? 'missing verb' : `unknown verb "${verb}"`);
  }
};

/** `glassray evals …` — eval CRUD plus judged runs (run waits, then prints the eval with its verdicts). */
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
        label: { type: 'string' },
        rule: { type: 'string' },
        description: { type: 'string' },
        'no-autorun': { type: 'boolean', default: false },
        'autorun-threshold': { type: 'string' },
      });
      let body;
      if (values.deviation !== undefined) {
        if (
          values.label !== undefined ||
          values.rule !== undefined ||
          values.description !== undefined ||
          values['no-autorun'] ||
          values['autorun-threshold'] !== undefined
        ) {
          usageFail('evals', '--deviation only combines with --flow (the deviation supplies the label/rule)');
        }
        body = { deviationId: values.deviation };
      } else {
        if (values.label === undefined || values.rule === undefined) {
          usageFail('evals', 'create needs --deviation <id>, or both --label and --rule');
        }
        body = { label: values.label, rule: values.rule };
        if (values.description !== undefined) body.description = values.description;
        if (values['no-autorun']) body.autorun = false;
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
        autorun: { type: 'boolean', default: false },
        'no-autorun': { type: 'boolean', default: false },
        'autorun-threshold': { type: 'string' },
      });
      const id = requireId('evals', positionals);
      if (values.flow !== undefined && values['no-flow']) usageFail('evals', 'pass either --flow or --no-flow, not both');
      if (values.autorun && values['no-autorun']) usageFail('evals', 'pass either --autorun or --no-autorun, not both');
      const body = {};
      if (values.flow !== undefined) body.flowId = values.flow;
      if (values['no-flow']) body.flowId = null;
      if (values.autorun) body.autorun = true;
      if (values['no-autorun']) body.autorun = false;
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

/** `glassray deviations list|get <id>|resolve <id> [--reopen]`. */
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

/** `glassray discovery run [--sample <n>] [--flow <id>]` — deviation discovery over recent traces. */
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

/** `glassray fix <deviationId>` — run the improver, then print the deviation (it carries fixMarkdown). */
export const cmdFix = async ({ port, args }) => {
  const { values, positionals } = parseFlags('fix', args, WAIT_OPTIONS);
  const id = requireId('fix', positionals, '<deviationId>');
  return enqueueAndWait(port, `/api/deviations/${encodeURIComponent(id)}/fix`, {}, waitOpts('fix', values), () =>
    api(port, `/api/deviations/${encodeURIComponent(id)}`),
  );
};

/** `glassray runs list [--limit <n>]|get <id>|cancel <id>` — background-run inspection and cancel. */
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
