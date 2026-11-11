import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookCoverFromUrl: vi.fn(),
  metadataSearch: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  // The lookup row only exists in the desktop build, which is where a cover
  // can be downloaded at all.
  isDesktopRuntime: true,
  ipc: {
    bookCoverFromUrl: mocks.bookCoverFromUrl,
    metadataSearch: mocks.metadataSearch,
  },
}));

import { BookMetaDialog } from "@/features/library/BookMetaDialog";
import type { BookSummary, Candidate } from "@/types/ipc";

const COVER = "https://img3.doubanio.com/view/subject/l/public/s35198069.jpg";

const book: BookSummary = {
  id: "test-1",
  title: "存在主义及其他",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 1_024,
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
  authors: ["陈嘉映"],
  tags: [],
};

const candidate: Candidate = {
  source: "douban",
  title: "存在主义及其他",
  subtitle: null,
  authors: ["陈嘉映 编译"],
  publisher: "云南人民出版社",
  publishedYear: 2025,
  description: null,
  rating: 8.1,
  ratingCount: 110,
  doubanUrl: "https://book.douban.com/subject/37112079/",
  language: null,
  isbn: "9787222231535",
  coverUrl: COVER,
  matchScore: 1,
};

function open(overrides: Partial<BookSummary> = {}) {
  const onSave = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <BookMetaDialog book={{ ...book, ...overrides }} onCancel={vi.fn()} onSave={onSave} />
    </QueryClientProvider>,
  );
  return { onSave, invalidate, user: userEvent.setup() };
}

beforeEach(() => {
  mocks.bookCoverFromUrl.mockReset();
  mocks.bookCoverFromUrl.mockResolvedValue(undefined);
  mocks.metadataSearch.mockReset();
  mocks.metadataSearch.mockResolvedValue([candidate]);
});

describe("the cover a candidate brings", () => {
  it("is fetched on 保存, not when the candidate is clicked", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));

    // Nothing is written before the reader says so.
    expect(mocks.bookCoverFromUrl).not.toHaveBeenCalled();
    expect(screen.getByText("封面：保存时下载")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mocks.bookCoverFromUrl).toHaveBeenCalledWith("test-1", COVER);
  });

  /**
   * The regression this exists for: the cover is downloaded *after* the save
   * has already invalidated the shelf, so the refetch reads `cover_path = NULL`
   * and the card keeps its placeholder forever. The shelf has to be asked
   * again once the file is actually there.
   */
  it("refreshes the shelf again once the file has landed", async () => {
    const { user, invalidate } = open();
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["books"] }));
  });

  it("leaves a book that already has a picture alone", async () => {
    const { user } = open({ coverUrl: "fangce://localhost/cover/test-1" });
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));

    expect(screen.queryByText("封面：保存时下载")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(mocks.bookCoverFromUrl).not.toHaveBeenCalled();
  });
});
