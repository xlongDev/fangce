import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BookSummary } from "@/types/ipc";

/** The native save panel, stubbed: this suite is about what the dialog asks for,
 *  and the panel is a separate concern with its own error story.
 *
 *  `vi.hoisted` so the module exports *this* function rather than a wrapper
 *  around it — the assertions are about what the panel was asked for. */
const { save } = vi.hoisted(() => ({
  // `null` is the panel being dismissed, which one of the cases below needs.
  save: vi.fn(async (): Promise<string | null> => "/tmp/导出"),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@/lib/ipc", () => ({ isDesktopRuntime: true }));

import { ExportPackDialog } from "@/features/library/PackDialog";

const baseBook: BookSummary = {
  id: "test-1",
  title: "测试书",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 4_500_000,
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
  authors: ["张三"],
  tags: [],
};

function renderDialog(book: Partial<BookSummary> = {}) {
  const onConfirm = vi.fn();
  render(
    <ExportPackDialog book={{ ...baseBook, ...book }} onCancel={() => {}} onConfirm={onConfirm} />,
  );
  return { onConfirm };
}

/** The chip for one export kind. */
const chip = (label: string) => screen.getByRole("button", { name: label });

beforeEach(() => {
  save.mockClear();
});

describe("the export dialog", () => {
  it("offers the book's own file first, because it is the one another reader can open", () => {
    renderDialog();
    expect(chip("原文件")).toHaveAttribute("aria-pressed", "true");
    expect(chip("书档")).toHaveAttribute("aria-pressed", "false");
    expect(chip("书目 CSV")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText("书档密码")).not.toBeInTheDocument();
  });

  it("asks the panel for the extension of the shape that is selected", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(chip("原文件"));
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "测试书.epub" }));

    await user.click(chip("书档"));
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "测试书.ctz" }));

    await user.click(chip("加密书档"));
    await user.type(screen.getByLabelText("书档密码"), "pw");
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "测试书.ctzx" }));

    await user.click(chip("书目 CSV"));
    expect(screen.queryByLabelText("书档密码")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(save).toHaveBeenLastCalledWith({
      title: "导出书目 CSV",
      defaultPath: "测试书.csv",
      filters: [{ name: "书目 CSV", extensions: ["csv"] }],
    });
  });

  it("says the right thing about each shape, since only one of them travels", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByText(/兼容其他阅读器/)).toBeInTheDocument();

    await user.click(chip("书档"));
    expect(screen.getByText(/只有本应用认得/)).toBeInTheDocument();

    await user.click(chip("书目 CSV"));
    expect(screen.getByText(/书单里的一行/)).toBeInTheDocument();
    expect(screen.getByText(/可在设置页导入恢复/)).toBeInTheDocument();
  });

  it("offers the backup section for a whole-library move", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    window.addEventListener("fangce:navigate", onNavigate);
    try {
      renderDialog();
      await user.click(screen.getByRole("button", { name: "设置 › 书库备份" }));
      expect(onNavigate).toHaveBeenCalledOnce();
      const event = onNavigate.mock.calls[0]?.[0] as CustomEvent<string> | undefined;
      expect(event?.detail).toBe("/settings#backup");
    } finally {
      window.removeEventListener("fangce:navigate", onNavigate);
    }
  });

  it("keeps the extension honest for a format whose own name is not its extension", async () => {
    const user = userEvent.setup();
    renderDialog({ format: "markdown" });
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "测试书.md" }));
  });

  it("will not export an encrypted pack without a password", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(chip("加密书档"));

    const submit = screen.getByRole("button", { name: "选择保存位置" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("书档密码"), "pw");
    expect(submit).toBeEnabled();
  });

  it("hands the caller the path, the shape and the password", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce("/tmp/书.ctzx");
    const { onConfirm } = renderDialog();

    await user.click(chip("加密书档"));
    await user.type(screen.getByLabelText("书档密码"), "pw");
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(onConfirm).toHaveBeenCalledWith({
      book: expect.objectContaining({ id: "test-1" }),
      path: "/tmp/书.ctzx",
      kind: "encrypted",
      password: "pw",
      includeAi: true,
    });
  });

  it("offers the metadata-rewritten copy for EPUB with an author-title file name", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce("/tmp/张三 - 测试书.epub");
    const { onConfirm } = renderDialog();

    await user.click(chip("带元信息 EPUB"));
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "张三 - 测试书.epub" }),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "enriched", path: "/tmp/张三 - 测试书.epub" }),
    );
  });

  it("hides the metadata rewrite for other formats", () => {
    renderDialog({ format: "pdf" });
    expect(screen.queryByRole("button", { name: "带元信息 EPUB" })).toBeNull();
  });

  it("carries no password for the shapes that have none", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce("/tmp/书.epub");
    const { onConfirm } = renderDialog();

    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(onConfirm).toHaveBeenCalledWith({
      book: expect.objectContaining({ id: "test-1" }),
      path: "/tmp/书.epub",
      kind: "original",
      password: undefined,
      includeAi: false,
    });
  });

  it("keeps private conversations out of a plaintext pack until asked", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce("/tmp/书.ctz");
    const { onConfirm } = renderDialog();

    await user.click(chip("书档"));
    const toggle = screen.getByRole("checkbox", { name: /包含 AI 导读与对话/ });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(onConfirm).toHaveBeenCalledWith({
      book: expect.objectContaining({ id: "test-1" }),
      path: "/tmp/书.ctz",
      kind: "pack",
      password: undefined,
      includeAi: true,
    });
  });

  it("starts an encrypted pack with AI included but lets it be turned off", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce("/tmp/书.ctzx");
    const { onConfirm } = renderDialog();

    await user.click(chip("加密书档"));
    const toggle = screen.getByRole("checkbox", { name: /包含 AI 导读与对话/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await user.type(screen.getByLabelText("书档密码"), "pw");
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "encrypted", includeAi: false }),
    );
  });

  it("does not offer an AI toggle to shapes that cannot carry it", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(chip("书目 CSV"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("hands the caller a catalogue row without inventing a password", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce("/tmp/测试书.csv");
    const { onConfirm } = renderDialog();

    await user.click(chip("书目 CSV"));
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(onConfirm).toHaveBeenCalledWith({
      book: expect.objectContaining({ id: "test-1" }),
      path: "/tmp/测试书.csv",
      kind: "catalog",
      password: undefined,
      includeAi: false,
    });
  });

  it("writes nothing when the panel is dismissed", async () => {
    const user = userEvent.setup();
    save.mockResolvedValueOnce(null);
    const { onConfirm } = renderDialog();

    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
