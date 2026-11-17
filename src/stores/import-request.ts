import { create } from "zustand";

/**
 * The hand-off from the global import command to the shelf.
 *
 * The picker, every import mutation and the outcome summary live inside
 * `LibraryPage`, but the command palette and ⌘O are global — they can run while
 * the reader is open or the reader is in settings, with no shelf showing.
 * A request therefore has to outlive the page that made it: `request` leaves a
 * pending flag, and whichever shelf is mounted (or mounts next) takes it.
 *
 * `take` clears the flag before returning, so exactly one shelf answers —
 * during a filter swap `AnimatePresence` can keep two copies mounted at once,
 * and opening two file dialogs would be worse than opening none.
 *
 * `route` is the pathname the shell is *showing*, written on every navigation.
 * A shelf on its way out is still mounted for the length of the page swap, so
 * counting mounted shelves cannot tell the command whether anyone can answer:
 * ⌘O from 设置 used to hand the request to the departing shelf and leave the
 * reader looking at settings with no picker they could see. The command now
 * checks the route instead of an overlap-sensitive mount count.
 */
interface ImportRequest {
  /** Bumped on every request so a mounted shelf's effect re-runs. */
  seq: number;
  /** True from a request until a shelf picks it up. */
  pending: boolean;
  /** Pathname currently on screen, so a global command knows where it is. */
  route: string;
  /** Written by the shell's navigation bridge, before the new page is painted. */
  setRoute: (route: string) => void;
  request: () => void;
  /** Take the pending request. Only the first caller gets `true`. */
  take: () => boolean;
}

export const useImportRequest = create<ImportRequest>((set, get) => ({
  seq: 0,
  pending: false,
  route: "/",
  setRoute: (route) => set({ route }),
  request: () => set((state) => ({ seq: state.seq + 1, pending: true })),
  take: () => {
    if (!get().pending) return false;
    set({ pending: false });
    return true;
  },
}));
