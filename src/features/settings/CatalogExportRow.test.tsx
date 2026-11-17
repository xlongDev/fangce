import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportCatalog: vi.fn(),
  importCatalog: vi.fn(),
  choose: vi.fn(),
  openDialog: vi.fn(),
  desktop: true,
  dialogError: null as string | null,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openDialog,
  save: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return mocks.desktop;
  },
  ipc: {
    libraryExportCatalog: mocks.exportCatalog,
    libraryImportCatalog: mocks.importCatalog,
  },
}));
vi.mock("@/hooks/useSavePath", () => ({
  // The panel itself belongs to the plugin; what this row owes it is the path
  // it was given, and how a refusal is shown.
  useSavePath: () => ({ choose: mocks.choose, error: mocks.dialogError }),
}));

import { CatalogExportRow } from "./CatalogExportRow";

function open() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CatalogExportRow />
    </QueryClientProvider>,
  );
}

const button = () => screen.getByRole("button", { name: /导出书单/ });
const restoreButton = () => screen.getByRole("button", { name: "选择 CSV 恢复" });

beforeEach(() => {
  mocks.desktop = true;
  mocks.dialogError = null;
  mocks.choose.mockReset().mockResolvedValue("/tmp/books.csv");
  mocks.openDialog.mockReset().mockResolvedValue("/tmp/restore.csv");
  mocks.exportCatalog.mockReset().mockResolvedValue(3);
  mocks.importCatalog.mockReset().mockResolvedValue({ restored: 2, missing: ["gone-id"] });
});

describe("CatalogExportRow", () => {
  it("offers the list on the desktop and says what it does not contain", () => {
    open();
    expect(button()).toBeTruthy();
    expect(screen.getByText(/单本书也可以用书卡/)).toBeTruthy();
  });

  it("renders nothing in the browser, which has no filesystem command", () => {
    mocks.desktop = false;
    const { container } = open();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks for a .csv path and exports the shelf to it", async () => {
    open();
    await userEvent.click(button());

    await waitFor(() => expect(mocks.exportCatalog).toHaveBeenCalledWith("/tmp/books.csv"));
    expect(mocks.choose).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^fangce-books-\d{4}-\d{2}-\d{2}\.csv$/),
        filters: [{ name: "书单 CSV", extensions: ["csv"] }],
      }),
    );
    expect(await screen.findByText("已导出 3 本书。")).toBeTruthy();
  });

  it("says so when the shelf was empty rather than claiming an export", async () => {
    mocks.exportCatalog.mockResolvedValue(0);
    open();
    await userEvent.click(button());

    expect(await screen.findByText(/书架是空的/)).toBeTruthy();
  });

  it("treats a cancelled panel as no export at all", async () => {
    mocks.choose.mockResolvedValue(null);
    open();
    await userEvent.click(button());

    await waitFor(() => expect(mocks.choose).toHaveBeenCalled());
    expect(mocks.exportCatalog).not.toHaveBeenCalled();
    expect(screen.queryByText(/已导出/)).toBeNull();
  });

  it("shows the panel's own refusal", () => {
    mocks.dialogError = "无法打开保存对话框：权限不足";
    open();
    expect(screen.getByText("无法打开保存对话框：权限不足")).toBeTruthy();
  });

  it("shows a failed write instead of a success", async () => {
    mocks.exportCatalog.mockRejectedValue(new Error("磁盘已满"));
    open();
    await userEvent.click(button());

    expect(await screen.findByText(/磁盘已满/)).toBeTruthy();
    expect(screen.queryByText(/已导出 3 本书/)).toBeNull();
  });

  it("disables the button while the file is being written", async () => {
    // Kept pending until the assertion, so the mutation's own state is what
    // disables the button rather than a mock of the button.
    let finish: ((count: number) => void) | undefined;
    mocks.exportCatalog.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    open();
    await userEvent.click(button());

    await waitFor(() => expect(screen.getByRole("button", { name: "正在导出…" })).toBeDisabled());
    finish?.(3);
    expect(await screen.findByText("已导出 3 本书。")).toBeTruthy();
  });

  it("restores the books named in a picked CSV and says what was skipped", async () => {
    open();
    await userEvent.click(restoreButton());

    await waitFor(() => expect(mocks.importCatalog).toHaveBeenCalledWith("/tmp/restore.csv"));
    expect(
      await screen.findByText("已从 CSV 恢复 2 本书，1 本不在书架，已跳过。可在操作记录里撤销。"),
    ).toBeTruthy();
  });

  it("does not promise an undo when no book was restored", async () => {
    mocks.importCatalog.mockResolvedValue({ restored: 0, missing: ["gone-id"] });
    open();
    await userEvent.click(restoreButton());

    expect(await screen.findByText("已从 CSV 恢复 0 本书，1 本不在书架，已跳过。")).toBeTruthy();
    expect(screen.queryByText(/可在操作记录里撤销/)).toBeNull();
  });

  it("does not import when the open panel is cancelled", async () => {
    mocks.openDialog.mockResolvedValue(null);
    open();
    await userEvent.click(restoreButton());

    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalled());
    expect(mocks.importCatalog).not.toHaveBeenCalled();
  });

  it("shows a failed restore rather than claiming success", async () => {
    mocks.importCatalog.mockRejectedValue(new Error("表头缺少书籍ID"));
    open();
    await userEvent.click(restoreButton());

    expect(await screen.findByText(/表头缺少书籍ID/)).toBeTruthy();
    expect(screen.queryByText(/已从 CSV 恢复/)).toBeNull();
  });
});
