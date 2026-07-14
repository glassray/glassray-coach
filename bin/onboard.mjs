/**
 * Interactive onboarding for `glassray-coach start` on an empty store: offer to
 * run the user's OWN Claude Code on the server-built onboarding prompt (their
 * code never transits anything but their machine), or hand the prompt over.
 *
 * The Claude execution seam is ported from the umbrella CLI's claude-runner:
 * Claude runs HEADLESSLY (`claude -p`) — it applies the change autonomously and
 * exits, returning control to `start` (an interactive TUI would strand the user
 * inside Claude while the server runs in the same terminal). `stream-json`
 * output becomes a live activity feed, and the permission model is deliberately
 * simple: auto-approve edits, allow the shell, HARD-deny `git commit`/`git push`
 * (deny beats allow) — the human reviews the uncommitted diff; that, not
 * install-scoping, is the safety property that matters.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { dim, paint, PALETTE } from './ui.mjs';

// ── environment probes ─────────────────────────────────────────────────────────

/** Whether the `claude` binary is resolvable on PATH. */
export const hasClaude = () => {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(probe, ['claude'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};

/**
 * Cheap static "is this repo already wired?" checks (no LLM): the tracing SDK
 * in package.json, or a glassray.yaml at the root. Used only to phrase the
 * offer honestly — an already-wired repo with an empty store usually means a
 * fresh data dir, not a fresh project.
 */
export const detectRepo = (cwd = process.cwd()) => {
  let tracingSdk = false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    tracingSdk = '@glassray/tracing' in deps;
  } catch {
    // No/unreadable package.json — not a Node repo (or not at its root).
  }
  return { tracingSdk, artifact: existsSync(path.join(cwd, 'glassray.yaml')) };
};

/** Best-effort OS clipboard copy via the platform's native tool; never throws. */
export const copyToClipboard = (text) => {
  const writers =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of writers) {
    try {
      if (spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return true;
    } catch {
      // Tool missing — try the next one.
    }
  }
  return false;
};

// ── the headless Claude runner ─────────────────────────────────────────────────

/**
 * Deny rules that HARD-BLOCK the spawned Claude from committing or pushing
 * (deny beats acceptEdits and the allow-list). Read-only git stays allowed.
 * Covers the bare + arg forms and the `git -C <path>` escape.
 */
const GIT_WRITE_DENY = [
  'Bash(git commit)',
  'Bash(git commit *)',
  'Bash(git push)',
  'Bash(git push *)',
  'Bash(git -C * commit*)',
  'Bash(git -C * push*)',
].join(',');

/** `claude -p` flags: stream events, auto-approve edits, allow the shell, deny git writes. */
const HEADLESS_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'acceptEdits',
  '--allowedTools',
  'Bash',
  '--disallowedTools',
  GIT_WRITE_DENY,
];

/** File-mutating tools whose target we surface as an edit in the summary. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update']);

/** A token carrying a shell metacharacter — where a package list ends. */
const SHELL_META = /[|<>&;]/;

/** If `cmd` is a package install, the packages it installs; else `null`. */
export const parseInstall = (cmd) => {
  const m = cmd.match(/^\s*(?:pnpm add|npm (?:install|i)|yarn add|bun add)\b\s*(.*)$/);
  if (!m) return null;
  const packages = [];
  for (const tok of (m[1] ?? '').trim().split(/\s+/)) {
    if (!tok) continue;
    if (SHELL_META.test(tok)) break; // stop at `2>&1`, `|`, `&&`, redirects
    if (tok.startsWith('-')) continue; // skip flags
    packages.push(tok);
  }
  return packages.length > 0 ? packages : null;
};

/** A repo-relative path for display. */
const relPath = (cwd, p) => (path.isAbsolute(p) ? path.relative(cwd, p) || p : p);

/** Shorten a shell command to a single readable clause. */
const shortCmd = (cmd) => {
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
};

/**
 * A stateful fold over Claude's `stream-json` events. `push(line)` returns a
 * fresh human label when a tool starts (for the live feed), or `null`;
 * `summary()` reports what actually landed (successful tools only). Pure — no
 * I/O — so it's unit-testable against a recorded transcript.
 */
export const createClaudeReducer = (cwd) => {
  const pending = new Map();
  const edits = new Set();
  const installs = new Set();
  let finalText = '';

  const classify = (name, input) => {
    const file = typeof input.file_path === 'string' ? input.file_path : undefined;
    if (EDIT_TOOLS.has(name) && file) {
      const rel = relPath(cwd, file);
      return { entry: { kind: 'edit', file: rel }, label: `editing ${rel}` };
    }
    if (name === 'Bash' && typeof input.command === 'string') {
      const packages = parseInstall(input.command);
      if (packages) return { entry: { kind: 'install', packages }, label: `installing ${packages.join(' ')}` };
      return { entry: { kind: 'other' }, label: `running ${shortCmd(input.command)}` };
    }
    if (name === 'Read' && file) return { entry: { kind: 'other' }, label: `reading ${path.basename(file)}` };
    if (name === 'Grep' || name === 'Glob') return { entry: { kind: 'other' }, label: 'searching the codebase' };
    return { entry: { kind: 'other' }, label: `${name.toLowerCase()}…` };
  };

  return {
    push(line) {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let e;
      try {
        e = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (e.type === 'assistant') {
        const content = e.message?.content ?? [];
        let label = null;
        for (const block of content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            const c = classify(block.name, block.input ?? {});
            pending.set(block.id, c.entry);
            label = c.label; // last tool in the message wins the feed line
          }
        }
        return label;
      }
      if (e.type === 'user') {
        for (const block of e.message?.content ?? []) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const entry = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          if (!entry || block.is_error) continue; // record SUCCESSFUL tools only
          if (entry.kind === 'edit') edits.add(entry.file);
          else if (entry.kind === 'install') for (const pkg of entry.packages) installs.add(pkg);
        }
        return null;
      }
      if (e.type === 'result' && typeof e.result === 'string') finalText = e.result;
      return null;
    },
    summary() {
      return { edits: [...edits], installs: [...installs], finalText };
    },
  };
};

/** The in-flight headless Claude, if any — so `start`'s shutdown paths can take it down too. */
let activeClaude = null;

/**
 * Kill the in-flight headless Claude, if any. `start` calls this from its
 * SIGINT/SIGTERM handlers and when the server child dies — a Claude mid-edit
 * must never outlive the CLI and the server it is wiring against.
 */
export const killActiveClaude = () => {
  if (activeClaude) activeClaude.kill('SIGTERM');
};

/**
 * Run the user's `claude` on the onboarding prompt in `cwd`, headless. The
 * prompt goes over stdin; stdout is the `stream-json` feed (never shown raw),
 * driving `onActivity(label)` and the returned summary. Resolves with the exit
 * code + summary; rejects only if the process can't be spawned.
 */
export const runClaude = (prompt, cwd = process.cwd(), onActivity) =>
  new Promise((resolve, reject) => {
    const onWindows = process.platform === 'win32';
    // On Windows `claude` is a `.cmd` shim Node can only exec through a shell.
    const child = spawn('claude', HEADLESS_ARGS, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: onWindows,
      ...(onWindows ? { windowsVerbatimArguments: false } : {}),
    });
    activeClaude = child;

    const reducer = createClaudeReducer(cwd);
    let stdoutBuf = '';
    let sawEvent = false;
    let stderrTail = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim()) sawEvent = true;
        const label = reducer.push(line);
        if (label && onActivity) onActivity(label);
        nl = stdoutBuf.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000); // tail only — explain, never flood
    });

    child.on('error', (err) => {
      if (activeClaude === child) activeClaude = null;
      reject(err);
    });
    child.on('exit', (code) => {
      if (activeClaude === child) activeClaude = null;
      if (stdoutBuf.trim()) reducer.push(stdoutBuf); // flush a trailing partial line
      if (!sawEvent && stderrTail.trim()) process.stderr.write(stderrTail); // format drift — don't hide Claude
      resolve({ code: code ?? 0, errorTail: stderrTail.trim(), ...reducer.summary() });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });

// ── the interactive offer ──────────────────────────────────────────────────────

/** Print the onboarding prompt verbatim between rules (a terminal copy grabs exactly the agent's text), then try the clipboard. */
const showPrompt = (prompt) => {
  console.log('');
  console.log(`  ${dim('─'.repeat(72))}`);
  console.log(prompt);
  console.log(`  ${dim('─'.repeat(72))}`);
  console.log(
    copyToClipboard(prompt)
      ? `  ${paint('✓', PALETTE.brand)} Copied to your clipboard — paste it into Claude Code, Codex, or Copilot.`
      : '  Copy the block above into Claude Code, Codex, or Copilot.',
  );
};

/** Print the manual OTLP wiring block. */
const showManual = (port, apiKey) => {
  console.log('');
  console.log("  Point your agent's OTLP exporter at Coach:");
  console.log('');
  console.log(`    export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:${port}"`);
  console.log('    export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"');
  console.log(`    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${apiKey}"`);
};

/**
 * The empty-store setup menu. Returns after the chosen path completes; the
 * server keeps running throughout (Claude's verify step needs it). Streams are
 * injectable for tests; `claudeAvailable` and `run` too.
 */
export const offerOnboarding = async (
  { prompt, port, apiKey, cwd = process.cwd() },
  {
    input = process.stdin,
    output = process.stdout,
    claudeAvailable = hasClaude(),
    run = runClaude,
  } = {},
) => {
  const repo = detectRepo(cwd);
  if (repo.tracingSdk || repo.artifact) {
    console.log(
      `  ${dim('This repo already has')} ${repo.tracingSdk ? '@glassray/tracing' : 'glassray.yaml'}${dim(' — an empty store usually means a fresh data dir; re-running setup is safe.')}`,
    );
  }
  console.log('  Set it up now?');
  if (claudeAvailable) {
    console.log(`    ${paint('1.', PALETTE.brand)} Run Claude Code here — headless; edits land uncommitted for you to review`);
  }
  console.log(`    ${paint('2.', PALETTE.brand)} Copy the onboarding prompt for any coding agent`);
  console.log(`    ${paint('3.', PALETTE.brand)} Show the manual wiring (OTLP env vars)`);
  const fallback = claudeAvailable ? '1' : '2';

  const rl = readline.createInterface({ input, output });
  let choice;
  try {
    choice = (await rl.question(`  Choose ${claudeAvailable ? '[1/2/3]' : '[2/3]'} (Enter = ${fallback}): `)).trim() || fallback;
  } finally {
    rl.close();
  }

  if (choice === '1' && claudeAvailable) {
    console.log('');
    console.log(`  Running Claude Code ${dim('(headless — it cannot git commit or push; review the diff after)')}`);
    let result;
    try {
      result = await run(prompt, cwd, (label) => console.log(`    ${dim('·')} ${label}`));
    } catch (err) {
      console.error(`  ✗ could not run claude (${err?.message ?? err}) — here's the prompt instead:`);
      showPrompt(prompt);
      return;
    }
    if (result.code !== 0) {
      const tail = result.errorTail ? ` — ${result.errorTail.split('\n').at(-1)}` : '';
      console.error(`  ✗ Claude Code exited with code ${result.code}${tail}; here's the prompt to run yourself:`);
      showPrompt(prompt);
      return;
    }
    console.log('');
    if (result.installs.length > 0) console.log(`  Installed  ${result.installs.join(', ')}`);
    if (result.edits.length > 0) console.log(`  Edited     ${result.edits.join(', ')}`);
    if (result.installs.length === 0 && result.edits.length === 0 && result.finalText) {
      console.log(`  ${result.finalText.split('\n')[0]}`);
    }
    console.log(`  Review with ${paint('git diff', PALETTE.brand)}, then run your agent — traces land here live.`);
    return;
  }
  if (choice === '3') {
    showManual(port, apiKey);
    return;
  }
  showPrompt(prompt); // '2' and anything unrecognized: the safe hand-off
};
