import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiTagDialog } from "@/features/library/AiTagDialog";
import { useTagRun } from "@/stores/tagRun";

const tagSuggest = vi.fn();
const tagSuggestApply = vi.fn();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    tagSuggest: (...args: unknown[]) => tagSuggest(...args),
    tagSuggestApply: (...args: unknown[]) => tagSuggestApply(...args),
  },
}));

function openWith(ids: string[]) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiTagDialog open ids={ids} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
}

function open() {
  return openWith(["book-1"]);
}

const SWITCH = "全部生成后统一审阅";

describe("AI 打标签", () => {
  beforeEach(() => {
    tagSuggest.mockReset();
    tagSuggestApply.mockReset();
    // 循环搬进了 store；单例状态必须每轮清空，否则上一轮的建议会漏进这一轮。
    useTagRun.getState().reset();
  });

  /** Opening a sheet must not spend a model call: the reader asked to look at
   *  the dialog, not to pay for a suggestion. */
  it("只在按下开始建议之后才调用模型", async () => {
    const { user } = open();

    expect(tagSuggest).not.toHaveBeenCalled();
    expect(screen.getByText(/分批策略/)).toBeTruthy();
    // The reader is about to spend somebody's tokens; the sheet says how many.
    expect(screen.getByText(/最多约 200 tokens/)).toBeTruthy();

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

  /** 「停在这里」must reach the in-flight fetch: a mounted request cannot be
   *  un-sent, but its answer must be dropped instead of popping up a review the
   *  reader just declined. A state-based `auto` never reached the callback. */
  it("停在这里会掐掉正在飞行的下一批", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const second = {
      suggestions: [{ bookId: "book-2", title: "活着", tags: ["文学"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    };
    tagSuggest
      .mockResolvedValueOnce({
        suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻"] }],
        considered: 1,
        remaining: 5,
        failedBatches: 0,
      })
      .mockImplementationOnce(() => gate.then(() => second));
    tagSuggestApply.mockResolvedValueOnce(1);
    const { user } = open();

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    await user.click(await screen.findByRole("button", { name: /应用：1 本 · 1 个标签/ }));
    await user.click(await screen.findByRole("button", { name: "停在这里" }));

    // Let the answer arrive after the stop: it has to be discarded.
    await act(async () => {
      release();
      await gate;
    });

    expect(screen.queryByText("活着")).toBeNull();
    expect(await screen.findByText(/已停在这里/)).toBeTruthy();
    expect(tagSuggestApply).toHaveBeenCalledTimes(1);
  });

  /** The switch flips the flow: nothing is written while generating, and every
   *  suggestion waits in one review list for a single confirm. */
  it("打开开关后先生成全部、不写入，出齐后统一审阅", async () => {
    tagSuggest.mockResolvedValue({
      suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    });
    tagSuggestApply.mockResolvedValueOnce(1);
    const { user } = open();

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));

    expect(await screen.findByText("三体")).toBeTruthy();
    expect(tagSuggestApply).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /应用：1 本 · 1 个标签/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /应用：1 本 · 1 个标签/ }));
    await waitFor(() =>
      expect(tagSuggestApply).toHaveBeenCalledWith([{ bookId: "book-1", tags: ["科幻"] }]),
    );
    expect(tagSuggestApply).toHaveBeenCalledTimes(1);
  });

  /** Review is real editing, not a yes/no: rename a tag, drop a tag, skip a
   *  whole book — then one write carries exactly what survived. */
  it("审阅时可改标签、删标签、跳过整本，确认后一次写入", async () => {
    tagSuggest.mockResolvedValueOnce({
      suggestions: [
        { bookId: "b1", title: "三体", tags: ["科幻", "硬科幻"] },
        { bookId: "b2", title: "活着", tags: ["文学"] },
        { bookId: "b3", title: "简史", tags: ["历史"] },
      ],
      considered: 3,
      remaining: 0,
      failedBatches: 0,
    });
    tagSuggestApply.mockResolvedValueOnce(1);
    const { user } = openWith(["b1", "b2", "b3"]);

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));
    await screen.findByText("三体");

    await user.click(screen.getByRole("button", { name: "修改标签 硬科幻" }));
    const input = screen.getByRole("textbox", { name: "编辑标签" });
    await user.clear(input);
    await user.type(input, "太空歌剧{Enter}");
    await user.click(screen.getByRole("button", { name: "文学" }));
    await user.click(screen.getByRole("button", { name: "简史" }));

    await user.click(screen.getByRole("button", { name: /应用：1 本 · 2 个标签/ }));
    await waitFor(() =>
      expect(tagSuggestApply).toHaveBeenCalledWith([{ bookId: "b1", tags: ["科幻", "太空歌剧"] }]),
    );
  });

  /** The whole point of chunking: over the backend's 60-book cap, each slice is
   *  disjoint so no book is suggested twice — and nothing is written to move
   *  the untagged cursor along. */
  it("超过单轮上限时切成不重叠的块，逐块拉取", async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `b${i}`);
    tagSuggest.mockImplementation((part: string[]) =>
      Promise.resolve({
        suggestions: part.map((id) => ({ bookId: id, title: id, tags: ["标签"] })),
        considered: part.length,
        remaining: 0,
        failedBatches: 0,
      }),
    );
    const { user } = openWith(ids);

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));

    await waitFor(() => expect(tagSuggest).toHaveBeenCalledTimes(3));
    expect(tagSuggest.mock.calls.map(([part]) => (part as string[]).length)).toEqual([60, 60, 10]);
    const all = tagSuggest.mock.calls.flatMap(([part]) => part as string[]);
    expect(new Set(all).size).toBe(130);
    expect(tagSuggestApply).not.toHaveBeenCalled();
  });

  /** The review list is paginated so 2000 glass chips don't lock the UI. Every
   *  row action must address its global index, not the page-local one. */
  it("翻页后删除/跳过作用于正确的书，不是当前页的同位置", async () => {
    const count = 55;
    const ids = Array.from({ length: count }, (_, i) => `b${i}`);
    tagSuggest.mockResolvedValue({
      suggestions: ids.map((id) => ({ bookId: id, title: id, tags: [`${id}-标签`] })),
      considered: count,
      remaining: 0,
      failedBatches: 0,
    });
    tagSuggestApply.mockResolvedValue(count - 1);
    const { user } = openWith(ids);

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));
    await screen.findByText("b0");

    // First page shows b0..b49; skip b0 so it stays out of the write.
    await user.click(screen.getByRole("button", { name: "b0" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("b50");
    // Second page: drop the tag on b50 — must change b50, not b0.
    await user.click(screen.getByRole("button", { name: "b50-标签" }));

    await user.click(screen.getByRole("button", { name: /应用：/ }));
    await waitFor(() => expect(tagSuggestApply).toHaveBeenCalledTimes(1));
    const written = tagSuggestApply.mock.calls[0]![0] as { bookId: string; tags: string[] }[];
    // b0 was skipped as a row; b50 had its only tag removed (an empty-tag row
    // is dropped too). Both stay out — and neither got confused with the other.
    expect(written.some((row) => row.bookId === "b0" || row.bookId === "b50")).toBe(false);
    expect(written).toHaveLength(count - 2);
  });

  /** Stop during generation keeps what was already paid for: the in-flight
   *  chunk lands (its tokens were spent), the loop stops at the next boundary,
   *  and every collected suggestion shows up in the review list. */
  it("生成中停止会保留已收集的建议供审阅，且不拉下一块", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const ids = Array.from({ length: 121 }, (_, i) => `b${i}`);
    // 三块（60+60+1）：第一块立即返回，第二块在飞时按停止，第二块结果要收下，
    // 第三块根本不该发出。
    tagSuggest
      .mockResolvedValueOnce({
        suggestions: [{ bookId: "b0", title: "第一本", tags: ["标签"] }],
        considered: 60,
        remaining: 61,
        failedBatches: 0,
      })
      .mockImplementationOnce(() =>
        gate.then(() => ({
          suggestions: [{ bookId: "b60", title: "第六十一本", tags: ["标签"] }],
          considered: 60,
          remaining: 1,
          failedBatches: 0,
        })),
      )
      .mockResolvedValueOnce({
        suggestions: [{ bookId: "b120", title: "第一百二十一本", tags: ["标签"] }],
        considered: 1,
        remaining: 0,
        failedBatches: 0,
      });
    const { user } = openWith(ids);

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));
    await waitFor(() => expect(tagSuggest).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "停在这里并审阅" }));
    await act(async () => {
      release();
      await gate;
    });

    expect(tagSuggest).toHaveBeenCalledTimes(2);
    // 已生成的都在审阅表里，包括飞行中那一批。
    expect(await screen.findByText("第一本")).toBeTruthy();
    expect(screen.getByText("第六十一本")).toBeTruthy();
    expect(screen.queryByText("第一百二十一本")).toBeNull();
    expect(screen.getByText(/已提前停止，下面保留的是已生成的 2 本建议/)).toBeTruthy();
    expect(tagSuggestApply).not.toHaveBeenCalled();
  });

  /** 生成中途开关要能点：关掉 = 停止攒建议，已生成的留进审阅表。 */
  it("生成中途关掉开关会停止并保留建议供审阅", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const ids = Array.from({ length: 121 }, (_, i) => `b${i}`);
    tagSuggest
      .mockResolvedValueOnce({
        suggestions: [{ bookId: "b0", title: "第一本", tags: ["标签"] }],
        considered: 60,
        remaining: 61,
        failedBatches: 0,
      })
      .mockImplementationOnce(() =>
        gate.then(() => ({
          suggestions: [{ bookId: "b60", title: "第六十一本", tags: ["标签"] }],
          considered: 60,
          remaining: 1,
          failedBatches: 0,
        })),
      );
    const { user } = openWith(ids);

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));
    await waitFor(() => expect(tagSuggest).toHaveBeenCalledTimes(2));

    // 生成中途关掉开关：此时它必须可点。
    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await act(async () => {
      release();
      await gate;
    });

    expect(useTagRun.getState().review?.cancelled).toBe(true);
    expect(tagSuggest).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("第一本")).toBeTruthy();
    expect(screen.getByText("第六十一本")).toBeTruthy();
    expect(tagSuggestApply).not.toHaveBeenCalled();
  });

  /** 逐批在飞切审阅：在飞那批的 token 已花，结果作为审阅第一批攒进去，
   *  后续块按 bookId 跳过它 —— 不丢弃、也不为同一本再请求一次。 */
  it("逐批在飞切审阅复用在飞结果，后续块不重复请求同一本", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const ids = Array.from({ length: 121 }, (_, i) => `b${i}`);
    tagSuggest
      .mockImplementationOnce(() =>
        gate.then(() => ({
          suggestions: [{ bookId: "b0", title: "逐批那本", tags: ["在飞标签"] }],
          considered: 60,
          remaining: 61,
          failedBatches: 0,
        })),
      )
      .mockImplementation((part: string[]) =>
        Promise.resolve({
          suggestions: part.map((id) => ({ bookId: id, title: id, tags: ["标签"] })),
          considered: part.length,
          remaining: 0,
          failedBatches: 0,
        }),
      );
    const { user } = openWith(ids);

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    await waitFor(() => expect(tagSuggest).toHaveBeenCalledTimes(1));

    // 生成中开关可点：点下只标记移交，不立刻建 review。
    await user.click(screen.getByRole("switch", { name: SWITCH }));
    expect(useTagRun.getState().review).toBeNull();
    expect(await screen.findByText(/正在切到统一审阅/)).toBeTruthy();

    // 放行在飞结果：它成为审阅第一批，后续块跳过 b0。
    await act(async () => {
      release();
      await gate;
    });
    await vi.waitFor(() => expect(useTagRun.getState().review?.running).toBe(false));

    expect(await screen.findByText("逐批那本")).toBeTruthy(); // 在飞那批的 title 保留（第 1 页）
    // 在飞的 b0 结果进了 store 的 rows（title 保留「逐批那本」）。b60 在第 2 页，
    // 这里查 store 而不是 DOM。
    expect(useTagRun.getState().review!.rows).toContainEqual({
      bookId: "b0",
      title: "逐批那本",
      tags: ["在飞标签"],
    });
    expect(useTagRun.getState().review!.rows.some((r) => r.bookId === "b60")).toBe(true);
    // 后续块请求里没有 b0 —— 它的 token 没被重复花。
    const rest = tagSuggest.mock.calls.slice(1).flatMap(([part]) => part as string[]);
    expect(rest).not.toContain("b0");
    expect(tagSuggestApply).not.toHaveBeenCalled();
  });

  /** 逐批在飞转后台：不重拉同一批 —— 在飞的结果先写库，store 从下一批接手。
   *  这是「不多花那一批 token」的核心：那批模型已经算过，不能为它再请求一次。 */
  it("逐批在飞转后台复用在飞结果，不重复请求那一批", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const ids = Array.from({ length: 70 }, (_, i) => `b${i}`);
    tagSuggest
      // 前台在飞的这一批（70 本里后端取的前 60 本）。
      .mockImplementationOnce(() =>
        gate.then(() => ({
          suggestions: [
            { bookId: "b0", title: "第一本", tags: ["标签"] },
            { bookId: "b1", title: "第二本", tags: ["标签"] },
          ],
          considered: 60,
          remaining: 10,
          failedBatches: 0,
        })),
      )
      // store 接手后重新问：这次只该问「剩下的」，且后端返回的 remaining=0。
      .mockImplementationOnce(() =>
        Promise.resolve({
          suggestions: [{ bookId: "b60", title: "第六十一本", tags: ["标签"] }],
          considered: 10,
          remaining: 0,
          failedBatches: 0,
        }),
      );
    tagSuggestApply.mockResolvedValue(1);
    const { user, onClose } = openWith(ids);

    await user.click(screen.getByRole("button", { name: /开始建议/ }));
    await waitFor(() => expect(tagSuggest).toHaveBeenCalledTimes(1));

    // 生成中点后台运行：先只标记移交，不立刻关窗（要等在飞结果回来接住）。
    await user.click(screen.getByRole("button", { name: "后台运行" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(tagSuggest).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/正在移交后台/)).toBeTruthy();

    // 放行在飞结果：先写库（复用那批 token），再让 store 接手下一批。
    await act(async () => {
      release();
      await gate;
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    await vi.waitFor(() => expect(useTagRun.getState().running).toBe(false));

    // 第一批的结果被原样写入，没有为它再发一次 tagSuggest。
    expect(tagSuggestApply).toHaveBeenCalledWith([
      { bookId: "b0", tags: ["标签"] },
      { bookId: "b1", tags: ["标签"] },
    ]);
    expect(tagSuggest).toHaveBeenCalledTimes(2); // 一次在飞 + 一次 store 接手
    expect(useTagRun.getState().written).toBe(1); // 只剩 store 那批的写入
  });

  /** 「后台运行」in review mode: the loop lives in the store, so closing the
   *  dialog must not stop it — the pill takes over and the rows survive. */
  it("后台运行启动审阅循环并关窗，建议仍在 store 里", async () => {
    tagSuggest.mockResolvedValue({
      suggestions: [{ bookId: "book-1", title: "三体", tags: ["科幻"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    });
    const { user, onClose } = open();

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: "后台运行" }));

    expect(onClose).toHaveBeenCalled();
    await vi.waitFor(() => expect(useTagRun.getState().review?.running).toBe(false));
    const review = useTagRun.getState().review!;
    expect(review.rows.map((r) => r.title)).toEqual(["三体"]);
    expect(tagSuggestApply).not.toHaveBeenCalled();
  });

  /** One dead chunk (e.g. all its books already had labels) must not throw away
   *  the suggestions the other chunks brought back. */
  it("一块失败不影响其余块的建议", async () => {
    const ids = Array.from({ length: 61 }, (_, i) => `b${i}`);
    tagSuggest.mockRejectedValueOnce(new Error("选中的书都已经有标签了")).mockResolvedValueOnce({
      suggestions: [{ bookId: "b60", title: "第六十一本", tags: ["标签"] }],
      considered: 1,
      remaining: 0,
      failedBatches: 0,
    });
    const { user } = openWith(ids);

    await user.click(screen.getByRole("switch", { name: SWITCH }));
    await user.click(screen.getByRole("button", { name: /生成全部建议/ }));

    expect(await screen.findByText("第六十一本")).toBeTruthy();
    expect(tagSuggest).toHaveBeenCalledTimes(2);
  });
});
