import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ShelfGroup } from "@/features/library/group";
import type { LibraryFilter } from "@/features/library/shelfQuery";
import type { KeyOverrides, Shortcut } from "@/lib/commands";
import type { LibrarySort } from "@/types/ipc";

export type ThemeMode = "system" | "light" | "dark";
export type TransparencyMode = "full" | "reduced";
export type ShelfLayout = "grid" | "list";

/**
 * How one shelf is arranged — the search, order, direction, grouping and label
 * its controls are standing on.
 *
 * One record per filter rather than one set of controls for the whole shelf:
 * the four shelves are four ways of looking at the same library, and sorting
 * 最近 by 最近阅读 should not silently re-order 书库 behind the reader.
 *
 * `descending` is the effective direction, not a flip of the order's own. The
 * backend returns each order in its own direction — 最近添加 descending, 书名
 * ascending — and the button has to say which way the list on screen actually
 * reads, so the flip is derived from it instead of stored (see `LibraryPage`).
 */
export interface ShelfView {
  search: string;
  sort: LibrarySort;
  descending: boolean;
  group: ShelfGroup;
  /** The label the 标签 shelf is narrowed to; `null` for the whole shelf. */
  tag: string | null;
}

export type ShelfViews = Record<LibraryFilter, ShelfView>;

/** The note list's own two controls: what it is narrowed to, and how. */
export interface NotesView {
  query: string;
  /** `noted` keeps only the highlights that carry a note of their own. */
  filter: "all" | "noted";
}

/**
 * Which sources the 词典 popup asks at once. The local chain — the platform
 * dictionary and the imported bundles — is one switch because one command
 * answers for both; the web sources and the AI fallback are their own.
 * 维基词典 and 维基百科 ship on (key-free and instant), Urban Dictionary off —
 * it is a network source of a very particular flavour, and readest ships its
 * network sources off too.
 */
export interface LookupSources {
  local: boolean;
  wiktionary: boolean;
  wikipedia: boolean;
  urban: boolean;
  ai: boolean;
}

interface SettingsState {
  theme: ThemeMode;
  transparency: TransparencyMode;
  sidebarCollapsed: boolean;
  sidebarHidden: boolean;
  /** Per-reader shelf density; `grid` is the cover-on-top tiles the app
   *  shipped with, `list` is a single-column row per book. */
  shelfLayout: ShelfLayout;
  /** Each shelf's arrangement, kept across a trip into the reader — which
   *  unmounts the shelf — and across a restart. */
  shelfViews: ShelfViews;
  /** The same for the notes page, which is unmounted just the same way when a
   *  highlight is followed back into its book. */
  notesView: NotesView;
  /** 词典 popup: which sources answer, at what size, and whether the term is
   *  spoken when the panel opens. */
  lookupSources: LookupSources;
  dictFontSize: number;
  dictAutoSpeak: boolean;
  /** Rebound keys, keyed by command id — the registry's commands and the
   *  reader's own table both. Empty until a reader changes one. */
  keyOverrides: KeyOverrides;
  /**
   * Catalogue fonts the reader has installed, by catalogue id.
   *
   * The bytes are adopted into the document from the CDN on demand — this
   * list is the *offer*: a font the picker may present and the reader may
   * select. Persisted here rather than in the reader store because it is an
   * app preference like the rest, and `resetAllSettings` writes the default
   * back like everything else.
   */
  downloadedFonts: string[];
  setTheme: (mode: ThemeMode) => void;
  setTransparency: (mode: TransparencyMode) => void;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  setShelfLayout: (layout: ShelfLayout) => void;
  setShelfView: (filter: LibraryFilter, patch: Partial<ShelfView>) => void;
  setNotesView: (patch: Partial<NotesView>) => void;
  setLookupSources: (patch: Partial<LookupSources>) => void;
  setDictFontSize: (size: number) => void;
  setDictAutoSpeak: (on: boolean) => void;
  /** `null` drops the override, which is what puts the default back — there is
   *  no separate "reset" value to store. */
  setKeyOverride: (id: string, keys: readonly Shortcut[] | null) => void;
  resetKeyOverrides: () => void;
  addDownloadedFont: (id: string) => void;
  removeDownloadedFont: (id: string) => void;
}

const shelfView = (sort: LibrarySort): ShelfView => ({
  search: "",
  sort,
  // Both shipping orders come back from the backend descending, so an
  // untouched shelf reads newest-first.
  descending: true,
  group: "none",
  tag: null,
});

/**
 * Every app preference at its shipping value, for the same reason the reader
 * store has one — `resetAllSettings` writes this back rather than keeping a
 * parallel list of defaults.
 */
export const DEFAULT_SETTINGS = {
  theme: "system",
  transparency: "full",
  sidebarCollapsed: false,
  sidebarHidden: false,
  shelfLayout: "grid",
  // 最近 is the shelf a reader opens to *carry on*, so its order is the one
  // that answers that: the book opened last is first. Everywhere else the
  // shelf is a library, and a library reads newest-added first.
  shelfViews: {
    all: shelfView("recentlyAdded"),
    recent: shelfView("recentlyRead"),
    favorites: shelfView("recentlyAdded"),
    tags: shelfView("recentlyAdded"),
    // The bin is read newest-deleted-first in spirit, and `recentlyAdded` is
    // the closest order the shelf has; the bin's own order is the backend's
    // (`deleted_at DESC`) until a reader picks something else.
    trash: shelfView("recentlyAdded"),
  },
  notesView: { query: "", filter: "all" },
  lookupSources: { local: true, wiktionary: true, wikipedia: true, urban: false, ai: true },
  dictFontSize: 14,
  dictAutoSpeak: false,
  keyOverrides: {},
  downloadedFonts: [],
} satisfies Partial<SettingsState>;

/**
 * Fills the keys a stored record does not have yet from the shipping default.
 *
 * `persist` merges the stored payload over the initial state **shallowly**, and
 * that is only safe for additions at the top level: a payload written before
 * `notesView` existed simply lacks the key, and the default stands. It is not
 * safe for a key added *inside* a record — the stored `shelfViews` (four
 * shelves) replaced the default (five), `shelfViews.trash` read as `undefined`,
 * and 回收站 crashed on `const { search } = view`. Top-level shape changes get
 * away with it; record-shape changes need this.
 *
 * `undefined` and `null` both fall back to the defaults, so a corrupted payload
 * is a reset rather than a crash.
 */
export function withDefaults<T extends object>(
  stored: Partial<T> | null | undefined,
  defaults: T,
): T {
  // Normalised first rather than spread behind a `?? {}` guard: spreading
  // `undefined` is already a no-op, and the lint is right that the guard is
  // noise. Naming the value keeps the "no payload at all" case readable.
  const extra: Partial<T> = stored ?? {};
  return { ...defaults, ...extra };
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setTheme: (theme) => set({ theme }),
      setTransparency: (transparency) => set({ transparency }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarHidden: (sidebarHidden) => set({ sidebarHidden }),
      setShelfLayout: (shelfLayout) => set({ shelfLayout }),
      setShelfView: (filter, patch) =>
        set((state) => ({
          shelfViews: {
            ...state.shelfViews,
            [filter]: { ...state.shelfViews[filter], ...patch },
          },
        })),
      setNotesView: (patch) => set((state) => ({ notesView: { ...state.notesView, ...patch } })),
      setLookupSources: (patch) =>
        set((state) => ({ lookupSources: { ...state.lookupSources, ...patch } })),
      setDictFontSize: (dictFontSize) =>
        set({ dictFontSize: Math.min(Math.max(Math.round(dictFontSize), 12), 20) }),
      setDictAutoSpeak: (dictAutoSpeak) => set({ dictAutoSpeak }),
      setKeyOverride: (id, keys) =>
        set((state) => {
          const next = { ...state.keyOverrides };
          if (keys === null) delete next[id];
          else next[id] = keys;
          return { keyOverrides: next };
        }),
      resetKeyOverrides: () => set({ keyOverrides: {} }),
      addDownloadedFont: (id) =>
        set((state) =>
          state.downloadedFonts.includes(id)
            ? state
            : { downloadedFonts: [...state.downloadedFonts, id] },
        ),
      removeDownloadedFont: (id) =>
        set((state) => ({ downloadedFonts: state.downloadedFonts.filter((font) => font !== id) })),
    }),
    {
      // Not bumped: the merge below keeps whatever the stored payload has and
      // fills the rest from the defaults, so a payload written before
      // `shelfViews` existed — or before 回收站 was a shelf — still opens.
      // Bumping without a `migrate` would instead throw every stored preference
      // away.
      name: "fangce.settings",
      version: 1,
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...stored,
          // One level deeper for the three records: these are the places a new
          // key gets added, and the shallow spread above would leave it missing.
          shelfViews: withDefaults(stored.shelfViews, current.shelfViews),
          notesView: withDefaults(stored.notesView, current.notesView),
          lookupSources: withDefaults(stored.lookupSources, current.lookupSources),
        };
      },
    },
  ),
);
