import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetConversation,
  rememberConversation,
  rememberedConversation,
} from "@/lib/aiConversationMemory";

describe("aiConversationMemory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("has nothing to say about a book nobody has asked in", () => {
    expect(rememberedConversation("b1")).toBeNull();
  });

  it("points one book at one conversation", () => {
    rememberConversation("b1", "c-42");
    expect(rememberedConversation("b1")).toBe("c-42");
  });

  it("keeps books apart", () => {
    // The same person reads two books; each remembers its own conversation, and
    // one must not reopen the other's transcript.
    rememberConversation("b1", "c-1");
    rememberConversation("b2", "c-2");

    expect(rememberedConversation("b1")).toBe("c-1");
    expect(rememberedConversation("b2")).toBe("c-2");
  });

  it("forgets a conversation that is gone, and stays empty", () => {
    rememberConversation("b1", "c-1");
    forgetConversation("b1");

    // Not "reopen the newest" — 新建 has to stay new, or the next mount would
    // drag the reader back into the conversation they just left.
    expect(rememberedConversation("b1")).toBeNull();
  });

  it("treats an empty id as nothing to remember", () => {
    rememberConversation("b1", "c-1");
    rememberConversation("b1", "");
    expect(rememberedConversation("b1")).toBeNull();
  });
});
