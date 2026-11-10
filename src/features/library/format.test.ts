import { describe, expect, it } from "vitest";
import type { BookSummary } from "@/types/ipc";

import {
  authorLine,
  formatFileSize,
  isFoliateFormat,
  pickContinueReading,
  sortOptions,
  titleForFilter,
} from "@/features/library/format";

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

describe("formatFileSize", () => {
  it("uses bytes below one kilobyte", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("uses kilobytes and megabytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536 * 1024)).toBe("1.5 MB");
  });

  it("survives unknown sizes", () => {
    expect(formatFileSize(-1)).toBe("");
  });
});

describe("isFoliateFormat", () => {
  /**
   * The set is the one place that decides which renderer draws a book, and the
   * notes page names a highlight's position off it too (`节` vs `章`). Pinning
   * the whole list makes a format joining it a deliberate two-file change —
   * and, more to the point, stops one being *left out*: a Kindle container
   * dropped from here falls back to the extracted-text renderer with no error
   * anywhere.
   */
  it("covers exactly the containers foliate renders", () => {
    for (const format of ["epub", "mobi", "azw", "azw3", "prc"] as const) {
      expect(isFoliateFormat(format)).toBe(true);
    }
    for (const format of ["pdf", "fb2", "cbz", "markdown", "txt"] as const) {
      expect(isFoliateFormat(format)).toBe(false);
    }
  });
});

describe("titleForFilter", () => {
  it("gives each shelf a title and subtitle", () => {
    const all = titleForFilter("all");
    expect(all.title).toBe("书库");
    expect(all.subtitle.length).toBeGreaterThan(0);
  });

  /**
   * The 最近 shelf's subtitle used to read 「继续阅读的地方」, but the
   * `ContinueReadingCard` that would justify it renders on the 书库 shelf only
   * (`LibraryPage`, `filter === "all"`). A subtitle naming something the page
   * does not have is the kind of copy that quietly stops matching the code, so
   * the value is pinned here.
   */
  it("does not promise the 最近 shelf a card it does not render", () => {
    expect(titleForFilter("recent").subtitle).toBe("最近读过的书");
  });
});

describe("sortOptions", () => {
  it("has a stable value/label pairing", () => {
    expect(sortOptions.length).toBeGreaterThanOrEqual(3);
    for (const option of sortOptions) {
      expect(option.value.length).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  /**
   * The list is hand-kept against the Rust enum: `LibrarySort` is a generated
   * type, so a value that no longer exists would still type-check here if the
   * bindings were regenerated without it — and a label whose order the backend
   * does not implement would silently do nothing when picked. Pinning the whole
   * set makes adding one to the enum a two-file change, which is the point.
   */
  it("names every order the backend implements", () => {
    expect(sortOptions.map((option) => option.value)).toEqual([
      "recentlyAdded",
      "recentlyRead",
      "progressDesc",
      "titleAsc",
      "authorAsc",
      "formatAsc",
      "sizeDesc",
    ]);
  });
});

describe("pickContinueReading", () => {
  it("returns undefined when nothing has been opened", () => {
    const list = [
      makeBook({ id: "a", lastReadAt: null, progress: 0.5 }),
      makeBook({ id: "b", lastReadAt: null, progress: 0.8 }),
    ];
    expect(pickContinueReading(list)).toBeUndefined();
  });

  it("picks the book with the most recent lastReadAt, regardless of progress", () => {
    // The shelf used to pick the *first* book with progress > 0, which
    // meant opening a brand-new book (progress=null) stopped the card from
    // pointing at the book actually opened last.
    const list = [
      makeBook({ id: "old", lastReadAt: 100, progress: 0.9 }),
      makeBook({ id: "latest", lastReadAt: 200, progress: 0.02 }),
      makeBook({ id: "middle", lastReadAt: 150, progress: 0.6 }),
    ];
    expect(pickContinueReading(list)?.id).toBe("latest");
  });

  it("ignores progress entirely — the most recently opened book wins", () => {
    const list = [
      makeBook({ id: "finished", lastReadAt: 100, progress: 1 }),
      makeBook({ id: "opened", lastReadAt: 200, progress: 0 }),
    ];
    expect(pickContinueReading(list)?.id).toBe("opened");
  });

  it("returns undefined for an empty shelf", () => {
    expect(pickContinueReading([])).toBeUndefined();
  });
});

describe("authorLine", () => {
  it("joins several authors", () => {
    expect(authorLine(makeBook({ authors: ["Steve Klabnik", "Carol Nichols"] }))).toBe(
      "Steve Klabnik / Carol Nichols",
    );
  });

  /**
   * Calibre-converted books carry a `dc:creator` of `Unknown`, and the shelf
   * printed it verbatim — an English placeholder in an otherwise Chinese UI,
   * which reads as an error rather than as metadata (seen on a real 39-book
   * shelf). Dropping it is what lets `BookCard` take its empty-author branch,
   * which is in turn what keeps the format/size block on the tile's right edge.
   */
  it("drops the placeholders a converter leaves behind", () => {
    for (const placeholder of ["Unknown", "unknown", "N/A", "null", "佚名", "未知作者", "不详"]) {
      expect(authorLine(makeBook({ authors: [placeholder] }))).toBe("");
    }
  });

  it("keeps a real name that merely looks short", () => {
    // `na` and `none` are surnames; a dropped author is worse than a
    // placeholder one, so they are deliberately not in the list.
    expect(authorLine(makeBook({ authors: ["Na"] }))).toBe("Na");
    expect(authorLine(makeBook({ authors: ["None"] }))).toBe("None");
  });

  it("drops a placeholder but keeps the real authors beside it", () => {
    expect(authorLine(makeBook({ authors: ["Unknown", "刘慈欣"] }))).toBe("刘慈欣");
  });

  it("trims entries and drops the empty ones", () => {
    expect(authorLine(makeBook({ authors: ["  刘慈欣  ", ""] }))).toBe("刘慈欣");
  });
});
