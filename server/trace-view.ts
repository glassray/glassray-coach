/** Structural surface of the vendor trace normalizer's per-trace view. */
export type TraceView = {
  name: string | null;
  agent: string | null;
  provider: string | null;
  startedAt: string | number | Date | null;
  endedAt: string | number | Date | null;
  durationMs: number | null;
  spanCount: number | null;
  status: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  inputPreview: string | null;
  outputPreview: string | null;
  tree: unknown;
};

/** Signature of the vendor `buildTraceView(envelope, traceId)` display-field deriver. */
export type BuildTraceView = (envelope: unknown, traceId: string) => TraceView;

/** True when a dynamic-import failure means "module absent" rather than a bug inside the module. */
const isModuleNotFound = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  return (
    /cannot find|failed to (load|resolve)|not found/i.test(err.message) &&
    err.message.includes('vendor')
  );
};

/** Loads the real vendor normalizer (./vendor/index.js); falls back to the temporary stub only when the vendor module is missing. */
export const loadBuildTraceView = async (): Promise<BuildTraceView> => {
  // Non-literal specifier: the vendor module is authored separately, so typecheck must
  // pass (and the fallback must engage) while coach/server/vendor/ hasn't landed yet.
  const vendorSpecifier = './vendor/index.js';
  try {
    const mod = (await import(vendorSpecifier)) as { buildTraceView?: BuildTraceView };
    if (typeof mod.buildTraceView !== 'function') {
      throw new Error('vendor module does not export buildTraceView');
    }
    return mod.buildTraceView;
  } catch (err) {
    if (isModuleNotFound(err)) {
      const stub = await import('./vendor-stub.js');
      return stub.buildTraceView;
    }
    throw err;
  }
};

/** Coerces a vendor timestamp (ISO string, epoch ms, or Date) into a Date; null when absent or invalid. */
export const toDate = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Coerces a vendor numeric field into a finite integer; null otherwise. */
export const toInt = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
