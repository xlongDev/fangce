import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportCatalog: vi.fn(),
  choose: vi.fn(),
  desktop: true,
  dialogError: null as string | null,
}));

vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return mocks.desktop;
  },
  ipc: { libraryExportCatalog: mocks.exportCatalog },
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

beforeEach(() => {
  mocks.desktop = true;
  mocks.dialogError = null;
  mocks.choose.mockReset().mockResolvedValue("/tmp/books.csv");
  mocks.exportCatalog.mockReset().mockResolvedValue(3);
});

describe("CatalogExportRow", () => {
  it("offers the list on the desktop and says what it does not contain", () => {
    open();
    expect(button()).toBeTruthy();
    expect(screen.getByText(/只有清单，不含书文件/)).toBeTruthy();
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
});
