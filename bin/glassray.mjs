#!/usr/bin/env node
/**
 * glassray CLI — zero-dependency plain ESM.
 * Bare `glassray-coach` (and `help` / `--help`) prints the branded landing screen.
 * Server commands: start | init | reset | status | doctor.
 * Data commands (bin/commands.mjs): traces | stats | usage | flows | evals |
 * deviations | discovery | experiments | fix | runs — pure JSON on stdout, for
 * coding agents.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MANAGEMENT_COMMANDS, showLanding } from './landing.mjs';
import {
  GUIDES,
  PALETTE,
  VERSION,
  bullet,
  compactBrand,
  compareVersions,
  cross,
  dim,
  fetchLatestVersion,
  link,
  maybeScheduleUpdateRefresh,
  paint,
  readUpdateNotice,
  updateCheckOptedOut,
} from './ui.mjs';

// A consumer closing the pipe (`| head`, `| jq -e` …) is a normal end of
// output for a JSON-emitting CLI, not a crash.
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0);
  throw err;
});

/** Repo-relative root of the coach package (this file lives in coach/bin/). */
const COACH_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Default dashboard/ingest port. */
const DEFAULT_PORT = 5899;

/** Resolves the data directory: --data-dir > $GLASSRAY_HOME > ~/.glassray. */
const resolveHome = (dataDir) => dataDir ?? process.env.GLASSRAY_HOME ?? path.join(homedir(), '.glassray');

/** Print one red-✗ error line to stderr. */
const errorLine = (message) => console.error(`${cross()} ${message}`);

/** Fetches /api/info from a running coach, or null when unreachable. */
const fetchInfo = async (port, timeoutMs = 1000) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const info = await res.json();
    return info?.name === 'glassray' ? info : null;
  } catch {
    return null;
  }
};

/** Best-effort browser open (open / xdg-open / start); failures are silently ignored. */
const openBrowser = (url) => {
  const attempt =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(attempt[0], attempt[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best effort only.
  }
};

/** Checks whether a TCP port is free on 127.0.0.1. */
const isPortFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });

/**
 * Whether the running coach has zero captured traces. Retries a couple of
 * times — right after spawn the stats route can lag /api/info by a beat — and
 * when the count still can't be read, reports empty: wrongly leading with the
 * onboarding prompt on a populated store is mild noise, but hiding it on a
 * fresh store loses a new user entirely.
 */
const storeLooksEmpty = async (port) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/stats`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) continue;
      const traces = (await res.json())?.totals?.traces;
      if (typeof traces === 'number') return traces === 0;
    } catch {
      // Transient probe failure — retry.
    }
  }
  return true;
};

/**
 * Prints the branded connection card (dashboard, ingest, key, next steps).
 * On an empty store the hand-off prompt from /api/info leads — paste it into a
 * coding agent and it does the wiring — with the manual OTLP env as the
 * fallback for stores that already have traffic.
 */
const printConnectBlock = (info, port, updateNotice = null, { empty = false } = {}) => {
  const dashboard = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log(`  ${compactBrand()}`);
  console.log('');
  console.log(`  ${bullet('ok')} Coach ${dim(`v${info.version ?? VERSION}`)} is running`);
  console.log(`    Dashboard   ${link(dashboard)}`);
  console.log(`    Ingest      ${info.ingestEndpoint}`);
  console.log(`    API key     ${info.apiKey}`);
  console.log('');
  if (empty && info.agentPrompt) {
    console.log('  Nothing is instrumented yet. Paste this into Claude Code (or any coding');
    console.log('  agent) — it wires tracing, flows, and rules; then just run your agent:');
    console.log('');
    console.log(`  ${dim('─'.repeat(72))}`);
    // The prompt is printed verbatim (no indent, no color) so a triple-click
    // or terminal copy grabs exactly what the coding agent should receive.
    console.log(info.agentPrompt);
    console.log(`  ${dim('─'.repeat(72))}`);
  } else {
    console.log("  Point your agent's OTLP exporter at it:");
    console.log('');
    console.log(`    export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:${port}"`);
    console.log('    export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"');
    console.log(`    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${info.apiKey}"`);
  }
  console.log('');
  console.log(
    `  Next: ${paint('glassray-coach init', PALETTE.brand)} in your agent's repo · quickstart ${link(GUIDES.quickstart)}`,
  );
  if (updateNotice) {
    console.log('');
    console.log(`  ${updateNotice}`);
  }
  console.log('');
};

/** start: spawn the server (tsx), wait for /api/info, print the connect card, open the browser. */
const cmdStart = async ({ port, dataDir, noOpen }) => {
  const home = resolveHome(dataDir);
  maybeScheduleUpdateRefresh(home);
  if (!(await isPortFree(port))) {
    const running = await fetchInfo(port);
    if (running) {
      console.log(`glassray already running on port ${port}`);
      printConnectBlock(running, port, readUpdateNotice(home), {
        empty: await storeLooksEmpty(port),
      });
      if (!noOpen) openBrowser(`http://127.0.0.1:${port}/`);
      return;
    }
    errorLine(`port ${port} is in use by something else — pass --port <n> to pick another`);
    process.exit(1);
  }

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(COACH_ROOT, 'server', 'index.ts')],
    {
      cwd: COACH_ROOT,
      env: { ...process.env, GLASSRAY_HOME: home, GLASSRAY_PORT: String(port) },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  // Wait (up to ~20s) for the server to answer, then print the connect card.
  const deadline = Date.now() + 20_000;
  let info = null;
  while (info === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    info = await fetchInfo(port);
  }
  if (info === null) {
    errorLine('server did not come up within 20s (see logs above)');
    child.kill('SIGTERM');
    process.exit(1);
  }
  printConnectBlock(info, port, readUpdateNotice(home), {
    empty: await storeLooksEmpty(port),
  });
  if (!noOpen) openBrowser(`http://127.0.0.1:${port}/`);
};

/** mcp: removed in 0.2 — the CLI (plus the installable skill) is the one agent-facing surface now. */
const cmdMcp = () => {
  errorLine(
    'glassray-coach mcp was removed in 0.2 — Coach is now driven through the CLI. ' +
      'Run `glassray-coach init` to install the Claude Code skill, then use the resource commands ' +
      '(see `glassray-coach --help`). If you had it registered: `claude mcp remove glassray`.',
  );
  process.exit(1);
};

/** Source of the bundled agent skill that `glassray-coach init` installs. */
const SKILL_SOURCE = path.join(COACH_ROOT, 'skills', 'glassray', 'SKILL.md');

/**
 * Where `init` installs the skill — one file, both standard locations, plain
 * copies (symlinks are unreliable on Windows): `.agents/skills/` is the open
 * Agent Skills standard (agentskills.io — Codex, VS Code, Copilot);
 * `.claude/skills/` is what Claude Code discovers.
 */
const SKILL_DESTS = [
  path.join('.agents', 'skills', 'glassray', 'SKILL.md'),
  path.join('.claude', 'skills', 'glassray', 'SKILL.md'),
];

/** init: install the bundled agent skill into the current repo (both skill directories). */
const cmdInit = async ({ force, dataDir }) => {
  if (!existsSync(SKILL_SOURCE)) {
    errorLine(`skill file missing at ${SKILL_SOURCE} — this install has no skills/ directory (try reinstalling @glassray/coach)`);
    process.exit(1);
  }
  const source = await readFile(SKILL_SOURCE, 'utf8');

  // Refuse before touching anything: a modified copy in EITHER location needs
  // an explicit --force, so a partial install can't clobber local edits.
  const dests = SKILL_DESTS.map((rel) => path.join(process.cwd(), rel));
  if (!force) {
    for (const dest of dests) {
      if (existsSync(dest) && (await readFile(dest, 'utf8')) !== source) {
        errorLine(`${dest} already exists with different content — pass --force to overwrite`);
        process.exit(1);
      }
    }
  }

  let wrote = 0;
  for (const dest of dests) {
    if (!force && existsSync(dest) && (await readFile(dest, 'utf8')) === source) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, source);
    wrote += 1;
  }
  maybeScheduleUpdateRefresh(resolveHome(dataDir));
  console.log('');
  console.log(`  ${bullet('ok')} agent skill ${wrote === 0 ? 'already installed (up to date)' : 'installed'}`);
  console.log(`    ${dests[0]}   ${dim('(Agent Skills standard — Codex, VS Code, Copilot)')}`);
  console.log(`    ${dests[1]}   ${dim('(Claude Code)')}`);
  console.log('');
  console.log('  Next: ask your coding agent to set up flows and evals for your agent.');
  console.log(`  Docs: ${link(GUIDES.cli)}`);
  console.log('');
};

/** reset: wipe the data directory (confirm unless --yes). */
const cmdReset = async ({ dataDir, yes }) => {
  const home = resolveHome(dataDir);
  if (!existsSync(home)) {
    console.log(`nothing to reset — ${home} does not exist`);
    return;
  }
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Delete all Glassray Coach data in ${home}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('aborted');
      return;
    }
  }
  await rm(home, { recursive: true, force: true });
  console.log(`wiped ${home}`);
};

/** status: the branded state card — server, data dir, key file, update notice. */
const cmdStatus = async ({ port, dataDir }) => {
  const home = resolveHome(dataDir);
  // Capture existence BEFORE scheduling the update refresh — the detached
  // child may create the data dir (for its cache) while we report on it.
  const homeExists = existsSync(home);
  maybeScheduleUpdateRefresh(home);
  const keyFile = path.join(home, 'local-api-key');
  const info = await fetchInfo(port);
  console.log('');
  console.log(`  ${compactBrand()}`);
  console.log('');
  if (info) {
    console.log(`  ${bullet('ok')} server running on ${link(`http://127.0.0.1:${port}/`)} ${dim(`(v${info.version})`)}`);
  } else {
    console.log(`  ${bullet('down')} server not running on port ${port}`);
    console.log(`    Start one:   ${paint('glassray-coach start', PALETTE.brand)}`);
  }
  console.log(`    Data dir    ${home}${homeExists ? '' : dim(' (missing)')}`);
  console.log(`    Key file    ${keyFile}${existsSync(keyFile) ? '' : dim(' (missing)')}`);
  const notice = readUpdateNotice(home);
  if (notice) {
    console.log('');
    console.log(`  ${notice}`);
  }
  console.log('');
};

/** doctor: environment checks with one-line fixes, plus the one live update check. */
const cmdDoctor = async ({ port, dataDir }) => {
  const home = resolveHome(dataDir);
  const ok = (msg) => console.log(`  ${paint('ok  ', PALETTE.brand)} ${msg}`);
  const failLine = (msg) => console.log(`  ${paint('FAIL', PALETTE.error)} ${msg}`);
  const note = (msg) => console.log(`  ${paint('note', PALETTE.warn)} ${msg}`);
  let failures = 0;

  console.log('');
  // Floor is 20.6: the `start` spawn uses `node --import`, added in 20.6.0.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20 || (major === 20 && minor >= 6)) {
    ok(`node ${process.versions.node}`);
  } else {
    failures += 1;
    failLine(`node ${process.versions.node} — install Node 20.6+ (e.g. \`nvm install 20 && nvm use 20\`)`);
  }

  if (await isPortFree(port)) {
    ok(`port ${port} is free`);
  } else if (await fetchInfo(port)) {
    ok(`port ${port} is in use by a running glassray`);
  } else {
    failures += 1;
    failLine(`port ${port} is in use by another process — stop it or pass --port <n>`);
  }

  // A diagnostic shouldn't leave state behind: if the data dir didn't exist,
  // remove the one we create just to test writability.
  const homeExisted = existsSync(home);
  try {
    await mkdir(home, { recursive: true });
    const probe = path.join(home, '.write-probe');
    await writeFile(probe, 'ok');
    await unlink(probe);
    ok(`data dir ${home} is writable`);
  } catch {
    failures += 1;
    failLine(`data dir ${home} is not writable — fix permissions or set GLASSRAY_HOME to a writable path`);
  } finally {
    if (!homeExisted) await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  // The one live update check (a diagnostic wants the truth now) — informational
  // only, honors the opt-out envs, and never counts as a failure.
  if (!updateCheckOptedOut()) {
    const latest = await fetchLatestVersion();
    if (latest === null) note('update check skipped (offline?)');
    else if (compareVersions(latest, VERSION) > 0) note(`${latest} is available (you have ${VERSION}) — npm i -g @glassray/coach`);
    else ok(`version ${VERSION} (latest)`);
  }

  console.log('');
  process.exit(failures === 0 ? 0 : 1);
};

/** Command words served by bin/commands.mjs (everything else is server management). */
const RESOURCE_COMMANDS = new Set([
  'traces',
  'stats',
  'usage',
  'flows',
  'evals',
  'deviations',
  'discovery',
  'experiments',
  'fix',
  'runs',
  'pull',
  'push',
  'check',
  'compare',
  'run',
  'link',
]);

/** Validate + normalize a port value (flag or $GLASSRAY_PORT); exits 1 when unusable. */
const resolvePort = (raw) => {
  // An unset flag/env — or an empty env var — means the default.
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  // parseArgs (strict:false) yields `true` for a bare `--port` with no value.
  if (typeof raw !== 'string') {
    errorLine('--port requires a value');
    process.exit(1);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
    errorLine(`invalid --port ${raw}`);
    process.exit(1);
  }
  return port;
};

const rawArgs = process.argv.slice(2);

/**
 * Lenient first pass just to locate the command word + the global flags: only
 * value-taking globals are declared (so they consume their values); everything
 * unknown is tolerated — resource commands re-parse their own flags strictly.
 */
const probe = parseArgs({
  args: rawArgs,
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'V' },
  },
  allowPositionals: true,
  strict: false,
});

/**
 * Index of the command word in rawArgs: the first token that isn't a flag or a
 * global value-flag's value. `indexOf(command)` would mis-slice when a flag's
 * VALUE equals a command word (`--data-dir flows flows list`).
 */
const commandIndex = (() => {
  const valueFlags = new Set(['--port', '--data-dir']);
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (valueFlags.has(arg)) {
      i += 1; // skip the flag's value
      continue;
    }
    if (arg.startsWith('-')) continue; // boolean flags and --flag=value forms
    return i;
  }
  return -1;
})();
const command = commandIndex >= 0 ? rawArgs[commandIndex] : undefined;

if (probe.values.version === true) {
  console.log(VERSION);
  process.exit(0);
}

/** Print the landing screen (the branded help) and exit 0. */
const landing = async () => {
  await showLanding({
    port: resolvePort(probe.values.port ?? process.env.GLASSRAY_PORT),
    home: resolveHome(typeof probe.values['data-dir'] === 'string' ? probe.values['data-dir'] : undefined),
  });
  process.exit(0);
};

// Bare command, `help`, and top-level --help/-h are all the landing screen;
// `help <resource>` prints that resource's own usage block.
if (command === undefined || command === 'help') {
  const topic = command === 'help' ? probe.positionals[1] : undefined;
  if (topic !== undefined && RESOURCE_COMMANDS.has(topic)) {
    const { printHelp } = await import('./commands.mjs');
    printHelp(topic);
    process.exit(0);
  }
  if (topic !== undefined && !MANAGEMENT_COMMANDS.includes(topic)) {
    errorLine(`unknown command "${topic}" — run \`glassray-coach --help\``);
    process.exit(1);
  }
  await landing();
} else if (RESOURCE_COMMANDS.has(command)) {
  const rest = rawArgs.slice(commandIndex + 1);
  const commands = await import('./commands.mjs');
  if (rest.includes('--help') || rest.includes('-h')) {
    commands.printHelp(command);
    process.exit(0);
  }
  const port = resolvePort(probe.values.port ?? process.env.GLASSRAY_PORT);
  /** Resource-command dispatch table: command word → handler in bin/commands.mjs. */
  const handlers = {
    traces: commands.cmdTraces,
    stats: commands.cmdStats,
    usage: commands.cmdUsage,
    flows: commands.cmdFlows,
    evals: commands.cmdEvals,
    deviations: commands.cmdDeviations,
    discovery: commands.cmdDiscovery,
    experiments: commands.cmdExperiments,
    fix: commands.cmdFix,
    runs: commands.cmdRuns,
    pull: commands.cmdPull,
    push: commands.cmdPush,
    check: commands.cmdCheck,
    compare: commands.cmdCompare,
    run: commands.cmdRun,
    link: commands.cmdLink,
  };
  await handlers[command]({ port, args: rest });
} else {
  /** Strictly parsed management-command flags; an unknown flag is a usage error, not a stack trace. */
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        port: { type: 'string' },
        'data-dir': { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'V', default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    errorLine(`${err instanceof Error ? err.message : String(err)} — run \`glassray-coach --help\``);
    process.exit(1);
  }
  const { values, positionals } = parsed;

  if (values.help) await landing();

  // Same precedence as the resource commands: --port > $GLASSRAY_PORT > default.
  const port = resolvePort(values.port ?? process.env.GLASSRAY_PORT);
  const ctx = { port, dataDir: values['data-dir'], noOpen: values['no-open'], yes: values.yes, force: values.force };

  switch (positionals[0]) {
    case 'start':
      await cmdStart(ctx);
      break;
    case 'init':
      await cmdInit(ctx);
      break;
    case 'mcp':
      cmdMcp();
      break;
    case 'reset':
      await cmdReset(ctx);
      break;
    case 'status':
      await cmdStatus(ctx);
      break;
    case 'doctor':
      await cmdDoctor(ctx);
      break;
    default:
      errorLine(`unknown command "${positionals[0]}" — run \`glassray-coach --help\``);
      process.exit(1);
  }
}
