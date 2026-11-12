import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BookMetaDialog } from "@/features/library/BookMetaDialog";
import type { BookSummary } from "@/types/ipc";

const book: BookSummary = {
  id: "test-1",
  title: "三体",
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
  authors: ["刘慈欣"],
  tags: [],
};

function open(overrides: Partial<BookSummary> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  // The sheet holds a metadata-lookup mutation, which needs the same provider
  // every page in the app is rendered under.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BookMetaDialog book={{ ...book, ...overrides }} onCancel={onCancel} onSave={onSave} />
    </QueryClientProvider>,
  );
  return { onSave, onCancel, user: userEvent.setup() };
}

const saveButton = () => screen.getByRole("button", { name: "保存" });

/**
 * A row written before a column existed has the field *missing*, not null —
 * which is what every browser-build row from before migration 26 looks like,
 * and what the demo shelf looked like until it was fixed.
 *
 * `undefined !== null` is true, so the rating line's guard let it through and
 * called `.toFixed` on undefined: the whole sheet came down with 「这个界面出错了」
 * instead of showing a book with no rating.
 */
it("renders a row that predates the rating columns", () => {
  const {
    rating: _rating,
    ratingCount: _ratingCount,
    ratingSource: _ratingSource,
    isbn: _isbn,
    publishedYear: _publishedYear,
    doubanUrl: _doubanUrl,
    ...older
  } = book;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BookMetaDialog book={older as BookSummary} onCancel={vi.fn()} onSave={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(screen.getByLabelText("书名")).toHaveValue("三体");
});

describe("BookMetaDialog — 元数据编辑表", () => {
  it("pre-fills every field from the book", () => {
    open({ authors: ["刘慈欣", "李四"], subtitle: "地球往事", publisher: "重庆出版社" });

    expect(screen.getByLabelText("书名")).toHaveValue("三体");
    expect(screen.getByLabelText("作者")).toHaveValue("刘慈欣, 李四");
    expect(screen.getByLabelText("副标题")).toHaveValue("地球往事");
    expect(screen.getByLabelText("出版社")).toHaveValue("重庆出版社");
  });

  it("keeps 保存 disabled until something actually changed", async () => {
    const { user } = open();
    expect(saveButton()).toBeDisabled();

    // Typed and undone: the field matches the book again, so there is nothing
    // worth a round trip and nothing for the shelf to re-render.
    const title = screen.getByLabelText("书名");
    await user.type(title, "II");
    await user.type(title, "{Backspace}{Backspace}");
    expect(saveButton()).toBeDisabled();

    await user.type(title, " II");
    expect(saveButton()).toBeEnabled();
  });

  it("sends the whole form, blank fields included as null", async () => {
    const { user, onSave } = open({ publisher: "重庆出版社" });

    await user.clear(screen.getByLabelText("书名"));
    await user.type(screen.getByLabelText("书名"), "三体 II");
    await user.clear(screen.getByLabelText("出版社"));
    await user.click(saveButton());

    // `null` for the cover: this sheet never chose one, so the save must leave
    // whatever picture the book has alone.
    expect(onSave).toHaveBeenCalledWith(
      {
        title: "三体 II",
        subtitle: null,
        description: null,
        language: "zh",
        publisher: null,
        isbn: null,
        publishedYear: null,
        rating: null,
        ratingCount: null,
        ratingSource: null,
        doubanUrl: null,
        authors: ["刘慈欣"],
      },
      null,
    );
  });

  it("splits authors on both commas and drops the empty names", async () => {
    const { user, onSave } = open();

    const authors = screen.getByLabelText("作者");
    await user.clear(authors);
    // ASCII comma, full-width comma, and a trailing one that leaves a blank.
    await user.type(authors, "刘慈欣, 李四，王五,");
    await user.click(saveButton());

    expect(onSave.mock.calls[0]?.[0].authors).toEqual(["刘慈欣", "李四", "王五"]);
  });

  it("refuses an empty title rather than round-tripping a rejected save", async () => {
    const { user, onSave } = open();

    await user.clear(screen.getByLabelText("书名"));

    expect(screen.getByText("书名不能为空。")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await user.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("is closed — and renders nothing — without a book", () => {
    render(<BookMetaDialog book={null} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });
});
