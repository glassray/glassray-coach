/*
 * Rough token pricing for the cost rollup — a small, EASILY EDITED table of
 * blended USD per 1M tokens, keyed by provider. Deliberately approximate: real
 * cost depends on the exact model, and Coach is offline (no live price feed),
 * so the UI labels this an estimate. Update these as list prices move, or set a
 * provider to null to omit it from the estimate.
 */

/** Blended input / output USD per 1,000,000 tokens, by provider. */
const PROVIDER_PRICING: Record<string, { inPerM: number; outPerM: number } | null> = {
  anthropic: { inPerM: 3, outPerM: 15 },
  openai: { inPerM: 2.5, outPerM: 10 },
};

/** Rough USD cost for a token bucket under a provider; 0 when the provider is unpriced. */
export const estimateCostUsd = (
  provider: string | null,
  tokensIn: number,
  tokensOut: number,
): number => {
  const price = provider ? PROVIDER_PRICING[provider] : null;
  if (!price) return 0;
  return (tokensIn / 1_000_000) * price.inPerM + (tokensOut / 1_000_000) * price.outPerM;
};

/**
 * The PRICE BOOK: input / output USD per 1M tokens per model id. This is what
 * "cost if metered" is computed from — the honesty fix that lets a model swap
 * answer "is it cheaper?" even on the free `claude-subscription` provider.
 * Update as list prices move.
 */
export const MODEL_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'claude-opus-4-8': { inPerM: 15, outPerM: 75 },
  'claude-opus-4-6': { inPerM: 15, outPerM: 75 },
  'claude-sonnet-4-6': { inPerM: 3, outPerM: 15 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
  'gpt-4o': { inPerM: 2.5, outPerM: 10 },
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.6 },
};

/** Longest-prefix match into the price book, so dated ids (`claude-haiku-4-5-20251001`) still price. */
const priceForModel = (model: string): { inPerM: number; outPerM: number } | null => {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [id, price] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(id)) return price;
  }
  // Family fallback: an unknown Claude/GPT id gets the provider's blended rate.
  if (model.startsWith('claude')) return PROVIDER_PRICING.anthropic ?? null;
  if (model.startsWith('gpt') || model.startsWith('o')) return PROVIDER_PRICING.openai ?? null;
  return null;
};

/**
 * USD this token bucket WOULD cost on a metered API key, regardless of the
 * provider that actually served it — priced from the model id alone. This is
 * the "cost if metered" figure shown next to $0 subscription/mock spend, so a
 * model-swap comparison is never theater. 0 when the model can't be priced.
 */
export const estimateCostIfMetered = (
  model: string | null,
  tokensIn: number,
  tokensOut: number,
): number => {
  const price = model ? priceForModel(model) : null;
  if (!price) return 0;
  return (tokensIn / 1_000_000) * price.inPerM + (tokensOut / 1_000_000) * price.outPerM;
};

/** Providers whose token spend costs the developer real money (metered API keys). */
const METERED_PROVIDERS = new Set(['anthropic', 'openai']);

/**
 * Rough USD cost of a token bucket for a specific (provider, model) — used to
 * meter Coach's OWN LLM spend against the budget. Only the metered providers
 * accrue cost; `mock` and `claude-subscription` are free / flat-rate, so they
 * return 0 and never count against the budget. Falls back to the blended
 * provider rate when the exact model id is unknown.
 */
export const estimateCostForModel = (
  provider: string | null,
  model: string | null,
  tokensIn: number,
  tokensOut: number,
): number => {
  if (!provider || !METERED_PROVIDERS.has(provider)) return 0;
  const price = (model ? MODEL_PRICING[model] : undefined) ?? PROVIDER_PRICING[provider];
  if (!price) return 0;
  return (tokensIn / 1_000_000) * price.inPerM + (tokensOut / 1_000_000) * price.outPerM;
};
