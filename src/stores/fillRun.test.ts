import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    metadataPropose: vi.fn(),
    metadataApply: vi.fn(),
    metadataProposeTitles: vi.fn(),
    metadataApplyTitles: vi.fn(),
  },
}));

import { ipc } from "@/lib/ipc";
import { CHUNK, useFillRun } from "@/stores/fillRun";
import type { Candidate_Serialize, Proposal_Serialize, TitleProposal_Serialize } from "@/types/ipc";

const propose = vi.mocked(ipc.metadataPropose);
const apply = vi.mocked(ipc.metadataApply);
const proposeTitles = vi.mocked(ipc.metadataProposeTitles);
const applyTitles = vi.mocked(ipc.metadataApplyTitles);

const titleProposal = (id: string): TitleProposal_Serialize => {
  const candidate: Candidate_Serialize = {
    source: "neodb",
    title: `${id}（目录名）`,
    subtitle: null,
    authors: [],
    publisher: null,
    publishedYear: null,
    description: null,
    rating: null,
    ratingCount: null,
    doubanUrl: null,
    language: null,
    isbn: null,
    coverUrl: null,
    matchScore: 0.9,
  };
  return {
    bookId: id,
    bookTitle: id,
    candidates: [candidate],
    confident: true,
    skipped: null,
  };
};

const proposal = (id: string, over: Partial<Proposal_Serialize> = {}): Proposal_Serialize => ({
  bookId: id,
  bookTitle: id,
  fills: [{ field: "publisher", from: null, to: "某出版社" }],
  skipped: null,
  throttledForMs: null,
  matchScore: 0.95,
  rating: null,
  ratingCount: null,
  ratingSource: null,
  doubanUrl: null,
  coverUrl: null,
  coverReplaces: false,
  existing: [],
  ...over,
});

const ids = (count: number) => Array.from({ length: count }, (_, i) => `b${i}`);

const throttledProposal = (id: string): Proposal_Serialize =>
  proposal(id, {
    fills: [],
    skipped: "查询失败：豆瓣 返回 403，建议 20 秒后重试",
    throttledForMs: 10,
  });

/** The loop is async and touches a store; give it a turn to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useFillRun.getState().reset();
  propose.mockImplementation((asked: string[]) => Promise.resolve(asked.map((id) => proposal(id))));
  apply.mockImplementation((items: unknown[]) => Promise.resolve(items.length));
  proposeTitles.mockImplementation((asked: string[]) =>
    Promise.resolve(asked.map((id) => titleProposal(id))),
  );
  applyTitles.mockImplementation((items: unknown[]) => Promise.resolve(items.length));
});

describe("the whole-shelf run", () => {
  it("asks in batches and counts what it wrote", async () => {
    useFillRun.getState().start(ids(CHUNK + 1));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[0]![0]).toHaveLength(CHUNK);
    expect(propose.mock.calls[1]![0]).toHaveLength(1);
    // A run that never opened the switch must not touch existing covers.
    expect(propose.mock.calls[0]![1]).toBe(false);
    const state = useFillRun.getState();
    expect(state.done).toBe(CHUNK + 1);
    expect(state.written).toBe(CHUNK + 1);
    expect(state.stopped).toBeNull();
    // A run started without 后台运行 has no shell pill to show.
    expect(state.background).toBe(false);
  });

  /** The rename switch is carried to every batch, like the cover switch. */
  it("carries the rename decision to every batch", async () => {
    useFillRun.getState().start(ids(CHUNK + 1), false, true);
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(proposeTitles).toHaveBeenCalledTimes(2);
    expect(proposeTitles.mock.calls[0]![0]).toHaveLength(CHUNK);
    expect(proposeTitles.mock.calls[1]![0]).toHaveLength(1);
    expect(applyTitles).toHaveBeenCalledTimes(2);
    expect(useFillRun.getState().renamed).toBe(CHUNK + 1);
  });

  /** A run started from a preview must not silently swap the title the
   *  reader picked for the catalogue's first answer. */
  it("keeps preview-picked titles and only asks about the rest", async () => {
    const picked = [{ id: "b0", title: "读者选的书名" }];
    useFillRun.getState().start(ids(2), false, true, picked);
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(proposeTitles).toHaveBeenCalledTimes(1);
    expect(proposeTitles.mock.calls[0]![0]).toEqual(["b1"]);
    expect(applyTitles).toHaveBeenCalledWith([
      { id: "b0", title: "读者选的书名" },
      { id: "b1", title: "b1（目录名）" },
    ]);
  });

  /** 替换已有封面 is a decision the whole run carries to every batch,
   *  not something one dialog re-decides per chunk. */
  it("carries the cover-replacement answer to every batch", async () => {
    useFillRun.getState().start(ids(CHUNK + 1), true);
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[0]![1]).toBe(true);
    expect(propose.mock.calls[1]![1]).toBe(true);
  });

  it("counts a book the catalogue had nothing for as skipped, not written", async () => {
    propose.mockImplementation((asked: string[]) =>
      Promise.resolve(
        asked.map((id, index) =>
          index === 0 ? proposal(id, { fills: [], skipped: "没有找到相近的书" }) : proposal(id),
        ),
      ),
    );
    useFillRun.getState().start(ids(3));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(useFillRun.getState().written).toBe(2);
    expect(useFillRun.getState().skipped).toBe(1);
    // The skipped one is never sent to the write.
    expect(apply.mock.calls[0]![0]).toHaveLength(2);
  });

  // Stopping has to be honoured between batches: a batch is a transaction, and
  // abandoning it halfway would make the counts lie about what was written.
  it("stops after the batch in flight", async () => {
    // The first batch is held open, so the cancel lands while it is in flight.
    const gate: { release?: () => void } = {};
    propose.mockImplementationOnce(
      (asked: string[]) =>
        new Promise<Proposal_Serialize[]>((resolve) => {
          gate.release = () => resolve(asked.map((id) => proposal(id)));
        }),
    );
    useFillRun.getState().start(ids(CHUNK * 2));
    await settle();
    useFillRun.getState().cancel();
    gate.release?.();
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    const state = useFillRun.getState();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(state.stopped).toBe("已停止");
    expect(state.done).toBe(CHUNK);
  });

  // A catalogue that stopped answering is not a book without metadata: half a
  // batch failing means the remaining hundreds would fail the same way, one
  // twelve-second timeout at a time.
  it("stops when half a batch fails to answer", async () => {
    propose.mockImplementation((asked: string[]) =>
      Promise.resolve(
        asked.map((id, index) =>
          index < asked.length / 2
            ? proposal(id, {
                fills: [],
                skipped: "查询失败：豆瓣：豆瓣返回了 403，过一会儿再试",
              })
            : proposal(id),
        ),
      ),
    );
    useFillRun.getState().start(ids(CHUNK * 3));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    const state = useFillRun.getState();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(state.stopped).toContain("403");
    expect(state.failed).toBeGreaterThan(0);
    // The count is useless without the books: keep each failure's title and
    // the catalogue's own reason so the dialog can list them.
    expect(state.failures).toHaveLength(state.failed);
    expect(state.failures[0]).toMatchObject({
      bookId: "b0",
      bookTitle: "b0",
      skipped: expect.stringContaining("403"),
    });
  });

  it("retries a throttled book in a later batch instead of failing it", async () => {
    propose.mockImplementationOnce((asked: string[]) =>
      Promise.resolve(
        asked.map((id, index) =>
          index === 0
            ? proposal(id, {
                fills: [],
                skipped: "查询失败：豆瓣 返回 403，建议 20 秒后重试",
                throttledForMs: 10,
              })
            : proposal(id),
        ),
      ),
    );
    useFillRun.getState().start(ids(CHUNK + 1));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(propose).toHaveBeenCalledTimes(2);
    // The held book is asked again, not written off with the failures.
    expect(propose.mock.calls[1]![0]).toEqual(["b40", "b0"]);
    const state = useFillRun.getState();
    expect(state.failed).toBe(0);
    expect(state.deferred).toBe(0);
    expect(state.written).toBe(CHUNK + 1);
    expect(state.done).toBe(CHUNK + 1);
    expect(state.stopped).toBeNull();
  });

  // Two mostly-throttled batches mean the provider rejected this machine, not
  // that four thousand books are hard to match. Stop before the loop works
  // through the rest of the shelf and keeps poking a server that said no.
  it("pauses the whole run after two throttled batches", async () => {
    propose.mockImplementation((asked: string[]) => Promise.resolve(asked.map(throttledProposal)));
    useFillRun.getState().start(ids(CHUNK * 3));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(propose).toHaveBeenCalledTimes(2);
    const state = useFillRun.getState();
    expect(state.stopped).toContain("平台限流");
    // The message names the source, the status and the suggested wait.
    expect(state.stopped).toContain("豆瓣 返回 403，建议 20 秒后重试");
    expect(state.failed).toBe(0);
    expect(state.done).toBe(0);
    // The asked books and the unasked remainder are all still available.
    expect(state.pending).toHaveLength(CHUNK * 3);
  });

  // A blocked address must not turn into an infinite loop, but being blocked
  // is not a failed lookup either: after two asks the book stays pending.
  it("keeps a twice-throttled book pending instead of failing it", async () => {
    let calls = 0;
    propose.mockImplementation((asked: string[]) => {
      calls += 1;
      return Promise.resolve(
        asked.map((id) => (id === "b0" && calls <= 2 ? throttledProposal(id) : proposal(id))),
      );
    });
    useFillRun.getState().start(ids(CHUNK + 1), true);
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    const state = useFillRun.getState();
    expect(state.failed).toBe(0);
    expect(state.pending).toEqual(["b0"]);
    expect(state.done).toBe(CHUNK);
    expect(state.stopped).toBeNull();

    // The retry asks only that book and remembers the cover decision.
    useFillRun.getState().retryPending();
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));
    expect(propose.mock.calls[2]![0]).toEqual(["b0"]);
    expect(propose.mock.calls[2]![1]).toBe(true);
    const retried = useFillRun.getState();
    expect(retried.pending).toEqual([]);
    // The retry is its own run; the earlier batch's counts are not carried.
    expect(retried.written).toBe(1);
  });

  it("reports a stop pressed during the last batch as stopped", async () => {
    // The loop-head check has already passed when the press lands; without
    // the finally check this reads as a completed run.
    const gate: { release?: () => void } = {};
    propose.mockImplementationOnce(
      (asked: string[]) =>
        new Promise<Proposal_Serialize[]>((resolve) => {
          gate.release = () => resolve(asked.map((id) => proposal(id)));
        }),
    );
    useFillRun.getState().start(ids(3));
    await settle();
    useFillRun.getState().cancel();
    gate.release?.();
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));

    expect(useFillRun.getState().stopped).toBe("已停止");
  });

  it("refuses to start a second run on top of the first", async () => {
    useFillRun.getState().start(ids(CHUNK * 2));
    useFillRun.getState().start(ids(3));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));
    // The second call was ignored: only the first run's two batches happened.
    expect(useFillRun.getState().total).toBe(CHUNK * 2);
  });
});
