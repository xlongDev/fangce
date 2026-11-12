import { describe, expect, it } from "vitest";

import {
  groupByCall,
  groupByDay,
  KINDS,
  type OperationCall,
} from "@/features/settings/SettingsPage";
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

const call = (over: Partial<OperationCall>): OperationCall => ({
  callId: "call-a",
  at: 1_700_000_000,
  action: "update_metadata",
  summary: "改了书籍信息",
  source: "ui",
  title: "三体",
  count: 1,
  undoable: true,
  ...over,
});

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** Which chips an action answers to, `all` included. */
const kinds = (action: string) =>
  KINDS.filter((kind) => kind.matches(action)).map((kind) => kind.key);

describe("the kind chips", () => {
  /** One save that also replaced the picture answers both questions: 「我什么
   *  时候换过封面」 and 「谁改了出版社」 are looking at the same line. */
  it("files one save under both 改信息 and 换封面", () => {
    expect(kinds("update_metadata_cover")).toEqual(["all", "metadata", "cover"]);
  });

  /** Rows written before a save and a cover became one call. */
  it("files the old separate cover rows under 换封面", () => {
    expect(kinds("cover")).toContain("cover");
  });

  it("files a fill under 补全 only", () => {
    expect(kinds("fill_metadata")).toEqual(["all", "fill"]);
  });

  it("files everything that removes a book under 删除", () => {
    expect(kinds("trash")).toContain("delete");
    expect(kinds("purge")).toContain("delete");
    expect(kinds("empty_trash")).toContain("delete");
  });
});

describe("groupByDay", () => {
  it("puts one day's calls under one heading, in the order they arrived", () => {
    const today = new Date();
    const older = new Date(today);
    older.setDate(today.getDate() - 5);

    const days = groupByDay([
      call({ callId: "a", at: seconds(today) }),
      call({ callId: "b", at: seconds(today) }),
      call({ callId: "c", at: seconds(older) }),
    ]);

    expect(days).toHaveLength(2);
    expect(days[0]!.label).toBe("今天");
    expect(days[0]!.calls.map((entry) => entry.callId)).toEqual(["a", "b"]);
    expect(days[1]!.calls.map((entry) => entry.callId)).toEqual(["c"]);
  });

  /** 「昨天」 is how a reader thinks about the day before; a date would be read
   *  as a month and a number, and the eye would have to convert it. */
  it("names the day before 昨天", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);

    const days = groupByDay([call({ at: seconds(yesterday) })]);
    expect(days[0]!.label).toBe("昨天");
  });

  /** The year only appears when it is not this one. */
  it("leaves the year off a day in this year and keeps it otherwise", () => {
    const thisYear = new Date();
    thisYear.setMonth(0, 2);
    const lastYear = new Date(thisYear);
    lastYear.setFullYear(thisYear.getFullYear() - 1);

    const days = groupByDay([
      call({ callId: "a", at: seconds(thisYear) }),
      call({ callId: "b", at: seconds(lastYear) }),
    ]);

    // A heading for 1 月 2 日 of this year has no year in it.
    expect(days[0]!.label).not.toContain(String(thisYear.getFullYear()));
    expect(days[1]!.label).toContain(String(lastYear.getFullYear()));
  });
});
