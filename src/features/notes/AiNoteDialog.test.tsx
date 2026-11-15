import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiNoteDialog } from "@/features/notes/AiNoteDialog";

const notesDraftSuggest = vi.fn();
const notesDraftApply = vi.fn();

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: false,
  ipc: {
    notesDraftSuggest: (...args: unknown[]) => notesDraftSuggest(...args),
    notesDraftApply: (...args: unknown[]) => notesDraftApply(...args),
  },
}));

function open() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiNoteDialog open ids={["a1", "a2"]} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
}

const run = {
  suggestions: [
    { annotationId: "a1", bookId: "b1", quote: "给岁月以文明", note: "文明先于岁月" },
    { annotationId: "a2", bookId: "b1", quote: "给文明以岁月", note: "顺序值得再想" },
  ],
  considered: 2,
  remaining: 0,
  failedBatches: 0,
};

describe("AI 补笔记", () => {
  beforeEach(() => {
    notesDraftSuggest.mockReset();
    notesDraftApply.mockReset();
  });

  it("打开对话框不调用模型", () => {
    open();
    expect(notesDraftSuggest).not.toHaveBeenCalled();
    expect(screen.getByText(/不会覆盖你自己写过的话/)).toBeTruthy();
  });

  it("点掉一条就只写另一条", async () => {
    const { user } = open();
    notesDraftSuggest.mockResolvedValueOnce(run);
    notesDraftApply.mockResolvedValueOnce(1);

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    expect(notesDraftSuggest).toHaveBeenCalledWith(["a1", "a2"]);
    expect(await screen.findByText("文明先于岁月")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "给岁月以文明" }));
    expect(screen.getByRole("button", { name: "应用：1 条" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "应用：1 条" }));

    expect(notesDraftApply).toHaveBeenCalledWith([
      { annotationId: "a2", bookId: "b1", note: "顺序值得再想" },
    ]);
    expect(await screen.findByText(/已给 1 条补上笔记/)).toBeTruthy();
  });

  it("失败给原因和重试，不自动重试", async () => {
    const { user } = open();
    notesDraftSuggest.mockRejectedValueOnce(new Error("模型没答上来"));
    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    expect(await screen.findByText("Error: 模型没答上来")).toBeTruthy();
    expect(notesDraftSuggest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "再试一次" })).toBeTruthy();
  });
});
