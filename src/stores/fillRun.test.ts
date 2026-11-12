import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: { metadataPropose: vi.fn(), metadataApply: vi.fn() },
}));

import { ipc } from "@/lib/ipc";
import { CHUNK, useFillRun } from "@/stores/fillRun";
import type { Proposal } from "@/types/ipc";

const propose = vi.mocked(ipc.metadataPropose);
const apply = vi.mocked(ipc.metadataApply);

const proposal = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  bookId: id,
  bookTitle: id,
  fills: [{ field: "publisher", from: null, to: "某出版社" }],
  skipped: null,
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

/** The loop is async and touches a store; give it a turn to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useFillRun.getState().reset();
  propose.mockImplementation((asked: string[]) => Promise.resolve(asked.map((id) => proposal(id))));
  apply.mockImplementation((items: unknown[]) => Promise.resolve(items.length));
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
  });

  /** 「连已有封面一起换」 is a decision the whole run carries to every batch,
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
        new Promise<Proposal[]>((resolve) => {
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
  });

  it("refuses to start a second run on top of the first", async () => {
    useFillRun.getState().start(ids(CHUNK * 2));
    useFillRun.getState().start(ids(3));
    await vi.waitFor(() => expect(useFillRun.getState().running).toBe(false));
    // The second call was ignored: only the first run's two batches happened.
    expect(useFillRun.getState().total).toBe(CHUNK * 2);
  });
});
