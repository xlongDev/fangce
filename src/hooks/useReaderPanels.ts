import { useCallback, useEffect, useRef, useState } from "react";

import type { Panel } from "@/features/reader/ReaderChrome";

/**
 * Which side panel the reader has open, and the search drawer's query.
 *
 * Only one panel at a time, so they never stack, and the whole thing is two
 * cells of state — but it is worth a hook for `close` alone.
 *
 * Closing is only "set it to none". The search drawer leaves two things
 * behind — its query, and the match highlights painted into the pages — and
 * both are deliberately kept: they are the reader's context, and a reader who
 * closes the drawer to read the page the hits are on must not watch the ink
 * vanish with the panel. What retires the ink is a new search (each engine
 * clears before it walks), emptying the field (the page answers the query's
 * going-away), or the book itself closing. Navigating away — a chapter, a
 * bookmark, a picked hit — was always a `setPanel` close for the same reason.
 *
 * `setPanel` is exposed raw for exactly those places.
 */
export interface ReaderPanelControls {
  panel: Panel;
  setPanel: (next: Panel) => void;
  /** The chrome's panel button: the same id closes the panel it names. */
  toggle: (id: Exclude<Panel, "none">) => void;
  /** The search drawer's query. */
  search: string;
  /** What the drawer should search for next — the toolbar's 搜索 action, and
   *  picking a hit. */
  setSearch: (query: string) => void;
  /**
   * The drawer's own way out. Returns whether anything was open, so a key
   * handler can tell "I consumed this Escape" from "pass it on".
   */
  close: () => boolean;
}

export function useReaderPanels(initialQuery: string): ReaderPanelControls {
  const [panel, setPanel] = useState<Panel>("none");
  const [search, setSearch] = useState(initialQuery);
  /** What is open *now*. `close` has to keep one identity — it goes into the
   *  key handler's dependency list — so it cannot read `panel` from a closure
   *  that a re-render may have replaced. */
  const panelRef = useRef<Panel>("none");
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  const toggle = useCallback(
    (id: Exclude<Panel, "none">) => setPanel((current) => (current === id ? "none" : id)),
    [],
  );

  const close = useCallback(() => {
    if (panelRef.current === "none") return false;
    // Written synchronously as well as into state: two closes in a row (a ✕
    // and an Escape, a double-press) must not clean up twice.
    panelRef.current = "none";
    setPanel("none");
    return true;
  }, []);

  return { panel, setPanel, toggle, search, setSearch, close };
}
