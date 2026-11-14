import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiTagDialog } from "@/features/library/AiTagDialog";

const tagSuggest = vi.fn();
const tagSuggestApply = vi.fn();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    tagSuggest: (...args: unknown[]) => tagSuggest(...args),
    tagSuggestApply: (...args: unknown[]) => tagSuggestApply(...args),
  },
}));

function open() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiTagDialog open ids={["book-1"]} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
}

describe("AI 打标签", () => {
  beforeEach(() => {
    tagSuggest.mockReset();
    tagSuggestApply.mockReset();
  });

  /** Opening a sheet must not spend a model call: the reader asked to look at
   *  the dialog, not to pay for a suggestion. */
  it("只在按下开始建议之后才调用模型", async () => {
    const { user } = open();

    expect(tagSuggest).not.toHaveBeenCalled();
    expect(screen.getByText(/一次最多 60 本/)).toBeTruthy();
    // The reader is about to spend somebody's tokens; the sheet says how many.
    expect(screen.getByText(/合计最多约 200 tokens/)).toBeTruthy();

    tagSuggest.mockResolvedValueOnce({
      suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻", "中国文学"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    });
    await user.click(screen.getByRole("button", { name: /开始建议/ }));

    expect(tagSuggest).toHaveBeenCalledWith(["book-1"]);
    expect(await screen.findByText("三体")).toBeTruthy();
    expect(screen.getByRole("button", { name: /应用：1 本 · 2 个标签/ })).toBeTruthy();
  });

  /** Clicking a chip takes that word out of what will be written — the whole
   *  point of a preview. */
  it("点掉一个标签就不写它", async () => {
    tagSuggest.mockResolvedValueOnce({
      suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻", "中国文学"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    });
    tagSuggestApply.mockResolvedValueOnce(1);
    const { user } = open();

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    await user.click(await screen.findByRole("button", { name: "中国文学" }));
    await user.click(screen.getByRole("button", { name: /应用：1 本 · 1 个标签/ }));

    await waitFor(() =>
      expect(tagSuggestApply).toHaveBeenCalledWith([{ bookId: "book-1", tags: ["科幻"] }]),
    );
    expect(await screen.findByText(/已给 1 本加上标签/)).toBeTruthy();
  });

  /** More books than one run carries: after an apply the next batch is
   *  fetched on its own — but nothing is written until the reader presses
   *  apply again. */
  it("应用后自动看下一批，不用再点一次", async () => {
    tagSuggest
      .mockResolvedValueOnce({
        suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻"] }],
        considered: 1,
        remaining: 5,
        failedBatches: 0,
      })
      .mockResolvedValueOnce({
        suggestions: [{ bookId: "book-1", title: "活着", tags: ["文学"] }],
        considered: 1,
        remaining: 0,
        failedBatches: 0,
      });
    tagSuggestApply.mockResolvedValueOnce(1);
    const { user } = open();

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    await user.click(await screen.findByRole("button", { name: /应用：1 本 · 1 个标签/ }));

    // Second call, no second click on 开始建议.
    expect(await screen.findByText("活着")).toBeTruthy();
    expect(tagSuggest).toHaveBeenCalledTimes(2);
    // And the second batch is waiting for a decision, not written.
    expect(screen.getByRole("button", { name: /应用：1 本 · 1 个标签/ })).toBeTruthy();
    expect(tagSuggestApply).toHaveBeenCalledTimes(1);
  });

  /** A batch where the reader unticked everything (or the model tagged nothing)
   *  writes no labels — and must not keep re-asking the same books forever. */
  it("一批什么都没写就停下，交回「继续」", async () => {
    tagSuggest.mockResolvedValueOnce({
      suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻"] }],
      considered: 1,
      remaining: 5,
      failedBatches: 0,
    });
    tagSuggestApply.mockResolvedValueOnce(0);
    const { user } = open();

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    await user.click(await screen.findByRole("button", { name: /应用：1 本 · 1 个标签/ }));

    expect(await screen.findByRole("button", { name: /继续下一批（还剩 5 本）/ })).toBeTruthy();
    expect(tagSuggest).toHaveBeenCalledTimes(1);
  });

  /** A model that answered rag instead of JSON comes back as an error, and the
   *  sheet says so rather than showing an empty shelf. */
  it("失败时说清原因并给一次重试", async () => {
    tagSuggest.mockRejectedValueOnce(new Error("模型没有按书单的格式回答"));
    const { user } = open();

    await user.click(screen.getByRole("button", { name: /开始建议/ }));

    expect(await screen.findByText(/模型没有按书单的格式回答/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "再试一次" })).toBeTruthy();
  });
});
