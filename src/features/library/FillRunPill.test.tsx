import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: { metadataPropose: vi.fn(), metadataApply: vi.fn() },
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
    // 胶囊和详情面板各有一处「正在停止…」，两处都要立刻跟上。
    expect(screen.getAllByText("正在停止…").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "停止中" })).toBeTruthy();
  });

  it("详情默认可见，折叠成小徽章后计数仍在，点徽章恢复", async () => {
    act(() => {
      useFillRun.setState({
        running: false,
        total: 2,
        done: 2,
        written: 1,
        failed: 1,
        failures: [failure],
        stopped: null,
        pending: [],
      });
    });
    show();

    expect(await screen.findByText(/失败明细/)).toBeTruthy();
    expect(screen.getByText("书本甲")).toBeTruthy();
    expect(screen.getByText("查询失败：目录没有回应")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "折叠补全进度" }));
    expect(useFillRun.getState().collapsed).toBe(true);
    // 折叠后只剩图标 + 计数，计数还在。
    expect(screen.getAllByText("2 / 2").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "展开补全进度" }));
    expect(useFillRun.getState().collapsed).toBe(false);
    expect(screen.getByRole("button", { name: "折叠补全进度" })).toBeTruthy();
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
});
