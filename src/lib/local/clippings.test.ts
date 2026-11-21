import { describe, expect, it } from "vitest";

import { csvRows, detect, parseClippings, parseCsv, parseMarkdown } from "@/lib/local/clippings";
import { renderCsvMany, renderMarkdownMany, type Notes } from "@/lib/local/notes";

/**
 * The two halves are pinned to each other by a round trip: a file `notes.ts`
 * writes has to read back into what went in. That is the contract a reader
 * actually relies on — export, keep the file, put it back — and it is stronger
 * than asserting on either half alone.
 *
 * The shapes themselves are the desktop's; see the note on `clippings.ts`.
 */

const notes: Notes = {
  id: "b1",
  title: "三体",
  authors: ["刘慈欣"],
  progress: 0.5,
  entries: [
    {
      id: "a1",
      chapterIdx: 0,
      text: "第一条：疾病是身体的谜题\n第二行还在引号里",
      note: "我的批注",
      color: "#ffd12e",
      style: null,
    },
    { id: "a2", chapterIdx: 0, text: "第二条", note: null, color: null, style: null },
    { id: "a3", chapterIdx: 2, text: "第三章的一句", note: "记一笔", color: null, style: null },
  ],
};

describe("a round trip through Markdown", () => {
  it("returns what went in", () => {
    const parsed = parseMarkdown(renderMarkdownMany([notes]));
    expect(parsed.highlights).toHaveLength(3);
    expect(parsed.highlights.map((entry) => entry.text)).toEqual([
      "第一条：疾病是身体的谜题\n第二行还在引号里",
      "第二条",
      "第三章的一句",
    ]);
    expect(parsed.highlights.map((entry) => entry.bookId)).toEqual(["b1", "b1", "b1"]);
    expect(parsed.highlights.map((entry) => entry.chapterIdx)).toEqual([0, 0, 2]);
    expect(parsed.highlights.map((entry) => entry.note)).toEqual(["我的批注", null, "记一笔"]);
    // Ink rides in the link-line comment, so Markdown now keeps it too.
    expect(parsed.highlights.map((entry) => entry.color)).toEqual(["#ffd12e", null, null]);
    expect(parsed.highlights[0]?.title).toBe("三体");
  });
});

describe("a round trip through CSV", () => {
  it("returns what went in, and keeps a line break inside a field", () => {
    const parsed = parseCsv(renderCsvMany([notes]));
    expect(parsed.highlights).toHaveLength(3);
    expect(parsed.highlights[0]?.text).toBe("第一条：疾病是身体的谜题\n第二行还在引号里");
    expect(parsed.highlights[0]?.note).toBe("我的批注");
    expect(parsed.highlights[0]?.color).toBe("#ffd12e");
    expect(parsed.highlights[0]?.bookId).toBe("b1");
    expect(parsed.highlights[2]?.chapterIdx).toBe(2);
    // "never chose" is not the same fact as yellow, and stays blank.
    expect(parsed.highlights[1]?.color).toBeNull();
  });
});

describe("parseMarkdown", () => {
  it("keeps a `> ` that belongs to the note in the note", () => {
    // The first blank ends the quote; after that the quote marker is prose.
    const parsed = parseMarkdown("## 《三体》\n\n### 第 1 章\n\n> 一句\n\n> 这句也在笔记里\n");
    expect(parsed.highlights[0]?.text).toBe("一句");
    expect(parsed.highlights[0]?.note).toBe("> 这句也在笔记里");
  });

  it("reads a bare `>` as a blank line inside the quote", () => {
    const parsed = parseMarkdown("## 《三体》\n\n### 第 1 章\n\n> 上\n>\n> 下\n");
    expect(parsed.highlights[0]?.text).toBe("上\n\n下");
  });

  it("drops an entry with nothing in it", () => {
    // The summary line under a title must not become a highlight.
    const parsed = parseMarkdown("# 笔记导出\n\n1 本书 · 3 条标注\n\n## 《三体》\n");
    expect(parsed.highlights).toHaveLength(0);
  });
});

describe("csvRows", () => {
  it("keeps a delimiter, a quote and a line break inside one field", () => {
    expect(csvRows('a,"b,c",d\n')).toEqual([["a", "b,c", "d"]]);
    expect(csvRows('a,"say ""hi""",d\n')).toEqual([["a", 'say "hi"', "d"]]);
    expect(csvRows('a,"two\nlines",d\n')).toEqual([["a", "two\nlines", "d"]]);
  });
});

describe("what is ours and what is not", () => {
  it("knows the two shapes", () => {
    expect(detect(renderMarkdownMany([notes]))).toBe("markdown");
    expect(detect(renderCsvMany([notes]))).toBe("csv");
  });

  it("refuses a Kindle clippings file rather than reading it badly", () => {
    // `==========` is Kindle's own separator; reading it would be guessing.
    const kindle = "三体 (刘慈欣)\n- 您在位置 123 的标注\n\n一句\n\n==========\n";
    expect(detect(kindle)).toBeNull();
    expect(parseClippings(kindle)).toBeNull();
  });

  it("refuses a CSV with no 原文 column instead of guessing which one holds it", () => {
    expect(parseCsv("\uFEFF章节,链接\n1,fangce://book/b1?annotation=a1\n").highlights).toEqual([]);
  });
});
