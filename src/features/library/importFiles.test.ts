import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), scanPaths: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/lib/ipc", () => ({ ipc: { bookScanPaths: mocks.scanPaths } }));

import { expandImportPaths, pickFolder } from "@/features/library/importFiles";

describe("pickFolder", () => {
  it("asks for one directory and hands back its path", async () => {
    mocks.open.mockResolvedValue("/books/三体");
    await expect(pickFolder()).resolves.toBe("/books/三体");
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    );
  });

  it("treats a cancelled dialog as no folder", async () => {
    mocks.open.mockResolvedValue(null);
    await expect(pickFolder()).resolves.toBeNull();
  });
});

describe("expandImportPaths", () => {
  it("sends picked folders and dropped files through the same expansion", async () => {
    mocks.scanPaths.mockResolvedValue(["/books/a.epub"]);
    await expect(expandImportPaths(["/books", "/loose.pdf"])).resolves.toEqual(["/books/a.epub"]);
    expect(mocks.scanPaths).toHaveBeenCalledWith(["/books", "/loose.pdf"]);
  });
});
