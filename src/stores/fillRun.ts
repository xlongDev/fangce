import { create } from "zustand";

import { demoEnabled, demoProposals } from "@/lib/demo";
import { ipc } from "@/lib/ipc";
import { hasSomething, toFill } from "@/lib/metadata";
import { showToast } from "@/stores/toasts";
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
  /** The failed proposals themselves, so the summary can name the books and
   *  quote the catalogue's reason instead of only showing a count. */
  failures: Proposal[];
  /** Books waiting out a catalogue cooldown, to be asked again in a later
   *  batch. Not failures: they have no answer yet. */
  deferred: number;
  /** The wait a catalogue asked for after the last batch, in milliseconds. */
  cooldownMs: number;
  /** Books left unanswered when the run paused or finished, so the reader can
   *  send just those again instead of reselecting the whole shelf. */
  pending: string[];
  /** The cover decision this run was started with; a retry must not change it. */
  replaceCovers: boolean;
  /** Ask only the books still pending, with the same cover decision. */
  retryPending: () => void;
  /** Why it stopped before the end, or `null` when it ran to completion. */
  stopped: string | null;
  /** 胶囊横向折叠成小徽章；纯展示态，循环照跑。 */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** 通知条上的「返回界面」：完整补全界面挂在书架的 ShelfBatchBar 上。 */
  sheetOpen: boolean;
  openSheet: () => void;
  closeSheet: () => void;
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
/// ponytail: two retries, then the book becomes a failure. Enough to ride out
/// a short cooldown without turning a blocked IP into an infinite loop.
const MAX_TRIES = 2;

/**
 * Wakes the between-batch wait when 停止 is pressed.
 *
 * A cooldown can be twenty seconds; polling it once a second made the button
 * look dead for up to a second and kept a timer alive for the whole wait. One
 * resolver, replaced by each new wait, is both immediate and cheaper.
 */
let wakePause: (() => void) | null = null;

const idle = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  written: 0,
  skipped: 0,
  failed: 0,
  failures: [] as Proposal[],
  deferred: 0,
  cooldownMs: 0,
  pending: [] as string[],
  replaceCovers: false,
  stopped: null as string | null,
  collapsed: false,
  sheetOpen: false,
};

export const useFillRun = create<FillRun>((set, get) => ({
  ...idle,
  reset: () => {
    wakePause?.();
    set(idle);
  },
  setCollapsed: (collapsed) => set({ collapsed }),
  openSheet: () => set({ sheetOpen: true }),
  closeSheet: () => set({ sheetOpen: false }),
  cancel: () => {
    set({ cancelled: true });
    // Shown by every surface reading the store: the press is acknowledged now,
    // even though the batch in flight has to finish before the loop can exit.
    wakePause?.();
  },
  start: (ids, replaceCovers = false) => {
    // One run at a time: two loops would interleave transactions and report
    // progress that belongs to neither. Say so rather than dropping the click.
    if (get().running) {
      showToast("error", "正在补全元信息，等这轮结束再开始。");
      return;
    }
    if (ids.length === 0) return;
    set({ ...idle, running: true, total: ids.length, replaceCovers });
    void loop(ids, replaceCovers, set, get);
  },
  retryPending: () => {
    const { pending, replaceCovers, running } = get();
    if (running) {
      showToast("error", "正在补全元信息，等这轮结束再重试。");
      return;
    }
    if (pending.length === 0) return;
    set({ ...idle, running: true, total: pending.length, replaceCovers });
    void loop(pending, replaceCovers, set, get);
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
  const failures: Proposal[] = [];
  let deferred = 0;
  let cooldownMs = 0;
  let stopped: string | null = null;
  let at = 0;

  // A mutable queue, not a fixed index: a book the catalogue asked us to wait
  // on goes to the back instead of being lost to a 「失败」 it does not deserve.
  const queue = [...ids];
  const tries = new Map<string, number>();
  const heldIds = new Set<string>();
  let throttledBatches = 0;

  try {
    for (; at < queue.length;) {
      // Checked between batches, not inside one: a batch is a transaction, and
      // stopping in the middle of it would leave the count lying about what was
      // written.
      if (get().cancelled) {
        stopped = "已停止";
        break;
      }
      const slice = queue.slice(at, at + CHUNK);
      at += slice.length;
      // The demo build has no backend to ask; it serves canned proposals so the
      // progress panel is something a browser test can actually drive.
      const demo = demoEnabled();
      const proposals = demo
        ? demoProposals(slice)
        : // oxlint-disable-next-line no-await-in-loop -- 一批一次事务，下一批要等这批写完
          await ipc.metadataPropose(slice, replaceCovers);
      const worth = proposals.filter(hasSomething);
      const broke = proposals.filter(isFailure);
      const held = proposals.filter(isThrottled);

      skipped += proposals.length - worth.length - broke.length - held.length;

      // A book held in an earlier batch and answered here is done with; only
      // the ones still waiting belong in the retry list.
      for (const proposal of proposals) {
        if (!isThrottled(proposal)) heldIds.delete(proposal.bookId);
      }
      for (const proposal of held) {
        heldIds.add(proposal.bookId);
        const next = (tries.get(proposal.bookId) ?? 0) + 1;
        // Two asks is enough. After that leave the book pending rather than
        // calling it a failure: being rate-limited is not the book's fault.
        if (next < MAX_TRIES) {
          tries.set(proposal.bookId, next);
          queue.push(proposal.bookId);
        }
      }

      if (worth.length > 0) {
        // oxlint-disable-next-line no-await-in-loop -- 同上：写要按批落盘，不然进度是假的。
        written += demo
          ? // Nothing to write in the demo; count it so the summary is real.
            worth.length
          : // oxlint-disable-next-line no-await-in-loop -- 同上：写要按批落盘，不然进度是假的。
            await ipc.metadataApply(worth.map(toFill));
      }
      failed += broke.length;
      failures.push(...broke);
      // Every throttled book is still unanswered, including one that has used
      // up its two asks. Counting either as done would pass 100% and hide it.
      done += slice.length - held.length;
      deferred = queue.slice(at).filter((id) => tries.has(id)).length;
      cooldownMs = held.reduce((longest, p) => Math.max(longest, p.throttledForMs ?? 0), 0);
      set({ done, written, skipped, failed, failures, deferred, cooldownMs });

      // Two consecutive batches that are mostly 「wait」 mean the provider is
      // refusing this machine, not that these books are hard to find. Stop
      // before the loop works through the rest of the shelf and turns a
      // temporary block into 2388 unanswered books.
      throttledBatches = held.length * 2 >= slice.length ? throttledBatches + 1 : 0;
      if (throttledBatches >= 2) {
        // The backend already put the source, status and suggested wait in the
        // per-book reason. Quote it rather than making the reader guess.
        const reason = held[0]?.skipped?.replace(/^查询失败：/, "") ?? "平台没有给出原因";
        stopped = `平台限流，已暂停后续查询：${reason}`;
        break;
      }
      // Half a batch failing is not a bad match, it is a catalogue that stopped
      // answering — and the remaining two hundred books would fail the same
      // way, one twelve-second timeout at a time. A short retry batch is not a
      // signal: one book left can be one book failing.
      if (slice.length >= CHUNK / 2 && broke.length * 2 >= slice.length) {
        stopped = `连续查询失败，已自动停止：${broke[0]?.skipped ?? "目录没有回应"}`;
        break;
      }
      if (at < queue.length) {
        // oxlint-disable-next-line no-await-in-loop -- 间隔本身就是目的：别把别人的服务器当成压测目标。
        await cancellablePause(Math.max(PAUSE_MS, cooldownMs), get);
        cooldownMs = 0;
        set({ cooldownMs });
      }
    }
  } catch (err) {
    // A thrown error is the whole call failing — a network drop, a database
    // that would not open. The books already written stay written.
    stopped = err instanceof Error ? err.message : String(err);
  } finally {
    wakePause = null;
    // A stop on the last batch reaches here without the loop-head check. Say
    // so: a run that was cancelled but reads 「补全完成」 is indistinguishable
    // from one that was not stopped at all.
    if (stopped === null && get().cancelled) stopped = "已停止";
    // Whatever was not answered — the rest of the first pass and every book
    // held by a cooldown — stays available as one retry, not a reselection.
    const pending = [...new Set([...queue.slice(at), ...heldIds])];
    if (stopped) deferred = 0;
    set({
      running: false,
      stopped,
      done,
      written,
      skipped,
      failed,
      failures,
      deferred,
      cooldownMs,
      pending,
    });
  }
}

function isThrottled(proposal: Proposal): boolean {
  return (proposal.throttledForMs ?? 0) > 0;
}

function isFailure(proposal: Proposal): boolean {
  return !isThrottled(proposal) && (proposal.skipped?.startsWith("查询失败") ?? false);
}

/** A cooldown can be twenty seconds; 「停止」 still has to work during it. */
function cancellablePause(ms: number, get: () => FillRun): Promise<void> {
  if (get().cancelled || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wakePause = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakePause = finish;
  });
}
