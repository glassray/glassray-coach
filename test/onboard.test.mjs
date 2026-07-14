/*
 * The interactive onboarding surface (bin/onboard.mjs): the stream-json
 * reducer that turns Claude's transcript into a live feed + summary, the
 * install-command parser, the repo detector, and the menu's three paths —
 * driven through injected streams and a stubbed runner, no real `claude`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeReducer, detectRepo, offerOnboarding, parseInstall } from '../bin/onboard.mjs';

/** One stream-json line. */
const line = (obj) => `${JSON.stringify(obj)}\n`;

/** An assistant message carrying one tool_use block. */
const toolUse = (id, name, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});

/** A user message carrying one tool_result block. */
const toolResult = (id, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
});

describe('parseInstall', () => {
  it('recognizes the package managers and strips flags', () => {
    expect(parseInstall('npm install @glassray/tracing')).toEqual(['@glassray/tracing']);
    expect(parseInstall('pnpm add -D @glassray/tracing zod')).toEqual(['@glassray/tracing', 'zod']);
    expect(parseInstall('yarn add @glassray/tracing')).toEqual(['@glassray/tracing']);
  });
  it('stops at shell operators and rejects non-installs', () => {
    expect(parseInstall('npm i @glassray/tracing 2>&1 | tee log')).toEqual(['@glassray/tracing']);
    expect(parseInstall('node agent.mjs')).toBeNull();
    expect(parseInstall('npm install')).toBeNull();
  });
});

describe('createClaudeReducer', () => {
  it('labels tool starts and records only successful edits/installs', () => {
    const r = createClaudeReducer('/repo');
    expect(r.push(line(toolUse('t1', 'Edit', { file_path: '/repo/src/agent.ts' })))).toBe('editing src/agent.ts');
    expect(r.push(line(toolResult('t1')))).toBeNull();
    expect(r.push(line(toolUse('t2', 'Bash', { command: 'npm i @glassray/tracing' })))).toBe(
      'installing @glassray/tracing',
    );
    r.push(line(toolResult('t2')));
    // A FAILED edit must not appear in the summary.
    r.push(line(toolUse('t3', 'Write', { file_path: '/repo/broken.ts' })));
    r.push(line(toolResult('t3', true)));
    r.push(line({ type: 'result', result: 'All wired up.' }));
    expect(r.summary()).toEqual({
      edits: ['src/agent.ts'],
      installs: ['@glassray/tracing'],
      finalText: 'All wired up.',
    });
  });
  it('ignores blank and non-JSON lines', () => {
    const r = createClaudeReducer('/repo');
    expect(r.push('')).toBeNull();
    expect(r.push('not json')).toBeNull();
  });
});

describe('detectRepo', () => {
  it('spots the tracing dep and the artifact file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gr-onboard-'));
    try {
      expect(detectRepo(dir)).toEqual({ tracingSdk: false, artifact: false });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@glassray/tracing': '^1' } }));
      writeFileSync(path.join(dir, 'glassray.yaml'), 'version: 1\n');
      expect(detectRepo(dir)).toEqual({ tracingSdk: true, artifact: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('offerOnboarding', () => {
  /** Drive the menu with a canned keystroke line; capture console output. */
  const drive = async (answer, opts) => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume(); // discard the readline echo
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(args.join(' ')));
    try {
      const done = offerOnboarding(
        { prompt: 'THE-PROMPT', port: 5899, apiKey: 'glsk_local_x', cwd: tmpdir() },
        { input, output, ...opts },
      );
      input.write(`${answer}\n`);
      await done;
      return logs.join('\n');
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('hands the prompt over on choice 2 (and on Enter without claude)', async () => {
    const out = await drive('2', { claudeAvailable: false });
    expect(out).toContain('THE-PROMPT');
    expect(out).not.toContain('Run Claude Code here'); // option 1 hidden without claude
    const fallback = await drive('', { claudeAvailable: false });
    expect(fallback).toContain('THE-PROMPT');
  });

  it('prints the manual OTLP wiring on choice 3', async () => {
    const out = await drive('3', { claudeAvailable: false });
    expect(out).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(out).toContain('Bearer glsk_local_x');
    expect(out).not.toContain('THE-PROMPT');
  });

  it('runs the injected runner on choice 1 and reports the summary', async () => {
    const run = vi.fn(async (_prompt, _cwd, onActivity) => {
      onActivity('editing src/agent.ts');
      return { code: 0, errorTail: '', edits: ['src/agent.ts'], installs: ['@glassray/tracing'], finalText: '' };
    });
    const out = await drive('1', { claudeAvailable: true, run });
    expect(run).toHaveBeenCalledWith('THE-PROMPT', expect.any(String), expect.any(Function));
    expect(out).toContain('editing src/agent.ts');
    expect(out).toContain('Installed  @glassray/tracing');
    expect(out).toContain('Edited     src/agent.ts');
  });

  it('falls back to the prompt when the runner exits non-zero', async () => {
    const run = vi.fn(async () => ({ code: 1, errorTail: 'boom', edits: [], installs: [], finalText: '' }));
    const out = await drive('1', { claudeAvailable: true, run });
    expect(out).toContain('exited with code 1');
    expect(out).toContain('THE-PROMPT');
  });
});
