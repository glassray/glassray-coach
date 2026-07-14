/**
 * The glassray landing screen — what the bare `glassray-coach` command (and
 * `glassray-coach help` / `--help`) prints: the mark, a live server probe, the
 * command reference, and the guide links. Rendering is a pure function of the
 * gathered data so tests can assert on it without a terminal or a server.
 */
import {
  GUIDES,
  MODE_OUT,
  PALETTE,
  bold,
  brandHeader,
  bullet,
  dim,
  heading,
  link,
  maybeScheduleUpdateRefresh,
  paint,
  readUpdateNotice,
} from './ui.mjs';

/** The management command words dispatched by bin/glassray.mjs (kept here so help can't drift from dispatch). */
export const MANAGEMENT_COMMANDS = ['start', 'init', 'reset', 'status', 'doctor', 'help', 'mcp'];

/**
 * The command reference, grouped the way people use it. Every dispatchable
 * command word must appear in some row — a test enforces it.
 */
export const COMMAND_SECTIONS = [
  {
    title: 'GETTING STARTED',
    rows: [
      ['start', 'Start the server + dashboard  (--port, --data-dir, --no-open)'],
      ['init', 'Install the agent skill into this repo (Claude Code · Codex · Copilot)'],
      ['doctor', 'Check node, port, and data dir — with one-line fixes'],
    ],
  },
  {
    title: 'TRACES & ANALYSIS',
    note: 'need a running Coach · stdout is pure JSON, built for scripts and coding agents',
    rows: [
      ['traces', 'list · get <id> · tail — browse and live-stream captured traces'],
      ['flows', 'list · get · create · update · delete · audit · discover'],
      ['evals', 'list · get · create · update · run · delete — assertion rules'],
      ['deviations', 'list · get <id> · resolve <id> · discover'],
      ['discovery run', 'Find recurring failures across recent traces (alias of `deviations discover`)'],
      ['experiments', 'list · get <id> — durable A/B compare containers'],
      ['fix <deviationId>', 'Generate a fix doc for your coding agent'],
      ['runs', 'list · get <id> · cancel <id> — background runs'],
      ['stats · usage', "Store rollups · Coach's own LLM spend vs budget"],
    ],
  },
  {
    title: 'THE RULE ARTIFACT & THE LOOP',
    note: 'glassray.yaml — flows + rules + a run recipe; the loop: run baseline → change → run candidate → compare',
    rows: [
      ['pull', 'Serialize flows + rules into glassray.yaml (--from cloud · --as-fixtures · --traces <flow>)'],
      ['push', 'Reconcile glassray.yaml into the target (--dry-run · --prune)'],
      ['run <flow> --label <x>', "Execute the flow's run recipe; traces land under the label"],
      ['compare <flow> <a> <b>', 'Score the rule suite over two labelled corpora — pass rate + cost delta'],
      ['check', 'Run every rule; exit non-zero on a threshold breach (--fixtures)'],
      ['link <project>', 'Record the cloud project + auth for pull --from cloud / --traces'],
    ],
  },
  {
    title: 'MANAGE',
    rows: [
      ['status', 'Data dir + whether a server is up'],
      ['reset --yes', 'Wipe the local data directory'],
    ],
  },
];

/** Worked examples shown on the landing screen (Greptile-style: real invocations, one line each). */
const EXAMPLE_ROWS = [
  ['glassray-coach traces list --status error', 'The runs that failed.'],
  ['glassray-coach discovery run', 'Find recurring failures in recent traces.'],
  ['glassray-coach flows audit <id>', "Check a flow's classification quality."],
  ['glassray-coach evals run <id>', "Score a flow's traces against its rule."],
];

/** The LEARN rows at the bottom of the landing screen — links, plus the skill-install commands. */
const LEARN_ROWS = [
  ['Quickstart', GUIDES.quickstart, 'link'],
  ['The loop', GUIDES.loop, 'link'],
  ['CLI reference', GUIDES.cli, 'link'],
  ['Source', GUIDES.github, 'link'],
  ['Agent skill', 'glassray-coach init   ·   npx skills add glassray/glassray-coach', 'cmd'],
];

/** Fetch a loopback JSON endpoint with a short budget; null on any failure. */
const probeJson = async (port, pathname, timeoutMs = 1000) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

/**
 * Probe for a running Coach: `/api/info` decides running/not; the counts are
 * best-effort extras (any failure just drops them from the card).
 */
export const probeCoach = async (port) => {
  const info = await probeJson(port, '/api/info');
  if (info?.name !== 'glassray') return { running: false };
  const [stats, flows, evals] = await Promise.all([
    probeJson(port, '/api/stats'),
    probeJson(port, '/api/flows'),
    probeJson(port, '/api/evals'),
  ]);
  const counts =
    stats && flows && evals
      ? { traces: stats.totals?.traces ?? 0, flows: flows.items?.length ?? 0, evals: evals.items?.length ?? 0 }
      : null;
  return {
    running: true,
    version: info.version,
    apiKey: info.apiKey,
    ingest: info.ingestEndpoint,
    dashboard: `http://127.0.0.1:${port}/`,
    counts,
  };
};

/** Left-pad-free two-column row: a fixed-width bright-bold command cell + its description. */
const row = (cell, description, cellWidth) =>
  `    ${bold(paint(cell.padEnd(cellWidth), PALETTE.brandBright))}  ${description}`;

/**
 * Render the landing screen as one string. Pure: everything variable (probe
 * result, width, update notice) comes in as data.
 */
export const renderLanding = ({ port, probe, width = 80, updateNotice = null, mode = MODE_OUT }) => {
  const out = [];
  const wide = width >= 50;

  // Header: mark beside the name/tagline on wide terminals, compact line otherwise.
  out.push(...brandHeader('The local AI-agent trace debugger.', { width, mode }));
  out.push('');

  // Live status block.
  const n = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (probe.running) {
    const countsNote = probe.counts
      ? ` — ${n(probe.counts.traces, 'trace')}, ${n(probe.counts.flows, 'flow')}, ${n(probe.counts.evals, 'eval')}`
      : '';
    out.push(`  ${bullet('ok')} Coach ${dim(`v${probe.version}`)} running on port ${port}${countsNote}`);
    out.push(`    Dashboard   ${link(probe.dashboard, mode)}`);
    out.push(`    Ingest      ${probe.ingest}   ${dim(`(key: ${probe.apiKey?.slice(0, 16)}…)`)}`);
  } else {
    out.push(`  ${bullet('down')} No Coach running on port ${port}`);
    out.push(`    Start one:   ${bold(paint('glassray-coach start', PALETTE.brandBright))}`);
  }
  out.push('');

  // Command reference.
  const cellWidth = Math.max(
    ...COMMAND_SECTIONS.flatMap((s) => s.rows.map(([cell]) => cell.length)),
  );
  for (const section of COMMAND_SECTIONS) {
    out.push(`  ${heading(section.title)}${section.note ? `   ${dim(section.note)}` : ''}`);
    for (const [cell, description] of section.rows) out.push(row(cell, description, cellWidth));
    out.push('');
  }

  // Worked examples (full invocations, the fastest way to see the shape of the CLI).
  const exampleWidth = Math.max(...EXAMPLE_ROWS.map(([cell]) => cell.length));
  out.push(`  ${heading('EXAMPLES')}`);
  for (const [cell, description] of EXAMPLE_ROWS) {
    out.push(`    ${bold(paint(cell.padEnd(exampleWidth), PALETTE.brandBright))}  ${dim(description)}`);
  }
  out.push('');

  // Guide links + the skill-install one-liners.
  out.push(`  ${heading('LEARN')}`);
  for (const [label, value, kind] of LEARN_ROWS) {
    const cell = kind === 'cmd' ? bold(paint(value, PALETTE.brandBright)) : link(value, mode);
    out.push(`    ${label.padEnd(cellWidth)}  ${cell}`);
  }
  out.push('');
  out.push(`  Run ${bold(paint('glassray-coach <command> --help', PALETTE.brandBright))} for flags, or ${bold(paint('glassray-coach start', PALETTE.brandBright))} to begin.`);
  if (updateNotice) {
    out.push('');
    out.push(`  ${updateNotice}`);
  }
  out.push('');
  return out.join('\n');
};

/** Gather the live data and print the landing screen (the bare-command entry point). */
export const showLanding = async ({ port, home }) => {
  maybeScheduleUpdateRefresh(home);
  const probe = await probeCoach(port);
  console.log(
    renderLanding({
      port,
      probe,
      width: process.stdout.columns ?? 80,
      updateNotice: readUpdateNotice(home),
    }),
  );
};
