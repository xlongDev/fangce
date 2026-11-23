import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: { metadataPropose: vi.fn(), metadataApply: vi.fn() },
}));
const navigateTo = vi.fn();
vi.mock("@/features/command/registerCoreCommands", () => ({
  navigateTo: (to: string) => navigateTo(to),
}));

import { FillRunPill } from "@/features/library/FillRunPill";
import { useFillRun } from "@/stores/fillRun";
import { useToasts } from "@/stores/toasts";
import type { Proposal_Serialize } from "@/types/ipc";

const failure: Proposal_Serialize = {
  bookId: "b1",
  bookTitle: "书本甲",
  fills: [],
  skipped: "查询失败：目录没有回应",
  throttledForMs: null,
  matchScore: 0,
  rating: null,
  ratingCount: null,
  ratingSource: null,
  doubanUrl: null,
  coverUrl: null,
  coverReplaces: false,
  existing: [],
};

function show(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <FillRunPill />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  useFillRun.getState().reset();
  useToasts.setState({ toasts: [] });
  navigateTo.mockClear();
});

describe("整架补全的常驻胶囊", () => {
  it("弹窗关掉后仍显示进度，停止仍可用", async () => {
    act(() => {
      useFillRun.setState({ running: true, total: 10, done: 4, written: 3, skipped: 1 });
    });
    show();

    expect(screen.getByText("补全中")).toBeTruthy();
    expect(screen.getAllByText("4 / 10").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(useFillRun.getState().cancelled).toBe(true);
  });

  it("按下停止立刻显示停止中，不等当前批次结束", async () => {
    act(() => {
      useFillRun.setState({
        running: true,
        total: 10,
        done: 4,
        cancelled: false,
        stopped: null,
      });
    });
    show();

    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(screen.getByText("正在停止…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止中" })).toBeTruthy();
  });

  it("横向折叠成小徽章后计数仍在，点徽章恢复；底部没有详情", async () => {
    act(() => {
      useFillRun.setState({
        running: false,
        total: 2,
        done: 2,
        written: 1,
        skipped: 1,
        failed: 1,
        failures: [failure],
        stopped: null,
        pending: [],
      });
    });
    show();

    const surface = document.querySelector("[data-fill-run-surface]");
    expect(surface?.textContent).toContain("补全完成");
    expect(surface?.textContent).toContain("2 / 2");
    expect(screen.getByRole("button", { name: "返回界面" })).toBeTruthy();
    // 进度明细与失败清单只在弹窗里，不在这条通知条上再画一遍。
    expect(surface?.textContent).not.toContain("已补全");
    expect(surface?.textContent).not.toContain("失败明细");
    // 折叠只是横向收起，详情面板不回来。
    await userEvent.click(screen.getByRole("button", { name: "折叠补全进度" }));
    expect(useFillRun.getState().collapsed).toBe(true);
    expect(screen.getAllByText("2 / 2").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-fill-run-surface]")?.textContent).not.toContain(
      "失败明细",
    );

    // 折叠态默认只剩图标；指针进来才把计数横向弹出，离开又收回去。
    const badge = screen.getByRole("button", { name: "展开补全进度" });
    const count = document.querySelector<HTMLElement>("[data-fill-run-count]");
    await userEvent.unhover(badge);
    expect(count?.style.gridTemplateColumns).toBe("0fr");
    await userEvent.hover(badge);
    expect(count?.style.gridTemplateColumns).toBe("1fr");
    await userEvent.unhover(badge);
    expect(count?.style.gridTemplateColumns).toBe("0fr");

    await userEvent.click(screen.getByRole("button", { name: "展开补全进度" }));
    expect(useFillRun.getState().collapsed).toBe(false);
    expect(screen.getByRole("button", { name: "折叠补全进度" })).toBeTruthy();
  });

  it("返回界面先回书架，再打开完整补全界面", async () => {
    act(() => {
      useFillRun.setState({ running: true, total: 10, done: 4 });
    });
    show();

    await userEvent.click(screen.getByRole("button", { name: "返回界面" }));
    expect(navigateTo).toHaveBeenCalledWith("/");
    expect(useFillRun.getState().sheetOpen).toBe(true);
  });

  it("结束时刷新书架并报一次结果", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    act(() => {
      useFillRun.setState({ running: true, total: 2, done: 0 });
    });
    show(client);

    await act(async () => {
      useFillRun.setState({
        running: false,
        total: 2,
        done: 2,
        written: 2,
        skipped: 0,
        stopped: null,
        pending: [],
      });
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["books"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["operations"] });
    expect(useToasts.getState().toasts.map((toast) => toast.message)).toContain(
      "整架补全完成：已补全 2 本，跳过 0 本。",
    );
  });

  it("只有一只玻璃面，不再叠成两条通知条", () => {
    act(() => {
      useFillRun.setState({ running: true, total: 10, done: 4, written: 3, skipped: 1 });
    });
    show();

    const surfaces = document.querySelectorAll("[data-fill-run-surface]");
    expect(surfaces.length).toBe(1);
    const text = surfaces[0]?.textContent ?? "";
    expect(text).toContain("补全中");
    expect(text).toContain("4 / 10");
    expect(text).not.toContain("已补全 3 本");
  });
});
