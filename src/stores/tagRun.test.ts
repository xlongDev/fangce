import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    tagSuggest: vi.fn(),
    tagSuggestApply: vi.fn(),
  },
}));

vi.mock("@/stores/toasts", () => ({ showToast: vi.fn() }));

import { ipc } from "@/lib/ipc";
import { useTagRun } from "./tagRun";

const suggest = vi.mocked(ipc.tagSuggest);
const apply = vi.mocked(ipc.tagSuggestApply);

const ids = ["b1", "b2", "b3"];
/** One answer from the backend: `remaining` is how many books are still untagged. */
const answer = (remaining: number, n = 1) => ({
  suggestions: Array.from({ length: n }, (_, i) => ({
    bookId: `b${i}`,
    title: `书${i}`,
    tags: ["标签"],
  })),
  considered: 3 - remaining,
  remaining,
  failedBatches: 0,
});

beforeEach(() => {
  suggest.mockReset();
  apply.mockReset();
  useTagRun.getState().reset();
});

/** The loop must keep going while `remaining` says books are left, and feed the
 *  full selection every time — the backend re-picks the untagged ones itself. */
it("逐批建议并写入，直到没有剩余", async () => {
  suggest.mockResolvedValueOnce(answer(1)).mockResolvedValueOnce(answer(0));
  apply.mockResolvedValue(1);

  useTagRun.getState().start(ids);
  await vi.waitFor(() => expect(useTagRun.getState().running).toBe(false));

  expect(suggest).toHaveBeenCalledTimes(2);
  expect(suggest.mock.calls.map(([arg]) => arg)).toEqual([ids, ids]);
  expect(apply).toHaveBeenCalledTimes(2);
  const state = useTagRun.getState();
  expect(state.written).toBe(2);
  expect(state.done).toBe(3);
  expect(state.remaining).toBe(0);
  expect(state.stopped).toBeNull();
});

/** Stop is checked between batches, not mid-transaction: the in-flight batch
 *  is written so its token spend and the count agree with the library. */
it("停止在批次边界生效，已写入的保留", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  suggest.mockResolvedValueOnce(answer(2));
  apply.mockImplementationOnce(() => gate.then(() => 1));
  apply.mockResolvedValue(1);

  useTagRun.getState().start(ids);
  await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  useTagRun.getState().cancel();
  release();
  await vi.waitFor(() => expect(useTagRun.getState().running).toBe(false));

  // The batch in flight still lands; no new batch is asked after the stop.
  expect(suggest).toHaveBeenCalledTimes(1);
  expect(useTagRun.getState().written).toBe(1);
  expect(useTagRun.getState().stopped).toBe("已停止");
});

/** 「全部生成后统一审阅」：逐块拉建议、全程不写库，攒齐后 rows 留在 store
 *  等读者审。ids 切成不重叠的块，才不会把同一本书建议两遍。 */
it("审阅模式逐块攒建议、不写库", async () => {
  const many = Array.from({ length: 130 }, (_, i) => `b${i}`);
  suggest.mockImplementation((part: string[]) =>
    Promise.resolve({
      suggestions: part.map((id) => ({ bookId: id, title: id, tags: ["标签"] })),
      considered: part.length,
      remaining: 0,
      failedBatches: 0,
    }),
  );

  useTagRun.getState().startReview(many);
  await vi.waitFor(() => expect(useTagRun.getState().review?.running).toBe(false));

  expect(suggest.mock.calls.map(([arg]) => (arg as string[]).length)).toEqual([60, 60, 10]);
  const all = suggest.mock.calls.flatMap(([arg]) => arg as string[]);
  expect(new Set(all).size).toBe(130); // 块间无交集
  const review = useTagRun.getState().review!;
  expect(review.rows).toHaveLength(130);
  expect(review.done).toBe(3);
  expect(apply).not.toHaveBeenCalled();
});

/** 停止时已花的 token 不能白费：飞行中的那块结果照样收下，rows 留给读者。 */
it("审阅模式停止后保留已收集的建议", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  // 三块（60+60+1）：第二块在飞时按停止，结果要收下，第三块不该发。
  const many = Array.from({ length: 121 }, (_, i) => `b${i}`);
  suggest
    .mockResolvedValueOnce({
      suggestions: [{ bookId: "b1", title: "第一本", tags: ["标签"] }],
      considered: 1,
      remaining: 2,
      failedBatches: 0,
    })
    .mockImplementationOnce(() =>
      gate.then(() => ({
        suggestions: [{ bookId: "b2", title: "第二本", tags: ["标签"] }],
        considered: 1,
        remaining: 1,
        failedBatches: 0,
      })),
    );

  useTagRun.getState().startReview(many);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
  useTagRun.getState().cancelReview();
  // 点停止立刻结算 UI —— 不等后端那次 tagSuggest（60 本 / 3 次调用）返回。
  expect(useTagRun.getState().review!.running).toBe(false);
  expect(useTagRun.getState().review!.cancelled).toBe(true);
  release();
  await gate;
  // 飞行块的 token 已花，结果照样并进已停的 review（不重开 running）。
  await vi.waitFor(() => expect(useTagRun.getState().review!.rows).toHaveLength(2));

  const review = useTagRun.getState().review!;
  expect(review.cancelled).toBe(true);
  expect(review.running).toBe(false);
  expect(review.rows.map((r) => r.title)).toEqual(["第一本", "第二本"]);
  expect(suggest).toHaveBeenCalledTimes(2); // 第三块没发
  expect(apply).not.toHaveBeenCalled();
});

/** 前台在飞那批作为 seed 攒进审阅：后续块按 bookId 跳过，不为同一本再花 token。 */
it("审阅 seed 已在第一批的书，后续块不重复请求", async () => {
  const many = Array.from({ length: 130 }, (_, i) => `b${i}`);
  suggest.mockImplementation((part: string[]) =>
    Promise.resolve({
      suggestions: part.map((id) => ({ bookId: id, title: id, tags: ["标签"] })),
      considered: part.length,
      remaining: 0,
      failedBatches: 0,
    }),
  );
  // seed 里有跨块的两本：b0（第一块）和 b60（第二块开头）。
  useTagRun.getState().startReview(many, [
    { bookId: "b0", title: "第一本", tags: ["在飞"] },
    { bookId: "b60", title: "第六十一本", tags: ["在飞"] },
  ]);
  await vi.waitFor(() => expect(useTagRun.getState().review?.running).toBe(false));

  const requested = suggest.mock.calls.flatMap(([arg]) => arg as string[]);
  expect(requested).not.toContain("b0");
  expect(requested).not.toContain("b60");
  const review = useTagRun.getState().review!;
  expect(review.rows).toContainEqual({ bookId: "b0", title: "第一本", tags: ["在飞"] });
  expect(review.rows).toContainEqual({ bookId: "b60", title: "第六十一本", tags: ["在飞"] });
  expect(review.rows).toHaveLength(130); // seed 2 + 其余 128，无重复
  expect(apply).not.toHaveBeenCalled();
});

/** 生成中「返回界面」也要能打开对话框看进度；关窗不误清建议。 */
it("审阅界面生成中也能打开，关闭面板不丢建议", async () => {
  suggest.mockResolvedValue(answer(0));
  useTagRun.getState().startReview(ids);
  expect(useTagRun.getState().review!.running).toBe(true);
  useTagRun.getState().requestReview(); // 还在跑，胶囊的「返回界面」要能开
  expect(useTagRun.getState().reviewSheetOpen).toBe(true);
  useTagRun.getState().closeReviewSheet();
  expect(useTagRun.getState().reviewSheetOpen).toBe(false);

  await vi.waitFor(() => expect(useTagRun.getState().review?.running).toBe(false));
  expect(useTagRun.getState().review!.rows).toHaveLength(1); // 关窗不清建议
});

/** 旧循环在飞时开新一轮：旧结果回来不能灌进新任务（generation token）。 */
it("重开一轮后，旧循环的在飞结果不污染新任务", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  // 第一轮第一块卡在 gate；第二轮正常返回。
  suggest
    .mockImplementationOnce(() =>
      gate.then(() => ({
        suggestions: [{ bookId: "old", title: "旧书", tags: ["旧"] }],
        considered: 1,
        remaining: 0,
        failedBatches: 0,
      })),
    )
    .mockResolvedValue({
      suggestions: [{ bookId: "new", title: "新书", tags: ["新"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    });

  useTagRun.getState().startReview(["old"]);
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
  // 停止后 UI 立刻可再开一轮；旧轮那次 tagSuggest 还在 gate 上飞。
  useTagRun.getState().cancelReview();
  useTagRun.getState().startReview(["new"]); // 新一轮，代次 +1
  await vi.waitFor(() => expect(useTagRun.getState().review?.rows).toHaveLength(1));

  release(); // 旧轮在飞结果此刻才回来
  await gate;
  await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));

  const review = useTagRun.getState().review!;
  expect(review.rows.map((r) => r.title)).toEqual(["新书"]); // 旧书没混进来
});

/** A batch that writes nothing would re-ask the same books forever, burning
 *  tokens on every pass. Stop and hand control back. */
it("一批没有可写入的标签就停下", async () => {
  suggest.mockResolvedValue(answer(2));
  apply.mockResolvedValue(0);

  useTagRun.getState().start(ids);
  await vi.waitFor(() => expect(useTagRun.getState().running).toBe(false));

  expect(suggest).toHaveBeenCalledTimes(1);
  expect(useTagRun.getState().stopped).toMatch(/没有可写入的标签/);
});
