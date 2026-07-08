/**
 * glassray CLI branding kit — zero-dependency plain ESM.
 *
 * Owns everything human-facing and visual: terminal color-capability detection
 * (truecolor → 256 → 16 → plain, honoring NO_COLOR / FORCE_COLOR / dumb / pipes),
 * the brand palette (mapped from the product tokens in web/src/styles.css), the
 * pixel-exact Glassray mark (the 15×11 bitmap from glassray-mark.svg rendered as
 * Unicode half-blocks), text primitives, the guide-link table, and the npm
 * update check (passive cache + detached refresh; live probe for `doctor`).
 *
 * NEVER imported on the data-command stdout path for decoration — data commands
 * print verbatim API JSON only.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The CLI's own version, from package.json (this file lives in coach/bin/). */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// ── color capability ─────────────────────────────────────────────────────────

/** Detect the color depth to use for one stream ('truecolor' | '256' | '16' | 'plain'). */
const detectMode = (stream) => {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'plain';
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0';
  if (!forced) {
    if (stream.isTTY !== true) return 'plain';
    if (env.TERM === 'dumb') return 'plain';
  }
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || forced) return 'truecolor';
  if ((env.TERM ?? '').includes('256color')) return '256';
  return '16';
};

/** Color mode for stdout (computed once — the landing/help/cards stream). */
export const MODE_OUT = detectMode(process.stdout);
/** Color mode for stderr (errors + progress lines). */
export const MODE_ERR = detectMode(process.stderr);

/** One palette entry: the truecolor hex plus its 16-color ANSI fallback code. */
const entry = (hex, ansi16) => ({ hex, ansi16 });

/** The brand palette, mapped from the product tokens (web/src/styles.css). */
export const PALETTE = {
  /** Forest green — `--brand` — ok-states and the mark's base. */
  brand: entry('#166534', '32'),
  /** Luminous brand green — same hue family, readable as TEXT on dark terminals (forest is too dim). */
  brandBright: entry('#3fb950', '92'),
  /** Acid — `--acid` — the accent; the ray tip of the mark, update notices. */
  acid: entry('#ddff1a', '93'),
  /** Muted ink — `--muted-foreground` — secondary text, headings. */
  muted: entry('#787872', '90'),
  /** Warning amber — `--warning`. */
  warn: entry('#ffb347', '33'),
  /** Error red — `--error`. */
  error: entry('#ff5f4d', '31'),
};

/** Parse `#rrggbb` into [r, g, b]. */
const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Nearest xterm-256 cube index for an rgb triple. */
const to256 = ([r, g, b]) =>
  16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);

/** The SGR color prefix for a palette entry (or raw hex) at a given mode; '' when plain. */
const colorCode = (color, mode) => {
  const hex = typeof color === 'string' ? color : color.hex;
  switch (mode) {
    case 'truecolor': {
      const [r, g, b] = hexToRgb(hex);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    case '256':
      return `\x1b[38;5;${to256(hexToRgb(hex))}m`;
    case '16':
      return `\x1b[${typeof color === 'string' ? '39' : color.ansi16}m`;
    default:
      return '';
  }
};

/** Paint text in a palette entry (or raw hex) for stdout; no-op when plain. */
export const paint = (text, color, mode = MODE_OUT) => {
  const code = colorCode(color, mode);
  return code === '' ? text : `${code}${text}\x1b[39m`;
};

/** Paint for stderr (errors, progress). */
export const paintErr = (text, color) => paint(text, color, MODE_ERR);

/** Bold text (stdout); no-op when plain. */
export const bold = (text, mode = MODE_OUT) => (mode === 'plain' ? text : `\x1b[1m${text}\x1b[22m`);

/** Dim text (stdout); no-op when plain. */
export const dim = (text, mode = MODE_OUT) => (mode === 'plain' ? text : `\x1b[2m${text}\x1b[22m`);

/** A section heading: bold, muted, already-uppercase label. */
export const heading = (text) => bold(paint(text, PALETTE.muted));

/** A status bullet: ● in green (ok) / amber (warn) / red (down). */
export const bullet = (state) =>
  paint('●', state === 'ok' ? PALETTE.brand : state === 'warn' ? PALETTE.warn : PALETTE.error);

/** A red ✗ error prefix for stderr lines. */
export const cross = () => paintErr('✗', PALETTE.error);

/**
 * A styled URL — an OSC-8 clickable hyperlink on truecolor terminals (iTerm2,
 * WezTerm, Ghostty, VS Code…), a colored URL elsewhere, the bare URL when plain.
 */
export const link = (url, mode = MODE_OUT) => {
  if (mode === 'plain') return url;
  const painted = paint(url, PALETTE.brandBright, mode);
  return mode === 'truecolor' ? `\x1b]8;;${url}\x1b\\${painted}\x1b]8;;\x1b\\` : painted;
};

// ── the mark ─────────────────────────────────────────────────────────────────

/**
 * The Glassray mark, verbatim from glassray-mark.svg's rect grid: the SVG's
 * 19×19 canvas inks a 15×11 bitmap (x 2–16, y 4–14). '#' = pixel. The
 * SVG-parity test (test/cli-ui.test.mjs) re-derives this from the SVG itself,
 * so it cannot drift from the real logo.
 */
export const MARK_BITMAP = [
  '......#.#......',
  '.....#####.....',
  '..###########..',
  '###############',
  '.#############.',
  '...#########...',
  '.....#####.....',
  '......###......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
];

/** The mark's own fill, verbatim from the SVG (near-white). */
const MARK_COLOR = entry('#f4f5f7', '97');

/**
 * Render the mark as 6 terminal lines of half-blocks (two bitmap rows per
 * line — terminal cells are ~1:2, so pixels come out square and the SVG's
 * proportions hold). Painted in the SVG's own near-white (bright white at
 * 16 colors); plain mode returns uncolored block characters that inherit the
 * terminal's default foreground.
 */
export const renderMark = (mode = MODE_OUT) => {
  const lines = [];
  for (let row = 0; row < MARK_BITMAP.length; row += 2) {
    const top = MARK_BITMAP[row];
    const bottom = MARK_BITMAP[row + 1] ?? '.'.repeat(top.length);
    let line = '';
    for (let col = 0; col < top.length; col += 1) {
      const t = top[col] === '#';
      const b = bottom[col] === '#';
      line += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.map((line) => (mode === 'plain' ? line : paint(line, MARK_COLOR, mode)));
};

/** The narrow/pipe fallback brand line. */
export const compactBrand = () => `${paint('◆', PALETTE.acid)} ${bold('glassray coach')} ${dim(`v${VERSION}`)}`;

// ── guide links ──────────────────────────────────────────────────────────────

/** The canonical docs/repo links used by the landing screen, init, and error hints. */
export const GUIDES = {
  quickstart: 'https://glassray.ai/docs/coach/quickstart',
  loop: 'https://glassray.ai/docs/coach/analyze',
  cli: 'https://glassray.ai/docs/coach/cli',
  github: 'https://github.com/glassray/glassray-coach',
};

// ── update check ─────────────────────────────────────────────────────────────

/** Cache file (under $GLASSRAY_HOME) recording the last registry check. */
const updateCachePath = (home) => path.join(home, 'update-check.json');

/** How long a registry answer stays fresh before a background refresh (24 h). */
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

/** True when the user (or the environment) opted out of update checks entirely. */
export const updateCheckOptedOut = () =>
  Boolean(process.env.GLASSRAY_NO_UPDATE_CHECK) ||
  Boolean(process.env.NO_UPDATE_NOTIFIER) ||
  Boolean(process.env.CI);

/** True when the passive check may run at all: not opted out, and a human is watching. */
export const updateCheckEnabled = () => !updateCheckOptedOut() && process.stdout.isTTY === true;

/**
 * Compare two `x.y.z` versions: 1 when a > b, -1 when a < b, 0 when equal or
 * unparseable. A prerelease (`-…`) ranks below its own release.
 */
export const compareVersions = (a, b) => {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(v).trim());
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]) ? 1 : -1;
  }
  if (Boolean(pa[4]) !== Boolean(pb[4])) return pa[4] ? -1 : 1;
  return 0;
};

/** Read the cached check; null when absent/corrupt. */
const readUpdateCache = (home) => {
  try {
    const cache = JSON.parse(readFileSync(updateCachePath(home), 'utf8'));
    return typeof cache === 'object' && cache !== null ? cache : null;
  } catch {
    return null;
  }
};

/**
 * The one-line update notice from the CACHE (never the network), or null when
 * current / unknown / opted out.
 */
export const readUpdateNotice = (home) => {
  if (updateCheckOptedOut()) return null;
  const cache = readUpdateCache(home);
  if (typeof cache?.latest !== 'string') return null;
  if (compareVersions(cache.latest, VERSION) <= 0) return null;
  return `${paint('▲', PALETTE.acid)} Update available ${VERSION} → ${bold(cache.latest)} — run ${paint('npm i -g @glassray/coach', PALETTE.brand)}`;
};

/**
 * The detached-child refresh: fetch the latest published version (3s budget),
 * merge it into the cache. Runs as `node -e <script> <cachePath>` so the parent
 * CLI never waits on the network. Failures still stamp `lastCheckedAt` (no
 * retry storms offline); the previous `latest` survives a failed fetch.
 */
const REFRESH_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const cachePath = process.argv[1];
(async () => {
  let latest = null;
  try {
    const res = await fetch('https://registry.npmjs.org/@glassray/coach/latest', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { const body = await res.json(); if (typeof body.version === 'string') latest = body.version; }
  } catch {}
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latest: latest ?? prev?.latest ?? null }));
  } catch {}
})();
`;

/**
 * Default spawner for the background refresh (detached, fire-and-forget). The
 * data dir is created by the CHILD, not here — a read-only command like
 * `status` must not grow a missing data dir as a side effect of scheduling.
 */
const defaultRefreshSpawner = (cacheFile) => {
  try {
    const child = spawn(process.execPath, ['-e', REFRESH_SCRIPT, cacheFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best effort only — an update check must never break a command.
  }
};

/** True when the cache is stale enough that a background refresh is due (a future stamp — clock skew — counts as due). */
export const updateRefreshDue = (cache, now = Date.now()) => {
  if (typeof cache?.lastCheckedAt !== 'number') return true;
  const age = now - cache.lastCheckedAt;
  return !(age >= 0 && age < UPDATE_TTL_MS);
};

/**
 * Kick a background refresh when enabled and due. Returns whether one was
 * spawned (the spawner is injectable for tests — no test ever hits npm).
 */
export const maybeScheduleUpdateRefresh = (home, spawner = defaultRefreshSpawner) => {
  if (!updateCheckEnabled()) return false;
  if (!updateRefreshDue(readUpdateCache(home))) return false;
  spawner(updateCachePath(home));
  return true;
};

/** Live registry probe for `glassray doctor` (the one awaited check); null on any failure. */
export const fetchLatestVersion = async (timeoutMs = 3000) => {
  try {
    const res = await fetch('https://registry.npmjs.org/@glassray/coach/latest', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
};
