import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calibreScan: vi.fn(),
  applyMetadata: vi.fn(),
  importBooks: vi.fn(),
  pickDirectory: vi.fn(),
  onImportProgress: vi.fn(),
  desktop: true,
}));

vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return mocks.desktop;
  },
  ipc: { calibreScan: mocks.calibreScan, calibreApplyMetadata: mocks.applyMetadata },
  onImportProgress: mocks.onImportProgress,
}));
vi.mock("@/hooks/useLibrary", () => ({
  // The real hook is a react-query mutation whose invalidation is covered by
  // the shelf's own tests. Here only the paths it is handed matter.
  useImportBooks: () => ({ mutateAsync: mocks.importBooks, isPending: false }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.pickDirectory }));

import { CalibreDialog } from "@/features/library/CalibreDialog";
import type { CalibreBook, CalibreScan, ImportOutcome } from "@/types/ipc";

const emptyMetadata = {
  publisher: null,
  tags: [],
  series: null,
  rating: null,
  language: null,
  description: null,
  isbn: null,
  published: null,
};

const EPUB = "/books/calibre/刘慈欣/三体 (1)/三体.epub";
const AZW3 = "/books/calibre/刘慈欣/三体 (1)/三体.azw3";
const LIVING = "/books/calibre/余华/活着 (2)/活着.epub";
const scan: CalibreScan = {
  root: "/books/calibre",
  dbPath: "/books/calibre/metadata.db",
  books: [
    {
      id: 1,
      title: "三体",
      authors: ["刘慈欣"],
      formats: ["EPUB", "AZW3"],
      path: "刘慈欣/三体 (1)",
      files: [
        { path: EPUB, format: "epub" },
        { path: "/books/calibre/刘慈欣/三体 (1)/三体.azw3", format: "azw3" },
      ],
      metadata: {
        ...emptyMetadata,
        isbn: "9787536692930",
        tags: ["科幻", "中国文学"],
        rating: "8",
      },
    },
    {
      id: 2,
      title: "活着",
      authors: ["余华"],
      formats: ["EPUB"],
      path: "余华/活着 (2)",
      files: [{ path: "/books/calibre/余华/活着 (2)/活着.epub", format: "epub" }],
      metadata: { ...emptyMetadata },
    },
  ],
  metadataFields: ["ISBN", "标签", "评分"],
  warnings: ["有 1 本书在 data 表里没有格式文件记录（仍会从书库目录找文件）。"],
};

/** `noUncheckedIndexedAccess` makes `scan.books[0]` possibly undefined. The
 *  fixture always has both books; name it once rather than asserting in every
 *  expectation. */
function bookAt(index: number): CalibreBook {
  const book = scan.books[index];
  if (!book) throw new Error(`fixture has no book ${index}`);
  return book;
}

const imported: ImportOutcome = { kind: "imported", path: EPUB, id: "a", title: "三体" };

/** 150 books: enough to cross the 100-row page boundary. */
const manyBooks: CalibreBook[] = Array.from({ length: 150 }, (_, index) => ({
  id: index + 1,
  title: `书 ${index + 1}`,
  authors: ["作者"],
  formats: ["EPUB"],
  path: `作者/书 (${index + 1})`,
  files: [{ path: `/books/${index + 1}.epub`, format: "epub" }],
  metadata: { ...emptyMetadata },
}));

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CalibreDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function pick(path: string | null = "/books/calibre") {
  mocks.pickDirectory.mockResolvedValue(path);
  await userEvent.setup().click(screen.getByRole("button", { name: /选择书库目录/ }));
}

beforeEach(() => {
  mocks.desktop = true;
  mocks.calibreScan.mockReset();
  mocks.applyMetadata.mockReset();
  mocks.pickDirectory.mockReset();
  mocks.importBooks.mockReset();
  mocks.onImportProgress.mockReset();
  mocks.onImportProgress.mockImplementation(() => Promise.resolve(undefined));
  mocks.calibreScan.mockResolvedValue(scan);
  mocks.importBooks.mockResolvedValue([imported]);
  mocks.applyMetadata.mockResolvedValue({ written: 1, tagged: 1, skippedTags: 0 });
});

/** Pick a directory, wait for the scan, select one book and import it. */
async function importOne() {
  open();
  await pick();
  await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
  await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));
}

describe("the Calibre scan", () => {
  it("says so in the browser build instead of answering with an empty list", () => {
    mocks.desktop = false;
    open();

    expect(screen.getByText(/只在桌面版可用/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /选择书库目录/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入选中的/ })).not.toBeInTheDocument();
    expect(mocks.calibreScan).not.toHaveBeenCalled();
  });

  it("scans the picked root and shows the books, formats and warnings", async () => {
    open();
    await pick();

    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());
    expect(mocks.calibreScan).toHaveBeenCalledWith("/books/calibre");
    expect(screen.getByText(/EPUB 2 · AZW3 1/)).toBeInTheDocument();
    expect(screen.getByText("三体")).toBeInTheDocument();
    expect(screen.getByText("刘慈欣")).toBeInTheDocument();
    expect(screen.getByText(/格式文件记录/)).toBeInTheDocument();
  });

  it("reports which optional fields exist and which were skipped", async () => {
    open();
    await pick();

    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());
    expect(screen.getByText(/读到 ISBN、标签、评分/)).toBeInTheDocument();
    expect(screen.getByText(/没有 出版日期、出版社、系列、语言、简介/)).toBeInTheDocument();
    expect(screen.getByText(/还没有写进方册/)).toBeInTheDocument();
  });

  it("a library with no optional tables still reads as a library", async () => {
    mocks.calibreScan.mockResolvedValue({ ...scan, metadataFields: [] });
    open();
    await pick();

    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());
    expect(screen.getByText(/这个库没有可识别的扩展字段/)).toBeInTheDocument();
  });

  it("shows the values it read, not just the field names", async () => {
    open();
    await pick();

    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());
    // A real-library check needs to see the ISBN itself, not just "ISBN found".
    expect(screen.getByTitle(/ISBN 9787536692930/)).toBeInTheDocument();
    expect(screen.getByTitle(/标签 科幻、中国文学/)).toBeInTheDocument();
    expect(screen.getByTitle(/评分 8/)).toBeInTheDocument();
  });

  it("asks for an explicit selection before importing", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "导入选中的 0 本" })).toBeDisabled();
    expect(mocks.importBooks).not.toHaveBeenCalled();
  });

  it("imports one file per selected book, never both formats of one novel", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
    await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));

    await waitFor(() => expect(mocks.importBooks).toHaveBeenCalledWith({ paths: [EPUB] }));
    expect(await screen.findByText(/1 本已导入/)).toBeInTheDocument();
    // The selection is cleared so a second click cannot re-import the batch.
    expect(screen.getByRole("button", { name: "导入选中的 0 本" })).toBeDisabled();
  });

  it("select-all covers every importable book on the page", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: /选中筛选结果中可导入的 2 本/ }));
    expect(screen.getByRole("button", { name: "导入选中的 2 本" })).toBeEnabled();
  });

  it("filters by title or author", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    await userEvent.setup().type(screen.getByRole("textbox", { name: "按书名或作者筛选" }), "余华");

    expect(screen.getByText("活着")).toBeInTheDocument();
    expect(screen.queryByText("三体")).not.toBeInTheDocument();
  });

  it("paginates a large library and keeps the selection across pages", async () => {
    mocks.calibreScan.mockResolvedValue({ ...scan, books: manyBooks, warnings: [] });
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 150 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    expect(screen.getByText(/第 1 \/ 2 页 · 筛选结果 150 本/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "选择《书 1》" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(screen.getByText(/第 2 \/ 2 页 · 筛选结果 150 本/)).toBeInTheDocument();
    expect(screen.getByText("书 101")).toBeInTheDocument();
    // The book picked on page one is still in the batch.
    expect(screen.getByRole("button", { name: "导入选中的 1 本" })).toBeEnabled();
  });

  it("select-all reaches the whole filtered library, not just the visible page", async () => {
    mocks.calibreScan.mockResolvedValue({ ...scan, books: manyBooks, warnings: [] });
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 150 本/)).toBeInTheDocument());

    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: /选中筛选结果中可导入的 150 本/ }));
    expect(screen.getByRole("button", { name: "导入选中的 150 本" })).toBeEnabled();
  });

  it("counts import progress only while its own batch runs", async () => {
    let finish: ((value: ImportOutcome[]) => void) | undefined;
    mocks.importBooks.mockImplementation(
      () =>
        new Promise<ImportOutcome[]>((resolve) => {
          finish = resolve;
        }),
    );
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
    await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));
    expect(await screen.findByText(/正在导入 0 \/ 1/)).toBeInTheDocument();

    const handler = mocks.onImportProgress.mock.calls[0]?.[0] as (p: {
      done: number;
      total: number;
    }) => void;
    act(() => handler({ done: 1, total: 1 }));
    expect(screen.getByText(/正在导入 1 \/ 1/)).toBeInTheDocument();

    await act(async () => finish?.([imported]));
    expect(screen.queryByText(/正在导入/)).not.toBeInTheDocument();
  });

  it("offers only formats that really exist in this library", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const options = [
      ...screen.getByRole("combobox", { name: "优先导入格式" }).querySelectorAll("option"),
    ].map((option) => option.value);
    // "" is "automatic"; PDF is never offered because no book has one.
    expect(options).toEqual(["", "azw3", "epub"]);
  });

  it("imports the preferred format when the book has it", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "优先导入格式" }), "azw3");
    await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
    await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));

    await waitFor(() => expect(mocks.importBooks).toHaveBeenCalledWith({ paths: [AZW3] }));
  });

  it("says how many books fall back, and falls back to their own first file", async () => {
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "优先导入格式" }), "azw3");
    expect(screen.getByText(/有 1 本没有 AZW3/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /选中筛选结果中可导入的 2 本/ }));
    await user.click(screen.getByRole("button", { name: "导入选中的 2 本" }));
    await waitFor(() => expect(mocks.importBooks).toHaveBeenCalledWith({ paths: [AZW3, LIVING] }));
  });

  it("a book with no real file cannot be selected", async () => {
    mocks.calibreScan.mockResolvedValue({
      ...scan,
      books: [{ ...scan.books[0], files: [] }],
      warnings: [],
    });
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 1 本/)).toBeInTheDocument());

    expect(screen.getByRole("checkbox", { name: "选择《三体》" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入选中的 0 本" })).toBeDisabled();
  });

  it("shows each failure instead of only the batch summary", async () => {
    mocks.importBooks.mockResolvedValue([
      { kind: "failed", path: "/books/x.epub", message: "文件损坏" },
    ]);
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
    await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));

    expect(await screen.findByText(/1 本失败/)).toBeInTheDocument();
    expect(screen.getByText("x.epub：文件损坏")).toBeInTheDocument();
  });

  it("does not stay silent when the whole import fails", async () => {
    mocks.importBooks.mockRejectedValue(new Error("数据库忙"));
    open();
    await pick();
    await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
    await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));

    expect(await screen.findByText("数据库忙")).toBeInTheDocument();
  });

  it("shows the backend's explanation when the directory is not a library", async () => {
    mocks.calibreScan.mockRejectedValue(new Error("目录里没有 metadata.db"));
    open();
    await pick();

    await waitFor(() => expect(screen.getByText(/没有 metadata\.db/)).toBeInTheDocument());
  });

  it("a cancelled picker asks nothing and keeps the last report", async () => {
    open();
    await pick(null);

    expect(mocks.calibreScan).not.toHaveBeenCalled();
    expect(screen.getByText(/选一个包含 metadata\.db/)).toBeInTheDocument();
  });

  it("an empty but valid library reads as empty, not as a failure", async () => {
    mocks.calibreScan.mockResolvedValue({ ...scan, books: [], warnings: [] });
    open();
    await pick();

    await waitFor(() => expect(screen.getByText(/一本书都没有/)).toBeInTheDocument());
  });

  describe("copying the scanned metadata onto the shelf", () => {
    it("pairs each successful outcome with its scanned book by path", async () => {
      await importOne();

      await waitFor(() =>
        expect(mocks.applyMetadata).toHaveBeenCalledWith([
          { bookId: "a", authors: ["刘慈欣"], metadata: bookAt(0).metadata },
        ]),
      );
      expect(await screen.findByText(/已补全 1 本/)).toBeInTheDocument();
    });

    it("can be turned off, leaving the import itself untouched", async () => {
      open();
      await pick();
      await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: /导入时补进方册/ }));
      await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
      await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));

      await waitFor(() => expect(mocks.importBooks).toHaveBeenCalledWith({ paths: [EPUB] }));
      expect(mocks.applyMetadata).not.toHaveBeenCalled();
      expect(screen.queryByText(/已补全/)).not.toBeInTheDocument();
    });

    it("writes duplicates but never a file that failed to import", async () => {
      mocks.importBooks.mockResolvedValue([
        { kind: "failed", path: EPUB, message: "文件损坏" },
        { kind: "duplicate", path: LIVING, id: "b", title: "活着" },
      ]);
      open();
      await pick();
      await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: /选中筛选结果中可导入的 2 本/ }));
      await user.click(screen.getByRole("button", { name: "导入选中的 2 本" }));

      await waitFor(() =>
        expect(mocks.applyMetadata).toHaveBeenCalledWith([
          { bookId: "b", authors: ["余华"], metadata: bookAt(1).metadata },
        ]),
      );
    });

    it("uses the preferred format's path when pairing, not the first file", async () => {
      open();
      await pick();
      await waitFor(() => expect(screen.getByText(/共 2 本/)).toBeInTheDocument());

      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole("combobox", { name: "优先导入格式" }), "azw3");
      mocks.importBooks.mockResolvedValue([
        { kind: "imported", path: AZW3, id: "a", title: "三体" },
      ]);
      await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
      await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));

      await waitFor(() => expect(mocks.applyMetadata).toHaveBeenCalledTimes(1));
      expect(mocks.applyMetadata.mock.calls[0]?.[0]?.[0]?.bookId).toBe("a");
    });

    it("says the books landed when only the metadata write failed", async () => {
      mocks.applyMetadata.mockRejectedValue(new Error("数据库忙"));
      await importOne();

      expect(await screen.findByText(/书已导入，但元数据没写进去：数据库忙/)).toBeInTheDocument();
      expect(screen.getByText(/1 本已导入/)).toBeInTheDocument();
    });

    it("reports tagged books and skipped overlong tags", async () => {
      mocks.applyMetadata.mockResolvedValue({ written: 1, tagged: 1, skippedTags: 2 });
      await importOne();

      expect(await screen.findByText(/加了 1 本的标签 · 跳过 2 个过长标签/)).toBeInTheDocument();
    });

    it("does not write metadata when the whole import failed", async () => {
      mocks.importBooks.mockRejectedValue(new Error("导入器崩了"));
      await importOne();

      expect(await screen.findByText("导入器崩了")).toBeInTheDocument();
      expect(mocks.applyMetadata).not.toHaveBeenCalled();
    });

    it("keeps the full description in the data and cuts only the tooltip", async () => {
      const long = "简介文本".repeat(100);
      mocks.calibreScan.mockResolvedValue({
        ...scan,
        books: [{ ...scan.books[0], metadata: { ...emptyMetadata, description: long } }],
      });
      open();
      await pick();
      await waitFor(() => expect(screen.getByText(/共 1 本/)).toBeInTheDocument());

      const tooltip = screen.getByTitle(/简介/).getAttribute("title") ?? "";
      expect(tooltip).toContain("…");
      expect(tooltip.length).toBeLessThan(long.length);

      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: "选择《三体》" }));
      await user.click(screen.getByRole("button", { name: "导入选中的 1 本" }));
      await waitFor(() => expect(mocks.applyMetadata).toHaveBeenCalledTimes(1));
      // The value handed to the backend is the uncut one; the tooltip is a view.
      expect(mocks.applyMetadata.mock.calls[0]?.[0]?.[0]?.metadata.description).toBe(long);
    });
  });
});
