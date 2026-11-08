import { create } from "zustand";

import { ipc, onAiStream } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";
import type { BookSummary } from "@/types/ipc";

/**
 * The batch AI-guide run, which outlives the page that started it.
 *
 * A shelf of guides is minutes of sequential requests, and nobody watches a
 * progress bar for that — they go back to reading. A loop owned by the batch
 * bar would be abandoned by the first route change, halfway through, having
 * already paid for half the queue. So the loop lives here, above every
 * component, following the pattern `ocrRun.ts` established, and the shelf only
 * starts it and reads its progress.
 *
 * Two consequences worth stating outright:
 *
 * - **停止 only takes effect between books, and that is not a shortcut.** A
 *   stream cancelled midway comes back as Ok with the text written so far, so
 *   asking the backend to stop would cache a stump as the guide. The book in
 *   flight finishes and is cached whole; the queue just ends there.
 *
 * - **Completion is announced by a toast, raised from here.** Nothing is
 *   mounted when a long run ends, so there is no component left to report it —
 *   and the reader who walked away is exactly the one who needs telling.
 */
export interface GuideBatchRun {
  /** How many books this run set out to do. */
  total: number;
  /** 1-based position of the book being worked on. */
  index: number;
  /** Title of the book in flight. */
  title: string;
  /** Guides written so far. */
  generated: number;
  /** Titles of the books whose guide failed, in run order. */
  failed: string[];
  status: "running" | "stopping" | "done";
}

interface GuideBatchState {
  /** The run in flight, or the last one that finished. `null` before any. */
  run: GuideBatchRun | null;
  /** The pill folded to a small badge; the run keeps going underneath. A new
   *  run always starts unfolded. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Generates a guide for each book, in order. Ignored while a run is live. */
  start: (books: readonly BookSummary[]) => Promise<void>;
  /** Asks the run to stop after the book in flight. */
  stop: () => void;
}

/** The stream in flight; a delta from any other request drops itself. */
let active: string | null = null;
/** Resolves the book in flight. Nulled on settle, so a late event is dropped. */
let settle: ((error: string | null) => void) | null = null;

void onAiStream((delta) => {
  if (delta.requestId !== active || !delta.done) return;
  const resolve = settle;
  settle = null;
  active = null;
  resolve?.(delta.error ?? null);
});

/**
 * One book: resolves `null` on success, the error text on failure.
 *
 * The command rejection covers failures that never start a stream; a stream
 * failure arrives as its own done+error delta. Whichever lands first nulls
 * `settle`, so the latecomer is dropped instead of counted twice.
 */
function generateOne(book: BookSummary): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const finish = (error: string | null) => {
      settle = null;
      active = null;
      resolve(error);
    };
    active = requestId;
    settle = finish;
    ipc.aiDigest(requestId, book.id, false).catch((err: unknown) => {
      if (active !== requestId) return;
      finish(String(err));
    });
  });
}

/**
 * The stop request and the run's identity, deliberately outside the store.
 *
 * The running loop reads `stopRequested` between books — a field in the store
 * would work only if the loop re-read the store, which is exactly the coupling
 * this avoids. `runToken` marks the run that owns the UI: a new `start` bumps
 * it, and an abandoned loop stops writing state, so a run that was overtaken
 * cannot resurrect the panel as "done".
 */
let stopRequested = false;
let runToken = 0;

/** What to tell the reader when a run ends. */
export function describeBatch(generated: number, failed: string[], stopped: boolean): string {
  const head = stopped ? `已停止：新增 ${generated} 份导读` : `已生成 ${generated} 份导读`;
  if (failed.length === 0) return `${head}，已缓存在本机。`;
  const named = failed.slice(0, 3).join("、");
  const more = failed.length > 3 ? ` 等 ${failed.length} 本` : "";
  return `${head}；${failed.length} 本失败（${named}${more}），可稍后重试。`;
}

export const useGuideBatch = create<GuideBatchState>()((set, get) => ({
  run: null,
  collapsed: false,
  setCollapsed: (collapsed) => set({ collapsed }),
  start: async (books) => {
    const current = get().run;
    if (current && current.status !== "done") {
      // One run at a time, and said out loud rather than silently dropped.
      showToast("error", "正在生成导读，等它结束再开始。");
      return;
    }
    const [first] = books;
    if (!first) return;

    stopRequested = false;
    const token = ++runToken;
    set({
      collapsed: false,
      run: {
        total: books.length,
        index: 1,
        title: first.title,
        generated: 0,
        failed: [],
        status: "running",
      },
    });

    let generated = 0;
    const failed: string[] = [];

    for (let index = 0; index < books.length; index++) {
      const book = books[index];
      if (!book || stopRequested || runToken !== token) break;
      set((state) =>
        state.run ? { run: { ...state.run, index: index + 1, title: book.title } } : {},
      );
      // One stream at a time is the contract: sequential is what makes
      // stop-between-books and a single request id possible.
      // oxlint-disable-next-line no-await-in-loop
      const error = await generateOne(book);
      if (error === null) generated += 1;
      else failed.push(book.title);
      set((state) => (state.run ? { run: { ...state.run, generated, failed: [...failed] } } : {}));
    }

    if (runToken !== token) return; // overtaken by a newer start
    set({
      run: {
        total: books.length,
        index: books.length,
        title: "",
        generated,
        failed,
        status: "done",
      },
    });
    showToast(
      failed.length === 0 ? "success" : "error",
      describeBatch(generated, failed, stopRequested),
    );
  },

  stop: () => {
    stopRequested = true;
    set((state) =>
      state.run?.status === "running" ? { run: { ...state.run, status: "stopping" } } : {},
    );
  },
}));
