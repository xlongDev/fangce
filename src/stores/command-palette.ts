import { create } from "zustand";

/** One dialog shell, two things it can hold: ⌘K's commands and ⌘F's search. */
export type PaletteMode = "command" | "search";

interface CommandPaletteState {
  open: boolean;
  mode: PaletteMode;
  /**
   * Incremented on every open transition. Used as a remount key for the palette
   * body so the query and selection reset without a state-syncing effect.
   */
  session: number;
  setOpen: (open: boolean) => void;
  /** Open a mode. Pressing the key for the mode already on screen leaves the
   *  query alone rather than wiping what the reader has typed. */
  openWith: (mode: PaletteMode) => void;
  toggle: () => void;
}

export const useCommandPalette = create<CommandPaletteState>((set) => ({
  open: false,
  mode: "command",
  session: 0,
  setOpen: (open) =>
    set((state) => (open && !state.open ? { open, session: state.session + 1 } : { open })),
  openWith: (mode) =>
    set((state) =>
      state.open && state.mode === mode ? state : { open: true, mode, session: state.session + 1 },
    ),
  toggle: () =>
    set((state) =>
      state.open ? { open: false } : { open: true, mode: "command", session: state.session + 1 },
    ),
}));
