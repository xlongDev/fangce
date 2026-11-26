import { describe, expect, it } from "vitest";
import { nextChapterSection } from "./foliateChapters";

// 《看见》: 23 TOC chapters over 55 spine sections. Chapter bodies sit at
// 2, 4, 6, 10, 12…; the intervening sections are photo plates with captions
// but no TOC entry of their own.
const KANJIAN_STARTS = [
  1, 2, 4, 6, 10, 12, 14, 16, 18, 21, 23, 26, 28, 31, 33, 35, 38, 40, 42, 47, 49, 52, 53,
];

describe("nextChapterSection", () => {
  it("skips plate pages between two chapters", () => {
    // 第一章's body is section 4; section 5 is a caption page; 第二章 starts
    // at section 6. The voice must not stop on section 5.
    expect(nextChapterSection(KANJIAN_STARTS, 4, 55)).toBe(6);
  });

  it("rolls from whichever section of a chapter the queue came from", () => {
    // The follow scroll may have pushed primaryIndex from 4 to 5 while the
    // queue still held 第一章's words; either way the next chapter is 6.
    expect(nextChapterSection(KANJIAN_STARTS, 5, 55)).toBe(6);
  });

  it("returns null past the final chapter instead of jumping out of the book", () => {
    expect(nextChapterSection(KANJIAN_STARTS, 53, 55)).toBeNull();
    expect(nextChapterSection(KANJIAN_STARTS, 54, 55)).toBeNull();
  });

  it("falls back to the next spine section when the book has no mapped TOC", () => {
    expect(nextChapterSection([], 4, 55)).toBe(5);
  });

  it("does not invent a chapter beyond the spine", () => {
    expect(nextChapterSection([], 54, 55)).toBeNull();
  });
});
