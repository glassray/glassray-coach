import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MARK_BITMAP,
  compareVersions,
  maybeScheduleUpdateRefresh,
  readUpdateNotice,
  updateCheckEnabled,
  updateCheckOptedOut,
  updateRefreshDue,
} from '../bin/ui.mjs';
import { COMMAND_SECTIONS, MANAGEMENT_COMMANDS, renderLanding } from '../bin/landing.mjs';

/*
 * CLI branding + landing correctness: the terminal mark IS the SVG logo
 * (re-derived, never hand-copied), the landing screen documents every
 * dispatchable command, pipes receive no decoration and data-command stdout
 * stays pure, and the update check is gated + cache-driven (no test ever
 * touches npm).
 */

const COACH_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(COACH_ROOT, 'bin', 'glassray.mjs');

/** Run the CLI once with a hermetic env; update checks disabled unless a test opts in. */
const runCli = (args, env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: COACH_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GLASSRAY_NO_UPDATE_CHECK: '1', ...env },
    timeout: 15_000,
  });

describe('the terminal mark is the SVG logo', () => {
  it('re-derives the bitmap from glassray-mark.svg and matches MARK_BITMAP exactly', () => {
    const svg = readFileSync(path.join(COACH_ROOT, 'test', 'assets', 'glassray-mark.svg'), 'utf8');
    const px = [...svg.matchAll(/<rect x="(\d+)\.00" y="(\d+)\.00"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(px.length).toBeGreaterThan(0);
    const xs = px.map((p) => p[0]);
    const ys = px.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const width = Math.max(...xs) - x0 + 1;
    const height = Math.max(...ys) - y0 + 1;
    const grid = Array.from({ length: height }, () => Array(width).fill('.'));
    for (const [x, y] of px) grid[y - y0][x - x0] = '#';
    expect(grid.map((row) => row.join(''))).toEqual(MARK_BITMAP);
  });
});

describe('the shipped skill follows the Agent Skills spec (agentskills.io)', () => {
  it('SKILL.md frontmatter is valid: name rules, dir match, description + compatibility limits', () => {
    const skillDir = path.join(COACH_ROOT, 'skills', 'glassray');
    const raw = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    expect(fm, 'SKILL.md must start with YAML frontmatter').toBeTruthy();
    const get = (key) => {
      const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm[1])?.[1]?.trim();
      return value?.replace(/^"(.*)"$/, '$1'); // unquote
    };

    // Strict-YAML safety: an unquoted plain scalar must not contain ": " —
    // lenient parsers (Claude Code) accept it, strict ones (the `npx skills`
    // installer) reject the whole skill. Any such value must be quoted.
    for (const line of fm[1].split('\n')) {
      const m = /^\s*[\w-]+:\s*(.+)$/.exec(line);
      if (!m) continue;
      const value = m[1].trim();
      if (value.includes(': ') && !/^".*"$/.test(value)) {
        expect.fail(`frontmatter value must be quoted for strict YAML parsers: ${line.trim()}`);
      }
    }

    const name = get('name');
    expect(name).toBe(path.basename(skillDir)); // must match the folder name
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/); // lowercase/digits/single hyphens, no edge hyphens

    const description = get('description');
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);

    const compatibility = get('compatibility');
    if (compatibility) expect(compatibility.length).toBeLessThanOrEqual(500);

    // Progressive-disclosure guidance: keep the body under 500 lines.
    const body = raw.slice(fm[0].length);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body.split('\n').length).toBeLessThanOrEqual(500);
  });
});

describe('glassray init installs the skill to both standard locations', () => {
  it('writes .agents/skills and .claude/skills, is idempotent, and refuses to clobber edits without --force', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'glassray-init-'));
    const run = (args) =>
      spawnSync(process.execPath, [BIN, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GLASSRAY_NO_UPDATE_CHECK: '1' },
        timeout: 15_000,
      });
    try {
      const first = run(['init']);
      expect(first.status).toBe(0);
      const agents = path.join(cwd, '.agents', 'skills', 'glassray', 'SKILL.md');
      const claude = path.join(cwd, '.claude', 'skills', 'glassray', 'SKILL.md');
      const source = readFileSync(path.join(COACH_ROOT, 'skills', 'glassray', 'SKILL.md'), 'utf8');
      expect(readFileSync(agents, 'utf8')).toBe(source);
      expect(readFileSync(claude, 'utf8')).toBe(source);

      // Idempotent re-run.
      expect(run(['init']).status).toBe(0);

      // A locally edited copy refuses without --force, then --force restores it.
      writeFileSync(claude, 'locally edited');
      const refused = run(['init']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('--force');
      expect(run(['init', '--force']).status).toBe(0);
      expect(readFileSync(claude, 'utf8')).toBe(source);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('landing screen', () => {
  it('documents every dispatchable command word', () => {
    const text = renderLanding({ port: 5899, probe: { running: false }, width: 80, mode: 'plain' });
    const resourceCommands = ['traces', 'stats', 'usage', 'flows', 'evals', 'deviations', 'discovery', 'fix', 'runs'];
    const visibleManagement = MANAGEMENT_COMMANDS.filter((c) => c !== 'help' && c !== 'mcp');
    for (const word of [...resourceCommands, ...visibleManagement]) {
      expect(text, `landing must mention "${word}"`).toContain(word);
    }
    // The guide links are the discoverability story — all four must be present.
    expect(text).toContain('glassray.ai/docs/coach/quickstart');
    expect(text).toContain('glassray.ai/docs/coach/analyze');
    expect(text).toContain('glassray.ai/docs/coach/cli');
    expect(text).toContain('github.com/glassray/glassray-coach');
  });

  it('every COMMAND_SECTIONS row cell starts with a real command word', () => {
    const known = new Set([
      ...MANAGEMENT_COMMANDS,
      'traces',
      'stats',
      'usage',
      'flows',
      'evals',
      'deviations',
      'discovery',
      'fix',
      'runs',
      'reset',
    ]);
    for (const section of COMMAND_SECTIONS) {
      for (const [cell] of section.rows) {
        const first = cell.split(/[\s·]+/)[0];
        expect(known.has(first), `"${cell}" must start with a dispatchable command`).toBe(true);
      }
    }
  });

  it('bare `glassray` prints the landing to stdout, exits 0, and never decorates a pipe', () => {
    const res = runCli([]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('glassray coach');
    expect(res.stdout).toContain('glassray start');
    // Piped without FORCE_COLOR: plain mode — no ANSI escapes at all.
    expect(res.stdout).not.toMatch(/\x1b\[/);
  });

  it('a data command keeps stdout empty on exit 2 even with colors forced', () => {
    // Port 1 is never a Coach; FORCE_COLOR exercises the "branding never leaks
    // to the agent surface" guarantee on the unreachable path.
    const res = runCli(['stats', '--port', '59991'], { FORCE_COLOR: '1' });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('cannot reach a Coach server');
  });
});

describe('update check', () => {
  /** Env keys the gates read — saved/restored around each test. */
  const KEYS = ['GLASSRAY_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'CI'];
  let saved;
  let home;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    home = mkdtempSync(path.join(tmpdir(), 'glassray-ui-'));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('compareVersions orders releases and ranks prereleases below their release', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('garbage', '0.2.0')).toBe(0);
  });

  it('each opt-out disables the gate', () => {
    for (const key of KEYS) {
      process.env[key] = '1';
      expect(updateCheckOptedOut(), `${key} must opt out`).toBe(true);
      expect(updateCheckEnabled()).toBe(false);
      delete process.env[key];
    }
  });

  it('a stale cache is due, a fresh one is not', () => {
    expect(updateRefreshDue(null)).toBe(true);
    expect(updateRefreshDue({ lastCheckedAt: Date.now() })).toBe(false);
    expect(updateRefreshDue({ lastCheckedAt: Date.now() - 25 * 60 * 60 * 1000 })).toBe(true);
  });

  it('schedules exactly one injected refresh when enabled + due, none when opted out', () => {
    // updateCheckEnabled also requires a TTY stdout — fake it for the test.
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const spawned = [];
      expect(maybeScheduleUpdateRefresh(home, (cacheFile) => spawned.push(cacheFile))).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toBe(path.join(home, 'update-check.json'));

      // A fresh cache suppresses the next refresh.
      writeFileSync(spawned[0], JSON.stringify({ lastCheckedAt: Date.now(), latest: null }));
      expect(maybeScheduleUpdateRefresh(home, (cacheFile) => spawned.push(cacheFile))).toBe(false);
      expect(spawned).toHaveLength(1);

      // Opted out: never spawns, stale or not.
      process.env.GLASSRAY_NO_UPDATE_CHECK = '1';
      rmSync(spawned[0]);
      expect(maybeScheduleUpdateRefresh(home, (cacheFile) => spawned.push(cacheFile))).toBe(false);
      expect(spawned).toHaveLength(1);
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
  });

  it('renders the notice only for a genuinely newer cached version', () => {
    const cachePath = path.join(home, 'update-check.json');
    writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latest: '99.0.0' }));
    expect(readUpdateNotice(home)).toContain('99.0.0');
    writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latest: '0.0.1' }));
    expect(readUpdateNotice(home)).toBeNull();
    writeFileSync(cachePath, 'not json');
    expect(readUpdateNotice(home)).toBeNull();
    process.env.NO_UPDATE_NOTIFIER = '1';
    writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latest: '99.0.0' }));
    expect(readUpdateNotice(home)).toBeNull();
  });
});
