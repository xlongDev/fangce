import type { AiMessage } from "@/types/ipc";

/**
 * The exchange so far, cut to the number of turns the reader configured.
 *
 * Trimming lives here rather than in the backend because the conversation lives
 * in the renderer: one place decides what travels, and a second copy of the rule
 * in Rust would only be able to disagree with it.
 *
 * Two things a naive `slice(-n)` gets wrong and this does not:
 * - A turn is a question *and* its answer, so `turns` means `2 × turns`
 *   messages, not `turns`.
 * - The cut can land on an answer, leaving the history starting with an
 *   assistant message. Models read that as a continuation of something they
 *   cannot see, so leading answers are dropped.
 */
export function trimHistory(messages: readonly AiMessage[], turns: number): AiMessage[] {
  if (turns <= 0) return [];
  const kept = messages.slice(-(turns * 2));
  const firstUser = kept.findIndex((message) => message.role === "user");
  return firstUser <= 0 ? (firstUser === 0 ? kept : []) : kept.slice(firstUser);
}
