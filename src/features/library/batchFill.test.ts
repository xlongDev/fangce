import { describe, expect, it } from "vitest";

import { preview } from "@/features/library/BatchFillDialog";
import { existingHint, hasSomething } from "@/lib/metadata";
import type { Fill, Proposal } from "@/types/ipc";

const fill = (field: string, to: string): Fill => ({ field, from: null, to });

describe("preview", () => {
  // The regression this exists for: a 4000-character 简介 printed in full turned
  // one row into a page of marketing copy and pushed the dialog off both edges
  // of the window.
  it("summarises the blurb instead of printing it", () => {
    const blurb = "★亚马逊编辑推荐".repeat(400);
    const line = preview(fill("description", blurb));
    expect(line).toBe(`将填入（${blurb.length} 字）`);
    expect(line.length).toBeLessThan(40);
  });

  it("shortens a long value and leaves a short one alone", () => {
    expect(preview(fill("publisher", "重庆出版社"))).toBe("重庆出版社");
    const long = "一家名字特别特别长的出版社有限公司某某某分社（北京）编辑中心第三编辑部";
    expect(preview(fill("publisher", long))).toBe(`${long.slice(0, 32)}…`);
  });

  it("keeps the year readable", () => {
    expect(preview(fill("publishedYear", "2014"))).toBe("2014");
  });
});

const proposal = (over: Partial<Proposal>): Proposal => ({
  bookId: "b1",
  bookTitle: "三体",
  fills: [],
  skipped: null,
  matchScore: 0.95,
  rating: null,
  ratingCount: null,
  ratingSource: null,
  doubanUrl: null,
  coverUrl: null,
  existing: [],
  ...over,
});

describe("existingHint", () => {
  it("names what the fill will not touch", () => {
    expect(existingHint(["publisher", "language"])).toBe("已有 出版社、语言");
  });

  it("says nothing when the book has nothing", () => {
    expect(existingHint([])).toBeNull();
  });

  // One row, one line: six names would push the summary onto three lines and
  // bury the part that is actually changing.
  it("summarises a long list", () => {
    const hint = existingHint(["subtitle", "publisher", "language", "isbn", "publishedYear"]);
    expect(hint).toBe("已有 副标题、出版社 等 5 项");
  });
});

describe("hasSomething", () => {
  // The regression this exists for: a book whose six fields are all filled
  // still gains a rating, and judging by `fills` alone rendered it greyed out,
  // untickable, with no reason line — 「为什么这几行是灰的」.
  it("counts a rating with no fields as something to write", () => {
    expect(hasSomething(proposal({ rating: 9.1, ratingCount: 217634 }))).toBe(true);
  });

  it("counts a Douban link on its own", () => {
    expect(hasSomething(proposal({ doubanUrl: "https://book.douban.com/subject/1/" }))).toBe(true);
  });

  it("is false only when there is nothing at all", () => {
    expect(hasSomething(proposal({}))).toBe(false);
  });
});
