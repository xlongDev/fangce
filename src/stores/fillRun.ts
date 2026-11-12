import { create } from "zustand";

import { demoEnabled, demoProposals } from "@/lib/demo";
import { ipc } from "@/lib/ipc";
import { hasSomething, toFill } from "@/lib/metadata";
import type { Proposal } from "@/types/ipc";

/**
 * 整架补全: the loop that fills a whole shelf, one batch at a time.
 *
 * It lives in a store rather than in the dialog for the same reason the OCR run
 * does: the work outlasts the panel. A run over 950 books is minutes of
 * requests, and a component that unmounts when the reader clicks away would
 * take the run with it.
 *
 * **Why it is a loop and not one big request.** The backend asks four books at
 * a time and the whole batch is one transaction; feeding it 950 books would be
 * a single write that holds the library's only connection for the duration, and
 * one failure would roll the lot back. Forty at a time is a unit that can fail
 * without taking the rest with it.
 */
export interface FillRun {
  running: boolean;
  cancelled: boolean;
  total: number;
  /** Books the loop has finished asking about. */
  done: number;
  /** Books actually written. */
  written: number;
  /** Books the catalogue had nothing for. */
  skipped: number;
  /** Books whose lookup failed — a different thing from 「没有找到」. */
  failed: number;
  /** Why it stopped before the end, or `null` when it ran to completion. */
  stopped: string | null;
  start: (ids: string[], replaceCovers?: boolean) => void;
  cancel: () => void;
  reset: () => void;
}

/**
 * How many books one request asks about.
 *
 * Forty is also the dialog's preview cap; here it is the transaction size. The
 * number is a compromise between round trips and the time the library's single
 * connection stays locked while the batch is written.
 */
export const CHUNK = 40;

/**
 * Between batches.
 *
 * 950 books is roughly 1900 requests to a community catalogue. Going flat out
 * would finish sooner and get the reader's address throttled, which is a worse
 * outcome than a run that takes a few minutes longer.
 */
const PAUSE_MS = 500;

const idle = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  written: 0,
  skipped: 0,
  failed: 0,
  stopped: null as string | null,
};

export const useFillRun = create<FillRun>((set, get) => ({
  ...idle,
  reset: () => set(idle),
  cancel: () => set({ cancelled: true }),
  start: (ids, replaceCovers = false) => {
    // One run at a time: two loops would interleave transactions and report
    // progress that belongs to neither.
    if (get().running || ids.length === 0) return;
    set({ ...idle, running: true, total: ids.length });
    void loop(ids, replaceCovers, set, get);
  },
}));

async function loop(
  ids: string[],
  replaceCovers: boolean,
  set: (partial: Partial<FillRun>) => void,
  get: () => FillRun,
) {
  let done = 0;
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let stopped: string | null = null;

  try {
    for (let at = 0; at < ids.length; at += CHUNK) {
      // Checked between batches, not inside one: a batch is a transaction, and
      // stopping in the middle of it would leave the count lying about what was
      // written.
      if (get().cancelled) {
        stopped = "已停止";
        break;
      }
      const slice = ids.slice(at, at + CHUNK);
      // The demo build has no backend to ask; it serves canned proposals so the
      // progress panel is something a browser test can actually drive.
      const demo = demoEnabled();
      const proposals = demo
        ? demoProposals(slice)
        : // oxlint-disable-next-line no-await-in-loop -- 一批一次事务，下一批要等这批写完
          await ipc.metadataPropose(slice, replaceCovers);
      const worth = proposals.filter(hasSomething);
      const broke = proposals.filter(isFailure);

      skipped += proposals.length - worth.length - broke.length;
      failed += broke.length;
      if (worth.length > 0) {
        // oxlint-disable-next-line no-await-in-loop -- 同上：写要按批落盘，不然进度是假的。
        written += demo
          ? // Nothing to write in the demo; count it so the summary is real.
            worth.length
          : // oxlint-disable-next-line no-await-in-loop -- 同上：写要按批落盘，不然进度是假的。
            await ipc.metadataApply(worth.map(toFill));
      }
      done += slice.length;
      set({ done, written, skipped, failed });

      // Half a batch failing is not a bad match, it is a catalogue that stopped
      // answering — and the remaining two hundred books would fail the same
      // way, one twelve-second timeout at a time.
      if (broke.length * 2 >= slice.length) {
        stopped = `连续查不到，先停在这里：${broke[0]?.skipped ?? "目录没有回应"}`;
        break;
      }
      if (at + CHUNK < ids.length) {
        // oxlint-disable-next-line no-await-in-loop -- 间隔本身就是目的：别把别人的服务器当成压测目标。
        await pause(PAUSE_MS);
      }
    }
  } catch (err) {
    // A thrown error is the whole call failing — a network drop, a database
    // that would not open. The books already written stay written.
    stopped = err instanceof Error ? err.message : String(err);
  } finally {
    set({ running: false, stopped, done, written, skipped, failed });
  }
}

function isFailure(proposal: Proposal): boolean {
  return proposal.skipped?.startsWith("查询失败") ?? false;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
