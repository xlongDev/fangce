import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: { tagSuggest: vi.fn(), tagSuggestApply: vi.fn() },
}));
vi.mock("@/stores/toasts", () => ({ showToast: vi.fn() }));
const navigateTo = vi.fn();
vi.mock("@/features/command/registerCoreCommands", () => ({
  navigateTo: (to: string) => navigateTo(to),
}));

import { TagRunPill } from "@/features/library/TagRunPill";
import { useTagRun } from "@/stores/tagRun";

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TagRunPill />
    </QueryClientProvider>,
  );
}

function reviewState(overrides: Record<string, unknown> = {}) {
  useTagRun.setState({
    review: {
      ids: ["b1"],
      rows: [],
      done: 0,
      total: 40,
      failed: 0,
      error: null,
      running: true,
      cancelled: false,
      ...overrides,
    },
  });
}

beforeEach(() => {
  useTagRun.getState().reset();
  navigateTo.mockClear();
});

describe("批量打标签的常驻胶囊", () => {
  it("生成中能返回界面，也能停止", async () => {
    act(() => reviewState());
    show();

    expect(screen.getByText("生成建议中")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "返回界面" }));
    expect(useTagRun.getState().reviewSheetOpen).toBe(true);
    // 对话框只挂书架页：必须先回书架再开窗，否则按钮点了没反应。
    expect(navigateTo).toHaveBeenCalledWith("/");

    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(useTagRun.getState().review!.cancelled).toBe(true);
    expect(useTagRun.getState().review!.running).toBe(false);
  });

  it("折叠成纯图标徽章，hover 弹出计数，点它展开", async () => {
    act(() => reviewState({ done: 1 }));
    show();

    await userEvent.click(screen.getByRole("button", { name: "折叠打标签进度" }));
    expect(useTagRun.getState().collapsed).toBe(true);
    // 与补全徽章一致：默认只剩图标，指针进来才把计数横向弹出。
    const badge = screen.getByRole("button", { name: "展开打标签进度" });
    const count = document.querySelector<HTMLElement>("[data-tag-run-count]");
    await userEvent.unhover(badge);
    expect(count?.style.gridTemplateColumns).toBe("0fr");
    await userEvent.hover(badge);
    expect(count?.style.gridTemplateColumns).toBe("1fr");
    expect(screen.getByText("1/40 批")).toBeTruthy();

    // 折叠的徽章本身是按钮，点它展开。
    await userEvent.click(screen.getByRole("button", { name: "展开打标签进度" }));
    expect(useTagRun.getState().collapsed).toBe(false);
    expect(screen.getByRole("button", { name: "返回界面" })).toBeTruthy();
  });
});
