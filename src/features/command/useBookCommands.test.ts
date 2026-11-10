import { describe, expect, it } from "vitest";

import { matchBooks } from "@/features/command/useBookCommands";
import type { BookSummary } from "@/types/ipc";

function book(id: string, title: string, authors: string[] = [], tags: string[] = []): BookSummary {
  return {
    id,
    title,
    subtitle: null,
    description: null,
    language: null,
    publisher: null,
    format: "epub",
    fileSize: 1024,
    coverUrl: null,
    addedAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    progress: null,
    location: null,
    favorite: false,
    isbn: null,
    publishedYear: null,
    rating: null,
    ratingCount: null,
    doubanUrl: null,
    authors,
    tags,
  };
}

const SHELF = [
  book("b1", "三体", ["刘慈欣"], ["科幻"]),
  book("b2", "百年孤独", ["加西亚·马尔克斯"]),
  book("b3", "The Pragmatic Programmer", ["Andy Hunt"]),
];

describe("matchBooks", () => {
  it("returns nothing for an empty query, so the palette stays a command list", () => {
    expect(matchBooks(SHELF, "")).toEqual([]);
    expect(matchBooks(SHELF, "   ")).toEqual([]);
  });

  it("matches a title and ignores case", () => {
    expect(matchBooks(SHELF, "三体").map((b) => b.id)).toEqual(["b1"]);
    expect(matchBooks(SHELF, "pragmatic").map((b) => b.id)).toEqual(["b3"]);
  });

  it("matches an author, which is how most books are looked up", () => {
    expect(matchBooks(SHELF, "马尔克斯").map((b) => b.id)).toEqual(["b2"]);
  });

  it("matches a tag", () => {
    expect(matchBooks(SHELF, "科幻").map((b) => b.id)).toEqual(["b1"]);
  });

  it("caps the list so one short query cannot bury every command", () => {
    const many = Array.from({ length: 40 }, (_, i) => book(`m${i}`, `书 ${i}`));
    expect(matchBooks(many, "书")).toHaveLength(12);
  });

  it("returns nothing when no book matches", () => {
    expect(matchBooks(SHELF, "zzz")).toEqual([]);
  });
});
