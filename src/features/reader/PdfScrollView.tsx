import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { loadPageAspect } from "@/lib/pdf";
import type { Annotation } from "@/types/ipc";

import { PdfPageView } from "./PdfPageView";
import type { PdfSearchMark } from "./pdfTextSelection";
import type { TextRange } from "./selection";

/** Assumed page height/width ratio until page 1 has been measured (A4-ish). */
const FALLBACK_ASPECT = 297 / 210;

/**
 * Continuous vertical PDF scroll: every page is a fixed-height slot sized
 * from the page aspect, and canvases render only near the viewport — one
 * IntersectionObserver windows them, so a 400-page book stays light and the
 * scroller's total height is known up front (which keeps the reader's
 * fraction-based resume working without any special casing).
 */
export function PdfScrollView({
  bookId,
  numPages,
  margin,
  blockMargin,
  zoom = 1,
  animated = false,
  nightFg,
  nightBg,
  invertImages,
  annotationsByPage,
  ttsPage,
  ttsWash,
  searchMarksByPage,
  searchFocusKey,
  searchInk,
  onSearchFocusConsumed,
  onSelection,
  onAnnotationClick,
  onLayout,
}: {
  bookId: string;
  numPages: number;
  margin: number;
  blockMargin: number;
  /** CSS zoom over the fitted page; slots scale with it so page↔offset math holds. */
  zoom?: number;
  /** Eases the slot resize to match the button-driven zoom glide. */
  animated?: boolean;
  /** Night axis, forwarded to every page; null renders the document's own colours. */
  nightFg?: string | null;
  nightBg?: string | null;
  invertImages?: boolean;
  /** Saved annotations grouped by 0-based page. */
  annotationsByPage?: Map<number, Annotation[]>;
  /** The 0-based page the read-aloud voice is on, and its wash (sentence
   *  text plus the span to paint). Only that page receives it. */
  ttsPage?: number | null;
  ttsWash?: { text: string; from: number; to: number } | null;
  /** Search hits grouped by 0-based page (see `PdfPageView.searchMarks`). */
  searchMarksByPage?: Map<number, PdfSearchMark[]>;
  searchFocusKey?: string | null;
  searchInk?: string | null;
  onSearchFocusConsumed?: () => void;
  /** A completed text-layer selection on some page; `bottom` is the lowest
   *  line that carries text (see `selectionBottom`). */
  onSelection?: (range: TextRange, rect: DOMRect, pageNumber: number, bottom: number) => void;
  /** A click on annotated text on some page. */
  onAnnotationClick?: (annotation: Annotation, x: number, y: number, pageNumber: number) => void;
  /** Reports the rendered slot height so the reader can map pages to scroll offsets. */
  onLayout: (slotHeight: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(FALLBACK_ASPECT);
  const [slotH, setSlotH] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    let alive = true;
    void loadPageAspect(bookId).then((ratio) => {
      if (alive) setAspect(ratio);
    });
    return () => {
      alive = false;
    };
  }, [bookId]);

  // Slot height tracks the measured content width (padding included in
  // clientWidth, so subtract the inline margins).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const width = root.clientWidth - margin * 2;
      setSlotH(width > 0 ? Math.round(width * aspect * zoom) : 0);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [aspect, margin, zoom]);

  useEffect(() => {
    onLayout(slotH);
  }, [onLayout, slotH]);

  // The observer sees through the scroller's clipping, so the default window
  // root is enough; the margin pre-renders roughly one viewport ahead.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || slotH === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) {
              if (!next.has(page)) {
                next.add(page);
                changed = true;
              }
            } else if (next.has(page)) {
              next.delete(page);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { rootMargin: "100% 0px" },
    );
    for (const slot of root.querySelectorAll<HTMLElement>("[data-page]")) io.observe(slot);
    return () => io.disconnect();
  }, [slotH]);

  return (
    <div
      ref={rootRef}
      className="mx-auto w-full"
      style={{ paddingInline: margin, paddingBlock: blockMargin }}
    >
      {slotH > 0 &&
        Array.from({ length: numPages }, (_, index) => (
          <div
            key={index}
            data-page={index}
            className={cn(animated && "transition-[height] duration-200 ease-out")}
            style={{ height: slotH }}
          >
            {visible.has(index) && (
              <PdfPageView
                bookId={bookId}
                pageNumber={index + 1}
                fit="width"
                zoom={zoom}
                animated={animated}
                nightFg={nightFg}
                nightBg={nightBg}
                invertImages={invertImages}
                annotations={annotationsByPage?.get(index)}
                ttsWash={ttsPage === index ? ttsWash : null}
                searchMarks={searchMarksByPage?.get(index)}
                searchFocusKey={searchFocusKey}
                searchInk={searchInk}
                onSearchFocusConsumed={onSearchFocusConsumed}
                onSelection={(range, rect, bottom) => onSelection?.(range, rect, index + 1, bottom)}
                onAnnotationClick={(annotation, x, y) =>
                  onAnnotationClick?.(annotation, x, y, index + 1)
                }
              />
            )}
          </div>
        ))}
    </div>
  );
}
