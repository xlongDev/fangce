import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { usePdfReading, type PdfReadingOptions } from "@/features/reader/usePdfReading";
import type { PendingSelection } from "@/features/reader/selection";
import type { LayoutMode } from "@/features/reader/theme";
import type { ChapterMeta } from "@/types/ipc";

/**
 * A PDF's pages *are* its chapters, so the reader's (chapter, fraction)
 * position has to be re-expressed as a page index for every save, jump and
 * reload. That translation is what this hook keeps, and three of its promises
 * fail silently: a slot height of 0 puts the book back on its first page with
 * nothing on screen to say so, a suppress notice consumed twice re-applies
 * fraction 0 over a jump that already landed, and a turn at either end that
 * animates the page it never leaves. A spread turns one page at a time, like a
 * book: the outer page crosses to the inner side of the next spread.
 */

const CHAPTERS: ChapterMeta[] = [
  { idx: 0, title: "第 1 页", chars: 10 },
  { idx: 1, title: "第 2 页", chars: 10 },
  { idx: 2, title: "第 3 页", chars: 10 },
  { idx: 3, title: "第 4 页", chars: 10 },
];

/** One scroller whose content is four uniform 500px page slots. */
function scroller() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true });
  Object.defineProperty(el, "clientHeight", { value: 800 });
  return el;
}

function layout(mode: LayoutMode) {
  return { current: mode };
}

function options(over: Partial<PdfReadingOptions> = {}): PdfReadingOptions {
  return {
    bookId: "b1",
    isPdf: true,
    paged: true,
    scrollRef: createRef<HTMLDivElement>(),
    viewportRef: createRef<HTMLDivElement>(),
    layoutModeRef: layout("single"),
    marginRef: { current: 20 },
    fractionRef: { current: 0 },
    setPending: () => {},
    ...over,
  };
}

/** The outline query needs a client; the hook never awaits it here. */
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

const renderReading = (over: Partial<PdfReadingOptions> = {}) =>
  renderHook(() => usePdfReading(options(over)), { wrapper });

describe("usePdfReading", () => {
  it("parks a page jump's fraction on the page's share of the book", () => {
    const fractionRef = { current: 0 };
    const { result } = renderReading({ fractionRef });

    result.current.claimPage(2, CHAPTERS.length);
    // Three of four pages: the last one owns the tail, so 2/3 of the book.
    expect(fractionRef.current).toBeCloseTo(2 / 3);
  });

  it("drops the scroller onto the jump's own slot, and says so exactly once", () => {
    const el = scroller();
    const scrollRef = { current: el };
    const { result } = renderReading({ scrollRef, layoutModeRef: layout("scroll") });

    // The slot heights only exist once PdfScrollView has reported them.
    result.current.onLayout(500);
    result.current.claimPage(2, CHAPTERS.length);
    expect(el.scrollTop).toBe(1000);

    // One notice, consumed: the chapter load that follows must not land
    // fraction 0 over a jump that already scrolled, and the notice must not
    // fire twice for the same jump.
    expect(result.current.takeSuppressed()).toBe(true);
    expect(result.current.takeSuppressed()).toBe(false);
  });

  it("follows the slot under the top edge when the scroller moves", () => {
    const el = scroller();
    const scrollRef = { current: el };
    const { result } = renderReading({ scrollRef });
    result.current.onLayout(500);

    expect(result.current.scrolledPage).toBeNull();
    // The label is state, so the scroll handler's update is what a real
    // scroll event does: applied before the next paint reads it back.
    act(() => {
      el.scrollTop = 1100;
      result.current.trackScrolledPage(el, CHAPTERS.length);
    });
    expect(result.current.scrolledPage).toBe(3);
  });

  it("reopens on the saved page's slot, or on its share of the book", () => {
    const el = scroller();
    const { result } = renderReading({ scrollRef: { current: el }, marginRef: { current: 20 } });

    // Without slots yet, the saved page index becomes a whole-book fraction.
    result.current.restoreScrollSlot(el, 1, CHAPTERS);
    expect(result.current.scrolledPage).toBeNull();

    result.current.onLayout(500);
    el.scrollTop = 0;
    result.current.restoreScrollSlot(el, 2, CHAPTERS);
    expect(el.scrollTop).toBe(1000);
  });

  it("turns one page at a time in both the single and spread layouts", () => {
    const goTo = vi.fn();
    const single = renderReading({ layoutModeRef: layout("single") }).result.current;
    single.turn({
      dir: 1,
      scrub: false,
      chapterIdx: 1,
      chapterCount: CHAPTERS.length,
      revert: () => {},
      goTo,
      pageTransition: "none",
      reduce: null,
    });
    expect(goTo).toHaveBeenCalledWith(2);

    const spread = renderReading({ layoutModeRef: layout("double") }).result.current;
    spread.turn({
      dir: -1,
      scrub: false,
      chapterIdx: 3,
      chapterCount: CHAPTERS.length,
      revert: () => {},
      goTo,
      pageTransition: "none",
      reduce: null,
    });
    // A spread turns its outer page, not both halves: page 4's left neighbour
    // becomes page 3's right neighbour, so the turn lands on page 3.
    expect(goTo).toHaveBeenLastCalledWith(2);
  });

  it("refuses a turn past either end without animating the page it stays on", () => {
    const goTo = vi.fn();
    const single = renderReading({ layoutModeRef: layout("single") }).result.current;
    for (const [dir, chapterIdx] of [
      [1, CHAPTERS.length - 1],
      [-1, 0],
    ] as const) {
      expect(
        single.turn({
          dir,
          scrub: false,
          chapterIdx,
          chapterCount: CHAPTERS.length,
          revert: () => {},
          goTo,
          pageTransition: "pan",
          reduce: null,
        }),
      ).toBeNull();
    }
    expect(goTo).not.toHaveBeenCalled();

    // The spread steps one page too: its last page has no next page to arrive
    // at, even though the screen still shows a pair.
    const spread = renderReading({ layoutModeRef: layout("double") }).result.current;
    expect(
      spread.turn({
        dir: 1,
        scrub: false,
        chapterIdx: CHAPTERS.length - 1,
        chapterCount: CHAPTERS.length,
        revert: () => {},
        goTo,
        pageTransition: "pan",
        reduce: null,
      }),
    ).toBeNull();
    expect(goTo).not.toHaveBeenCalled();
  });

  it("opens the pill on a PDF text-layer selection, page-local", () => {
    const setPending = vi.fn();
    const { result } = renderReading({ setPending });

    result.current.onSelection(
      { start: 4, end: 9, text: "一句" },
      new DOMRect(10, 20, 30, 12),
      3,
      32,
    );
    expect(setPending).toHaveBeenCalledWith({
      range: { start: 4, end: 9, text: "一句" },
      x: 25,
      y: 20,
      bottom: 32,
      chapterIdx: 2,
    } satisfies PendingSelection);
  });
});
