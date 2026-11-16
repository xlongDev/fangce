import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadataSearch: vi.fn(),
  metadataCoverPreview: vi.fn(),
  coverPreviewFile: vi.fn(),
  openDialog: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  // The lookup row only exists in the desktop build, which is where a cover
  // can be downloaded at all.
  isDesktopRuntime: true,
  // The info sheet also reads per-book counts through `useBookInfo`. Those are
  // irrelevant to a cover test, so answer the offline shape and keep this
  // suite about metadata search.
  desktopQuery: (offline: unknown) => () => Promise.resolve(offline),
  ipc: {
    metadataSearch: mocks.metadataSearch,
    metadataCoverPreview: mocks.metadataCoverPreview,
    coverPreviewFile: mocks.coverPreviewFile,
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openDialog }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/stores/toasts", () => ({ showToast: mocks.showToast }));

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

const LOCAL_PREVIEW = "data:image/png;base64,iVBORw0KGgo=";

beforeEach(() => {
  mocks.metadataSearch.mockReset();
  mocks.metadataSearch.mockResolvedValue([candidate]);
  mocks.metadataCoverPreview.mockReset();
  mocks.metadataCoverPreview.mockResolvedValue(PREVIEW);
  mocks.coverPreviewFile.mockReset();
  mocks.coverPreviewFile.mockResolvedValue(LOCAL_PREVIEW);
  mocks.openDialog.mockReset();
  mocks.openDialog.mockResolvedValue("/books/covers/chosen.png");
  mocks.showToast.mockReset();
});

describe("the cover a candidate brings", () => {
  /**
   * The list is where the choice is made, so the picture has to be there —
   * 2014 年中信版 and 2017 年重印版 of one title are told apart by their covers,
   * not by the words above them. This is a preview: nothing is written.
   */
  it("is shown in the candidate list, without writing anything", async () => {
    const { user, onSave } = open();
    await user.click(screen.getByRole("button", { name: "查豆瓣" }));

    await waitFor(() => expect(document.querySelector(`img[src="${PREVIEW}"]`)).not.toBeNull());
    expect(mocks.metadataCoverPreview).toHaveBeenCalledWith(COVER);
    expect(onSave).not.toHaveBeenCalled();
  });

  /** A book with no picture has nothing to lose: the catalogue's cover is a
   *  fill, and it rides along with the save. */
  it("rides along with the save for a book that has none", async () => {
    const { user, onSave } = open();
    await user.click(screen.getByRole("button", { name: "查豆瓣" }));
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
    await user.click(screen.getByRole("button", { name: "查豆瓣" }));
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
    await user.click(screen.getByRole("button", { name: "查豆瓣" }));
    await user.click(await screen.findByRole("button", { name: "只换封面" }));

    expect(screen.getByLabelText("出版社")).toHaveValue("");
    expect(screen.getByLabelText("书名")).toHaveValue("存在主义及其他");
    expect(screen.getByText("保存时替换")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBe(COVER);
  });

  it("replaces it once the reader asks", async () => {
    const { user, onSave } = open({ coverUrl: "fangce://localhost/cover/test-1" });
    await user.click(screen.getByRole("button", { name: "查豆瓣" }));
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
    await user.click(screen.getByRole("button", { name: "查豆瓣" }));
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

/** The cover path the save asks for: the third argument, or `null` for 「别动封面」. */
const pathOfSave = (onSave: ReturnType<typeof vi.fn>): string | null => {
  const call = onSave.mock.calls.at(-1);
  return call ? (call[2] as string | null) : "never saved";
};

/** The third way to get a cover: a picture already on the reader's disk. No
 *  catalogue, no download — the path is saved and the backend reads the bytes. */
describe("uploading a local cover", () => {
  it("previews the picked image and sends its path — not a URL — on save", async () => {
    const { user, onSave } = open();
    await user.click(screen.getByRole("button", { name: /上传封面/ }));

    expect(mocks.openDialog).toHaveBeenCalled();
    expect(mocks.coverPreviewFile).toHaveBeenCalledWith("/books/covers/chosen.png");
    expect(screen.getByAltText("上传的封面预览")).toBeInTheDocument();
    expect(screen.getByText("保存时上传")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBeNull();
    expect(pathOfSave(onSave)).toBe("/books/covers/chosen.png");
  });

  it("can be dropped with 不换, leaving no cover to save", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /上传封面/ }));
    await user.click(screen.getByRole("button", { name: "不换" }));

    expect(screen.queryByAltText("上传的封面预览")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("a catalogue pick replaces the uploaded one so one save writes one cover", async () => {
    const { user, onSave } = open();
    await user.click(screen.getByRole("button", { name: /上传封面/ }));
    expect(screen.getByAltText("上传的封面预览")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查豆瓣" }));
    await user.click(await screen.findByRole("button", { name: "只换封面" }));

    expect(screen.queryByAltText("上传的封面预览")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(coverOfSave(onSave)).toBe(COVER);
    expect(pathOfSave(onSave)).toBeNull();
  });

  it("a failed read shows no preview and no toast-swallowed pending cover", async () => {
    mocks.coverPreviewFile.mockRejectedValueOnce(new Error("not an image"));
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /上传封面/ }));

    expect(screen.queryByAltText("上传的封面预览")).not.toBeInTheDocument();
    expect(mocks.showToast).toHaveBeenCalledWith("error", expect.stringContaining("读取封面失败"));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });
});

/** The lookup row has to explain itself without a hover: a bare 「豆瓣 / NeoDB」
 *  reads like a link to a website, and the trade-offs used to hide in a `title`
 *  tooltip nobody reached for. The group label + visible per-source line are
 *  what make the choice legible, so they are asserted as text, not decoration. */
describe("the lookup row explains itself", () => {
  it("labels the group as online completion", () => {
    open();
    expect(screen.getByText("在线补全信息")).toBeInTheDocument();
  });

  it("prints each source's trade-off as visible text, not a hidden tooltip", () => {
    open();
    // The detail lives in the `<li>`'s own text node (the source name is a
    // sibling `<span>`), so match just the detail — it appears nowhere else.
    expect(screen.getByText(/中文版次全，国内直连/)).toBeInTheDocument();
    expect(screen.getByText(/外文书与 ISBN，需代理/)).toBeInTheDocument();
  });
});
