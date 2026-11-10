import { describe, expect, it } from "vitest";
import type { BookSummary } from "@/types/ipc";

import { groupOptions, shelfItems, shelfSections } from "@/features/library/group";

function makeBook(overrides: Partial<BookSummary>): BookSummary {
  return {
    id: "x",
    title: "测试书",
    subtitle: null,
    description: null,
    language: "zh",
    publisher: null,
    format: "epub",
    fileSize: 0,
    coverUrl: null,
    addedAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    progress: null,
    location: null,
    favorite: false,
    isbn: null,
    publishedYear: null,
    authors: [],
    tags: [],
    ...overrides,
  } as BookSummary;
}

describe("groupOptions", () => {
  it("starts with the ungrouped shelf", () => {
    expect(groupOptions[0]?.value).toBe("none");
    expect(groupOptions.map((option) => option.value)).toEqual([
      "none",
      "progress",
      "author",
      "format",
    ]);
  });
});

describe("shelfSections", () => {
  it("leaves the shelf alone when grouping is off", () => {
    const list = [makeBook({ id: "a" }), makeBook({ id: "b" })];
    const { cards, sections } = shelfSections(list, "none");
    expect(cards).toBe(list);
    expect(sections).toEqual([]);
  });

  it("has nothing to section when the shelf is empty", () => {
    expect(shelfSections([], "progress")).toEqual({ cards: [], sections: [] });
  });

  it("orders reading states from in-progress to finished", () => {
    const list = [
      makeBook({ id: "a", progress: 0.3 }),
      makeBook({ id: "b", progress: null }),
      makeBook({ id: "c", progress: 1 }),
      makeBook({ id: "d", progress: 0.7 }),
      makeBook({ id: "e", progress: 0 }),
    ];
    const { cards, sections } = shelfSections(list, "progress");

    expect(sections.map((section) => [section.label, section.count])).toEqual([
      ["在读", 2],
      ["未开始", 2],
      ["已读完", 1],
    ]);
    // The order *within* a section is the order the books arrived in.
    expect(cards.map((book) => book.id)).toEqual(["a", "d", "b", "e", "c"]);
  });

  it("counts a book past the end as finished", () => {
    const list = [makeBook({ id: "a", progress: 1.4 })];
    const { sections } = shelfSections(list, "progress");
    expect(sections.map((section) => section.label)).toEqual(["已读完"]);
  });

  it("files a book under its first author, and the rest under 未知作者", () => {
    const list = [
      makeBook({ id: "a", authors: ["鲁迅"] }),
      makeBook({ id: "b", authors: ["老舍"] }),
      makeBook({ id: "c", authors: ["鲁迅", "许广平"] }),
      makeBook({ id: "d", authors: [] }),
    ];
    const { cards, sections } = shelfSections(list, "author");
    const labels = sections.map((section) => section.label);

    // Largest section first, so the shelf opens on the one with the most books.
    expect(labels[0]).toBe("鲁迅");
    expect(labels).toContain("老舍");
    expect(labels).toContain("未知作者");
    expect(sections.find((section) => section.label === "鲁迅")?.count).toBe(2);
    // A co-author is not a second section: the book appears exactly once.
    expect(cards.map((book) => book.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("orders formats the way the shelf lists them, not by size", () => {
    const list = [
      makeBook({ id: "a", format: "pdf" }),
      makeBook({ id: "b", format: "epub" }),
      makeBook({ id: "c", format: "markdown" }),
      makeBook({ id: "d", format: "pdf" }),
    ];
    const { cards, sections } = shelfSections(list, "format");

    expect(sections.map((section) => section.label)).toEqual(["EPUB", "PDF", "Markdown"]);
    expect(sections.map((section) => section.start)).toEqual([0, 1, 3]);
    expect(cards.map((book) => book.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("totals the same number of cards as books it was given", () => {
    const list = [
      makeBook({ id: "a", format: "pdf" }),
      makeBook({ id: "b", format: "epub" }),
      makeBook({ id: "c", format: "txt" }),
    ];
    for (const by of ["progress", "author", "format"] as const) {
      const { cards } = shelfSections(list, by);
      expect(cards).toHaveLength(list.length);
    }
  });
});

/** An item list as labels — a heading by name, a row by its first card. */
function shape(items: ReturnType<typeof shelfItems>): string[] {
  return items.map((item) => (item.kind === "header" ? item.section.label : `row ${item.from}`));
}

describe("shelfItems", () => {
  /** Three piles of one, in the order the shelf lists formats. */
  const list = [
    makeBook({ id: "a", format: "pdf" }),
    makeBook({ id: "b", format: "epub" }),
    makeBook({ id: "c", format: "markdown" }),
  ];
  const { sections } = shelfSections(list, "format");

  it("reads an ungrouped shelf as plain rows", () => {
    expect(shelfItems([], 5, 2, new Set())).toEqual([
      { kind: "row", from: 0, to: 2 },
      { kind: "row", from: 2, to: 4 },
      { kind: "row", from: 4, to: 5 },
    ]);
  });

  it("has no lines for an empty shelf", () => {
    expect(shelfItems([], 0, 4, new Set())).toEqual([]);
  });

  it("heads each pile and cuts its rows inside it", () => {
    expect(shape(shelfItems(sections, 3, 2, new Set()))).toEqual([
      "EPUB",
      "row 0",
      "PDF",
      "row 1",
      "Markdown",
      "row 2",
    ]);
  });

  it("starts every pile on a fresh line, whatever the last one left over", () => {
    const two = shelfSections(
      [
        makeBook({ id: "a", format: "epub" }),
        makeBook({ id: "b", format: "epub" }),
        makeBook({ id: "c", format: "epub" }),
        makeBook({ id: "d", format: "pdf" }),
        makeBook({ id: "e", format: "pdf" }),
      ],
      "format",
    );

    // EPUB is three books over two lines and leaves the second one half empty;
    // PDF's two books do not borrow it. That half-empty line is what a heading
    // in the flow costs, and it is the heading that fills it next.
    expect(shape(shelfItems(two.sections, 5, 2, new Set()))).toEqual([
      "EPUB",
      "row 0",
      "row 2",
      "PDF",
      "row 3",
    ]);
  });

  it("keeps a folded pile's cards out of the list entirely", () => {
    expect(shape(shelfItems(sections, 3, 2, new Set(["pdf"])))).toEqual([
      "EPUB",
      "row 0",
      "PDF",
      "Markdown",
      "row 2",
    ]);
  });

  it("cuts rows at one column when no measurement has landed yet", () => {
    expect(shape(shelfItems([], 2, 0, new Set()))).toEqual(["row 0", "row 1"]);
  });
});
