import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { PdfOutlineItem } from "@/lib/pdf";
import { usePdfOutline } from "@/hooks/useReader";
import type { Annotation, ChapterMeta } from "@/types/ipc";
import { applyPosition } from "@/features/reader/paging";
import type { CurlTurn } from "@/features/reader/pdfCurl";
import { cancelPdfTurn, snapshotPdfTurn } from "@/features/reader/pdfTurn";
import { globalProgress } from "@/features/reader/progress";
import { relayRulerLayout } from "@/features/reader/rulerPointer";
import type { PendingSelection, TextRange } from "@/features/reader/selection";
import type { LayoutMode, PageTransition } from "@/features/reader/theme";
import { usePdfZoom } from "@/features/reader/usePdfZoom";

/**
 * Everything the PDF path keeps for itself.
 *
 * A PDF is the one branch whose pages *are* its chapters, so it needs
 * bookkeeping the other two renderers have no concept of: which uniform scroll
 * slot the scroller is over, where a page jump left the position, the pinch
 * zoom, and the turn's own snapshot of the page pdf.js is about to redraw. All
 * of that lives here; the page keeps the handful of calls a turn, a jump and a
 * scroll make into it, and the JSX it draws the view with.
 *
 * The refs (`scrollRef`, `layoutModeRef`, …) are handed in rather than owned:
 * they describe the reader's one scroller and viewport, which every renderer
 * shares.
 */
export interface PdfReadingOptions {
  bookId: string;
  isPdf: boolean;
  /** Continuous scroll vs paged single/double spread — the reader's own. */
  paged: boolean;
  /** The one scroller; a zoomed PDF pans inside it, a scroll-layout one flows. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The reading viewport a turn snapshot is laid over. */
  viewportRef: RefObject<HTMLDivElement | null>;
  layoutModeRef: RefObject<LayoutMode>;
  marginRef: RefObject<number>;
  fractionRef: RefObject<number>;
  /** The pill's sink: a PDF selection opens the same toolbar prose opens. */
  setPending: (pending: PendingSelection | null) => void;
}

export interface PdfReading {
  /** Pinch zoom factor; 1 is the fitted page. */
  zoom: number;
  /** Whether the last zoom change was animated (a pinch, not a step). */
  animated: boolean;
  /** One zoom notch. */
  step: (next: number) => void;
  /** The PDF's own bookmark outline, for the TOC panel. */
  outline: PdfOutlineItem[];
  /** The scrolled page the scroll layout's indicator follows. */
  scrolledPage: number | null;
  /**
   * A page jump's PDF half: park the fraction on the page index and, in the
   * scroll layout, drop the scroller onto that page's uniform slot.
   */
  claimPage: (page: number, chapterCount: number) => void;
  /**
   * Whether a page jump already positioned the scroller. Consumes the notice:
   * the chapter load that follows must not land fraction 0 over it.
   */
  takeSuppressed: () => boolean;
  /** The scroll handler's PDF half: follow the slot under the top edge. */
  trackScrolledPage: (el: HTMLDivElement, chapterCount: number) => void;
  /**
   * The pending position's PDF half, for the scroll layout only: a saved PDF
   * position is a page index, and the slots carry it directly.
   */
  restoreScrollSlot: (el: HTMLDivElement, chapterIdx: number, chapters: ChapterMeta[]) => void;
  /** PDF text-layer selection: same pill, page-local offsets. */
  onSelection: (range: TextRange, rect: DOMRect, pageNumber: number, bottom: number) => void;
  /** Click on annotated text in the PDF: opens the pill in remove mode. */
  onAnnotationClick: (annotation: Annotation, x: number, y: number, pageNumber: number) => void;
  /** The scroll view's slot height, which maps pages to scroll offsets. */
  onLayout: (slotHeight: number) => void;
  /** The PDF half of one page turn; see `flip` for the shared preamble. */
  turn: (options: {
    dir: 1 | -1;
    /** Leave the turn open for the wheel gesture to drive. */
    scrub: boolean;
    /** The page the turn starts from (its chapter index). */
    chapterIdx: number;
    /** Total pages — a turn past either end has nowhere to arrive. */
    chapterCount: number;
    /** Puts the reader back where the turn began, while the sheet still covers. */
    revert: () => void;
    goTo: (idx: number) => void;
    pageTransition: PageTransition;
    reduce: boolean | null;
  }) => CurlTurn | null;
}

/**
 * Stand-in for a PDF's bookmark outline before (or without) the query. A fresh
 * `[]` per render would re-seed the TOC panel's fold state on every re-render,
 * collapsing whatever the reader had opened.
 */
const EMPTY_OUTLINE: PdfOutlineItem[] = [];

export function usePdfReading({
  bookId,
  isPdf,
  paged,
  scrollRef,
  viewportRef,
  layoutModeRef,
  marginRef,
  fractionRef,
  setPending,
}: PdfReadingOptions): PdfReading {
  // Scroll-layout PDF bookkeeping: the slot height reported by PdfScrollView
  // maps pages to scroll offsets, the label follows the scrolled page, and the
  // suppress flag stops a page-jump's chapter load from re-applying position 0.
  const pdfSlotH = useRef(0);
  const suppressPdfPending = useRef(false);
  const [pdfScrollPage, setPdfScrollPage] = useState<number | null>(null);
  const { zoom, animated, step: stepZoom } = usePdfZoom(scrollRef, isPdf);
  const outlineQuery = usePdfOutline(bookId, isPdf);
  const outline = outlineQuery.data ?? EMPTY_OUTLINE;

  // The scrolled-page label only means something in the scroll layout; reset
  // it when the layout flips (render-time adjust, the ImageLightbox pattern).
  const [prevPaged, setPrevPaged] = useState(paged);
  if (prevPaged !== paged) {
    setPrevPaged(paged);
    setPdfScrollPage(null);
  }

  const handlePdfLayout = useCallback(
    (slotHeight: number) => {
      pdfSlotH.current = slotHeight;
      // The scroll view mounts lazily (Suspense), after the layout-switch
      // effect has already run on an empty scroller; once the slots have real
      // heights, re-anchor the fraction so entering scroll mode keeps the page.
      if (slotHeight > 0 && layoutModeRef.current === "scroll") {
        const el = scrollRef.current;
        if (el) applyPosition(el, fractionRef.current, "scroll", marginRef.current);
      }
      // The PDF's text layer arrives with the pages, not with the chapter: tell
      // the ruler the geometry changed, or its first placement measures whatever
      // fragments happened to be painted when it asked.
      relayRulerLayout(viewportRef.current);
    },
    [layoutModeRef, marginRef, scrollRef, fractionRef, viewportRef],
  );

  /** PDF text-layer selection: same pill, page-local offsets. */
  const onPdfSelection = useCallback(
    (range: TextRange, rect: DOMRect, pageNumber: number, bottom: number) => {
      setPending({
        range,
        x: rect.left + rect.width / 2,
        y: rect.top,
        bottom,
        chapterIdx: pageNumber - 1,
      });
    },
    [setPending],
  );

  /** Click on annotated text in the PDF: opens the pill in remove mode. */
  const onPdfAnnotationClick = useCallback(
    (annotation: Annotation, x: number, y: number, pageNumber: number) => {
      setPending({
        range: { start: annotation.startChar, end: annotation.endChar, text: annotation.text },
        x,
        y,
        annotationId: annotation.id,
        chapterIdx: pageNumber - 1,
      });
    },
    [setPending],
  );

  const claimPage = useCallback(
    (page: number, chapterCount: number) => {
      // A paged PDF has no scrollable overflow, so its fraction rides on the
      // page index; a later mode switch re-anchors on the same page.
      fractionRef.current = chapterCount > 1 ? page / (chapterCount - 1) : 0;
      if (layoutModeRef.current === "scroll" && pdfSlotH.current > 0) {
        const el = scrollRef.current;
        if (el) {
          // Position is set directly on the uniform slots; the upcoming
          // chapter load must not re-apply fraction 0 over it.
          suppressPdfPending.current = true;
          el.scrollTop = page * pdfSlotH.current;
        }
      }
    },
    [fractionRef, layoutModeRef, scrollRef],
  );

  const takeSuppressed = useCallback(() => {
    if (!suppressPdfPending.current) return false;
    suppressPdfPending.current = false;
    return true;
  }, []);

  const trackScrolledPage = useCallback((el: HTMLDivElement, chapterCount: number) => {
    const slot = pdfSlotH.current;
    if (slot <= 0) return;
    const page = Math.min(chapterCount, Math.floor(el.scrollTop / slot) + 1);
    setPdfScrollPage((prev) => (prev === page ? prev : page));
  }, []);

  const restoreScrollSlot = useCallback(
    (el: HTMLDivElement, chapterIdx: number, chapters: ChapterMeta[]) => {
      // A PDF's scroll layout is a stack of uniform page slots, and the saved
      // position is a *page index*: the chapter fraction inside a page is
      // always zero, so the fraction that lands on the page is the page's own
      // share of the book. Without this the book reopens at its first page.
      if (pdfSlotH.current > 0) {
        el.scrollTop = chapterIdx * pdfSlotH.current;
        return;
      }
      applyPosition(el, globalProgress(chapters, chapterIdx, 0), "scroll", marginRef.current);
    },
    [marginRef],
  );

  const turn = useCallback<PdfReading["turn"]>(
    ({ dir, scrub, chapterIdx, chapterCount, revert, goTo, pageTransition, reduce }) => {
      // One page per turn in both layouts. A spread shows two pages, but it
      // turns like a book: the outer page crosses the spine and becomes the
      // next spread's inner page. Stepping two used to shove both halves at
      // once, which read as two sheets sliding past each other rather than a
      // page being turned (see `pdfTurn.ts` for the travel and the outer page).
      //
      // The page being left has to be copied out before the step: it lives in
      // the canvas pdf.js is about to redraw, so once the number changes there
      // is nothing left to animate. The copy rides over the incoming page
      // until the turn is done. Scroll layout skips it — there the step is a
      // scroll through a continuous strip.
      const step = 1;
      // `goTo` clamps the index, so a turn past the last page (or before the
      // first) would leave the reader showing the same page — but only *after*
      // the snapshot had already played a full turn over it. Refuse at the
      // edge, before there is anything to animate. This is the check the
      // shared `flip` preamble skips for PDF.
      if (chapterIdx + dir * step < 0 || chapterIdx + dir * step >= chapterCount) return null;
      const sheet =
        layoutModeRef.current !== "scroll"
          ? snapshotPdfTurn(viewportRef.current, dir, pageTransition, reduce)
          : null;
      goTo(chapterIdx + dir * step);
      if (!sheet) return null;
      // Held open for a gesture. Letting go without committing puts the page
      // back: `chapterIdx` is where this turn started, and the revert runs
      // while the sheet still covers the page, so the reader never watches it
      // re-render.
      if (!scrub) {
        sheet.finish(true);
        return null;
      }
      return {
        set: sheet.set,
        finish: (commit: boolean) => sheet.finish(commit, revert),
      };
    },
    [layoutModeRef, viewportRef],
  );

  // A sheet is pinned in pixels to the page boxes measured at turn start. A
  // pane resize in the middle of a turn — the sidebar spring, or the width pin
  // releasing after it — moves those boxes underneath the sheet, so the sheet
  // ends up covering only part of the new page and exposes a strip of another
  // one. Watch both widths: the viewport changes as soon as the sidebar moves,
  // the pinned content when the pin releases. Either way the page has already
  // landed, so dropping the decoration is all the recovery a resize needs.
  useEffect(() => {
    if (!isPdf || !paged) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const content = viewport.querySelector<HTMLElement>("[data-reading-content]");
    const widths = () =>
      `${Math.round(viewport.clientWidth)}:${content ? Math.round(content.clientWidth) : 0}`;
    let last = widths();
    const observer = new ResizeObserver(() => {
      const now = widths();
      if (now === last) return;
      last = now;
      cancelPdfTurn(viewport);
    });
    observer.observe(viewport);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [isPdf, paged, viewportRef]);

  return {
    zoom,
    animated,
    step: stepZoom,
    onSelection: onPdfSelection,
    onAnnotationClick: onPdfAnnotationClick,
    onLayout: handlePdfLayout,
    outline,
    scrolledPage: pdfScrollPage,
    claimPage,
    takeSuppressed,
    trackScrolledPage,
    restoreScrollSlot,
    turn,
  };
}
