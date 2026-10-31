import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";
import {
  RULER_LAYOUT_EVENT,
  RULER_PAD_FACTOR,
  bandOver,
  blockAt,
  clampAnchor,
  crossExtentOf,
  fallbackBand,
  lineRects,
  nextBlock,
  nextColumnBlock,
  onPage,
  toColumns,
  toLines,
  toSpans,
  visibleLines,
} from "@/features/reader/rulerPointer";
import type { RulerColumn, RulerInterval, RulerRect } from "@/features/reader/rulerPointer";
import { MAX_RULER_OPACITY, rulerHex, useReaderSettings } from "@/stores/reader";

/**
 * How far the band stands off the page's own edges when it spans the full width
 * (or height). A band drawn edge to edge has nowhere to show the corner it
 * rounds, and a rounded rectangle that touches the frame reads as a clipped one.
 */
const RULER_INSET = 8;

/**
 * The band as drawn: its place along the reading axis, the extent of the lines it
 * covers across the page (`null` when there was nothing to measure), and whether
 * the page it is on has no lines in the reading area at all.
 *
 * That last one is not a detail. A page the window reaches no line of — a cover,
 * a plate, the top three-quarters of a chapter opener — is a page with nothing
 * to mark, and a band drawn there is a large empty rounded rectangle floating on
 * blank paper, which is what a reader sees and reports as "it selected an empty
 * thing". The two cases are different questions: *no line near where the band
 * wants to be* still gets an arithmetic band (a figure, a paragraph gap, the
 * lines just off the top of the window), while *no line on the page* gets
 * nothing at all.
 */
type Band = RulerInterval & { from: number | null; to: number | null; blank: boolean };

/** One step's worth of motion. The band arrives at a line block, so it travels
 *  on the landing curve rather than an expo-out, which would front-load the
 *  distance and then crawl through the last few pixels. */
const RULER_STEP_MS = 340;

/** How long the band takes to appear: switched on, or handed to a page that
 *  arrived. It fades and settles down into the page rather than blinking on. */
const RULER_APPEAR_MS = 220;

/**
 * How many frames an empty measurement is re-asked for. Long enough for a
 * chapter to be fetched and a section to be laid out — the two arrivals that
 * bring the lines — and short enough that a page with genuinely nothing to
 * measure (a cover, an empty chapter) stops asking.
 */
const SETTLE_TRIES = 120;

/** Frames skipped between asks once the burst is over: thirty frames ≈ 500 ms. */
const SETTLE_WALK = 30;

/** What the reader's chrome drives the ruler with. */
export type ReadingRulerHandle = {
  /**
   * Steps the band one whole block of lines, in reading order. `false` means the
   * page is over in that direction — there is no block left — and it is the
   * caller's move to turn the page or scroll on.
   */
  move: (direction: 1 | -1) => boolean;
};

/**
 * Which way an arrow key steps the band, or `0` for a key it leaves alone.
 *
 * Horizontal type reads down the page, so all four arrows step the band —
 * right/down forward, left/up back. Vertical type reads leftward, where
 * Left/Right are the page turns the reader already knows, so only Up/Down step
 * it; the reference draws the line in the same place.
 */
export function rulerStepForKey(key: string, vertical: boolean): 1 | -1 | 0 {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  if (vertical) return 0;
  if (key === "ArrowRight") return 1;
  if (key === "ArrowLeft") return -1;
  return 0;
}

/**
 * A reading ruler: a band over a block of lines, with everything outside it
 * washed toward the paper.
 *
 * The band *is* a place in the text, not a record of where the pointer or the
 * page happened to be. It is measured onto real rendered lines (where they
 * actually fall, not where the settings' leading says they should), it is as
 * thick as the block it covers, and it steps by whole blocks — so it is never
 * half a line off, and never drifts. What makes it a ruler rather than a stripe
 * is the washing: the page outside the band is painted back over itself, leaving
 * the eye one lit strip of type.
 *
 * The band is therefore *not* a translucent colour laid over the words — that
 * would tint the very text it exists to clarify, and a tint is the one thing the
 * band must not do to the page. When the reader picks a colour it is a
 * translucent fill and nothing more; on 「仅描边」 the band is a pair of hairlines
 * in the page's own ink, which is the reading the reference ships as its default.
 *
 * Where the page shows one column the band spans the page. Where it shows a
 * spread — two flows side by side whose line grids do not agree — the band covers
 * the column being read and the *other* column is washed along with the rest,
 * because a band spanning both would cut lines in one of them whichever lines it
 * snapped to. Stepping runs down the column and then into the next one, and only
 * past the last one is the page over.
 *
 * The parent supplies the page (the viewport, the axis, how many columns, the
 * reader's leading, the paper). What the ruler looks like is the ruler's own
 * settings, so those it reads for itself — as the rest of the reader's panels do.
 */
export function ReadingRuler({
  ref,
  hostRef,
  enabled,
  vertical,
  columns,
  pitch,
  scrim,
  ink,
  lines,
  scroll,
}: {
  ref?: RefObject<ReadingRulerHandle | null>;
  /** The reading viewport; the band is absolute against it. */
  hostRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** Whether the type runs in columns, which turns the band a quarter turn. */
  vertical: boolean;
  /** Columns the renderer is laying out: 2 for a spread, 1 otherwise. */
  columns: number;
  /** One line of body text at the reader's own settings, in px — the ruler's own
   *  arithmetic for the places with no line to measure, and the unit its padding
   *  and its step are measured in. */
  pitch: number;
  /** The page's own colour: what the rest of the page fades into. */
  scrim: string;
  /** The page's ink, for the band's hairlines. */
  ink: string;
  /**
   * The visible lines of type, in this window's client coordinates. Omitted when
   * the words are in this document and the ruler can walk them itself; supplied
   * by the foliate view, whose sections are the only things that know where a
   * book's lines are.
   */
  lines?: () => readonly RulerRect[] | null;
  /**
   * The scrolled layout's auto-scroll. Absent in the paged layouts, where a step
   * ends at the page's edge and the key turns the page.
   *
   * The scrolled model is the paged one turned inside out. The band still steps
   * whole measured blocks — the same `nextBlock`/`bandOver` geometry the page
   * turns use — but past the trigger line the step stops being a move of the
   * band and becomes a move of the page: `by` scrolls the reading flow by the
   * *measured* distance between the two blocks' first lines, which lands the
   * block the band just stepped to exactly where the band was standing. The
   * band holds its place on screen, the text steps under it, and the eye never
   * chases either. `trigger` is that line, as a fraction of the reading axis.
   */
  scroll?: { trigger: number; by: (delta: number) => number };
}) {
  const rulerLines = useReaderSettings((state) => state.rulerLines);
  const rulerColor = useReaderSettings((state) => state.rulerColor);
  const rulerOpacity = useReaderSettings((state) => state.rulerOpacity);
  const rulerPosition = useReaderSettings((state) => state.rulerPosition);
  const update = useReaderSettings((state) => state.update);
  const reduce = useReducedMotion();

  /** The band as drawn: where it sits along the reading axis, and — `from`/`to` —
   *  the extent of the lines it was drawn on, across the page. `null` extent when
   *  there was nothing to measure, which falls back to the band's own inset. */
  const [band, setBand] = useState<Band | null>(null);
  /** The reading area itself, so the wash can be sized in the render. */
  const [area, setArea] = useState<{ axis: number; cross: number }>({ axis: 0, cross: 0 });
  const [dragging, setDragging] = useState(false);
  /** A step is in flight: the band travels to its block rather than jumping. */
  const [stepping, setStepping] = useState(false);
  /** Whether the band is on the page at all: it fades in rather than blinking
   *  on, and stays out of the way while a page is turning under it. */
  const [revealed, setRevealed] = useState(false);

  // Everything the effect measures lives in refs, because the imperative handle
  // and the pointer handlers both read it long after the render that set it up.
  const linesRef = useRef<RulerInterval[]>([]);
  const columnsRef = useRef<RulerColumn[]>([]);
  const activeColumnRef = useRef(0);
  const areaRef = useRef({ axis: 0, cross: 0 });
  /** The fragments the lines were measured from, which is also what says how wide
   *  the band is — see `applyBlock`. */
  const rectsRef = useRef<RulerRect[]>([]);
  /** Where those fragments ran across the page, as a short signature. Part of the
   *  placement key, because a page can re-wrap without the reading area changing
   *  shape — see `place`. */
  const measureSigRef = useRef("");
  /**
   * Where the band sat, as a fraction of the reading axis, re-derived at every
   * measure from the lines themselves rather than from the stored setting.
   *
   * The stored `rulerPosition` is a percentage, and a percentage is only stable
   * while the page keeps its shape. A reading area that changes width re-wraps
   * the text, the block under that percentage becomes a different block, and on
   * a page whose lines are few and far between — a chapter title centred in
   * three-quarters of a blank page — it becomes a block somewhere else
   * entirely: measured on a real book, entering fullscreen dropped the band onto
   * a figure caption, and it then drew itself as wide as that caption. The
   * fraction of the *line the band was on* is the thing that survives.
   */
  const anchorFracRef = useRef<number | null>(null);
  const bandRef = useRef<Band | null>(null);
  const gripRef = useRef<{ centre: number; extent: number; at: number } | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  /** The frame on which a landing band fades in. */
  const revealRef = useRef(0);
  // Where the reader left the band, as it was when this mount began. Placement
  // follows it until the reader moves the band themselves (`movedRef`), and the
  // band itself after that — so saving a drag cannot pull it back onto a line,
  // and a page still arriving cannot leave it remembering a place nobody chose.
  const seedRef = useRef(rulerPosition);
  /** Whether the reader has moved the band in this mount. */
  const movedRef = useRef(false);
  /** The way the page last turned, consumed by the placement that meets it. */
  const dirRef = useRef<1 | -1 | 0>(0);
  /**
   * Whether steps are currently being absorbed by auto-scroll. Set the moment a
   * forward step crosses the trigger line, and cleared the moment a step can no
   * longer be absorbed — a clamp at either edge of the flow, a drag, the band
   * running out of page — because in every one of those the band is walking the
   * window again and the next backward step must walk with it.
   */
  const parkedRef = useRef(false);
  /**
   * The block of lines the band is standing on — the state the next step is
   * computed from. Kept apart from the drawn band on purpose: the band carries
   * whatever padding `bandOver` found room for (none on a page whose leading is
   * tighter than its type, where the line boxes touch), so stripping a fixed
   * pad off the drawn band to recover "the block" reads a number that is not
   * one of anything — measured on a real book, the recovered block start crept
   * one padding-width down the page at every absorbed step and the band drifted
   * off the text it was parked on. A drag leaves the band off any block, and
   * this goes null until a landing puts it on one again.
   */
  const blockRef = useRef<RulerInterval | null>(null);
  /** What the last placement was made for: the reading area's own size and the
   *  leading the band was sized against. A page that moved *under* a band made
   *  for the same ones leaves it exactly where it is; a differently shaped
   *  reading area or a new leading is a new band, and it is placed.
   *
   *  Both extents, and the width is the one that earns its place: the band's
   *  width is the extent of the lines it covers, so a pane that changed width
   *  re-wrapped them and they are a different length. Leaving the width out is
   *  what made the band keep the measure of the page it was drawn on when the
   *  sidebar collapsed, was hidden, or the reader went fullscreen — the pane got
   *  wider, the words re-wrapped, and the band stayed the width of the words it
   *  had before, running out past them (or stopping short) by however much the
   *  measure changed. */
  const placedKeyRef = useRef("");

  const pad = Math.round(pitch * RULER_PAD_FACTOR);

  /** Puts a band on the page. A step — or a page turn handing the band to the
   *  page it landed on — travels on the landing curve; a re-measure (a resize, a
   *  repagination under a still band) must not, or the band would chase every
   *  frame of it. */
  const draw = useCallback(
    (
      next: RulerInterval,
      animate: boolean,
      from: number | null,
      to: number | null,
      blank = false,
    ) => {
      const drawnBand: Band = { ...next, from, to, blank };
      bandRef.current = drawnBand;
      setBand(drawnBand);
      setStepping(animate);
      if (stepTimerRef.current !== null) window.clearTimeout(stepTimerRef.current);
      stepTimerRef.current = window.setTimeout(() => {
        stepTimerRef.current = null;
        setStepping(false);
      }, RULER_STEP_MS);
    },
    [],
  );

  /**
   * How wide the band is, across the page: the extent of the lines it is drawn
   * on, and of nothing else.
   *
   * It used to be the extent of every fragment in the section, and that is a
   * different thing. A book carries text the reader never sees — a print-only
   * running head, a helper laid off the column, a `font-size: 0` line that still
   * has leading — and it has a *box* for it all the same, as wide as the page's
   * content and as invisible as it is unpainted. `checkVisibility` cannot see
   * those (clipping and a zero font are not visibility), and no rule on the
   * fragment's own coordinates can either: such a box is inside the reading area
   * and inside the page. All of them land in one union, and the band comes out
   * as wide as the page instead of as wide as the words — measured on real books,
   * 13–29% of the window wider, in every state that re-lays the pane out.
   *
   * So the width is taken from the lines the band is *drawn on* — not from the
   * block it was handed. A block is a run of `rulerLines` lines, but the block
   * the reader lands on can be far taller than the band that covers it: a
   * chapter title centred in three-quarters of a blank page puts its only line at
   * the top and the paragraphs below in the same block, and the union of that
   * whole block is the page's own width. Measured on a real book, entering
   * fullscreen put the band on a 456px block holding a 124px title and the
   * paragraphs under it, and drew the band 576px wide — wider than anything the
   * reader could see on it. The band is a window on the lines it washes, so the
   * lines it washes are what it is as wide as.
   *
   * The path where a block is not a run of lines keeps its own extent: a
   * spread's block is one column of a two-column grid (its lines share heights,
   * so the block alone cannot say which column it is on).
   *
   * 🔴 **A vertical line is *not* such a path**, whatever it looks like. Its
   * "line" is a column, and a column is a block of text whose height is whatever
   * the paragraph happens to be: the columns of one page run to wildly different
   * lengths, and the last column of a chapter is a single short line. Reading the
   * full page height as the band's cross extent drew it 636px tall over a column
   * whose text is 126px — measured on a real book, overshooting the words below by
   * **418px**, most of the band sitting on blank paper. 「行没排满是两端对齐」这句话
   * 对横排的一**行**散文成立，对竖排的一**列**不成立 —— 列有真的顶边和底边。
   */
  const crossOf = useCallback(
    (washed: RulerInterval, column?: RulerColumn) => {
      // 🔴 The vertical reading axis is measured from the reading area's **right**
      // edge, so that is the extent a vertical fragment's own x has to be
      // projected through — not `area.cross`, which in vertical is the pane's
      // *height*. Projecting through the height shifts every fragment by
      // width − height (342px on a 994 × 652 pane), so the filter below keeps the
      // wrong fragments and the extent comes back describing columns the band is
      // not on. Same wrong-edge bug as the line list, one function over.
      const { cross, axis } = areaRef.current;
      const from = vertical ? axis : cross;
      return crossExtentOf(
        rectsRef.current.filter((rect) => {
          const lo = vertical ? from - rect.right : rect.top;
          const hi = vertical ? from - rect.left : rect.bottom;
          if (hi <= washed.start || lo >= washed.end) return false;
          // 🔴 Reaching in is not covering. The band is wider than the line it
          // marks — its padding, and the room the cap leaves it, sit over the
          // neighbour — and a fragment the band only clips by a hair is not one
          // of the words it is washing, however much taller that fragment is.
          // Measured on a real book in vertical type: the band stood on a column
          // whose text runs 100..226 and clipped the column beside it by 2px of
          // its 25, and that neighbour's 318px tail became the band's own — the
          // band hung **102px** below every word it covered. A fragment counts
          // when the band covers most of it.
          const covered = Math.min(hi, washed.end) - Math.max(lo, washed.start);
          if (covered * 2 < hi - lo) return false;
          if (!column) return true;
          const near = vertical ? rect.top : rect.left;
          const far = vertical ? rect.bottom : rect.right;
          return far > column.left && near < column.right;
        }),
        vertical,
      );
    },
    [vertical],
  );

  /** Draws the band around a block, as wide as the lines in it. The block is
   *  remembered as the one the next step runs from — see `blockRef`. */
  const applyBlock = useCallback(
    (target: RulerInterval, animate: boolean, column?: RulerColumn) => {
      blockRef.current = target;
      const { axis } = areaRef.current;
      if (axis <= 0) return;
      // Hand `bandOver` the lines of the page the block is on, so its padding
      // comes off the leading the page actually has. 使用书籍排版 gives the book
      // back its own line height, and the configured `pitch` is then not a
      // measurement of anything on screen — see `bandOver`.
      const pageLines = column ? column.lines : linesRef.current;
      const wanted = bandOver(target, pitch, rulerLines, pageLines);
      const extent = wanted.end - wanted.start;
      const centre = clampAnchor((wanted.start + wanted.end) / 2, extent, 0, axis);
      // A spread hands the block back from one column, and its lines share
      // heights with the other column's, so the block alone cannot say which one
      // it is on: that path takes the width of the column it is stepping in.
      //
      // The band, not the block: `wanted` is the stretch of lines it actually
      // covers, and that is the window whose words it has to be as wide as.
      //
      // Vertical included, and that is the fix: a column is a block of text with
      // a real top and bottom, so its band's cross extent comes off the same
      // measurement as a horizontal line's. `crossOf` reads the two axes the right
      // way round already; skipping it here left `from`/`to` null, and a null pair
      // is the render's cue to fall back to the whole area — so every vertical band
      // was the full pane's height whatever it was covering.
      const edges = crossOf(wanted, column);
      draw(
        { start: centre - extent / 2, end: centre + extent / 2 },
        animate,
        edges?.from ?? null,
        edges?.to ?? null,
      );
    },
    [crossOf, draw, pitch, rulerLines],
  );

  /**
   * No line to sit on where the band wants to be: the reader's own leading still
   * marks the place, and with no lines there is nothing to be as wide as — the
   * band's own inset it is.
   *
   * A page with *no lines in the window at all* is marked `blank` instead, and
   * the render drops it. That is a different thing from a paragraph gap: there
   * is nothing on this page for the ruler to point at, so it points at nothing.
   */
  const applyFallback = useCallback(
    (centre: number, animate = false) => {
      const { axis } = areaRef.current;
      if (axis <= 0) return;
      const blank = linesRef.current.length === 0 && columnsRef.current.length === 0;
      const extent = pitch * Math.max(1, Math.floor(rulerLines));
      const at = clampAnchor(centre, extent, 0, axis);
      draw(fallbackBand(at, pitch, rulerLines), animate, null, null, blank);
    },
    [draw, pitch, rulerLines],
  );

  /**
   * Saves where the band is, so the next visit reopens on it. Only ever called
   * for the reader's own moves — a drag, a step — because saving a placement
   * would walk the stored place down the page one page turn at a time.
   */
  const remember = useCallback(() => {
    const { axis } = areaRef.current;
    const drawn = bandRef.current;
    if (axis <= 0 || !drawn) return;
    const centre = (drawn.start + drawn.end) / 2;
    update({ rulerPosition: Math.round((centre / axis) * 1000) / 10 });
  }, [update]);

  /**
   * Re-walks the page for its lines. Written once and kept until the page moves:
   * re-measuring on every scroll would walk the band down the page with the text,
   * because the line under it changes as the text goes by — the reference froze
   * its measurement for the same reason. The band is a window cut in the page, so
   * the page moving *under* it is the point.
   *
   * An empty answer is not an answer, though. The first measure happens before the
   * chapter has mounted — the words arrive asynchronously, and on the book path a
   * section's frame is still zero-sized — so the caller keeps asking until the
   * lines exist rather than caching that emptiness.
   *
   * Returns how many lines the page has, and zero when it has none to measure
   * onto yet — the count, not a yes/no, because a page arrives in pieces and the
   * caller has to be able to tell a page still growing from one that is there.
   */
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return 0;
    const box = host.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return 0;
    const source =
      lines ??
      (() =>
        // This reader's own scroller, found under its own viewport: a pair has
        // two `[data-reading-content]` boxes and "the first in the document"
        // is always the left book's — measuring that one leaves this pane with
        // no lines and the band never appears.
        lineRects(document, host.querySelector("[data-reading-content]")));
    const raw = (source() ?? []).map((rect): RulerRect => ({
      top: rect.top - box.top,
      bottom: rect.bottom - box.top,
      left: rect.left - box.left,
      right: rect.right - box.left,
    }));
    // The axis runs in reading order: down the page for horizontal type, and
    // leftward from the right edge for vertical-rl. Only the cross axis is then
    // the page's own width or height.
    const next = vertical
      ? { axis: box.width, cross: box.height }
      : { axis: box.height, cross: box.width };
    areaRef.current = next;
    setArea((was) => (was.axis === next.axis && was.cross === next.cross ? was : next));

    // Only what the reader can see takes part, on *both* axes. Across the page
    // that means fragments that are *on this page*: a paginated book keeps the
    // pages either side of this one in the document, flush against the reading
    // area and — after the pane's own width changes — straddling it, and a
    // fragment off either edge drags the band out into the margin. Along the
    // axis it means the lines the window reaches, below. (A page that is laid
    // out *inside* the area and painted nowhere is the other half of that
    // problem, and only the renderer can see it — see `FoliateBookView`.)
    const rects = raw.filter((rect) => onPage(rect, vertical, 0, next.cross));
    rectsRef.current = rects;
    // The outermost edges of what is on the page, not the typical ones: this is a
    // fingerprint of the measure the words were set in, and the band's own width
    // is those words' width.
    const extent = crossExtentOf(rects, vertical);
    measureSigRef.current = extent ? `${Math.round(extent.from)}:${Math.round(extent.to)}` : "-";

    if (columns > 1 && !vertical) {
      // A spread: two flows whose line grids do not agree, so they are measured
      // apart and the band covers one of them.
      const measured = toColumns(rects, columns, 0, next.cross).flatMap((entry) => {
        const onScreen = visibleLines(entry.lines, 0, next.axis);
        return onScreen.length > 0
          ? [{ left: entry.left, right: entry.right, lines: onScreen }]
          : [];
      });
      columnsRef.current = measured;
      linesRef.current = [];
      // A page the reader has arrived on starts the band in the column the
      // reading starts in: the first one going forward, the last one going back.
      if (dirRef.current === 1) activeColumnRef.current = 0;
      if (dirRef.current === -1) activeColumnRef.current = Number.MAX_SAFE_INTEGER;
      const active = Math.min(activeColumnRef.current, Math.max(0, measured.length - 1));
      activeColumnRef.current = active;
      return measured.reduce((total, entry) => total + entry.lines.length, 0);
    }

    // The vertical axis is measured from the reading area's **right** edge, so
    // that is the extent `toSpans` needs — not `next.cross`, which in vertical is
    // the pane's *height*. Handing it the height shifts every line by the
    // difference between the pane's two sides: on a 994 × 652 pane the lines came
    // out at −249…548 instead of 93…890, so the whole list sat off the axis, the
    // band was placed where nothing is, and a 2-line band came out 175px wide over
    // 8 columns of the page next door. The two extents are the same number in
    // horizontal, which is why only 竖排 showed it.
    const axisFrom = vertical ? box.width : next.cross;
    linesRef.current = visibleLines(toLines(toSpans(rects, vertical, axisFrom)), 0, next.axis);
    columnsRef.current = [];
    // The lines moved under a band that has not moved: the fraction it now sits
    // at is the one to keep, and it is the only reading of "where it was" that
    // survives the next re-wrap.
    const drawn = bandRef.current;
    if (drawn && next.axis > 0) {
      const centre = (drawn.start + drawn.end) / 2;
      if (centre >= 0 && centre <= next.axis) {
        const at = centre / next.axis;
        // Only a band that is on the page says anything about where on it.
        if (anchorFracRef.current === null || Math.abs(at - anchorFracRef.current) < 0.2) {
          anchorFracRef.current = at;
        }
      }
    }
    return linesRef.current.length;
  }, [columns, hostRef, lines, vertical]);

  /** The block of lines nearest an anchor on a page of lines, or the last one. */
  const blockNear = useCallback(
    (page: readonly RulerInterval[], anchor: number): RulerInterval | null =>
      blockAt(page, anchor, rulerLines) ??
      // Below the last line of the page: the last block there is the honest
      // answer, and it is also what a step back would have found.
      nextBlock(page, { start: anchor, end: anchor }, rulerLines, 1) ??
      nextBlock(page, { start: Infinity, end: Infinity }, rulerLines, -1),
    [rulerLines],
  );

  /**
   * Puts the band on the current page.
   *
   * A page the reader has *arrived on* — a turn — hands the band to that page:
   * forward, its first block of lines; back, its last one. That is the difference
   * between continuing to read and being dropped wherever the band happened to
   * be when the page left. Every other measure keeps the reader's place.
   */
  const place = useCallback(() => {
    const { axis } = areaRef.current;
    if (axis <= 0) return;
    const dir = dirRef.current;
    dirRef.current = 0;
    const drawn = bandRef.current;
    // A page that moved *under* the band leaves it exactly where the reader put
    // it. Re-snapping there is a movement they never asked for — the band
    // shifting again half a second after the scroll — and a band drawn on the
    // page is right wherever it stands. Only the first measure, a turn, or a band
    // that this page would not draw itself sets the place.
    //
    // "This page" is the reading area's size *and* where its words ran, and the
    // second half is not optional. The sidebar spring pins the page for half a
    // second, and the ruler measures it there: it stamps the key with the width
    // the pane is *about* to have. The pin lets go, the page re-wraps into the
    // width the pane already had, the key is unchanged — so the re-measure agreed
    // that nothing had changed, `place` declined, and the band kept the measure
    // of the page it was drawn on, sitting a pane's width off the words until
    // something else moved it.
    const key = `${areaRef.current.cross}|${axis}|${measureSigRef.current}|${rulerLines}|${pitch}`;
    if (dir === 0 && drawn && placedKeyRef.current === key) return;
    placedKeyRef.current = key;
    const held = dir === 0 && movedRef.current ? drawn : null;
    // A page the reader has not touched is placed where the last measure found
    // the band on *this* page, which a re-wrap moves with the text; the stored
    // percentage is the fallback for a page measured for the first time.
    const fraction = anchorFracRef.current ?? (seedRef.current ?? 0) / 100;
    const centre = held ? (held.start + held.end) / 2 : fraction * axis;
    const half = held ? Math.max(0, (held.end - held.start) / 2 - pad) : (pitch * rulerLines) / 2;
    const anchor = dir === 1 ? 0 : dir === -1 ? axis : centre - half;

    const page = columnsRef.current.length > 0 ? null : linesRef.current;
    const column = columnsRef.current[activeColumnRef.current] ?? null;
    const block = page ? blockNear(page, anchor) : blockNear(column?.lines ?? [], anchor);
    const landing = dir !== 0 || !drawn;
    // On the page that arrived, in place: the handover is the fade, not a slide
    // from wherever the band was standing when the page left.
    if (block) applyBlock(block, false, column ?? undefined);
    else applyFallback(dir === 1 ? half : dir === -1 ? axis - half : centre, false);
    // Switched on, or handed to a page that arrived: the band appears on the
    // page rather than travelling to it. A turn's band rides the old page for
    // the length of the turn otherwise, which is the jump there and back.
    if (landing) {
      setRevealed(false);
      revealRef.current = requestAnimationFrame(() => setRevealed(true));
    }
  }, [applyBlock, applyFallback, blockNear, pad, pitch, rulerLines]);

  /**
   * An absorbed step in flight: the page is carrying it on the landing curve,
   * frame by frame, and the band stands still while the text glides under it.
   * `appliedMag` accumulates how far the scroller actually went, as a
   * *magnitude* — the scrollport quantizes to whole pixels, so the last
   * frame's remainder rides the next delta and the total lands on the measured
   * advance to the pixel; the direction is kept apart from the distance so a
   * backward glide cannot double-count its sign.
   */
  const glideRef = useRef<{
    raf: number;
    at: number;
    advance: number;
    appliedMag: number;
    direction: 1 | -1;
    nextStart: number;
  } | null>(null);

  /**
   * Lands an absorbed step for real: whatever is left of the glide scrolls
   * on the spot, the lines are re-measured at rest, and the band is drawn on
   * the block it was handed. Runs when a glide finishes — and when a new step
   * interrupts one, so every step measures a page standing still and its
   * advance stays the measured distance between two blocks' first lines.
   */
  const landGlide = useCallback(() => {
    const glide = glideRef.current;
    if (!glide || !scroll) return;
    glideRef.current = null;
    window.cancelAnimationFrame(glide.raf);
    let appliedMag = glide.appliedMag;
    const remaining = glide.advance - appliedMag;
    if (remaining > 0) {
      appliedMag += Math.abs(scroll.by(glide.direction * remaining));
    }
    measure();
    // The block stepped to stands the applied distance from where it was
    // measured; find it among the fresh lines and draw there. A clamp at an
    // edge of the flow (the total falling short of the advance) puts the band
    // most of the way down — still on its block, or on the flow's last one.
    //
    // Animated even though the band does not move: a parked band holds its
    // place on screen, and what changes here is its *shape* — the next block
    // is taller or shorter, its lines reach further across the page — which is
    // a change of the box the reader is looking at, and it arrives on the same
    // landing curve as a step that does travel. (Under reduced motion `draw`
    // drops the transition, which is the point of asking for less movement.)
    const anchor = glide.nextStart - glide.direction * appliedMag;
    const landed = blockNear(linesRef.current, anchor);
    parkedRef.current = true;
    if (landed) applyBlock(landed, true);
    else applyFallback(anchor);
  }, [applyBlock, applyFallback, blockNear, measure, scroll]);

  /**
   * One step of the reader's own advance, whole blocks at a time.
   *
   * In the paged layouts the band walks the page and the step ends at its edge;
   * in the scrolled one the same walk crosses the trigger line and turns into a
   * scroll — see `scroll`. The absorbed step travels on the band's own landing
   * curve — `--ease-land`, a cubic ease-out, for exactly as long as a band
   * step — so the text glides one block under the stationary band and the eye
   * never sees a jump. Distance and direction stay apart in the glide: the
   * ease works in magnitudes, and the sign rides only the `scroll.by` call.
   */
  const move = useCallback(
    (direction: 1 | -1) => {
      // A step arriving mid-glide lands the glide first: the page stands
      // still while the next one measures it.
      landGlide();
      const drawn = bandRef.current;
      if (!drawn) return false;
      if (!scroll) parkedRef.current = false;
      // The block the band stands on — remembered when it was drawn, not
      // re-derived from the band, whose padding is whatever the page had room
      // for (see `blockRef`). A dragged band is off any block, and the old
      // pad-stripping reading is the best that is left.
      const from = blockRef.current ?? { start: drawn.start + pad, end: drawn.end - pad };

      if (columnsRef.current.length > 0) {
        const next = nextColumnBlock(
          columnsRef.current,
          activeColumnRef.current,
          from,
          rulerLines,
          direction,
        );
        if (!next) return false;
        activeColumnRef.current = next.index;
        movedRef.current = true;
        applyBlock(next.block, true, columnsRef.current[next.index]);
        remember();
        return true;
      }

      const next = nextBlock(linesRef.current, from, rulerLines, direction);
      if (!next) {
        parkedRef.current = false;
        return false;
      }
      movedRef.current = true;
      const { axis } = areaRef.current;
      // Where the step would put the band, decided before it is drawn: past the
      // trigger line the step is absorbed by the page instead. Backward joins
      // only once forward has parked — a band below the line must be able to
      // walk up to it.
      const wanted = scroll ? bandOver(next, pitch, rulerLines, linesRef.current) : null;
      const absorb =
        scroll !== undefined &&
        wanted !== null &&
        (parkedRef.current || (direction === 1 && wanted.end > axis * scroll.trigger));
      if (absorb && scroll) {
        // The scroll is the *measured* distance between the two blocks' first
        // lines — not a block of the settings' leading. That exactness is the
        // whole alignment story: scrolling precisely that far lands the block
        // the band just stepped to exactly where the band was standing, so the
        // band holds its place on screen and the text steps one block under it.
        const advance = Math.max(1, Math.abs(Math.round(next.start - from.start)));
        if (reduce) {
          // Under reduced motion there is no glide: the step is a change of
          // place, and the reader who asked for less movement wants it to
          // arrive. The scroll is instant, so the landing measures against it
          // synchronously.
          const applied = scroll.by(direction * advance);
          measure();
          parkedRef.current = Math.abs(applied) >= advance - 1;
          const anchor = next.start - applied;
          const landed = blockNear(linesRef.current, anchor);
          if (landed) applyBlock(landed, true);
          else applyFallback(anchor);
        } else {
          // The band never moves from here on — the text glides under it, on
          // the landing curve, for exactly as long as a band step takes. Until
          // the glide lands, the band keeps covering the block it was on,
          // which the scroll has not moved yet. The frame is created with the
          // glide (a plain closure may re-schedule itself; a useCallback
          // cannot read its own identity), and it ends in `landGlide`.
          const glide: NonNullable<typeof glideRef.current> = {
            raf: 0,
            at: performance.now(),
            advance,
            appliedMag: 0,
            direction,
            nextStart: next.start,
          };
          const frame = (now: number) => {
            if (glideRef.current !== glide) return;
            const t = Math.min(1, (now - glide.at) / RULER_STEP_MS);
            const target = (1 - (1 - t) ** 3) * glide.advance;
            const delta = target - glide.appliedMag;
            if (delta > 0) {
              glide.appliedMag += Math.abs(scroll.by(glide.direction * delta));
            }
            if (t < 1) {
              glide.raf = requestAnimationFrame(frame);
              return;
            }
            landGlide();
          };
          glideRef.current = glide;
          glide.raf = requestAnimationFrame(frame);
          parkedRef.current = true;
        }
      } else {
        applyBlock(next, true);
      }
      remember();
      return true;
    },
    [
      applyBlock,
      applyFallback,
      blockNear,
      landGlide,
      measure,
      pad,
      pitch,
      reduce,
      remember,
      rulerLines,
      scroll,
    ],
  );

  /** One arrow of a drag: the band follows the pointer, and stops where it is put. */
  const onDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drawn = bandRef.current;
      const { axis } = areaRef.current;
      if (!drawn || axis <= 0) return;
      // From here the band is the reader's, not the saved place's: a re-measure
      // while they drag it (a window resize, a repagination) must leave it where
      // their hand put it.
      movedRef.current = true;
      // A glide still in the air lands on the spot first — the hand grabs a
      // band standing on its block — and a dragged band is out of the
      // auto-scroll's keep: it stands where the hand left it, off any block.
      landGlide();
      blockRef.current = null;
      parkedRef.current = false;
      gripRef.current = {
        centre: (drawn.start + drawn.end) / 2,
        extent: drawn.end - drawn.start,
        at: vertical ? event.clientX : event.clientY,
      };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [landGlide, vertical],
  );

  const onDragMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const grip = gripRef.current;
      const drawn = bandRef.current;
      const { axis } = areaRef.current;
      if (!grip || !drawn || axis <= 0) return;
      // 🔴 Negated in 竖排, and the reason is the axis the band is measured on.
      // Down the page (horizontal) the reader's `start` grows with `clientY`, so
      // the pointer's own delta moves the band the way the hand went. In 竖排
      // `start` is the distance from the reading area's **right** edge, so it
      // grows as the pointer goes **left** — feeding it the screen delta as it
      // stands ran the band the other way: drag left, the band went right.
      const moved = vertical ? grip.at - event.clientX : event.clientY - grip.at;
      const centre = clampAnchor(grip.centre + moved, grip.extent, 0, axis);
      // A drag moves the band down the page and not across it: the lines it was
      // measured on are the reader's own now, and they keep their own width.
      const next: Band = {
        start: centre - grip.extent / 2,
        end: centre + grip.extent / 2,
        from: drawn.from,
        to: drawn.to,
        blank: drawn.blank,
      };
      bandRef.current = next;
      setBand(next);
      event.preventDefault();
      event.stopPropagation();
    },
    [vertical],
  );

  const onDragEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!gripRef.current) return;
      gripRef.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      remember();
    },
    [remember],
  );

  useImperativeHandle(
    ref,
    () => ({
      move,
    }),
    [move],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!enabled || !host) return;

    let tries = 0;
    let pending = false;
    let frame = 0;
    let skipped = 0;
    // The lines a measure last counted, so the loop can tell a page still
    // arriving from a page that is there.
    let counted = -1;
    // …and where those lines *are*: a page that re-wraps has the same number of
    // lines in a different measure, and a pane whose width changed under a
    // settled band has the same count again after the caret that replaced the
    // sidebar has mounted. Two measures agreeing on the count is not the page
    // agreeing it is the same page.
    let countedShape = "";
    // The words are not always there yet: a chapter is fetched, a section has to
    // lay out, and neither resizes anything this effect observes. One ask per
    // frame covers the words that arrive within a couple of seconds; past that
    // the ask slows to a walk — a frame in thirty — instead of stopping, because
    // a band that never appears is one the reader cannot step with the keys and
    // one that reopens nowhere in particular. The walk stops the moment the
    // lines are there, and with them the two measures that agree.
    //
    // A measure that is *short* is not an answer either. A chapter arrives in
    // pieces and the first piece is often a line or two, so the loop waits for two
    // measures in a row to agree: measured against a page still growing, the band
    // snaps to whatever fragment is on screen — a stray line at the top of an
    // empty column — and then sits on it until something else moves the page.
    //
    // Agreement is the line count *and* the shape of the reading area it was
    // measured in, because a page that re-wraps has the same lines in a different
    // measure — and that is exactly what the sidebar and fullscreen do. Counting
    // lines alone settled the loop on the first frame of the spring, against a
    // pane still pinned at the old width; the pin let go half a second later,
    // nothing asked again, and the band kept the measure of the page it had been
    // drawn on, sitting a pane's width off the words.
    //
    // **Zero lines is an answer too**, and this is where it used to hang. A page
    // whose window reaches no line — a chapter opener whose title sits inside the
    // top three-quarters of the page, a plate, a section whose next screen holds
    // the words — measures zero, so `measured > 0` was false, so `place` was
    // never called, so the band kept the position it had on the *previous* page
    // and the loop asked again forever. Measured on a real book: 184 measures in
    // 6 seconds, the band parked 400px above the words, and the reader saw a
    // band floating on blank paper. Zero lines means the band is placed
    // arithmetically, which is the honest answer for a page with no lines to sit
    // on; what it must never mean is *not placed*.
    const ask = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        const measured = measure();
        const shape = `${areaRef.current.cross}x${areaRef.current.axis}`;
        if (measured === counted && shape === countedShape) {
          place();
          return;
        }
        countedShape = shape;
        counted = measured;
        tries += 1;
        if (tries >= SETTLE_TRIES && skipped++ < SETTLE_WALK) {
          ask();
          return;
        }
        skipped = 0;
        ask();
      });
    };
    ask();

    // A re-measure walks the chapter's text nodes, which is milliseconds of work
    // — and the reading area is resized on every frame of the sidebar spring, as
    // is the window on a drag of its corner. So the walk is coalesced to one per
    // frame: many notices, one answer. It is also why a re-measure draws without
    // a transition, because a target rewritten every frame restarts the clock
    // every frame and the band would crawl after the layout instead of arriving.
    let layoutFrame = 0;
    const relayout = () => {
      if (layoutFrame !== 0) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        tries = 0;
        // A re-measure after a page turn meets a page of the same shape, so the
        // count it last saw cannot be trusted to say the new one has arrived.
        counted = -1;
        countedShape = "";
        ask();
      });
    };

    ask();
    const observer = new ResizeObserver(relayout);
    observer.observe(host);
    // The relay's `detail` is the way the page turned, and only a turn's notice
    // carries one: a resize or a repagination is the same page, and the band
    // keeps its place on it.
    const onLayout = (event: Event) => {
      const turn = (event as CustomEvent<{ dir: 1 | -1 | 0; landed: boolean } | undefined>).detail;
      if (turn && turn.dir !== 0) {
        dirRef.current = turn.dir;
        // Still turning: the band hides and waits for the page that arrives,
        // instead of riding this one out to its last line.
        if (!turn.landed) {
          setRevealed(false);
          return;
        }
      }
      relayout();
    };
    host.addEventListener(RULER_LAYOUT_EVENT, onLayout);

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(layoutFrame);
      cancelAnimationFrame(revealRef.current);
      observer.disconnect();
      host.removeEventListener(RULER_LAYOUT_EVENT, onLayout);
    };
  }, [enabled, hostRef, measure, place]);

  useEffect(
    () => () => {
      if (stepTimerRef.current !== null) window.clearTimeout(stepTimerRef.current);
      if (glideRef.current !== null) window.cancelAnimationFrame(glideRef.current.raf);
    },
    [],
  );

  // Leaving the reader saves where the band is, so the next visit — same book or
  // another one — opens on it. Nothing else saves a placement, which is what
  // keeps a page turn from walking the stored place down the book; the exit is
  // the one moment the current place is the reader's.
  useEffect(() => {
    const atExit = remember;
    return () => atExit();
  }, [remember]);

  // Nothing to mark on this page: no band at all, rather than a large empty
  // rounded rectangle on blank paper. The washes go with it — there is no block
  // of text for them to be "outside" of.
  if (!enabled || !band || band.blank) return null;

  const tint = rulerHex(rulerColor);
  const fade = Math.min(Math.max(rulerOpacity, 0.05), MAX_RULER_OPACITY);

  // Where the band is, in each axis. The reading axis already runs in reading
  // order, so the *other* one is the only one that has to be flipped back:
  // vertical-rl reads leftward, and a band standing `start` away from the right
  // edge is drawn from that edge. Across the page the band is as wide as the
  // words it covers — a strip that runs on past them into the margins reads as if
  // it had faded out before and after the lines it marks (`crossOf`) — and the
  // band's own inset is what a page with nothing measured yet gets.
  const cross =
    band.from !== null && band.to !== null
      ? { from: Math.max(0, band.from - pad), to: Math.min(area.cross, band.to + pad) }
      : { from: RULER_INSET, to: Math.max(RULER_INSET, area.cross - RULER_INSET) };

  // The properties that actually move: on a step, the band and the four washes
  // travel together, on the landing curve. Nothing glides while the reader is
  // dragging the band — the pointer is already the animation, and a transition on
  // top of it is the band lagging behind the hand that is moving it. Nothing
  // glides under reduced motion either: a step is a change of place, and the
  // reader who asked for less movement wants it to arrive, not to travel.
  const glide: CSSProperties | undefined =
    stepping && !dragging && !reduce
      ? {
          transitionProperty: "top, right, bottom, left, width, height",
          transitionDuration: `${RULER_STEP_MS}ms`,
          transitionTimingFunction: "var(--ease-land)",
        }
      : undefined;

  // Appearing: the band and the wash that comes with it fade in and settle down
  // into the page. Switched on, they arrive rather than blink on; between pages
  // they are out of the way entirely, so the turn itself is what the reader sees.
  const appear: CSSProperties = {
    transitionProperty: "opacity, transform",
    transitionDuration: `${RULER_APPEAR_MS}ms`,
    transitionTimingFunction: "var(--ease-land)",
  };

  const axisStyle = (from: number, to: number): CSSProperties =>
    vertical
      ? { right: from, width: Math.max(0, to - from) }
      : { top: from, height: Math.max(0, to - from) };
  const crossStyle = (from: number, to: number): CSSProperties =>
    vertical
      ? { top: from, height: Math.max(0, to - from) }
      : { left: from, width: Math.max(0, to - from) };

  // Everything outside the band is the page painted back over itself: first the
  // two sides along the reading axis, then the two along the other one — which on
  // a spread is the column not being read, and on a single-column page is the
  // sliver the band's own inset leaves. Together they are the hole and nothing
  // else, so no seam of undimmed type is left at the band's own margins.
  //
  // Every one of the four carries *both* extents. An absolutely positioned box
  // with an axis offset and no cross extent is shrink-to-fit, and an empty box
  // shrinks to nothing — so the two axis washes would be invisible and the page
  // outside the band would never fade at all.
  const paper: CSSProperties = {
    position: "absolute",
    background: scrim,
    // The wash has two jobs at once: how far the page fades, and whether the
    // ruler is on the page at all. Off, it goes with the band.
    opacity: revealed ? fade : 0,
    ...appear,
    ...glide,
  };
  const before: CSSProperties = {
    ...paper,
    ...axisStyle(0, band.start),
    ...crossStyle(0, area.cross),
  };
  const after: CSSProperties = {
    ...paper,
    ...axisStyle(band.end, area.axis),
    ...crossStyle(0, area.cross),
  };
  const leading: CSSProperties = {
    ...paper,
    ...axisStyle(band.start, band.end),
    ...crossStyle(0, cross.from),
  };
  const trailing: CSSProperties = {
    ...paper,
    ...axisStyle(band.start, band.end),
    ...crossStyle(cross.to, area.cross),
  };
  // The band's own edge: a hairline in the page's ink when it has no fill of its
  // own, nothing when the colour is already the mark. It runs all the way round:
  // two hairlines along the band with nothing joining them read as one band
  // broken apart at its ends, which is exactly what a rounded corner does to
  // them.
  const border: CSSProperties = tint ? {} : { border: `1px solid ${ink}` };

  return (
    <div aria-hidden data-reading-ruler className="pointer-events-none absolute inset-0 z-20">
      <div data-ruler-wash="before" style={before} />
      <div data-ruler-wash="after" style={after} />
      <div data-ruler-wash="leading" style={leading} />
      <div data-ruler-wash="trailing" style={trailing} />
      <div
        data-ruler-band
        className="absolute box-border rounded-2xl"
        style={{
          ...axisStyle(band.start, band.end),
          ...crossStyle(cross.from, cross.to),
          ...appear,
          opacity: revealed ? 1 : 0,
          transform: revealed ? undefined : "translateY(-5px)",
          ...glide,
          background: tint
            ? `color-mix(in srgb, ${tint} ${Math.round(fade * 100)}%, transparent)`
            : undefined,
          ...border,
        }}
      >
        {/* The band is inert so text selection works through it, which is the
            whole reason it has no drag affordance of its own: these two edges are
            the parts that take a pointer, and on a mouse they are the drag. */}
        <div
          data-ruler-edge="leading"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className={cn(
            "pointer-events-auto absolute touch-none",
            vertical
              ? "top-0 bottom-0 -left-2 w-4 cursor-col-resize"
              : "-top-2 right-0 left-0 h-4 cursor-row-resize",
          )}
        />
        <div
          data-ruler-edge="trailing"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className={cn(
            "pointer-events-auto absolute touch-none",
            vertical
              ? "top-0 -right-2 bottom-0 w-4 cursor-col-resize"
              : "right-0 -bottom-2 left-0 h-4 cursor-row-resize",
          )}
        />
      </div>
    </div>
  );
}
