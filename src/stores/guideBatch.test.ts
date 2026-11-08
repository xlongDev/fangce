import { beforeEach, expect, it, vi } from "vitest";

import type { AiDelta } from "@/lib/bindings";
import type { BookSummary } from "@/types/ipc";

/** The stream handler the backend "emits" through, captured on subscribe.
 *  Lives in `vi.hoisted` because the mock factory runs before this module's
 *  own `let` bindings initialize — a plain module `let` is still in its dead
 *  zone when the store subscribes, and the assignment dies silently. */
const hook = vi.hoisted(() => ({
  stream: null as ((delta: AiDelta) => void) | null,
}));

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: {
    aiGuideStatus: vi.fn(async () => [] as string[]),
    aiDigest: vi.fn(),
  },
  onAiStream: vi.fn(async (handler: (delta: AiDelta) => void) => {
    hook.stream = handler;
    return undefined;
  }),
}));

vi.mock("@/stores/toasts", () => ({
  showToast: vi.fn(),
}));

import { ipc } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";
import { describeBatch, useGuideBatch } from "./guideBatch";

const digest = vi.mocked(ipc.aiDigest);
const toast = vi.mocked(showToast);

const book = (id: string, title: string): BookSummary => ({ id, title }) as unknown as BookSummary;

/** The done event a completed guide stream ends with. */
function done(requestId: string, error: string | null = null): AiDelta {
  return { requestId, text: null, done: true, finishReason: null, error } as AiDelta;
}

/** The state after a run, read straight off the store. */
const run = () => useGuideBatch.getState().run;

beforeEach(() => {
  digest.mockReset();
  toast.mockClear();
  useGuideBatch.setState({ run: null });
});

it("generates each book in order and finishes with a toast", async () => {
  digest.mockImplementation(async (requestId) => {
    hook.stream?.(done(requestId));
    return null;
  });

  await useGuideBatch.getState().start([book("b1", "一"), book("b2", "二")]);

  expect(digest.mock.calls.map((call) => call[1])).toEqual(["b1", "b2"]);
  expect(run()).toEqual({
    total: 2,
    index: 2,
    title: "",
    generated: 2,
    failed: [],
    status: "done",
  });
  expect(toast).toHaveBeenCalledWith("success", "已生成 2 份导读，已缓存在本机。");
});

it("drops a book whose stream failed and keeps going", async () => {
  digest.mockImplementation(async (requestId, bookId) => {
    if (bookId === "b1") throw new Error("接口不通");
    hook.stream?.(done(requestId));
    return null;
  });

  await useGuideBatch.getState().start([book("b1", "一"), book("b2", "二")]);

  expect(run()).toMatchObject({ generated: 1, failed: ["一"], status: "done" });
  expect(toast).toHaveBeenCalledWith("error", "已生成 1 份导读；1 本失败（一），可稍后重试。");
});

it("stops between books: the book in flight finishes, the rest never start", async () => {
  /** Resolves the held stream for the call at `index`. */
  const holders: Array<() => void> = [];
  digest.mockImplementation(async (requestId) => {
    await new Promise<void>((resolve) => {
      holders.push(() => {
        hook.stream?.(done(requestId));
        resolve();
      });
    });
    return null;
  });

  const finished = useGuideBatch
    .getState()
    .start([book("b1", "一"), book("b2", "二"), book("b3", "三")]);

  await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
  holders[0]?.();
  await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(2));
  expect(run()).toMatchObject({ index: 2, title: "二", status: "running" });

  useGuideBatch.getState().stop();
  expect(run()?.status).toBe("stopping");

  holders[1]?.();
  await finished;

  expect(digest.mock.calls.map((call) => call[1])).toEqual(["b1", "b2"]);
  expect(run()).toMatchObject({ generated: 2, failed: [], status: "done" });
  expect(toast).toHaveBeenCalledWith("success", "已停止：新增 2 份导读，已缓存在本机。");
});

it("refuses a second run while one is live", async () => {
  /** Releases the held book: emit its done event, then let the command return. */
  const release: { current: (() => void) | null } = { current: null };
  digest.mockImplementation(async (requestId) => {
    await new Promise<void>((resolve) => {
      release.current = () => {
        hook.stream?.(done(requestId));
        resolve();
      };
    });
    return null;
  });

  const first = useGuideBatch.getState().start([book("b1", "一")]);
  await vi.waitFor(() => expect(run()?.status).toBe("running"));

  await useGuideBatch.getState().start([book("b2", "二")]);
  expect(digest).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith("error", "正在生成导读，等它结束再开始。");

  release.current?.();
  await first;

  expect(run()).toMatchObject({ generated: 1, failed: [], status: "done" });
});

it("folding is presentation only: the run goes on, a new run unfolds", async () => {
  /** Releases the held book: emit its done event, then let the command return. */
  const release: { current: (() => void) | null } = { current: null };
  digest.mockImplementation(async (requestId) => {
    await new Promise<void>((resolve) => {
      release.current = () => {
        hook.stream?.(done(requestId));
        resolve();
      };
    });
    return null;
  });

  const first = useGuideBatch.getState().start([book("b1", "一")]);
  await vi.waitFor(() => expect(run()?.status).toBe("running"));

  useGuideBatch.getState().setCollapsed(true);
  expect(useGuideBatch.getState().collapsed).toBe(true);

  // The book finishes under the fold; the badge rides until the run ends.
  release.current?.();
  await first;
  expect(run()?.status).toBe("done");

  // A new run opens the pill again.
  digest.mockImplementation(async (requestId) => {
    hook.stream?.(done(requestId));
    return null;
  });
  await useGuideBatch.getState().start([book("b2", "二")]);
  expect(useGuideBatch.getState().collapsed).toBe(false);
});

it("describes the three endings differently", () => {
  expect(describeBatch(3, [], false)).toBe("已生成 3 份导读，已缓存在本机。");
  expect(describeBatch(2, [], true)).toBe("已停止：新增 2 份导读，已缓存在本机。");
  expect(describeBatch(1, ["一", "二", "三", "四"], false)).toBe(
    "已生成 1 份导读；4 本失败（一、二、三 等 4 本），可稍后重试。",
  );
});
