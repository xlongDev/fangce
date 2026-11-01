import { describe, expect, it } from "vitest";

import { trimHistory } from "@/lib/aiChat";
import type { AiMessage } from "@/types/ipc";

const user = (content: string): AiMessage => ({ role: "user", content });
const assistant = (content: string): AiMessage => ({ role: "assistant", content });

describe("trimHistory", () => {
  const exchange = [user("一"), assistant("一答"), user("二"), assistant("二答"), user("三")];

  it("keeps the last n turns, a turn being a question and its answer", () => {
    // Two turns back from a trailing question: the answer before it, then it.
    expect(trimHistory(exchange, 2)).toEqual([user("二"), assistant("二答"), user("三")]);
  });

  it("drops the leading answer a naive cut would leave behind", () => {
    // The last two messages are [answer, question]; starting the history on an
    // answer reads to a model as continuing something it cannot see.
    expect(trimHistory(exchange, 1)).toEqual([user("三")]);
  });

  it("returns everything when the history is shorter than the window", () => {
    expect(trimHistory([user("一"), assistant("一答")], 8)).toHaveLength(2);
  });

  it("returns nothing for a window of zero", () => {
    expect(trimHistory(exchange, 0)).toEqual([]);
  });

  it("returns nothing when there is no question at all", () => {
    expect(trimHistory([assistant("孤儿")], 4)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const copy = [...exchange];
    trimHistory(exchange, 1);
    expect(exchange).toEqual(copy);
  });
});
