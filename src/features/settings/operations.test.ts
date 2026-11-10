import { describe, expect, it } from "vitest";

import { groupByCall } from "@/features/settings/SettingsPage";
import type { Operation } from "@/types/ipc";

const row = (over: Partial<Operation>): Operation => ({
  id: 1,
  at: 1_700_000_000,
  source: "ui",
  action: "batch_metadata",
  callId: "call-a",
  bookId: "b1",
  bookTitle: "三体",
  summary: "批量改出版社：统一",
  undoable: true,
  ...over,
});

describe("groupByCall", () => {
  it("folds one call's rows into one entry", () => {
    const calls = groupByCall([
      row({ id: 3, bookId: "b3", bookTitle: "Piranesi" }),
      row({ id: 2, bookId: "b2", bookTitle: "Dune" }),
      row({ id: 1, bookId: "b1", bookTitle: "三体" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.count).toBe(3);
    // The newest row's title stands for the call; the count says there are more.
    expect(calls[0]!.title).toBe("Piranesi");
  });

  it("keeps separate calls separate, in the order they arrived", () => {
    const calls = groupByCall([
      row({ id: 4, callId: "call-b", summary: "移到回收站" }),
      row({ id: 2, callId: "call-a" }),
      row({ id: 1, callId: "call-a" }),
    ]);
    expect(calls.map((call) => call.callId)).toEqual(["call-b", "call-a"]);
    expect(calls[1]!.count).toBe(2);
  });

  it("refuses to undo a call with one book that cannot be put back", () => {
    // A half-restored batch is worse than an honest "this one cannot be undone".
    const calls = groupByCall([row({ id: 2, undoable: false }), row({ id: 1, undoable: true })]);
    expect(calls[0]!.undoable).toBe(false);
  });
});
