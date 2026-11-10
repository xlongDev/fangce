import { describe, expect, it } from "vitest";

import type { Annotation, BookSummary } from "@/types/ipc";
import {
  exportPayload,
  filterNotes,
  groupByBook,
  inkColor,
  keepEntries,
  tally,
  unitLabel,
} from "@/features/notes/aggregate";

function book(id: string, overrides: Partial<BookSummary> = {}): BookSummary {
  return {
    id,
    title: `书 ${id}`,
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
    rating: null,
    ratingCount: null,
    ratingSource: null,
    doubanUrl: null,
    authors: [],
    tags: [],
    ...overrides,
  } as BookSummary;
}

function mark(
  id: string,
  bookId: string,
  chapterIdx: number,
  startChar: number,
  text: string,
  note: string | null = null,
): Annotation {
  return {
    id,
    bookId,
    chapterIdx,
    startChar,
    endChar: startChar + text.length,
    text,
    cfi: null,
    color: null,
    style: null,
    note,
    createdAt: 0,
  };
}

const A = book("a", { title: "我们为什么会生病", authors: ["尼斯"] });
const B = book("b", { title: "金色梦乡", authors: ["伊坂幸太郎"] });
const C = book("c", { title: "长日将尽", authors: ["石黑一雄"] });

describe("groupByBook", () => {
  it("keeps the shelf's order and drops books with no highlights", () => {
    const groups = groupByBook(
      [A, B, C],
      new Map([
        ["c", [mark("c1", "c", 0, 0, "晚年的损伤")]],
        ["a", [mark("a1", "a", 0, 0, "演化的遗留")]],
      ]),
    );
    // Order is the shelf's, not the map's — the map is keyed by book id and
    // carries no opinion about which book was read last.
    expect(groups.map((group) => group.book.id)).toEqual(["a", "c"]);
  });

  it("sorts one book's highlights into reading order", () => {
    const groups = groupByBook(
      [A],
      new Map([
        [
          "a",
          [
            mark("late", "a", 2, 10, "第三章"),
            mark("early", "a", 0, 90, "第一章后半"),
            mark("first", "a", 0, 5, "第一章开头"),
          ],
        ],
      ]),
    );
    expect(groups[0]!.entries.map((entry) => entry.annotation.id)).toEqual([
      "first",
      "early",
      "late",
    ]);
  });

  it("leaves the input alone", () => {
    const list = [mark("late", "a", 2, 0, "后"), mark("early", "a", 0, 0, "前")];
    groupByBook([A], new Map([["a", list]]));
    // `toSorted` rather than `sort`: the array in the query cache is shared
    // with the reader, and re-ordering it in place would be a write into
    // another page's data.
    expect(list.map((entry) => entry.id)).toEqual(["late", "early"]);
  });

  it("carries the book onto every entry", () => {
    const groups = groupByBook([A], new Map([["a", [mark("a1", "a", 0, 0, "x")]]]));
    expect(groups[0]!.entries[0]!.book.id).toBe("a");
  });
});

describe("filterNotes", () => {
  const groups = groupByBook(
    [A, B],
    new Map([
      [
        "a",
        [
          mark(
            "a1",
            "a",
            0,
            0,
            "演化并不设计，它只保留此刻还能留下的东西。",
            "把「设计」换成「修补」",
          ),
          mark("a2", "a", 1, 0, "咳嗽、发烧、呕吐大多是防御本身。"),
        ],
      ],
      ["b", [mark("b1", "b", 0, 0, "两把钥匙开两把锁。", "记一下")]],
    ]),
  );

  const all = { query: "", onlyNoted: false };

  it("returns everything for a blank query", () => {
    expect(tally(filterNotes(groups, all)).highlights).toBe(3);
  });

  it("matches the passage, the note and the book alike", () => {
    expect(tally(filterNotes(groups, { ...all, query: "演化" })).highlights).toBe(1);
    expect(tally(filterNotes(groups, { ...all, query: "钥匙" })).highlights).toBe(1);
    // A note the reader wrote is searchable by the same box as the text.
    expect(tally(filterNotes(groups, { ...all, query: "修补" })).highlights).toBe(1);
    // The title, because remembering which book a line came from is the work
    // this page exists to do.
    expect(tally(filterNotes(groups, { ...all, query: "金色梦乡" })).highlights).toBe(1);
    expect(tally(filterNotes(groups, { ...all, query: "伊坂" })).highlights).toBe(1);
  });

  it("drops a group whose every entry was filtered out", () => {
    const shown = filterNotes(groups, { ...all, query: "金色梦乡" });
    // A heading with nothing under it reads as a loading failure.
    expect(shown.map((group) => group.book.id)).toEqual(["b"]);
  });

  it("keeps only the highlights with a note written on them", () => {
    const shown = filterNotes(groups, { ...all, onlyNoted: true });
    expect(tally(shown).highlights).toBe(2);
    expect(shown.map((group) => group.book.id)).toEqual(["a", "b"]);
    expect(shown[0]!.entries.map((entry) => entry.annotation.id)).toEqual(["a1"]);
  });

  it("combines the note filter with the query", () => {
    expect(tally(filterNotes(groups, { query: "咳嗽", onlyNoted: true })).highlights).toBe(0);
    expect(tally(filterNotes(groups, { query: "咳嗽", onlyNoted: false })).highlights).toBe(1);
  });

  it("ignores surrounding whitespace", () => {
    expect(tally(filterNotes(groups, { ...all, query: "  演化  " })).highlights).toBe(1);
  });
});

describe("tally", () => {
  it("counts highlights and the notes among them", () => {
    const groups = groupByBook(
      [A],
      new Map([
        [
          "a",
          [
            mark("a1", "a", 0, 0, "x", "写了"),
            mark("a2", "a", 1, 0, "y"),
            mark("a3", "a", 2, 0, "z", "也写了"),
          ],
        ],
      ]),
    );
    expect(tally(groups)).toEqual({ highlights: 3, notes: 2 });
  });

  it("is zero for nothing", () => {
    expect(tally([])).toEqual({ highlights: 0, notes: 0 });
  });
});

describe("inkColor", () => {
  it("reads a null colour as the legacy yellow", () => {
    // The column predates per-highlight colour, so rows written before it read
    // back null and have always painted yellow. A different fallback here
    // would recolour old highlights on this page and not in the book.
    expect(inkColor(mark("a1", "a", 0, 0, "x"))).toBe("#ffd12e");
  });

  it("keeps the colour the reader chose", () => {
    const entry = { ...mark("a1", "a", 0, 0, "x"), color: "#56aee2" };
    expect(inkColor(entry)).toBe("#56aee2");
  });
});

describe("unitLabel", () => {
  it("calls the index a section in the books foliate renders", () => {
    // A spine item, not the chapter a table of contents lists.
    expect(unitLabel("epub")).toBe("节");
    expect(unitLabel("mobi")).toBe("节");
    expect(unitLabel("azw")).toBe("节");
    expect(unitLabel("azw3")).toBe("节");
    expect(unitLabel("prc")).toBe("节");
  });

  it("calls it a chapter everywhere else", () => {
    expect(unitLabel("txt")).toBe("章");
    expect(unitLabel("markdown")).toBe("章");
    expect(unitLabel("pdf")).toBe("章");
    expect(unitLabel("fb2")).toBe("章");
    expect(unitLabel("cbz")).toBe("章");
  });
});

describe("keepEntries", () => {
  const groups = groupByBook(
    [A, B, C],
    new Map([
      ["a", [mark("a1", "a", 0, 0, "x"), mark("a2", "a", 1, 0, "y")]],
      ["b", [mark("b1", "b", 0, 0, "z")]],
      ["c", [mark("c1", "c", 0, 0, "w")]],
    ]),
  );

  it("keeps only the named highlights, in the order they were already in", () => {
    const kept = keepEntries(groups, new Set(["a2", "b1"]));
    expect(kept.map((group) => group.book.id)).toEqual(["a", "b"]);
    expect(kept[0]?.entries.map((entry) => entry.annotation.id)).toEqual(["a2"]);
  });

  it("drops a book whose every highlight was left out", () => {
    // Otherwise the page would draw a book header over an empty list.
    expect(keepEntries(groups, new Set(["b1"])).map((group) => group.book.id)).toEqual(["b"]);
  });

  it("keeps the book, not a copy of the entries' own book", () => {
    const kept = keepEntries(groups, new Set(["c1"]));
    expect(kept[0]?.book).toBe(C);
  });

  it("is empty for an empty set and leaves the input alone", () => {
    const before = groups.map((group) => group.entries.length);
    expect(keepEntries(groups, new Set())).toEqual([]);
    expect(groups.map((group) => group.entries.length)).toEqual(before);
  });
});

describe("exportPayload", () => {
  it("pairs each book with its own highlights, in screen order", () => {
    // The pairing is the contract: the backend groups by book, so the books
    // have to arrive in the order the page drew them and the ids in reading
    // order inside each. The shelf here is deliberately not alphabetical.
    const groups = groupByBook(
      [C, A, B],
      new Map([
        ["a", [mark("a2", "a", 1, 0, "y"), mark("a1", "a", 0, 0, "x")]],
        ["c", [mark("c1", "c", 0, 0, "w")]],
      ]),
    );
    expect(exportPayload(groups)).toEqual({
      bookIds: ["c", "a"],
      ids: ["c1", "a1", "a2"],
    });
  });

  it("skips a group with nothing in it", () => {
    // A book header is not a reason to write a book section.
    const groups = groupByBook([A, B], new Map([["a", [mark("a1", "a", 0, 0, "x")]]]));
    expect(exportPayload(groups).bookIds).toEqual(["a"]);
  });

  it("is two empty lists for nothing", () => {
    expect(exportPayload([])).toEqual({ bookIds: [], ids: [] });
  });
});
