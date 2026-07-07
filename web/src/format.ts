/** Small, dependency-free formatters shared across the Coach views. */

/** Format an ISO timestamp as a short relative age ("just now", "5m ago", "3d ago"). */
export const relativeTime = (iso: string | null): string => {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
};

/** Format a millisecond duration compactly ("820ms", "1.2s", "1m 3s", "5h 42m"). */
export const formatDuration = (ms: number | null): string => {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  // Decimal seconds, but only while rounding stays under a minute — otherwise the
  // carry (e.g. 59.96 → "60.0s") must roll into "1m 0s", handled below.
  if (seconds < 60) {
    const decimals = seconds < 10 ? 2 : 1;
    const rounded = Number(seconds.toFixed(decimals));
    // Pick the precision from the *rounded* value so a carry across the 10s
    // boundary reads as "10.0s", not "10.00s".
    if (rounded < 60) return `${rounded.toFixed(rounded < 10 ? 2 : 1)}s`;
  }
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${whole % 60}s`;
};

/** Group-separate an integer, or render an em dash when absent ("1,204", "—"). */
export const formatNumber = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString();

/** Render an in→out token pair, collapsing to a dash when both are absent. */
export const formatTokens = (tokensIn: number | null | undefined, tokensOut: number | null | undefined): string => {
  if (tokensIn == null && tokensOut == null) return "—";
  return `${formatNumber(tokensIn)} → ${formatNumber(tokensOut)}`;
};

/** Pretty-print an arbitrary captured value: strings pass through, JSON is indented. */
export const prettyValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/** Read a numeric field out of a run's free-form `stats` blob, defaulting to 0. */
export const readStat = (stats: Record<string, unknown> | null | undefined, key: string): number => {
  const v = stats?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/** Pluralize a noun by count ("1 trace", "3 traces"). */
export const plural = (n: number, noun: string): string => `${formatNumber(n)} ${noun}${n === 1 ? "" : "s"}`;

/** Truncate a single-line preview string for dense table cells. */
export const truncate = (value: string | null, max = 80): string => {
  if (!value) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
