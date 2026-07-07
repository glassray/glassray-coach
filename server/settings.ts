import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/*
 * Dashboard-editable settings — an override layer over the env/default config so
 * a developer can pick their LLM provider, models, and spend cap from the UI
 * without restarting or editing env vars. Persisted to `<home>/settings.json`
 * (mode 0600) and cached in memory; `getSettings()` is the sync accessor the LLM
 * resolvers and the budget check consult *before* env, which is before defaults.
 * Only non-secret config lives here — provider API keys stay in the environment.
 */

/** The user-overridable settings. Every field is optional — an unset field falls back to env, then a default. */
export const settingsSchema = z.object({
  llmProvider: z.enum(['mock', 'claude-subscription', 'anthropic', 'openai']).optional(),
  heavyModelId: z.string().trim().min(1).max(200).optional(),
  lightModelId: z.string().trim().min(1).max(200).optional(),
  budgetUsd: z.number().min(0).max(1_000_000).optional(),
});

/** The shape stored in `settings.json` and returned by `getSettings()`. */
export type CoachSettings = z.infer<typeof settingsSchema>;

/** In-memory cache, so the (synchronous) LLM resolvers can read settings without disk I/O per call. */
let current: CoachSettings = {};

/** The settings file path under the data home. */
const settingsPath = (home: string): string => path.join(home, 'settings.json');

/** The dashboard-set overrides — read by the LLM provider/model resolvers and the budget check. */
export const getSettings = (): CoachSettings => current;

/** Load `settings.json` into the cache at boot; a missing or malformed file resets to empty (env/defaults win). */
export const loadSettings = async (home: string): Promise<CoachSettings> => {
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(await readFile(settingsPath(home), 'utf8')));
    current = parsed.success ? parsed.data : {};
  } catch {
    current = {};
  }
  return current;
};

/** Merge a validated patch into the cache and persist it (0600); returns the new full settings. */
export const saveSettings = async (home: string, patch: CoachSettings): Promise<CoachSettings> => {
  current = { ...current, ...patch };
  await writeFile(settingsPath(home), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  return current;
};
