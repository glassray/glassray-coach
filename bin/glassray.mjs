#!/usr/bin/env node
/**
 * glassray CLI — zero-dependency plain ESM.
 * Commands: start (default) | mcp | reset | status | doctor.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Repo-relative root of the coach package (this file lives in coach/bin/). */
const COACH_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Default dashboard/ingest port. */
const DEFAULT_PORT = 5899;

/** Resolves the data directory: --data-dir > $GLASSRAY_HOME > ~/.glassray. */
const resolveHome = (dataDir) => dataDir ?? process.env.GLASSRAY_HOME ?? path.join(homedir(), '.glassray');

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

/** Prints the copy-paste connection block (dashboard, ingest, key, OTEL env). */
const printConnectBlock = (info, port) => {
  const dashboard = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  Glassray Coach is running');
  console.log('');
  console.log(`    Dashboard  ${dashboard}`);
  console.log(`    Ingest     ${info.ingestEndpoint}`);
  console.log(`    API key    ${info.apiKey}`);
  console.log('');
  console.log("  Point your agent's OTLP exporter at it:");
  console.log('');
  console.log(`    export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:${port}"`);
  console.log('    export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"');
  console.log(`    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${info.apiKey}"`);
  console.log('');
};

/** start: spawn the server (tsx), wait for /api/info, print the connect block, open the browser. */
const cmdStart = async ({ port, dataDir, noOpen }) => {
  const home = resolveHome(dataDir);
  if (!(await isPortFree(port))) {
    const running = await fetchInfo(port);
    if (running) {
      console.log(`glassray already running on port ${port}`);
      printConnectBlock(running, port);
      if (!noOpen) openBrowser(`http://127.0.0.1:${port}/`);
      return;
    }
    console.error(`error: port ${port} is in use by something else — pass --port <n> to pick another`);
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

  // Wait (up to ~20s) for the server to answer, then print the connect block.
  const deadline = Date.now() + 20_000;
  let info = null;
  while (info === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    info = await fetchInfo(port);
  }
  if (info === null) {
    console.error('error: server did not come up within 20s (see logs above)');
    child.kill('SIGTERM');
    process.exit(1);
  }
  printConnectBlock(info, port);
  if (!noOpen) openBrowser(`http://127.0.0.1:${port}/`);
};

/** mcp: run the stdio MCP server (server/mcp.ts) that proxies the running coach over loopback. */
const cmdMcp = ({ port }) => {
  // stderr ONLY — stdout is the MCP JSON-RPC channel.
  const invoke = `node ${path.join(COACH_ROOT, 'bin', 'glassray.mjs')}`;
  const portFlag = port === DEFAULT_PORT ? '' : ` --port ${port}`;
  console.error(`hint: claude mcp add glassray -- ${invoke} mcp${portFlag}`);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(COACH_ROOT, 'server', 'mcp.ts')],
    {
      cwd: COACH_ROOT,
      env: { ...process.env, GLASSRAY_PORT: String(port) },
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
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

/** status: report data dir and whether a coach answers on the port. */
const cmdStatus = async ({ port, dataDir }) => {
  const home = resolveHome(dataDir);
  console.log(`data dir  ${home}${existsSync(home) ? '' : ' (missing)'}`);
  console.log(`key file  ${path.join(home, 'local-api-key')}${existsSync(path.join(home, 'local-api-key')) ? '' : ' (missing)'}`);
  const info = await fetchInfo(port);
  if (info) {
    console.log(`server    running on http://127.0.0.1:${port}/ (v${info.version})`);
  } else {
    console.log(`server    not running on port ${port}`);
  }
};

/** doctor: environment checks with one-line fixes. */
const cmdDoctor = async ({ port, dataDir }) => {
  const home = resolveHome(dataDir);
  let failures = 0;

  // Floor is 20.6: the `start`/`mcp` spawns use `node --import`, added in 20.6.0.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20 || (major === 20 && minor >= 6)) {
    console.log(`ok    node ${process.versions.node}`);
  } else {
    failures += 1;
    console.log(`FAIL  node ${process.versions.node} — install Node 20.6+ (e.g. \`nvm install 20 && nvm use 20\`)`);
  }

  if (await isPortFree(port)) {
    console.log(`ok    port ${port} is free`);
  } else if (await fetchInfo(port)) {
    console.log(`ok    port ${port} is in use by a running glassray`);
  } else {
    failures += 1;
    console.log(`FAIL  port ${port} is in use by another process — stop it or pass --port <n>`);
  }

  // A diagnostic shouldn't leave state behind: if the data dir didn't exist,
  // remove the one we create just to test writability.
  const homeExisted = existsSync(home);
  try {
    await mkdir(home, { recursive: true });
    const probe = path.join(home, '.write-probe');
    await writeFile(probe, 'ok');
    await unlink(probe);
    console.log(`ok    data dir ${home} is writable`);
  } catch {
    failures += 1;
    console.log(`FAIL  data dir ${home} is not writable — fix permissions or set GLASSRAY_HOME to a writable path`);
  } finally {
    if (!homeExisted) await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(failures === 0 ? 0 : 1);
};

/** Usage text for --help / unknown commands. */
const USAGE = `glassray — local AI-agent trace viewer

Usage: glassray [command] [flags]

Commands:
  start     Start the server + dashboard (default)
  mcp       Run a stdio MCP server for coding agents (proxies the running coach)
  reset     Wipe the data directory
  status    Show data dir and whether the server is up
  doctor    Check node version, port, and data-dir writability

Flags:
  --port <n>       Port to serve on (default ${DEFAULT_PORT})
  --data-dir <p>   Data directory (default $GLASSRAY_HOME or ~/.glassray)
  --no-open        Don't open the browser after start
  --yes            Skip the reset confirmation
  --help           Show this help
`;

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const port = values.port !== undefined ? Number(values.port) : DEFAULT_PORT;
if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
  console.error(`error: invalid --port ${values.port}`);
  process.exit(1);
}

const ctx = { port, dataDir: values['data-dir'], noOpen: values['no-open'], yes: values.yes };
const command = positionals[0] ?? 'start';

switch (command) {
  case 'start':
    await cmdStart(ctx);
    break;
  case 'mcp':
    cmdMcp(ctx);
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
    console.error(`error: unknown command "${command}"\n`);
    console.log(USAGE);
    process.exit(1);
}
