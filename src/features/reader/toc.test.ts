import { describe, expect, it } from "vitest";

import { currentTocRow, parentIndices, pathToCurrent, tocRows, tocTree } from "./toc";

/** A foliate-shaped TOC: parents immediately before their children, depth
    attached — the invariant both real sources actually hold. */
const nested = [
  { idx: 0, title: "第一部分", depth: 0 },
  { idx: 1, title: "理解语言模型", depth: 1 },
  { idx: 2, title: "第1章", depth: 2 },
  { idx: 3, title: "大语言模型简介", depth: 2 },
  { idx: 4, title: "1.1 什么是语言人工智能", depth: 3 },
  { idx: 5, title: "第二部分", depth: 0 },
];

describe("tocRows", () => {
  it("keeps a nested TOC's depth and refuses to invent page numbers for it", () => {
    const rows = tocRows(nested, []);

    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2, 3, 0]);
    expect(rows.map((row) => row.title)).toEqual(nested.map((entry) => entry.title));
    // A foliate row is a TOC entry, not a page: numbering it by its position in
    // the flattened list would print a page the book never had.
    expect(rows.every((row) => row.marker === "")).toBe(true);
    // The row still jumps by its position in the book's own TOC.
    expect(rows.map((row) => row.target)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("numbers a flat chapter list and gives it no nesting", () => {
    const rows = tocRows(
      [
        { idx: 0, title: "第一章" },
        { idx: 1, title: "" },
      ],
      [],
    );

    expect(rows.map((row) => row.marker)).toEqual(["1", "2"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0]);
    expect(rows[1]!.title).toBe("第 2 节");
  });

  it("marks a PDF outline by page and prefers it over the chapter list", () => {
    const rows = tocRows(
      [{ idx: 0, title: "第 1 页" }],
      [
        { title: "封面", page: 0, depth: 0 },
        { title: "第1章", page: 4, depth: 1 },
      ],
    );

    expect(rows.map((row) => row.marker)).toEqual(["1", "5"]);
    expect(rows.map((row) => row.target)).toEqual([0, 4]);
  });
});

describe("tocTree", () => {
  it("rebuilds the nesting one stack walk, and folds only what has children", () => {
    const tree = tocTree(tocRows(nested, []));

    expect(tree.map((node) => node.row.title)).toEqual(["第一部分", "第二部分"]);
    expect(tree[0]!.children.map((node) => node.row.title)).toEqual(["理解语言模型"]);
    expect(tree[0]!.children[0]!.children.map((node) => node.row.title)).toEqual([
      "第1章",
      "大语言模型简介",
    ]);
    expect(tree[0]!.children[0]!.children[1]!.children.map((node) => node.row.title)).toEqual([
      "1.1 什么是语言人工智能",
    ]);

    // Row 2 and 4 are leaves; offering them a chevron would do nothing.
    expect(parentIndices(tree)).toEqual([0, 1, 3]);
  });

  it("offers nothing to fold on a flat list", () => {
    const tree = tocTree(
      tocRows(
        [
          { idx: 0, title: "一" },
          { idx: 1, title: "二" },
        ],
        [],
      ),
    );

    expect(tree).toHaveLength(2);
    expect(parentIndices(tree)).toEqual([]);
  });
});

describe("pathToCurrent", () => {
  it("opens exactly the ancestors of the entry being read", () => {
    const rows = tocRows(nested, []);

    expect([...pathToCurrent(rows, 4)].toSorted()).toEqual([0, 1, 3]);
    expect([...pathToCurrent(rows, 0)]).toEqual([]);
    // Nobody reading a section the TOC does not list gets a spurious expansion.
    expect([...pathToCurrent(rows, -1)]).toEqual([]);
  });
});

describe("currentTocRow", () => {
  it("takes the last entry at or before the page, and an exact index otherwise", () => {
    const outline = tocRows(
      [],
      [
        { title: "封面", page: 0, depth: 0 },
        { title: "第1章", page: 4, depth: 1 },
        { title: "第2章", page: 9, depth: 1 },
      ],
    );
    expect(currentTocRow(outline, 6, true)).toBe(1);
    expect(currentTocRow(outline, 0, true)).toBe(0);

    const chapters = tocRows(nested, []);
    expect(currentTocRow(chapters, 3, false)).toBe(3);
    expect(currentTocRow(chapters, 99, false)).toBe(-1);
  });
});
