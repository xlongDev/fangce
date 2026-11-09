import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

import { cn } from "@/lib/cn";
import { loadDoc } from "@/lib/pdf";
import { useScanPages } from "@/stores/scanPages";
import type { Annotation } from "@/types/ipc";

import {
  displaySize,
  hasRaster,
  MAX_DPR,
  pageScales,
  putRaster,
  rasterKeyOf,
  takeRaster,
} from "./pdfCanvas";
import { installNightContext } from "./pdfNightContext";
import {
  clearPageHighlights,
  clearPageSearchHits,
  clearTtsWash,
  layerOffsetAtPoint,
  paintPageHighlights,
  paintPageSearchHits,
  paintTtsWash,
  locateLayerText,
  resolveLayerSelection,
} from "./pdfTextSelection";
import type { PdfSearchMark } from "./pdfTextSelection";
import type { TextRange } from "./selection";
import { selectionBottom } from "./selection";

/** One rendered PDF page. Fixed layout is the point: fonts, spacing and
    illustrations come out exactly as the document drew them, which text
    extraction can never reproduce. */

type RenderState = "loading" | "ready" | "error";

/** Stable empty default so the paint effect's deps stay identity-safe. */
const EMPTY: Annotation[] = [];
const EMPTY_MARKS: PdfSearchMark[] = [];

/** How long a zoom must rest before the page is re-rasterised at the new
    scale. Long enough that a pinch — or a held zoom key — costs one render,
    short enough that it lands while the page is still under the eye. */
const ZOOM_SETTLE_MS = 240;

/** How long the page must sit still before the next one is rasterised behind
    the reader's back. Any resize, zoom or turn clears and restarts it, so a
    sidebar spring or a window drag costs one prefetch at the resting size
    rather than one per frame. */
const PREFETCH_SETTLE_MS = 300;

/** A cancellable pdf.js render, held by whoever started it so a newer one —
    or the reader turning the page — can call it off. */
interface TaskSlot {
  task: { cancel: () => void } | null;
}

/**
 * Draws page `pageNumber` (1-based) into a canvas, sized to fill its wrapper.
 * Re-renders when the wrapper resizes; `fit` picks between filling the width
 * (scroll layout) and the whole box (paged layouts). `zoom` rescales the page
 * in CSS straight away so a pinch stays responsive, then re-rasterises the
 * bitmap at that scale once the gesture rests: a page shown at 300% is drawn
 * at 300%, not stretched from the bitmap rasterised for the fitted size.
 *
 * `prefetchPage` is the page the reader will ask for next, rasterised once
 * this one has settled. It is the only reason a turn is instant: rasterising
 * an illustrated page costs 90–150 ms, and without it the reader sits on the
 * old page for that long. The result is a plain bitmap in a two-slot store —
 * see `pdfCanvas.ts` for what the key covers and what that costs.
 */
export function PdfPageView({
  bookId,
  pageNumber,
  prefetchPage = null,
  fit,
  zoom = 1,
  animated = false,
  nightFg,
  nightBg,
  invertImages = false,
  annotations = EMPTY,
  ttsWash = null,
  searchMarks = EMPTY_MARKS,
  searchFocusKey = null,
  searchInk = null,
  onSearchFocusConsumed,
  onSelection,
  onAnnotationClick,
}: {
  bookId: string;
  pageNumber: number;
  /** The page after this one, or null at the end of the book. */
  prefetchPage?: number | null;
  fit: "width" | "box";
  zoom?: number;
  /** Eases the CSS resize; pinch zooming passes false to stay direct. */
  animated?: boolean;
  /** Light end of the night axis, or null to render in the document's own
   *  colours. Plain strings, never an object: an object here would give the
   *  render effect a new dependency identity every render. */
  nightFg?: string | null;
  /** Dark end of the night axis. Doubles as the canvas ground colour. */
  nightBg?: string | null;
  /** Invert images too, for scanned PDFs that are one bright bitmap per page. */
  invertImages?: boolean;
  /** This page's saved annotations; painted onto the text layer. */
  annotations?: Annotation[];
  /** Read-aloud wash: the sentence being spoken plus the span inside it to
   *  paint (word-narrowed). Only the page whose chapter the voice is on
   *  receives it; `null` on every other page. */
  ttsWash?: { text: string; from: number; to: number } | null;
  /** This page's search hits, as needles to locate in the text layer. Must
   *  arrive reference-stable (the parent builds them inside a memo). */
  searchMarks?: PdfSearchMark[];
  /** The hit the reader just clicked; painting brings it into view once. */
  searchFocusKey?: string | null;
  /** The marker ink the reader picked, or `null` for the accent. */
  searchInk?: string | null;
  /** Consumes the focus request once it has been honoured. */
  onSearchFocusConsumed?: () => void;
  /** A completed text-layer selection, with its viewport rect for the pill.
   *  `bottom` is the lowest line that really carries text — see
   *  `selectionBottom` for why the rect's own bottom can be a line too low. */
  onSelection?: (range: TextRange, rect: DOMRect, bottom: number) => void;
  /** A click on text covered by an existing annotation. */
  onAnnotationClick?: (annotation: Annotation, x: number, y: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  /** Where this page's finished text layer's verdict goes. The footer's scan
      chip reads it — it lives outside the page on purpose, because a notice
      drawn over the paper covers the paper. */
  const report = useScanPages((state) => state.report);
  const [state, setState] = useState<RenderState>("loading");
  /** Fitted CSS size at zoom 1; zoom rescales it in JSX. */
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  /** The text layer exists and matches the current page render. */
  const [textReady, setTextReady] = useState(false);
  /** True while this page owns the read-aloud wash (see the paint effect). */
  const washPainted = useRef(false);
  /** The zoom the next raster is drawn at. Lags `zoom` so a pinch redraws
      once, when it rests, instead of on every frame. */
  const rasterZoomRef = useRef(zoom);
  /** This render's own entry point. A zoom re-raster goes through it rather
      than through the effect's deps: restarting the effect would clear the
      page's highlights and read-aloud wash, which belong to the page, not to
      the bitmap. */
  const schedulerRef = useRef<() => void>(() => {});
  /** Canvas signature already painted, and the scale the text layer was built
      at. A zoom change refreshes the bitmap but leaves the layer alone. */
  const paintedRef = useRef("");
  const layeredRef = useRef("");

  useEffect(() => {
    const timer = setTimeout(() => {
      if (rasterZoomRef.current === zoom) return;
      rasterZoomRef.current = zoom;
      schedulerRef.current();
    }, ZOOM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [zoom]);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    // Cancellable work owned by this run of the effect. Plain locals rather
    // than refs: nothing outside reads them, and a ref would have to be
    // re-read in the cleanup, by which point it has already moved on.
    const pageSlot: TaskSlot = { task: null };
    const prefetchSlot: TaskSlot = { task: null };
    let textTask: { cancel: () => void } | null = null;
    let prefetchTimer: number | null = null;

    const deviceDpr = () => Math.min(window.devicePixelRatio || 1, MAX_DPR);

    /** Everything this raster's pixels depend on, as one string. Built from
        the wrapper's measured box rather than the derived scale so it is
        available before `getPage` resolves — the prefetch files under the
        same key from the other side of the same render. */
    const keyFor = (page: number, wrap: HTMLDivElement, zoomToRaster: number, dpr: number) =>
      rasterKeyOf({
        bookId,
        pageNumber: page,
        fit,
        boxWidth: wrap.clientWidth,
        boxHeight: wrap.clientHeight,
        zoom: zoomToRaster,
        dpr,
        nightFg,
        nightBg,
        invertImages,
      });

    /** Paints a finished bitmap into the visible canvas and sizes the box it
        sits in. One synchronous block: the browser never paints between the
        clear and the draw, so the swap is atomic on screen. */
    const blit = (
      canvas: HTMLCanvasElement,
      bitmap: HTMLCanvasElement,
      fitted: { w: number; h: number },
      zoomToRaster: number,
      fromCache: boolean,
    ) => {
      setBase(fitted);
      // Written at the size the page is *shown* at, zoom included — the same
      // size JSX gives the canvas. React skips a style write whose value is
      // unchanged, so a fit-sized pair here would survive the re-render
      // `setBase` triggers and snap a zoomed page back to fit the moment the
      // raster landed.
      const shown = displaySize(fitted, zoomToRaster);
      canvas.style.width = `${shown.w}px`;
      canvas.style.height = `${shown.h}px`;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      // `data-pdf-raster` is how a test tells a prefetched page from a
      // rasterised one — the two are indistinguishable on screen by design,
      // which is the whole point of the prefetch. Written here rather than
      // through state so the swap stays one synchronous block.
      wrapRef.current?.setAttribute("data-pdf-raster", fromCache ? "cached" : "rendered");
    };

    /** Rasterises one page into a detached canvas. Shared by the page the
        reader is waiting on and the one fetched behind their back: a second
        copy of this geometry is exactly how a prefetched bitmap ends up
        unlike what a live render would have produced, while still matching
        the key it was filed under. */
    const rasterise = async (
      page: PDFPageProxy,
      wrap: HTMLDivElement,
      zoomToRaster: number,
      dpr: number,
      slot: TaskSlot,
    ) => {
      const unit = page.getViewport({ scale: 1 });
      const { fitScale, rasterScale } = pageScales({
        unitWidth: unit.width,
        unitHeight: unit.height,
        boxWidth: wrap.clientWidth,
        boxHeight: wrap.clientHeight,
        fit,
        zoom: zoomToRaster,
        dpr,
      });
      const viewport = page.getViewport({ scale: rasterScale });
      // The raster lands in a detached canvas, so the page already on screen
      // survives the whole render — a turn never shows an empty box while
      // pdf.js works. (readest does the same: it builds the canvas off-DOM and
      // swaps it in.)
      const bitmap = document.createElement("canvas");
      bitmap.width = Math.floor(viewport.width);
      bitmap.height = Math.floor(viewport.height);
      // The night wrapper goes on the raster's own canvas, never the visible
      // one: pdf.js v6 discards a handed-in `canvasContext` as soon as
      // `canvas` is set and calls `getContext("2d")` on that element itself,
      // so the element is the only hook that survives into the render.
      // Installing it before the context is fetched means both routes hand
      // pdf.js the wrapped one. Still per-canvas, so the shelf's cover
      // renderer in lib/pdf.ts keeps the document's real colours.
      const restore =
        nightFg && nightBg ? installNightContext(bitmap, nightFg, nightBg, invertImages) : null;
      const context = bitmap.getContext("2d");
      if (!context) {
        restore?.();
        return null;
      }
      // Whatever this slot was rendering is superseded the moment a new one
      // starts — two renders of the same page only make each other slower.
      slot.task?.cancel();
      // `background` is the paper the page is painted on; without it pdf.js
      // defaults to white and the whole page glares.
      const task = page.render({
        canvas: bitmap,
        canvasContext: context,
        viewport,
        ...(nightBg ? { background: nightBg } : {}),
      });
      slot.task = task;
      try {
        await task.promise;
      } finally {
        restore?.();
        if (slot.task === task) slot.task = null;
      }
      // The page at zoom 1. `blit` scales it by the zoom for the box it is
      // shown in — the fitted box itself never leaves this function.
      const fitted = {
        w: Math.floor(unit.width * fitScale),
        h: Math.floor(unit.height * fitScale),
      };
      return { fitScale, fitted, bitmap };
    };

    /** Rasterises the page the reader will ask for next, once this one has
        settled. It is the whole reason a turn is a blit instead of a 90–150 ms
        wait, and it costs one bitmap held in a two-slot store. */
    const schedulePrefetch = (doc: PDFDocumentProxy, wrap: HTMLDivElement) => {
      if (prefetchPage === null) return;
      if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
      prefetchTimer = window.setTimeout(() => {
        prefetchTimer = null;
        // The box is read now, not when the timer was set: whatever the reader
        // has settled on is what the turn after this one will render into.
        if (cancelled || wrap.clientWidth === 0) return;
        const zoomToRaster = rasterZoomRef.current;
        const dpr = deviceDpr();
        const key = keyFor(prefetchPage, wrap, zoomToRaster, dpr);
        if (hasRaster(key)) return;
        void (async () => {
          const page = await doc.getPage(prefetchPage);
          if (cancelled) return;
          const raster = await rasterise(page, wrap, zoomToRaster, dpr, prefetchSlot);
          if (!raster) return;
          if (cancelled) {
            raster.bitmap.width = 0;
            raster.bitmap.height = 0;
            return;
          }
          putRaster(key, { bitmap: raster.bitmap, fitted: raster.fitted });
        })().catch(() => {
          // A prefetch that fails or is superseded costs nothing; the reader
          // was never waiting on it, and the turn will render for real.
        });
      }, PREFETCH_SETTLE_MS);
    };

    const render = async () => {
      // Only the first raster of this box announces itself. Once a page is up,
      // a turn — or a zoom, or a theme flip — keeps it on screen until the new
      // bitmap is ready; announcing a load would blank the page the reader is
      // looking at, which is the flash this exists to avoid.
      const signature = `${pageNumber}|${fit}|${nightFg}|${nightBg}|${invertImages}`;
      if (paintedRef.current === "") setState("loading");
      setTextReady(false);
      // Cleared until this render lands, so the attribute always describes the
      // page currently on screen rather than the one that just left.
      wrapRef.current?.removeAttribute("data-pdf-raster");
      textTask?.cancel();
      // The reader has asked for a page. Anything still rasterising — the
      // speculative next page, or a render of the page they just left — must
      // neither share the main thread with it nor land on the canvas after it:
      // a superseded render that is left to finish would blit the page the
      // reader has already moved off.
      pageSlot.task?.cancel();
      if (prefetchTimer !== null) {
        window.clearTimeout(prefetchTimer);
        prefetchTimer = null;
      }
      prefetchSlot.task?.cancel();
      try {
        const doc = await loadDoc(bookId);
        const page = await doc.getPage(pageNumber);
        const wrap = wrapRef.current;
        const canvas = canvasRef.current;
        if (cancelled || !wrap || !canvas) return;
        if (wrap.clientWidth === 0) return;
        if (fit === "box" && wrap.clientHeight === 0) return;

        const unit = page.getViewport({ scale: 1 });
        // The bitmap spans the zoomed page, not the fitted one: the canvas is
        // displayed at `fitted × zoom`, so rasterising at `fitScale × zoom`
        // keeps one bitmap pixel per device pixel however far the reader zooms
        // in. `pageScales` is the only expression of that — the prefetch asks
        // it the same question, and the answer is what the cache key means.
        const zoomToRaster = rasterZoomRef.current;
        const dpr = deviceDpr();
        const { fitScale } = pageScales({
          unitWidth: unit.width,
          unitHeight: unit.height,
          boxWidth: wrap.clientWidth,
          boxHeight: wrap.clientHeight,
          fit,
          zoom: zoomToRaster,
          dpr,
        });

        // The page the reader is waiting on, already rasterised behind their
        // back: blit it and skip the render entirely. This is the whole point
        // of the store — on an illustrated page it turns a 90–150 ms wait into
        // a frame.
        const warm = takeRaster(keyFor(pageNumber, wrap, zoomToRaster, dpr));
        if (warm) {
          blit(canvas, warm.bitmap, warm.fitted, zoomToRaster, true);
        } else {
          const raster = await rasterise(page, wrap, zoomToRaster, dpr, pageSlot);
          if (!raster || cancelled) {
            if (raster) {
              raster.bitmap.width = 0;
              raster.bitmap.height = 0;
            }
            return;
          }
          blit(canvas, raster.bitmap, raster.fitted, zoomToRaster, false);
          // Release the scratch bitmap before the text layer builds; at 2x dpr
          // a page-sized one is ~10–25 MB.
          raster.bitmap.width = 0;
          raster.bitmap.height = 0;
        }
        paintedRef.current = signature;
        setState("ready");

        // The selectable text layer sits over the canvas at the page's CSS
        // size (no dpr: it must line up with layout pixels, and pdf.js scales
        // it internally by the real device pixel ratio). Rebuilt when the page
        // or the fitted size changes — never on a zoom, which the layer takes
        // through its CSS transform. Recorded only once it has rendered, so a
        // cancelled build is redone rather than left half-filled.
        const layer = layerRef.current;
        const layerKey = `${pageNumber}|${fitScale}`;
        if (layer && layeredRef.current !== layerKey) {
          layer.replaceChildren();
          // pdf.js v6 rewrites the layer box itself via setLayerDimensions:
          // width: calc(var(--total-scale-factor) * pageWidth …). Without the
          // variable the calc is invalid, the container collapses to 0×0 and
          // nothing on the page is selectable. The viewer defines this as the
          // viewport's CSS scale — exactly our fitted scale.
          layer.style.setProperty("--total-scale-factor", String(fitScale));
          const { TextLayer } = await import("pdfjs-dist");
          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: layer,
            viewport: page.getViewport({ scale: Math.max(fitScale, 0.01) }),
          });
          textTask = textLayer;
          await textLayer.render();
          layeredRef.current = layerKey;
          // Published only now, and stamped with the page it was built for.
          // "Not built yet" is not "empty": reading it that way put the scan
          // notice on screen for the length of every build, over page after
          // page of ordinary text. The store's key is what keeps a verdict
          // from being read against a page the reader has turned to.
          report(bookId, pageNumber, (layer.textContent?.trim() ?? "") === "");
        }
        if (!cancelled) {
          setTextReady(true);
          // Last, so the reader's own page is never behind the speculative one.
          schedulePrefetch(doc, wrap);
        }
      } catch (error) {
        // A cancelled render is bookkeeping, not a failure, and a failure in
        // the text layer must not stamp an error over a page that did raster.
        const name = (error as { name?: string }).name;
        if (
          !cancelled &&
          name !== "RenderingCancelledException" &&
          name !== "AbortException" &&
          paintedRef.current !== signature
        ) {
          setState("error");
        }
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    // A wrapper resize and a settled zoom are the same request: draw again.
    schedulerRef.current = schedule;
    void schedule();

    const observer = new ResizeObserver(schedule);
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => {
      schedulerRef.current = () => {};
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      pageSlot.task?.cancel();
      textTask?.cancel();
      if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
      prefetchSlot.task?.cancel();
      clearPageHighlights(pageNumber);
      clearPageSearchHits(pageNumber);
      if (washPainted.current) {
        clearTtsWash();
        washPainted.current = false;
      }
    };
  }, [bookId, pageNumber, prefetchPage, fit, nightFg, nightBg, invertImages, report]);

  // Paint this page's saved annotations onto its text layer whenever either
  // side changes. `annotations` must arrive reference-stable (the parent
  // groups by page inside a memo) or this repaints every render.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !textReady) return;
    if (annotations.length === 0) {
      clearPageHighlights(pageNumber);
      return;
    }
    paintPageHighlights(pageNumber, layer, annotations);
    return () => clearPageHighlights(pageNumber);
  }, [annotations, textReady, pageNumber]);

  // Read-aloud wash: anchor the spoken sentence in this page's text layer,
  // then paint the span inside it (the whole sentence, or the word the engine
  // last reported). Only the page that owns the wash may clear it — a
  // neighbour mounting with no wash must not erase the paint.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !textReady) return;
    if (!ttsWash) {
      if (washPainted.current) {
        clearTtsWash();
        washPainted.current = false;
      }
      return;
    }
    const hit = locateLayerText(layer, ttsWash.text, ttsWash.from, ttsWash.to);
    if (!hit) return;
    paintTtsWash(layer, hit.start, hit.end);
    washPainted.current = true;
  }, [ttsWash, textReady]);

  // Search-hit markers: located in the layer like the read-aloud wash, then
  // painted as one highlight union. A click's focus request is honoured here
  // exactly once and reported back — without consuming it, every zoom
  // re-render would yank the reader back to the hit.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !textReady) return;
    if (searchMarks.length === 0) {
      clearPageSearchHits(pageNumber);
      return;
    }
    const focused = paintPageSearchHits(pageNumber, layer, searchMarks, searchFocusKey, searchInk);
    if (focused) onSearchFocusConsumed?.();
    return () => clearPageSearchHits(pageNumber);
  }, [searchMarks, searchFocusKey, searchInk, textReady, pageNumber, onSearchFocusConsumed]);

  // Selection and annotation-click handling for the text layer, attached
  // imperatively for the same reason the prose mouseup is: a selection
  // surface is pointer behaviour, not a widget, and the layer stays a plain
  // semantic div.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const onMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = resolveLayerSelection(layer, selection);
      if (!range) return;
      const domRange = selection.getRangeAt(0);
      const box = domRange.getBoundingClientRect();
      onSelection?.(range, box, selectionBottom(domRange.getClientRects(), box));
    };
    const onClick = (event: MouseEvent) => {
      // A collapsed click on annotated text opens its pill; during or right
      // after a selection this must stay inert.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const offset = layerOffsetAtPoint(event.clientX, event.clientY, layer);
      if (offset === null) return;
      const hit = annotations.find(
        (annotation) => offset >= annotation.startChar && offset < annotation.endChar,
      );
      if (hit) onAnnotationClick?.(hit, event.clientX, event.clientY);
    };
    layer.addEventListener("mouseup", onMouseUp);
    layer.addEventListener("click", onClick);
    return () => {
      layer.removeEventListener("mouseup", onMouseUp);
      layer.removeEventListener("click", onClick);
    };
  }, [annotations, onSelection, onAnnotationClick]);

  // The box the page is shown in, at the reader's zoom — the same value the
  // re-raster writes, so a zoomed page can't be re-rendered back down to fit.
  const shown = base ? displaySize(base, zoom) : null;

  return (
    <div ref={wrapRef} data-pdf-page={pageNumber} className="relative h-full w-full">
      {/* Canvas and text layer share one centred box so the layer always sits
          exactly on the page, whatever the wrapper's width. The layer scales
          with `zoom` via transform: rebuilding it per pinch frame would
          thrash, and a transformed layer stays selectable and hittable. */}
      <div
        className="relative mx-auto"
        style={shown ? { width: `${shown.w}px`, height: `${shown.h}px` } : undefined}
      >
        <canvas
          ref={canvasRef}
          className={cn(
            "border-hairline block rounded-lg border",
            animated && "transition-[width,height] duration-200 ease-out",
          )}
          style={shown ? { width: `${shown.w}px`, height: `${shown.h}px` } : undefined}
        />
        <div
          data-pdf-layer=""
          ref={layerRef}
          className="pdf-text-layer absolute top-0 left-0"
          style={
            base
              ? {
                  width: `${base.w}px`,
                  height: `${base.h}px`,
                  transform: `scale(${zoom})`,
                  transformOrigin: "0 0",
                }
              : undefined
          }
        />
      </div>
      {state !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-text-3 text-sm">
            {state === "loading" ? "正在渲染页面…" : "这一页渲染失败"}
          </p>
        </div>
      )}
    </div>
  );
}
