import type { SpanNode } from "./api";

/*
 * Pull an editable LLM request out of a captured span so the replay debugger can
 * re-issue it. Handles the common shapes Coach's normalizer produces: a plain
 * string, a `{ messages: [...] }` chat body, a bare messages array, or a
 * single-input object (`{ input | prompt | question | … }`). Anything else is
 * surfaced as pretty JSON the user can hand-edit.
 */

/** One chat turn after normalization. */
interface Message {
  role: string;
  content: string;
}

/** Flatten a message `content` (string, array of text parts, or object) into plain text. */
const contentToText = (content: unknown): string => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  return JSON.stringify(content);
};

/** Coerce a span input into a chat message list, or null if it isn't one. */
const asMessages = (input: unknown): Message[] | null => {
  const arr = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).messages)
      ? ((input as Record<string, unknown>).messages as unknown[])
      : null;
  if (!arr) return null;
  const msgs = arr
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
    .map((m) => ({ role: String(m.role ?? "user"), content: contentToText(m.content ?? m.text ?? "") }));
  return msgs.length > 0 ? msgs : null;
};

/** Keys that carry a single free-text prompt on non-chat LLM inputs. */
const PROMPT_KEYS = ["input", "prompt", "question", "query", "text", "human_input"] as const;

/** An editable LLM request lifted from a span: the model plus a system + prompt split. */
export interface LlmRequest {
  model: string;
  system: string;
  prompt: string;
}

/** Extract an editable `{ model, system, prompt }` from an LLM span's captured input. */
export const extractLlmRequest = (node: SpanNode): LlmRequest => {
  const model = node.model ?? "";
  const msgs = asMessages(node.input);
  if (msgs) {
    const system = msgs
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const rest = msgs.filter((m) => m.role !== "system");
    // A single user turn maps to the prompt verbatim; multi-turn is rendered as
    // `role: content` blocks the user can trim before replaying.
    const prompt =
      rest.length === 1
        ? rest[0]!.content
        : rest.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    return { model, system, prompt };
  }
  const input = node.input;
  if (typeof input === "string") return { model, system: "", prompt: input };
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of PROMPT_KEYS) {
      if (typeof o[key] === "string") return { model, system: "", prompt: o[key] as string };
    }
  }
  return { model, system: "", prompt: input == null ? "" : JSON.stringify(input, null, 2) };
};
