import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadataSearch: vi.fn(),
  metadataCoverPreview: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  // The lookup row only exists in the desktop build, which is where a cover
  // can be downloaded at all.
  isDesktopRuntime: true,
  ipc: {
    metadataSearch: mocks.metadataSearch,
    metadataCoverPreview: mocks.metadataCoverPreview,
  },
}));

import { BookMetaDialog } from "@/features/library/BookMetaDialog";
import type { BookSummary, Candidate } from "@/types/ipc";

const COVER = "https://img3.doubanio.com/view/subject/l/public/s35198069.jpg";
/** What the backend hands back: bytes, typed, inline. */
const PREVIEW = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

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
  render(
    <QueryClientProvider client={client}>
      <BookMetaDialog book={{ ...book, ...overrides }} onCancel={vi.fn()} onSave={onSave} />
    </QueryClientProvider>,
  );
  return { onSave, user: userEvent.setup() };
}

/** The cover a save asks for: the second argument, or `null` for 「别动封面」. */
function coverOfSave(onSave: ReturnType<typeof vi.fn>): string | null {
  const call = onSave.mock.calls.at(-1);
  return call ? (call[1] as string | null) : "never saved";
}

beforeEach(() => {
  mocks.metadataSearch.mockReset();
  mocks.metadataSearch.mockResolvedValue([candidate]);
  mocks.metadataCoverPreview.mockReset();
  mocks.metadataCoverPreview.mockResolvedValue(PREVIEW);
});

describe("the cover a candidate brings", () => {
  /**
   * The list is where the choice is made, so the picture has to be there —
   * 2014 年中信版 and 2017 年重印版 of one title are told apart by their covers,
   * not by the words above them. This is a preview: nothing is written.
   */
  it("is shown in the candidate list, without writing anything", async () => {
    const { user, onSave } = open();
    await user.click(screen.getByRole("button", { name: "豆瓣" }));

    await waitFor(() => expect(document.querySelector(`img[src="${PREVIEW}"]`)).not.toBeNull());
    expect(mocks.metadataCoverPreview).toHaveBeenCalledWith(COVER);
    expect(onSave).not.toHaveBeenCalled();
  });

  /** A book with no picture has nothing to lose: the catalogue's cover is a
   *  fill, and it rides along with the save. */
  it("rides along with the save for a book that has none", async () => {
    const { user, onSave } = open();
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));

    expect(screen.getByText("保存时下载")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBe(COVER);
  });

  /**
   * The picture a file carries is often not a cover — a 3-D mock-up of the
   * whole jacket, a scan with a library sticker, a frame from the film — and
   * the catalogue's flat scan is what belongs on the shelf. But the picture on
   * the shelf is also what the reader has been looking at: picking a better
   * title must not silently take it away.
   */
  it("offers the catalogue's picture instead of taking it", async () => {
    const { user, onSave } = open({ coverUrl: "fangce://localhost/cover/test-1" });
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));

    expect(screen.getByRole("button", { name: /换成这张/ })).toBeInTheDocument();
    expect(screen.queryByText("保存时替换")).not.toBeInTheDocument();
    expect(screen.getByAltText("现在的封面")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBeNull();
  });

  /**
   * A reader who only wants the picture should not have to undo nine fields
   * afterwards. 「只换封面」 takes the image and nothing else — the candidate's
   * publisher (云南人民出版社) must not land in a book that has none.
   */
  it("takes only the picture when that is all the reader wants", async () => {
    const { user, onSave } = open({ coverUrl: "fangce://localhost/cover/test-1" });
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: "只换封面" }));

    expect(screen.getByLabelText("出版社")).toHaveValue("");
    expect(screen.getByLabelText("书名")).toHaveValue("存在主义及其他");
    expect(screen.getByText("保存时替换")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBe(COVER);
  });

  it("replaces it once the reader asks", async () => {
    const { user, onSave } = open({ coverUrl: "fangce://localhost/cover/test-1" });
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));
    await user.click(screen.getByRole("button", { name: /换成这张/ }));

    expect(screen.getByText("保存时替换")).toBeInTheDocument();

    // A cover alone is a change: the save button must not stay disabled just
    // because no word was touched.
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(coverOfSave(onSave)).toBe(COVER);
  });

  it("lets the reader put the old picture back", async () => {
    const { user, onSave } = open({ coverUrl: "fangce://localhost/cover/test-1" });
    await user.click(screen.getByRole("button", { name: "豆瓣" }));
    await user.click(await screen.findByRole("button", { name: /存在主义及其他/ }));
    await user.click(screen.getByRole("button", { name: /换成这张/ }));
    await user.click(screen.getByRole("button", { name: "不换" }));

    expect(screen.queryByText("保存时替换")).not.toBeInTheDocument();
    // The offer is still on the table, and saving must not fetch anything.
    expect(screen.getByRole("button", { name: /换成这张/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBeNull();
  });
});
