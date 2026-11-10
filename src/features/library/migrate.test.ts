import { describe, expect, it } from "vitest";

import { editionSummary, editionTwins } from "@/features/library/migrate";
import type { BookSummary } from "@/types/ipc";

/** A shelf row with nothing but what the match actually reads. */
function book(id: string, title: string, authors: string[] = []): BookSummary {
  return {
    id,
    title,
    authors,
    tags: [],
    progress: 0,
    favorite: false,
    isbn: null,
    publishedYear: null,
    rating: null,
    ratingCount: null,
    ratingSource: null,
    doubanUrl: null,
  } as unknown as BookSummary;
}

describe("editionTwins", () => {
  it("pairs a re-imported file with the edition already on the shelf", () => {
    const old = book("v1", "三体", ["刘慈欣"]);
    const fresh = book("v2", "三体", ["刘慈欣"]);
    // The shelf after the import: both rows are in it.
    expect(editionTwins([fresh], [old, fresh])).toEqual([{ from: old, to: fresh }]);
  });

  it("ignores the difference a re-import usually makes: spacing and case", () => {
    const old = book("v1", "The Pragmatic Programmer", ["Andy Hunt"]);
    const fresh = book("v2", "thepragmaticprogrammer", ["Andy Hunt"]);
    expect(editionTwins([fresh], [old, fresh])).toHaveLength(1);
  });

  it("does not pair two different books that share an author", () => {
    const other = book("a", "三体", ["刘慈欣"]);
    const fresh = book("b", "球状闪电", ["刘慈欣"]);
    expect(editionTwins([fresh], [other, fresh])).toEqual([]);
  });

  it("does not pair books whose authors disagree", () => {
    // Same title, different book: an anthology and a novel of the same name is
    // a real shelf, and this is why the question is asked rather than assumed.
    const other = book("a", "夜航西飞", ["柏瑞尔·马卡姆"]);
    const fresh = book("b", "夜航西飞", ["圣埃克苏佩里"]);
    expect(editionTwins([fresh], [other, fresh])).toEqual([]);
  });

  it("never offers the same old edition twice in one run", () => {
    const old = book("v1", "三体", ["刘慈欣"]);
    const first = book("v2", "三体", ["刘慈欣"]);
    const second = book("v3", "三体", ["刘慈欣"]);
    const pairs = editionTwins([first, second], [old, first, second]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.from.id).toBe("v1");
  });

  it("leaves a book with no title alone", () => {
    // A title that did not parse is not a coincidence worth acting on.
    const old = book("v1", "");
    const fresh = book("v2", "");
    expect(editionTwins([fresh], [old, fresh])).toEqual([]);
  });
});

describe("editionSummary", () => {
  const from = { ...book("v1", "三体"), progress: 0.42, favorite: true };

  it("says what the old edition is carrying", () => {
    expect(editionSummary({ from, to: book("v2", "三体") }, 27)).toBe(
      "已读 42% · 27 条标注 · 已收藏",
    );
  });

  it("says so when there is nothing to carry", () => {
    expect(editionSummary({ from: book("v1", "三体"), to: book("v2", "三体") }, 0)).toBe(
      "还没有读过",
    );
  });

  it("reads an unopened book as nothing rather than as an error", () => {
    // `progress` is a nullable column; a book never opened is null, not 0.
    const unopened = { ...book("v1", "三体"), progress: null };
    expect(editionSummary({ from: unopened, to: book("v2", "三体") }, 3)).toBe("3 条标注");
  });
});
