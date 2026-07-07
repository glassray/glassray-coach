import { randomBytes } from 'node:crypto';

/** Known id prefixes for Coach's local tables (run, deviation, deviation-example, flow, eval, eval-result, llm-usage). */
export type IdPrefix = 'run_' | 'dev_' | 'dex_' | 'flow_' | 'eval_' | 'evr_' | 'use_';

/** Mint a prefixed random-hex id (e.g. `dev_9f3a…`) — good enough for a single-process local store. */
export const newId = (prefix: IdPrefix): string => `${prefix}${randomBytes(12).toString('hex')}`;
