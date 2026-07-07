/*
 * Source: packages/shared/src/server/traces/input-preview.ts
 * Vendored for Glassray Coach — refresh by re-copying from the main app.
 */

/** Maximum characters stored in `traces.input_preview`. */
export const INPUT_PREVIEW_MAX = 200;

/**
 * Extract a short human-readable text snippet from a raw provider input value.
 *
 * Handles the most common LLM input shapes:
 *   - plain string  → use directly
 *   - `{ input: "..." }`  → LangChain single-input chains
 *   - `{ question: "..." }` → QA chains
 *   - `{ messages: [...] }` → chat models — take the last human/user message
 *   - anything else → JSON.stringify (truncated)
 *
 * Returns `null` when the value is absent or yields an empty string.
 */
export const extractInputPreview = (value: unknown): string | null => {
  const text = resolveText(value);
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > INPUT_PREVIEW_MAX ? trimmed.slice(0, INPUT_PREVIEW_MAX) + "…" : trimmed;
};

const resolveText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const v = value as Record<string, unknown>;

  // Plain string fields — most common LangChain chain shapes
  for (const key of ["input", "question", "human_input", "query", "text", "prompt"]) {
    if (typeof v[key] === "string") return v[key] as string;
  }

  // Chat messages array — take the last human/user message's content
  const msgs = v["messages"];
  if (Array.isArray(msgs) && msgs.length > 0) {
    // Walk from the end to find the last human/user turn
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i] as Record<string, unknown>;
      const role = (msg?.role ?? msg?.type ?? "").toString().toLowerCase();
      if (role === "human" || role === "user") {
        const content = msg?.content ?? msg?.text;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          // Multi-modal content blocks — grab first text block
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b?.type === "text" && typeof b?.text === "string") return b.text as string;
          }
        }
      }
    }
    // No human turn found — fall back to last message
    const last = msgs[msgs.length - 1] as Record<string, unknown>;
    const content = last?.content ?? last?.text;
    if (typeof content === "string") return content;
  }

  // Last resort: compact JSON (still useful as a preview)
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};
