import { create } from "zustand";

/**
 * The hand-off from the global import command to the shelf.
 *
 * The picker, every import mutation and the outcome summary live inside
 * `LibraryPage`, but the command palette and ⌘O are global — they can run while
 * the reader is open or the reader is in settings, with no shelf mounted.
 * A request therefore has to outlive the page that made it: `request` leaves a
 * pending flag, and whichever shelf is mounted (or mounts next) takes it.
 *
 * `take` clears the flag before returning, so exactly one shelf answers —
 * during a filter swap `AnimatePresence` can keep two copies mounted at once,
 * and opening two file dialogs would be worse than opening none.
 *
 * `shelves` is a count, not a boolean, for that same overlap: a leaving shelf
 * unmounts after the incoming one mounts, and a boolean would read zero in
 * between. The command uses it to decide whether it must navigate first —
 * bouncing a reader off `/recent` just to import would be a needless loss of
 * their place.
 */
interface ImportRequest {
  /** Bumped on every request so a mounted shelf's effect re-runs. */
  seq: number;
  /** True from a request until a shelf picks it up. */
  pending: boolean;
  /** How many LibraryPage instances are currently mounted. */
  shelves: number;
  request: () => void;
  /** Take the pending request. Only the first caller gets `true`. */
  take: () => boolean;
  shelfMounted: () => void;
  shelfUnmounted: () => void;
}

export const useImportRequest = create<ImportRequest>((set, get) => ({
  seq: 0,
  pending: false,
  shelves: 0,
  request: () => set((state) => ({ seq: state.seq + 1, pending: true })),
  take: () => {
    if (!get().pending) return false;
    set({ pending: false });
    return true;
  },
  shelfMounted: () => set((state) => ({ shelves: state.shelves + 1 })),
  shelfUnmounted: () => set((state) => ({ shelves: Math.max(0, state.shelves - 1) })),
}));
