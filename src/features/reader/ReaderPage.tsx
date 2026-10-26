import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { AnimatePresence, useReducedMotion } from "motion/react";

import { OverlayPortal } from "@/components/glass/overlay";
import { isFoliateFormat } from "@/features/library/format";
import { useAssetUrl } from "@/features/reader/assets";
import {
  IMAGE_PARAGRAPH_PREFIX,
  LINK_PARAGRAPH_PREFIX,
  WALLPAPER_PARAGRAPH_PREFIX,
} from "@/features/reader/chapterText";
import { useFoliateReading } from "@/features/reader/useFoliateReading";
import { useZhConverter } from "@/features/reader/zhConvert";
import type { ZhConvertMode } from "@/features/reader/zhConvert";
import { useFoliateStyle } from "@/features/reader/useFoliateStyle";
import { useReaderFullscreen } from "@/features/reader/useReaderFullscreen";
import { FULLSCREEN_MARGIN_BONUS, useReaderLayout } from "@/features/reader/useReaderLayout";
import { applyPosition, columnPitch, flipPage } from "@/features/reader/paging";
import { usePdfReading } from "@/features/reader/usePdfReading";
import { useProseReading } from "@/features/reader/useProseReading";
import { setTtsWashRule } from "@/features/reader/pdfTextSelection";
import type { CurlTurn } from "@/features/reader/pdfCurl";
import { ImageLightbox } from "@/features/reader/ImageLightbox";
import {
  ReaderFooterControls,
  ReaderHeaderBar,
  ReaderToolButtons,
  type ReaderToolButtonsProps,
} from "@/features/reader/ReaderChrome";
import { HeaderRule } from "@/features/reader/ReaderHeader";
import { PairPicker } from "@/features/reader/PairPicker";
import { ReaderHost } from "@/features/reader/ReaderHost";
import { SplitReader } from "@/features/reader/SplitReader";
import { usePairSlots, type PairIdentity } from "@/features/reader/pairLayout";
import { ReaderPanels } from "@/features/reader/ReaderPanels";
import { ReaderChapterView } from "@/features/reader/ReaderChapterView";
import { PullBookmark } from "@/features/reader/PullBookmark";
import { ReadingRuler } from "@/features/reader/ReadingRuler";
import type { ReadingRulerHandle } from "@/features/reader/ReadingRuler";
import {
  resolveReaderKey,
  type ReaderKeyContext,
  type ReaderKeyId,
} from "@/features/reader/readerKeys";
import { relayRulerLayout, relayRulerTurn } from "@/features/reader/rulerPointer";
import { medianCpm } from "@/features/reader/pace";
import {
  POSITION_SAVE_DELAY_MS,
  globalProgress,
  locateChapter,
  remainingChars,
  totalChars,
} from "@/features/reader/progress";
import {
  paragraphAt,
  resolveSelection,
  selectionBottom,
  type PendingSelection,
  type TextRange,
} from "@/features/reader/selection";
import { washCss, washRule } from "@/features/reader/ttsWash";
import { RsvpPlayer } from "@/features/reader/RsvpPlayer";
import {
  SelectionOverlay,
  selectionKeyOf,
  type LookupKind,
} from "@/features/reader/SelectionToolbar";
import type { AnnotationStyle } from "@/types/ipc";
import { useTtsHost } from "@/features/reader/TtsHost";
import { resolveSurface, readerGlassVars } from "@/features/reader/theme";
import { useAdoptedFontKey } from "@/features/reader/useAdoptedFontKey";
import {
  useAnnotations,
  useAnchorAnnotation,
  useCreateAnnotation,
  useDeleteAnnotation,
  useExportNotes,
  useSetAnnotationNote,
  useUpdateAnnotation,
} from "@/hooks/useAnnotations";
import { useBookmarks, useCreateBookmark, useDeleteBookmark } from "@/hooks/useBookmarks";
import { useElementHeight } from "@/hooks/useElementHeight";
import { usePageIsNight, useReadingSurface } from "@/hooks/useReadingSurface";
import { useFonts } from "@/hooks/useFonts";
import { useGamepadPager } from "@/hooks/useGamepadPager";
import { useBookImages, useChapter, useSetProgress } from "@/hooks/useReader";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useImageLightbox } from "@/hooks/useImageLightbox";
import { useHitJumps } from "@/hooks/useHitJumps";
import { usePageCounter } from "@/hooks/usePageCounter";
import { useReadAloud } from "@/hooks/useReadAloud";
import { useReadingClock, useReadingPace } from "@/hooks/useReading";
import { useReaderPanels } from "@/hooks/useReaderPanels";
import {
  LINE_HEIGHTS,
  PARA_GAPS,
  pageIsNight,
  useBookSettings,
  useReaderSettings,
} from "@/stores/reader";
import { useSettings } from "@/stores/settings";
import { sessionNow, useSpeechSession } from "@/stores/speech";
import { boxOf, useBookHandoff } from "@/stores/book-handoff";
import { partnerOf, usePairView } from "@/stores/pairView";
import { useChrome } from "@/stores/chrome";
import { cn } from "@/lib/cn";
import { isEditableTarget } from "@/lib/commands";
import type { Annotation, BookFormat, Bookmark, ChapterMeta, LocalFont } from "@/types/ipc";

/** Notes export reaches for the native save dialog; kept out of the reader's
 *  own chunk so the reader still loads without it. */
const ExportNotesDialog = lazy(() =>
  import("@/features/reader/ExportNotesDialog").then((module) => ({
    default: module.ExportNotesDialog,
  })),
);

/** The share card draws a QR and a whole canvas; the same reasoning as the
 *  export dialog, with a dependency of its own riding along. */
const QuoteCardDialog = lazy(() =>
  import("@/features/reader/QuoteCardDialog").then((module) => ({
    default: module.QuoteCardDialog,
  })),
);

/**
 * How long the page has to stand still before the reading ruler re-measures.
 *
 * Longer than the longest page-turn animation (450 ms, `flipPage`'s slide):
 * that animation is a *transform* on the scroller, and the lines' measured
 * positions include it, so a measure taken while one is running reads a page in
 * flight and parks the band on whatever block a half-slid page put under it.
 * The animation starts after the jump's own scroll event, so the settle has to
 * outlast it rather than the event.
 */
const RULER_SETTLE_MS = 520;

/** Gutter between the two columns of a spread: the page margin itself, so the
 * centre gap matches the outer margins and both paged modes share one rhythm. */

/** Wheel silence (ms) that ends one trackpad gesture and re-arms paging. */
const GESTURE_GAP = 200;

/** Wheel travel that starts a turn. Below this a nudge is not a gesture. */
const WHEEL_START_PX = 48;

/**
 * How far a dragged sheet has to travel before letting go turns the page.
 * Low, because a trackpad's own inertia carries a flick well past halfway on
 * its own — waiting for half would make a normal swipe spring back.
 */
const SCRUB_COMMIT = 0.35;

/**
 * Stillness (ms) before the pointer and the page number step off the page.
 *
 * Three seconds is the length of a glance: long enough that the number is still
 * there when the reader looks up from a paragraph, short enough that it is gone
 * before it reads as part of the page. foliate's own cursor hider waits the same
 * three seconds (`CURSOR_HIDE_MS` in view.js), so one stillness clears both.
 */
const IDLE_MS = 3000;

/**
 * Stand-in for the book's image list while the query is in flight. A fresh
 * `[]` per render would re-create every callback that reads it.
 */

/**
 * Stand-in for the imported fonts while the query is in flight. A fresh `[]`
 * per render would rebuild the stylesheet handed to foliate on every render.
 */
const NO_FONTS: LocalFont[] = [];

/** Which side panel is open. Only one at a time, so they never stack. */
/** Which side panel is open lives with the panels themselves: see
 *  `useReaderPanels`, and `ReaderChrome` for the union. */

interface ReaderViewProps {
  bookId: string;
  title: string;
  /** Cover on the `fangce` resource protocol, for the TTS player card. */
  coverUrl: string | null;
  /** Book's own language tag, for the TTS voice picker's language lead. */
  bookLanguage: string | null;
  /** How the book is stored; PDF renders its fixed pages instead of prose. */
  format: BookFormat;
  chapters: ChapterMeta[];
  initialProgress: number;
  /** Stored reading anchor for foliate books (a CFI); `null` for the rest. */
  initialCfi: string | null;
  /** Chapter given in the URL, or `null` to resume the saved position. */
  initialChapter: number | null;
  /** Search term carried over from a result, highlighted in the chapter. */
  initialQuery: string;
  /** Character offset of a search hit, scrolled into view once rendered. */
  initialOffset: number | null;
  /**
   * A highlight named by a `fangce://` link the reader followed. Wins
   * over the saved position: following a link means "show me this", not
   * "carry on where I left off".
   */
  initialAnnotation: string | null;
  /** What the 返回 button says; where it goes is `onBack`'s business. */
  backLabel: string;
  onBack: () => void;
  /**
   * Whether this reader is one of a 对照阅读 pair, and whether it is the one
   * the reader is working in. `null` (or absent) is the ordinary reader: the
   * only one in the window, with the whole chrome and all window-level input.
   *
   * A pair has one bar above the books (rendered by `SplitReader`, naming
   * both) and one bar below them, which the active pane paints into through a
   * portal (`pairLayout`). What stays with each pane is what is *per book* —
   * position, annotations, ruler, the panels' own state, and the verbs its
   * chrome carries; what is *per window* — keyboard, gamepad, the voice
   * session — follows the active pane, so two mounted readers never both
   * answer one keypress (see the `secondary` gates below).
   */
  pair?: { active: boolean; onActivate?: () => void } | null;
  /** Opens the companion-book picker. Owned by the route, which is where the
   *  URL lives; the chrome only carries the button. */
  onOpenPair?: () => void;
  /** Reports which book this is and where it is open, for the pair's top bar
   *  to name both books and give each its own steppers. Pair mode only. */
  onIdentity?: (identity: PairIdentity) => void;
}

/**
 * The reader surface. Rendered only once the book, chapter table and a saved
 * position are all known, so the resume position is captured synchronously in
 * the initial state instead of being back-filled by an effect.
 *
 * Exported for `ReaderHost`, which is what a 对照阅读 pair mounts twice —
 * see the cycle note there.
 */
export function ReaderView({
  bookId,
  title,
  coverUrl,
  bookLanguage,
  format,
  chapters,
  initialProgress,
  initialCfi,
  initialChapter,
  initialQuery,
  initialOffset,
  initialAnnotation,
  backLabel,
  onBack,
  pair = null,
  onOpenPair,
  onIdentity,
}: ReaderViewProps) {
  /**
   * The companion pane of a pair: reading happens here, window-level control
   * does not. Every gate below reads this one flag — chrome, keyboard,
   * gamepad, the speech session — so the two readers mounted side by side
   * divide the window between them instead of fighting over it.
   */
  const secondary = pair !== null && !pair.active;
  // Destructure `mutate`: the mutation result object gets a new identity on
  // every render, and a per-render `setProgress` would drag `goTo` and the
  // position effect along, snapping the scroll back to the top on each frame.
  const { mutate: setProgress } = useSetProgress(bookId);
  // This book's own typography and paper, on top of the app-wide values — a
  // 对照阅读 pane changes the book it is showing, not its neighbour.
  const settings = useBookSettings(bookId);
  const {
    fontSize,
    setFontSize,
    lineHeightIdx,
    paraGapIdx,
    marginX,
    marginY,
    indent,
    customSurface,
    pageTransition,
    layoutMode,
    autoScrollSpeed,
    readingSpeed,
    rsvpWpm,
    paceSamples,
    pageNumbers,
    pageNumberPosition,
    pageIndicatorAutoHide,
    pdfFill,
    pdfNight: pdfNightAxis,
    pdfGap,
    pdfInvertImages,
    invertBookImages,
  } = settings;
  const speechRate = settings.speechRate;
  const speechVoiceURI = settings.speechVoiceURI;
  const speechGranularity = settings.speechGranularity;
  const speechWashStyle = settings.speechWashStyle;
  const speechWashColor = settings.speechWashColor;
  // The indicator is off, or it counts the unit the layout measured, or it
  // counts the whole book (the tally below, or foliate's own counter). One flag
  // for the two on-modes: the measurement below is what both of them need.
  const showPages = pageNumbers !== "off";
  // Fullscreen mirrors the OS window rather than owning it: macOS can leave it
  // without us, so the real state has to be re-read on resize.
  const { fullscreen, exitHint, toggle: toggleFullscreen } = useReaderFullscreen();
  const reduce = useReducedMotion();
  const annotationsQuery = useAnnotations(bookId);
  const createAnnotation = useCreateAnnotation(bookId);
  const deleteAnnotation = useDeleteAnnotation(bookId);
  const updateAnnotation = useUpdateAnnotation(bookId);
  const anchorAnnotation = useAnchorAnnotation(bookId);
  const setAnnotationNote = useSetAnnotationNote(bookId);
  const bookmarksQuery = useBookmarks(bookId);
  const createBookmark = useCreateBookmark(bookId);
  const deleteBookmark = useDeleteBookmark(bookId);
  const exportNotes = useExportNotes();
  // Reading time: accumulates while this book is the open one and hands the
  // total to the backend once a minute.
  useReadingClock(bookId);
  // The engine binding comes from the shell, not from here: a session has to
  // outlive the page it started on, or leaving the reader mid-sentence cancels
  // the voice (see `TtsHost`). `goTo` still stops it on every chapter change —
  // that is navigation's business, and the binding is shared rather than owned.
  const { tts, sleep: sleepTimer } = useTtsHost();
  const stop = tts.stop;

  /** The sleep timer's one question this page has to ask: has a chapter-scoped
   *  timer fired? Arming and stopping live in the shell beside the engine,
   *  because stopping the voice is the timer's job and the voice lives there —
   *  and the player that draws the countdown is up there with it. */
  const { clearIfChapterEnded } = sleepTimer;

  const annotations = annotationsQuery.data;
  const bookmarks = bookmarksQuery.data;
  // Saved annotations grouped by 0-based PDF page, memoised so the per-page
  // text-layer paint effects only rerun when the query data changes.
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of annotations ?? []) {
      const list = map.get(annotation.chapterIdx) ?? [];
      list.push(annotation);
      map.set(annotation.chapterIdx, list);
    }
    return map;
  }, [annotations]);
  // A PDF has no prose of its own: chapters are pages, and the fixed pages are
  // rendered by pdf.js. The extracted text still powers search, TTS and AI.
  const isPdf = format === "pdf";
  // Formats whose chapters *are* their pages, one rendered unit apiece: a comic
  // archive is one plate per entry, a PDF one canvas per page. Their page
  // counts are already exact, so the indicator reads them off the chapter list
  // instead of estimating a book from a single page of it — which is where
  // "1 / 1 页" on every page of a PDF came from.
  const chapterIsPage = isPdf || format === "cbz";
  // Two renderers, one corpus. foliate keeps a book's own XHTML + CSS: for
  // MOBI and AZW3 that is the only faithful rendering (wallpapers, part-title
  // plates, inline art) and an EPUB asks for no less — so all three go through
  // it, off the one list the notes page reads too (`isFoliateFormat`).
  // Everything else renders the extracted text: FB2 / CBZ / TXT / MD gain
  // nothing the text model cannot already do, and PDF renders through its own
  // pdf.js pipeline (foliate's PDF path is stubbed out). The chapters in the
  // database are the same either way, so search, TTS and AI never care which
  // renderer is on screen.
  const useFoliate = isFoliateFormat(format);
  // The highlight a followed `fangce://` link names. A link carries an id,
  // not a position, so the row has to be in hand before anything can be
  // anchored to it.
  const deepLinkTarget = useMemo(
    () =>
      initialAnnotation === null
        ? null
        : ((annotations ?? []).find((annotation) => annotation.id === initialAnnotation) ?? null),
    [annotations, initialAnnotation],
  );
  // The selection the toolbar is showing, and where to put it. The shape is
  // shared rather than declared here: four renderers build one, two of them the
  // foliate view's own callbacks (see `PendingSelection`).
  const [pending, setPending] = useState<PendingSelection | null>(null);
  // Quoted text for the AI drawer; `null` means "use the whole chapter".
  const [aiContext, setAiContext] = useState<string | null>(null);
  // Notes export: the format picker is open and waiting for a destination.
  const [exportingNotes, setExportingNotes] = useState(false);
  // The highlight the share card is drawing; `null` = closed. One canvas is
  // shared by whichever row was pressed last, so this carries the whole
  // annotation — the dialog re-renders on every change, not on mount.
  const [shareAnnotation, setShareAnnotation] = useState<Annotation | null>(null);
  // 词典 / 翻译 / 维基百科 popup over the selection; `null` = closed. The
  // toolbar closes when it opens — one floating surface at a time.
  const [lookup, setLookup] = useState<{
    kind: LookupKind;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  // Query the search panel opens with (the toolbar's 搜索 action).
  const [searchSeed, setSearchSeed] = useState("");

  // A followed link into a book that renders as prose opens on the chapter that
  // quotes the passage. The chapter is all this path can promise: an
  // annotation's character offset counts the text the importer stored, not the
  // paragraphs the page actually paints, so scrolling by it would land nowhere
  // in particular. foliate books do better — they open at the mark itself.
  const linkedChapter = !useFoliate && deepLinkTarget ? deepLinkTarget.chapterIdx : null;
  // A chapter named in the URL wins over the saved position: arriving from a
  // search result means "open here", not "resume".
  const start = useMemo(
    () =>
      initialChapter !== null
        ? { idx: Math.min(initialChapter, chapters.length - 1), fraction: 0 }
        : linkedChapter !== null
          ? { idx: Math.min(linkedChapter, chapters.length - 1), fraction: 0 }
          : locateChapter(chapters, initialProgress),
    [chapters, initialProgress, initialChapter, linkedChapter],
  );

  const [chapterIdx, setChapterIdx] = useState(start.idx);
  const [displayProgress, setDisplayProgress] = useState(() =>
    globalProgress(chapters, start.idx, start.fraction),
  );
  /** Fraction inside the current chapter, for labels and bookmarking. */
  const [fraction, setFraction] = useState(start.fraction);
  /** Direction of the last chapter switch, drives the page transition. */
  const [nav, setNav] = useState<1 | -1>(1);
  /**
   * The book as foliate reports it: its own table of contents, its own
   * position, and the three things the view hands back.
   *
   * Aliased to the names the page and the view already used, so no consumer
   * changed. `useFoliateToc` is the one exception: it is not a hook call, it is
   * a question about the TOC, and next to `useFoliate` and `useFoliateStyle` it
   * read like one. The wiring around the book — the view's handle, the two
   * calls the ruler makes into it, the axis a vertical book reads along and the
   * CFI it opens at — is `useFoliateReading`'s.
   */
  const {
    toc: foliateToc,
    setToc: setFoliateToc,
    sectionLabel: foliateSectionLabel,
    page: foliatePage,
    bookPage: foliateBookPage,
    tocChapters: foliateChapters,
    tocIdx: foliateTocIdx,
    hasToc,
    remember: rememberFoliateLocation,
    select: onFoliateSelection,
    annotationClick: onFoliateAnnotationClick,
    anchor: onFoliateAnchor,
    ref: foliateRef,
    clearPaintedMatches,
    rulerLines: foliateRulerLines,
    readsLeftward,
    startCfi,
  } = useFoliateReading({
    bookId,
    deepLinkTarget,
    initialCfi,
    writingMode: settings.writingMode,
    useFoliate,
    chapters,
    setChapterIdx,
    setDisplayProgress,
    setProgress,
    setPending,
    setLookup,
    annotations,
    anchorAnnotation,
  });

  /** Continuous scroll vs paged single/double spread. */
  const paged = layoutMode !== "scroll";
  const scrollRef = useRef<HTMLDivElement>(null);
  // The reading viewport: the box the reading ruler is positioned against,
  // which is the pane below the header rather than the window.
  const viewportRef = useRef<HTMLDivElement>(null);
  /**
   * Which panel is open, and the search drawer's query.
   *
   * It is declared down here rather than up with the rest of the reader's
   * state because closing the drawer has to reach the foliate view above it —
   * the query is not the only thing the search leaves behind. See
   * `useReaderPanels`.
   */
  const {
    panel,
    setPanel,
    toggle: togglePanel,
    search,
    setSearch,
    close: closePanel,
  } = useReaderPanels(initialQuery, clearPaintedMatches);
  /**
   * A panel belongs to the book being read. Handing the window to the other
   * book closes this one's drawer: left open, it kept dimming a page nobody
   * was working on, and the bar's buttons — which now drive the other book —
   * could no longer close it. That leftover drawer is what read as "the panel
   * opened in the wrong book".
   *
   * Watches `panel` as well as `secondary`: a panel opened in the same tick
   * that handed the window away (a tool clicked as the other book's activation
   * lands) would otherwise arrive *after* this effect had already run.
   */
  useEffect(() => {
    if (secondary && panel !== "none") closePanel();
  }, [secondary, panel, closePanel]);
  /**
   * Scrolls the reading flow by one measured distance, in the scrolled layout,
   * and reports how far it actually went.
   *
   * 🔴 Which element is the scroller is the renderer's answer, not a CSS class:
   * `[data-reading-content]` is `overflow-y-auto` for a plain-text book and
   * `overflow-hidden` for one foliate renders — the scrollport lives inside the
   * section — so the foliate book goes through the view's own `scrollByPx`.
   * The report is what lets the ruler tell a clean block step from a clamp at
   * an edge of the flow, and it is why the plain-text path writes `scrollTop`
   * and reads it back instead of `scrollBy` (which reports nothing).
   */
  const scrollFlowBy = useCallback(
    (delta: number): number => {
      if (useFoliate) return foliateRef.current?.scrollByPx(delta, 0) ?? 0;
      const el = scrollRef.current;
      if (!el) return 0;
      const before = el.scrollTop;
      el.scrollTop = before + delta;
      return el.scrollTop - before;
    },
    [useFoliate, foliateRef],
  );
  // The reading ruler, driven imperatively for the same reason the foliate view
  // is: an arrow key has to ask the band to step *before* it becomes a page turn,
  // and only the ruler knows whether there is another block of lines to step to.
  const rulerRef = useRef<ReadingRulerHandle | null>(null);

  /**
   * Re-reads the live selection's box and moves the toolbar onto it.
   *
   * The toolbar is `position: fixed`, so anything that moves the page under it
   * — a wheel scroll, a page turn, a font that finished loading — leaves it
   * pointing at words that are no longer there. That reads as "the toolbar
   * sits a line away from what I selected", which no amount of care at
   * selection time can prevent. Both homes of a selection are covered: the
   * host document (prose, PDF text layer) and a foliate section iframe, whose
   * own `getSelection` the host cannot see.
   */
  const remeasureSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const domRange = selection.getRangeAt(0);
      const rect = domRange.getBoundingClientRect();
      const bottom = selectionBottom(domRange.getClientRects(), rect);
      const x = rect.left + rect.width / 2;
      setPending((prev) => {
        // Same object when nothing moved, so a scroll that does not carry the
        // selection costs no re-render of the whole reader.
        if (
          !prev ||
          (Math.abs(prev.x - x) < 1 &&
            Math.abs(prev.y - rect.top) < 1 &&
            Math.abs((prev.bottom ?? 0) - bottom) < 1)
        ) {
          return prev;
        }
        return { ...prev, x, y: rect.top, bottom };
      });
      return;
    }
    const box = foliateRef.current?.selectionBox();
    if (box) setPending((prev) => (prev?.cfi ? { ...prev, ...box } : prev));
  }, [foliateRef]);

  const toolbarOpen = pending !== null;
  useEffect(() => {
    if (!toolbarOpen) return;
    const el = scrollRef.current;
    el?.addEventListener("scroll", remeasureSelection, { passive: true });
    window.addEventListener("resize", remeasureSelection);
    return () => {
      el?.removeEventListener("scroll", remeasureSelection);
      window.removeEventListener("resize", remeasureSelection);
    };
  }, [toolbarOpen, remeasureSelection]);
  // Fraction to apply once the current chapter body has rendered. Starts at the
  // saved position, then is reset to the top of the chapter on navigation.
  const pendingScroll = useRef<number>(start.fraction);
  // Offset of a search hit to reveal instead of the scroll fraction.
  const pendingFocus = useRef<number | null>(initialOffset);
  /**
   * The write half of the slot above, handed to the hit jumps rather than the
   * ref itself: a hook must not mutate a value it does not own, and this one
   * is read by `applyPending` — in the navigation, declared further down.
   */
  const setPendingFocus = useCallback((offset: number | null) => {
    pendingFocus.current = offset;
  }, []);
  const debounceRef = useRef<number | null>(null);
  // Pending "the page has stopped moving" notice to the reading ruler. Its own
  // timer, not `debounceRef`: that one persists the position and the two must be
  // able to disagree about when the page settled.
  const rulerSettleRef = useRef<number | null>(null);
  // The way the page last turned, for the same notice: a page the reader arrived
  // on meets the band at its start, and one page turn can still be settling when
  // the notice goes out, so the direction has to outlive the call to `flip`.
  const rulerDirRef = useRef<1 | -1 | 0>(0);
  // Latest position along the active axis, read outside the scroll handler.
  const fractionRef = useRef<number>(start.fraction);
  // The offset the layout hook last scrolled the viewport to itself, so
  // `onScroll` below can tell a re-anchor from the reader leaving.
  const layoutScrollRef = useRef<{ left: number; top: number } | null>(null);
  // Everything about the column grid: measured viewport, the tail spacer and
  // the two mirrors every scroll callback reads (mode, applied margin).
  const { tail, measureTail, viewportW, viewportH, pinnedW, layoutModeRef, marginRef } =
    useReaderLayout({
      scrollRef,
      paged,
      layoutMode,
      marginX,
      fullscreen,
      fractionRef,
      layoutScrollRef,
      fontSize,
      lineHeightIdx,
      paraGapIdx,
      indent,
      fontFamily: settings.fontFamily,
    });

  // The PDF path's own bookkeeping — the scroll slots, the pinch zoom, a page
  // jump's position, the turn's snapshot and the view's three callbacks —
  // lives in `usePdfReading`. Every input is a ref or a flag the page already
  // has at this point, so the page keeps reading the same names below.
  const {
    zoom: pdfZoom,
    animated: pdfZoomAnimated,
    step: stepPdfZoom,
    outline,
    scrolledPage: pdfScrollPage,
    claimPage: pdfClaimPage,
    takeSuppressed: pdfTakeSuppressed,
    trackScrolledPage: pdfTrackScrolledPage,
    restoreScrollSlot: pdfRestoreScrollSlot,
    turn: pdfTurn,
    onSelection: onPdfSelection,
    onAnnotationClick: onPdfAnnotationClick,
    onLayout: handlePdfLayout,
  } = usePdfReading({
    bookId,
    isPdf,
    paged,
    scrollRef,
    viewportRef,
    layoutModeRef,
    marginRef,
    fractionRef,
    setPending,
  });
  /** Folds each progress save into the reading-speed estimate. The hook owns
   *  the two refs that used to sit here — see `useReadingPace`. */
  const reportPace = useReadingPace();
  /** Hover-reveal flip affordance for paged modes; hides itself after 2s idle. */
  const [flipHint, setFlipHint] = useState(false);
  /** Stillness: true once the pointer has not moved over the page for `IDLE_MS`.
   *  What an auto-hidden page indicator waits on, and what takes the pointer
   *  itself off the paper — the page is what the reader is looking at, not the
   *  chrome. The drawer is portalled inside this box, so working in it counts
   *  as activity too. */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  /** Where the last real move was, so a move that went nowhere is not one. */
  const lastMove = useRef({ x: -1, y: -1 });
  /**
   * Any real pointer activity in the page restarts the clock.
   *
   * A move the browser invents does not count: WebKit synthesizes mousemoves
   * when content scrolls under a resting pointer (a keyboard or wheel page
   * turn), and those would keep the number on the page for as long as the
   * reader flipped through chapters without touching the mouse.
   *
   * **Client coordinates, never screen ones.** A headless Linux runner has no
   * screen, so WebKit reports `screenX/Y` as 0,0 for every synthetic move —
   * with those, this guard reads "the pointer never moved" and the number
   * never comes back. That is not hypothetical: it is exactly what CI's WebKit
   * run said. `clientX/Y` are viewport-relative and always real.
   */
  const wake = useCallback((event?: { clientX: number; clientY: number }) => {
    if (event) {
      if (event.clientX === lastMove.current.x && event.clientY === lastMove.current.y) return;
      lastMove.current = { x: event.clientX, y: event.clientY };
    }
    setIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  // The clock starts when the page opens: the number is there to be read, and
  // then it steps aside on its own without anyone having to move a mouse. Only
  // the timer is armed here — `idle` already starts false, so no state write.
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, []);
  /** 1-based position inside the chapter's column count, for the page indicator. */
  const [pageInfo, setPageInfo] = useState<{ page: number; pages: number } | null>(null);

  /**
   * Every setting a page count depends on. A change re-paginates the chapter,
   * so the pages already in the tally belong to a layout that is gone.
   */
  const densityKey = `${layoutMode}|${marginX}|${marginY}|${fullscreen}|${fontSize}|${lineHeightIdx}|${paraGapIdx}|${indent}`;

  const flipHintTimer = useRef<number | null>(null);
  // WebKit synthesizes mousemoves when content scrolls under a resting cursor
  // (keyboard and wheel flips), which would wake the flip chrome. Only real
  // pointer travel re-reveals it; pointer-down still always does.
  const lastPointer = useRef({ x: 0, y: 0 });
  const revealFlipHint = useCallback(() => {
    setFlipHint(true);
    if (flipHintTimer.current !== null) window.clearTimeout(flipHintTimer.current);
    flipHintTimer.current = window.setTimeout(() => setFlipHint(false), 2000);
  }, []);
  const revealFlipHintOnMove = useCallback(
    (event: React.MouseEvent) => {
      const dx = event.clientX - lastPointer.current.x;
      const dy = event.clientY - lastPointer.current.y;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      if (Math.hypot(dx, dy) < 3) return;
      revealFlipHint();
    },
    [revealFlipHint],
  );
  useEffect(
    () => () => {
      if (flipHintTimer.current !== null) window.clearTimeout(flipHintTimer.current);
    },
    [],
  );

  const chapter = useChapter(bookId, chapterIdx);
  // Wallpaper markers (Kindle CSS page backgrounds) are page decoration, not
  // content: blank them once here so TTS, search, selection and highlighting
  // never see an asset path, while every paragraph index stays stable for
  // annotation anchoring. The path itself rides along for the page painter.
  const chapterData = useMemo(() => {
    const data = chapter.data;
    if (!data) return data;
    const marker = data.paragraphs.find((paragraph) =>
      paragraph.startsWith(WALLPAPER_PARAGRAPH_PREFIX),
    );
    return {
      ...data,
      wallpaper: marker ? marker.slice(WALLPAPER_PARAGRAPH_PREFIX.length) : null,
      paragraphs: data.paragraphs.map((paragraph) =>
        paragraph.startsWith(WALLPAPER_PARAGRAPH_PREFIX) ? "" : paragraph,
      ),
    };
  }, [chapter.data]);
  const wallpaperPath = chapterData?.wallpaper ?? null;

  /**
   * 简繁转换, display layer for the prose path. The converter arrives with the
   * dictionary chunk; until then (and for `off`) the chapter reads as
   * published. The rewrite sits *here* — one memo above every consumer — so
   * the rendered text, the selection resolver, the read-aloud queue and the AI
   * context all measure against the same string, exactly the invariant the
   * wallpaper blanking below it established. Marker paragraphs (image / link /
   * wallpaper) keep their syntax untouched.
   */
  const zhAvailable = !chapterIsPage;
  // 正文加粗 asks a different question of the same set of books: does the app
  // set the body text, or is the text a picture of itself? A PDF page is a
  // canvas pdf.js painted and a comic entry is a plate, so neither has a
  // weight to change and the panel does not offer the switch there.
  const boldAvailable = !chapterIsPage;
  const zhConverter = useZhConverter(zhAvailable ? settings.zhConvert : "off");
  const displayChapterData = useMemo(() => {
    if (!chapterData || !zhConverter) return chapterData;
    return {
      ...chapterData,
      paragraphs: chapterData.paragraphs.map((paragraph) =>
        paragraph &&
        !paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX) &&
        !paragraph.startsWith(LINK_PARAGRAPH_PREFIX)
          ? zhConverter(paragraph)
          : paragraph,
      ),
    };
  }, [chapterData, zhConverter]);
  /**
   * The page indicator, and the tally its whole-book unit is built from.
   *
   * `densityKey` comes in as the one value it is: which settings a page count
   * depends on is a layout fact, and the string is what the tally is
   * invalidated against.
   */
  const pageCounter = usePageCounter({
    unit: pageNumbers,
    chapterIsPage,
    useFoliate,
    chapters,
    chapterIdx,
    fraction,
    pageInfo,
    foliatePage,
    foliateBookPage,
    densityKey,
    // The test the tally has always made, kept literal on purpose — see the
    // option's own note on why it is not `!chapterData`.
    chapterMissing: chapterData === null,
  });
  // Aliased so the scroll handler and the indicator keep reading the same two
  // names: `countChapterPages` goes into that handler's dependency list, so it
  // has to be a plain identifier there.
  const { shown: shownPages, count: countChapterPages } = pageCounter;
  const bookImagesQuery = useBookImages(bookId);
  /**
   * The book's pictures, and which one the lightbox viewer is on.
   *
   * The importer's list wins whenever it has one; the browser build has no
   * `book_images`/`book_asset` behind it, so pictures arrive already decoded by
   * foliate and each click registers its entry path, the blob URL foliate made
   * and the section it lives in.
   *
   * Aliased to the names the four call sites already used — the keyboard
   * handler, the chapter view, foliate's click, and the viewer itself.
   */
  const {
    images: bookImages,
    urls,
    path: lightboxPath,
    index: lightboxIdx,
    openAt: openImageAt,
    openFromBook: openBookImage,
    step: stepLightbox,
    close: closeLightbox,
  } = useImageLightbox(bookImagesQuery.data);

  const fontsQuery = useFonts();
  const fonts = fontsQuery.data ?? NO_FONTS;

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const autoAdvance = useRef(false);

  /**
   * Auto-scroll. Declared here rather than beside the other reading settings
   * because `goTo` below clears it on a chapter jump, and the loop needs the
   * layout refs this far down.
   *
   * Destructured to the names the two call sites already used: the footer's
   * props are unchanged, and `stopAutoScroll` is a plain identifier for
   * `goTo`'s dependency list.
   */
  const {
    on: autoScrollOn,
    toggle: toggleAutoScroll,
    stop: stopAutoScroll,
  } = useAutoScroll({
    paged,
    speed: autoScrollSpeed,
    useFoliate,
    layoutModeRef,
    foliateRef,
    scrollRef,
  });

  /**
   * The page the reader is on, read by `goTo` rather than the page number it
   * closes over. A held turn reverts through a `goTo` built *before* the turn
   * moved the page, and one reading its own captured number answers "already
   * there" to the very page it is being asked to go back to.
   */
  const chapterIdxRef = useRef(chapterIdx);
  useEffect(() => {
    chapterIdxRef.current = chapterIdx;
  }, [chapterIdx]);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, chapters.length - 1));
      if (useFoliate) {
        // The panels count chapters the importer's way; a foliate book is
        // navigated by whole-book fraction, the only anchor such an entry
        // carries once the container's own sections are on screen.
        const at = globalProgress(chapters, clamped, 0);
        stop();
        setChapterIdx(clamped);
        setFraction(0);
        setDisplayProgress(at);
        stopAutoScroll();
        foliateRef.current?.goToFraction(at);
        return;
      }
      if (clamped === chapterIdxRef.current) return;
      // A chapter switch invalidates the paragraph queue the voice is walking.
      stop();
      setNav(clamped > chapterIdxRef.current ? 1 : -1);
      setChapterIdx(clamped);
      // A paged PDF has no scrollable overflow, so its fraction rides on the
      // page index; a later mode switch re-anchors on the same page.
      if (isPdf) pdfClaimPage(clamped, chapters.length);
      pendingScroll.current = 0;
      if (!isPdf) fractionRef.current = 0;
      const progress = globalProgress(chapters, clamped, 0);
      setProgress({ progress });
      setDisplayProgress(progress);
      setFraction(0);
      stopAutoScroll();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [
      chapterIdxRef,
      chapters,
      isPdf,
      pdfClaimPage,
      setProgress,
      stop,
      stopAutoScroll,
      useFoliate,
      foliateRef,
    ],
  );

  /** Jumps to a fraction inside a chapter, used by bookmarks. */
  const jumpTo = useCallback(
    (idx: number, target: number) => {
      if (useFoliate) {
        const at = globalProgress(chapters, idx, target);
        setChapterIdx(idx);
        setFraction(target);
        setDisplayProgress(at);
        foliateRef.current?.goToFraction(at);
        return;
      }
      if (idx === chapterIdx) {
        const el = scrollRef.current;
        if (el) applyPosition(el, target, layoutModeRef.current, marginRef.current);
        fractionRef.current = target;
        setFraction(target);
        setDisplayProgress(globalProgress(chapters, idx, target));
        return;
      }
      goTo(idx);
      // `goTo` resets the pending fraction; restore ours after it.
      pendingScroll.current = target;
    },
    [chapterIdx, chapters, goTo, layoutModeRef, marginRef, useFoliate, foliateRef],
  );

  const onChapterEnd = useCallback(() => {
    // A "read to the end of the chapter" timer ends the session here.
    if (clearIfChapterEnded()) {
      stop();
      return;
    }
    if (chapterIdx < chapters.length - 1) {
      autoAdvance.current = true;
      goTo(chapterIdx + 1);
    }
  }, [chapterIdx, chapters.length, goTo, stop, clearIfChapterEnded]);

  /**
   * Read-aloud, over whichever queue the renderer on screen provides.
   *
   * `paragraphs` is the chapter's prose with the wallpaper markers already
   * blanked — the same list the queue is cut from, so a marker never becomes an
   * utterance. `onChapterEnd` is the voice rolling past the last unit of a
   * chapter, which is navigation's business (the same shape as the sleep
   * timer's `onFire`).
   */
  const readAloud = useReadAloud({
    tts,
    useFoliate,
    isPdf,
    paragraphs: displayChapterData?.paragraphs ?? null,
    scrollRef,
    foliateRef,
    storedVoice: speechVoiceURI,
    rate: speechRate,
    granularity: speechGranularity,
    updateSettings: settings.update,
    onChapterEnd,
  });
  // Destructured for the dependency arrays below: a member expression there is
  // not statically checkable, and depending on `readAloud` itself would rebuild
  // them on every render — which for the position effect means re-applying the
  // pending scroll, i.e. snapping the page back to the top of the chapter.
  const { span: speechSpan, playFromStart, reveal } = readAloud;

  /**
   * A session left playing belongs to the reader that started it.
   *
   * Coming back to the chapter that was being read picks it up — that is the
   * whole point of the engine outliving this page — but anything else has to end
   * it: the queue the voice is walking is another chapter's, and the player
   * behind the bar reads its clocks and its scrubber from what this page
   * publishes below. Read once, off the store rather than off this render's
   * subscription, because the publish lands after this effect runs.
   *
   * Read *during the first render* rather than inside the effect, because two
   * things need the same answer — the effect, and the landing this page owes a
   * voice that got here first — and the second of them is a render-time
   * decision. By the time the effect runs, this page has already published a
   * queue of its own.
   */
  const [inherited] = useState(sessionNow);
  const ours =
    inherited.bookId !== null && inherited.bookId === bookId && inherited.chapterIdx === chapterIdx;
  /** The paragraph the voice is in, when the voice is the one that decides
   *  where this page opens. Read by `applyPending`, ahead of the fraction. */
  const pendingSpeechPara = useRef<number | null>(null);
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current) return;
    adopted.current = true;
    // The companion pane neither adopts a session nor steals one: the
    // session belongs to whichever book the reader is working in, and a
    // `stop()` from here would end the voice mid-sentence in the other pane.
    // ponytail: a pane that becomes active later does not adopt on the
    // switch — starting the voice afresh is one keypress, and the reverse
    // (re-adoption) has no safe trigger.
    if (secondary) return;
    if (inherited.bookId !== null && !ours) {
      stop();
      return;
    }
    if (!ours || tts.unit === null || tts.status === "idle") return;
    // A reader who comes back while the voice is on lands on the voice, not on
    // wherever the page happened to be left. The prose path can do that exactly:
    // the unit carries the paragraph it sits in, and `applyPending` centres it
    // once the body has rendered. A Kindle book cannot — its blocks belong to
    // the section, and only the view can collect them — so the section is asked
    // to bring the unit into view, which is the same call「回到阅读」makes. A PDF
    // or a CBZ needs neither: its chapter *is* the page the voice is on.
    if (useFoliate) reveal();
    else if (!chapterIsPage) pendingSpeechPara.current = inherited.units[tts.unit]?.source ?? null;
  }, [stop, inherited, ours, tts.unit, tts.status, useFoliate, chapterIsPage, reveal, secondary]);

  // Set when the voice rolls off the end of a chapter, consumed by the
  // position effect below once the next chapter has rendered.
  const applyPending = useCallback(
    (el: HTMLDivElement) => {
      // A PDF page jump already scrolled the uniform slots directly; the
      // chapter load that follows must not land fraction 0 on top of it.
      if (pdfTakeSuppressed()) return;
      const focus = pendingFocus.current;
      pendingFocus.current = null;
      // The voice's landing, when this page was opened by a session that was
      // already running (see the adoption effect): a paragraph of the chapter
      // on screen, centred. An index the chapter does not have is ignored
      // rather than obeyed — it can be answered off a list that has since
      // changed — and the fraction below has it, as it always did.
      const speechPara = pendingSpeechPara.current;
      pendingSpeechPara.current = null;
      const frac = pendingScroll.current;
      pendingScroll.current = 0;
      const paragraphs = displayChapterData?.paragraphs ?? [];
      const continueSpeech = autoAdvance.current;
      autoAdvance.current = false;
      if (continueSpeech) playFromStart();
      if (speechPara !== null) {
        const node = el.querySelector(`[data-para-idx="${speechPara}"]`);
        if (node) {
          node.scrollIntoView({ block: "center" });
          return;
        }
      }
      if (focus !== null) {
        const target = paragraphAt(paragraphs, focus);
        el.querySelector(`[data-para-idx="${target}"]`)?.scrollIntoView({ block: "center" });
        return;
      }
      // A PDF's scroll layout is a stack of uniform page slots, and the saved
      // position is a *page index* — see `usePdfReading.restoreScrollSlot`.
      if (isPdf && layoutModeRef.current === "scroll") {
        pdfRestoreScrollSlot(el, chapterIdx, chapters);
        return;
      }
      applyPosition(el, frac, layoutModeRef.current, marginRef.current);
    },
    [
      displayChapterData,
      chapterIdx,
      chapters,
      isPdf,
      layoutModeRef,
      marginRef,
      pdfRestoreScrollSlot,
      pdfTakeSuppressed,
      // `playFromStart` carries the queue and `onChapterEnd` in its own
      // identity, so neither is listed again here.
      playFromStart,
    ],
  );

  // Apply the pending position once the chapter body has rendered: a search hit
  // scrolls its paragraph to the middle, otherwise the saved fraction applies.
  // Auto-advance rides along: the voice restarts at paragraph zero of the new
  // chapter inside the same frame the body appears.
  useEffect(() => {
    if (chapterData == null) return;
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      measureTail(el);
      applyPending(el);
      // New chapter, new lines: the ruler measures the page it is now over. The
      // chapter body is in the DOM by the time this effect runs, and the frame
      // covers the tail spacer the ruler's own geometry depends on. A turn's
      // direction rides along once — a page the reader arrived on meets the band
      // at its start — and is spent here, so a later chapter jump (a bookmark, a
      // TTS roll) keeps the band where the reader was put.
      const dir = rulerDirRef.current;
      rulerDirRef.current = 0;
      relayRulerLayout(el, dir);
    });
    return () => cancelAnimationFrame(frame);
  }, [chapterData, applyPending, measureTail]);

  /** Flips one page in a paged layout; rolls into the neighbouring chapter at the edges. */
  /**
   * One page turn. `scrub` asks for the turn to be left open so a gesture can
   * drive it — the handle comes back instead of the animation being started —
   * and is only honoured where there is a sheet to hold (a paged PDF turning
   * with the mesh curl). Everywhere else the turn plays out on its own.
   */
  const flip = useCallback(
    (dir: 1 | -1, scrub = false): CurlTurn | null => {
      if (useFoliate) {
        // At the first/last page of the current section, roll explicitly into
        // the neighbouring section (foliate's implicit next()/prev() cross only
        // when its scroll probe reports the page edge, which is fragile);
        // otherwise turn the page normally. This makes "last page + next ->
        // next chapter" deterministic for keyboard paging.
        const handle = foliateRef.current;
        if (!handle) return null;
        // Same handover as the prose turn below: out of the way while the page
        // moves, back on the page that arrives (foliate relays that itself, with
        // the direction it was flipped).
        relayRulerTurn(viewportRef.current, dir);
        if (handle.atEdge(dir)) handle.section(dir);
        else handle.flip(dir);
        return null;
      }
      const el = scrollRef.current;
      if (!el) return null;
      // A prose page turn is a page the reader arrives on: the ruler is told the
      // turn has started — it steps out of the way rather than riding this page
      // down to its last line — and meets the new page at the far edge when the
      // turn's own relay lands (see `flipPage` / the settle notice in `onScroll`).
      rulerDirRef.current = dir;
      relayRulerTurn(el, dir);
      // A PDF page fills the viewport exactly — there is no column to slide,
      // so a flip is a page step, and the page being left has to be copied out
      // before the step. Those are the PDF branch's own (see
      // `usePdfReading.turn`); what is left here is the turn's shared preamble.
      if (isPdf) {
        return pdfTurn({
          dir,
          scrub,
          chapterIdx,
          revert: () => goTo(chapterIdx),
          goTo,
          pageTransition,
          reduce,
        });
      }
      const max = el.scrollWidth - el.clientWidth;
      const pos = el.scrollLeft;
      if (dir === 1 && pos >= max - 2) {
        goTo(chapterIdx + 1);
        return null;
      }
      if (dir === -1 && pos <= 2) {
        goTo(chapterIdx - 1);
        return null;
      }
      // Snap to an exact column boundary: the viewport width includes the page
      // margins, so scrolling by clientWidth drifts and slices the next column.
      const mode = layoutModeRef.current;
      const margin = marginRef.current;
      const pitch = columnPitch(el, mode, margin);
      const page = pitch > 0 ? (mode === "double" ? 2 : 1) : 0;
      if (page === 0 || pitch <= 0) {
        flipPage(el, pos + dir * el.clientWidth, pageTransition, dir, reduce);
        return null;
      }
      const target = (Math.round(pos / pitch) + dir * page) * pitch;
      flipPage(el, Math.max(0, Math.min(target, max)), pageTransition, dir, reduce);
      return null;
    },
    [
      chapterIdx,
      goTo,
      isPdf,
      layoutModeRef,
      marginRef,
      pdfTurn,
      useFoliate,
      foliateRef,
      pageTransition,
      reduce,
    ],
  );

  /** Chapter step; foliate's sections replace our chapter index for foliate books. */
  const stepChapter = useCallback(
    (dir: 1 | -1) => {
      if (useFoliate) {
        foliateRef.current?.section(dir);
        return;
      }
      goTo(chapterIdx + dir);
    },
    [chapterIdx, goTo, useFoliate, foliateRef],
  );

  /**
   * The wheel gesture, held across rebuilds of the handler below.
   *
   * A drag starts a turn, and starting a turn changes the page number — which
   * rebuilds `flip`, which re-runs the effect. Anything the handler kept in its
   * own locals would be dropped on the very event that began the gesture: the
   * accumulator would start over and the sheet would be lost with the page
   * already turned, with nothing left holding it.
   */
  const dragState = useRef({
    acc: 0,
    at: 0,
    flipped: false,
    progress: 0,
    timer: 0,
    drag: null as CurlTurn | null,
  });

  // In paged modes the wheel flips whole pages instead of nudging pixels:
  // free pixel scrolling always ends between two columns. A zoomed PDF pans
  // natively instead, and a pinch scales rather than flips.
  useEffect(() => {
    if (layoutMode === "scroll") return;
    if (isPdf && pdfZoom !== 1) return;
    const el = scrollRef.current;
    if (!el) return;
    const state = dragState.current;

    /**
     * How far the wheel has dragged the sheet. Measured from where the turn was
     * claimed, not from zero: the travel that earned the turn is spent, and
     * counting it again would jump the sheet the moment it appears.
     */
    const travelled = (acc: number, width: number) =>
      Math.min(1, Math.max(0, (Math.abs(acc) - WHEEL_START_PX) / Math.max(1, width)));

    /** The gesture is over: let the sheet go, one way or the other. */
    const settle = () => {
      window.clearTimeout(state.timer);
      state.timer = 0;
      state.acc = 0;
      state.flipped = false;
      const held = state.drag;
      state.drag = null;
      if (!held) return;
      held.finish(state.progress > SCRUB_COMMIT);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const now = performance.now();
      // One gesture = one page. Trackpad inertia keeps firing events long
      // after the flip, so a fixed cooldown would turn one swipe into two
      // pages; instead, only silence longer than GESTURE_GAP re-arms flipping.
      if (now - state.at > GESTURE_GAP) settle();
      state.at = now;
      state.acc += event.deltaY + event.deltaX;
      if (state.drag) {
        state.progress = travelled(state.acc, el.clientWidth);
        state.drag.set(state.progress);
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(settle, GESTURE_GAP);
        return;
      }
      if (state.flipped) return;
      if (Math.abs(state.acc) >= WHEEL_START_PX) {
        // A turn that can be held — a paged PDF turning with the mesh curl —
        // is handed over to the wheel from here, and the sheet follows the
        // gesture instead of stepping a whole page at once.
        const held = flip(state.acc > 0 ? 1 : -1, true);
        if (!held) {
          state.acc = 0;
          state.flipped = true;
          return;
        }
        state.drag = held;
        // Where this event already dragged it — a fast swipe arrives as one
        // large delta, and the sheet has to answer it on the spot rather than
        // waiting for a second event that may never come.
        state.progress = travelled(state.acc, el.clientWidth);
        held.set(state.progress);
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(settle, GESTURE_GAP);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // The drag is deliberately not settled on teardown: starting one changes
    // the page number, which rebuilds `flip` and re-runs this effect, and
    // settling there would commit a page the reader still has hold of. The
    // overlay lives inside the viewport, so an unmount takes it with it.
    return () => el.removeEventListener("wheel", onWheel);
  }, [flip, isPdf, layoutMode, pdfZoom]);

  /**
   * One step *along the reading axis*, which is not the same thing as a page.
   *
   * The reading ruler owns that axis while it is on: a step lays the band over
   * the next block of lines — and in the scrolled layout, past the trigger line
   * (`ReadingRuler.scroll`), the same step scrolls the flow under the band, so
   * the arrows never scroll the page *instead of* the ruler. Only when the band
   * has run out of page does the step move the reading on itself: a page turn in
   * the paged layouts, the neighbouring section in the scrolled one.
   *
   * Shared by the arrow keys and the gamepad, and it has to be: those are the
   * same gesture, and two copies of "ruler first, page second" would drift apart
   * the first time one of them was touched.
   *
   * 🔴 The scrolled fallback goes through `flip`, and that is not a preference:
   * it is the only branch that knows which element is the scroller.
   * `[data-reading-content]` is `overflow-y-auto` for a plain-text book and
   * **`overflow-hidden` for a book foliate renders** — foliate owns its own
   * scrollport inside the section, and the host cannot be scrolled at all.
   * `flip` crosses into the next section when the renderer reports the section
   * edge (`atEdge`), which is what is left of the step once the auto-scroll has
   * absorbed everything short of the flow's own end. A plain-text flow scrolls
   * its own container, whose clamp makes the call a no-op at either edge.
   */
  const stepAlongReading = useCallback(
    (step: 1 | -1) => {
      if (rulerRef.current?.move(step)) return;
      if (paged || useFoliate) {
        flip(step);
        return;
      }
      // A plain-text book in the scrolled layout: its host *is* the scroller.
      const block = fontSize * (LINE_HEIGHTS[lineHeightIdx] ?? 1.8) * settings.rulerLines;
      scrollRef.current?.scrollBy({ top: step * block, behavior: "smooth" });
    },
    [flip, fontSize, lineHeightIdx, paged, useFoliate, settings.rulerLines],
  );

  // Keyboard paging.
  //
  // The decision table itself is in `readerKeys.ts` — pure, so the whole of
  // "which key does what, and when" is asserted there instead of only being
  // reachable through the browser suite. What is left here is the two jobs that
  // need this component's own closure: build the context the gates read, and
  // turn a binding's id into the call that does the work.
  const runReaderKey = useCallback(
    (id: ReaderKeyId): void => {
      switch (id) {
        case "reader.lightbox.close":
          closeLightbox();
          return;
        case "reader.lightbox.next":
          stepLightbox(1);
          return;
        case "reader.lightbox.prev":
          stepLightbox(-1);
          return;
        case "reader.dismiss":
          // One floating surface at a time: a lookup closes before any panel.
          if (lookup) {
            setLookup(null);
            return;
          }
          if (pending) {
            window.getSelection()?.removeAllRanges();
            setPending(null);
            return;
          }
          // The drawer's own way out, cleanup and all. This used to be written
          // out here — clear the query, set the panel to none — and it forgot
          // the other half of what the search drawer leaves behind, so Escape
          // closed it and left foliate's match highlights painted on the page.
          if (closePanel()) return;
          if (fullscreen) void toggleFullscreen();
          return;
        case "reader.ruler.forward":
          stepAlongReading(1);
          return;
        case "reader.ruler.back":
          stepAlongReading(-1);
          return;
        case "reader.page.next":
          flip(1);
          return;
        case "reader.page.prev":
          flip(-1);
          return;
        // Vertical type runs the other way, so the arrow on the right is the
        // page before the one on screen: the keys follow the pages, not the
        // screen. The binding is named for the key, so this is where the
        // direction is decided.
        case "reader.turn.right":
          flip(readsLeftward ? -1 : 1);
          return;
        case "reader.turn.left":
          flip(readsLeftward ? 1 : -1);
          return;
        case "reader.chapter.next":
          stepChapter(1);
          return;
        case "reader.chapter.prev":
          stepChapter(-1);
          return;
      }
    },
    [
      closeLightbox,
      // Not `panel`: the dismiss cascade asks `closePanel()` whether it
      // consumed the key, and that callback keeps one identity across renders —
      // so this no longer re-makes every time a drawer opens or closes.
      closePanel,
      flip,
      fullscreen,
      lookup,
      pending,
      readsLeftward,
      stepAlongReading,
      stepChapter,
      stepLightbox,
      toggleFullscreen,
    ],
  );

  // Re-binds only when something a gate reads changes. `settings.readingRuler`
  // is in that list for the reason it always was: the band claims the arrows
  // only while it is on, so without it the key that just turned the band on
  // would keep turning pages until something else changed.
  useEffect(() => {
    // The companion pane answers no window-level keys: in a pair the keyboard
    // belongs to the pane the reader is working in, which is what the click
    // that activated it chose. Two mounted readers both bound would turn two
    // pages per keypress.
    if (secondary) return;
    const ctx: ReaderKeyContext = {
      lightboxOpen: lightboxPath !== null,
      rulerOn: settings.readingRuler,
      paged,
      readsLeftward,
    };
    const onKey = (event: KeyboardEvent) => {
      // Read per press rather than captured when the listener binds: the store
      // is the record of what is bound, so a rebind needs no re-binding here.
      const binding = resolveReaderKey(event, ctx, useSettings.getState().keyOverrides);
      if (!binding) return;
      // Don't hijack typing in any text field (search panel, etc.): a focused
      // input must keep its native caret/selection behaviour, and keys reaching
      // `window` from inside the book's iframe carry a `null` target so they are
      // never mistaken for an editable field here. Escape is the exception — it
      // is how the drawer closes, and the caret is in that drawer's own field
      // when it is pressed.
      if (!binding.inEditable && isEditableTarget(event.target)) return;
      runReaderKey(binding.id);
      if (!binding.keepDefault) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxPath, paged, readsLeftward, runReaderKey, settings.readingRuler, secondary]);

  // One step of the page, whichever way this layout moves: a page turn in the
  // paged layouts, a chapter in the scrolled one — the same split the arrow
  // keys already make, shared with the gamepad pedal.
  const pageStep = useCallback(
    (dir: 1 | -1) => {
      if (paged) flip(dir);
      else stepChapter(dir);
    },
    [flip, paged, stepChapter],
  );

  // A gamepad or a Bluetooth page-turner. The shoulders and the D-pad page, and
  // so does a stick pushed across: the same two calls, so the pad and the pedal
  // cannot disagree about which way the book goes. The stick's other axis is the
  // reading axis, and it gets the arrow keys' own step — the ruler when it is
  // on, the page when the page has run out.
  //
  // Off is the reader's own switch (手柄翻页 in the panel), for the pad shared
  // with something else that also uses the shoulders.
  useGamepadPager({
    // Same rule as the keyboard: the pad pages the pane in use, not both.
    enabled: settings.gamepadPaging && !secondary,
    onNext: () => pageStep(1),
    onPrev: () => pageStep(-1),
    onLineForward: () => stepAlongReading(1),
    onLineBack: () => stepAlongReading(-1),
  });

  const saveProgress = useCallback(
    (frac: number) => {
      const progress = globalProgress(chapters, chapterIdx, frac);
      setProgress({ progress });
      // Every save marks the end of one reading session: fold it into the
      // sustained speed estimate that powers the remaining-time labels.
      reportPace(progress * totalChars(chapters));
    },
    [chapters, chapterIdx, setProgress, reportPace],
  );

  /**
   * The scroller's offset at the moment the toolbar opened.
   *
   * A scroll event reporting *this* offset is news of a scroll that already
   * happened — the reveal that brought the words under the pointer — and the
   * anchor was measured after it. Chromium dispatches that event a frame or
   * two after the click, so dismissing on it closes the toolbar the same
   * gesture just opened: a highlight out of view (the demo book opens at 18%)
   * gets scrolled in, tapped, and the toolbar is gone before 记笔记 can be
   * pressed. Only an offset the toolbar has not seen means the page moved
   * under it, which is what the dismissal below is for.
   *
   * Layout effect, not a passive one: the reveal's scroll event can land in
   * the very next frame, and a passive effect may not have run by then — the
   * record has to exist before the browser can dispatch anything.
   */
  const openedScrollAt = useRef<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    openedScrollAt.current = pending && el ? { left: el.scrollLeft, top: el.scrollTop } : null;
  }, [pending]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    const at = openedScrollAt.current;
    // Stale for the dismissal only: the page still moved, so everything
    // below still runs — the reveal's own progress has to land.
    const stale = !!el && !!at && el.scrollLeft === at.left && el.scrollTop === at.top;
    // The layout re-anchoring after a re-flow (a resize, a typography change,
    // a sidebar spring) is not the reader leaving the passage: the words are
    // still under the toolbar, and `remeasureSelection` keeps it on them. So
    // the anchor is re-recorded instead of the toolbar dropped — resizing the
    // window used to close it, which is the same gesture a reader makes while
    // a note is half-written. Consumed either way, so it can never excuse a
    // scroll that is not this one.
    const laid = layoutScrollRef.current;
    const relaid =
      laid !== null && !!el && laid.left === el.scrollLeft && laid.top === el.scrollTop;
    if (relaid) {
      layoutScrollRef.current = null;
      openedScrollAt.current = { left: el.scrollLeft, top: el.scrollTop };
    } else if (!stale) {
      setPending(null);
    }
    if (!el) return;
    const pagedNow = layoutModeRef.current !== "scroll";
    const max = pagedNow ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    const pos = pagedNow ? el.scrollLeft : el.scrollTop;
    const frac = max > 0 ? pos / max : 0;
    fractionRef.current = frac;
    setFraction(frac);
    setDisplayProgress(globalProgress(chapters, chapterIdx, frac));
    // In a scroll-layout PDF the page indicator follows the slot under the
    // top edge; chapterIdx stays pinned to the page it was entered from.
    if (isPdf && !pagedNow) pdfTrackScrolledPage(el, chapters.length);
    if (pagedNow && showPages) {
      const pitch = columnPitch(el, layoutModeRef.current, marginRef.current);
      if (pitch > 0) {
        const page = Math.round(el.scrollLeft / pitch) + 1;
        const pages = Math.round(max / pitch) + 1;
        setPageInfo((prev) =>
          prev && prev.page === page && prev.pages === pages ? prev : { page, pages },
        );
        // The same measurement feeds the whole-book estimate: this is a page
        // count the layout actually took, for this chapter's share of the book.
        countChapterPages(pages);
      }
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => saveProgress(frac), POSITION_SAVE_DELAY_MS);
    // The page has moved under the reading ruler, and it re-measures once the
    // movement is over rather than at the start of it: every way a page turns
    // here ends as a scroll — the instant jump, 「平移」's smooth scroll, and the
    // ones that jump and then animate — but only the last scroll event says the
    // page has arrived. The band stays where it is and is re-derived from the
    // lines now under it, which is the whole idea of it.
    if (rulerSettleRef.current !== null) window.clearTimeout(rulerSettleRef.current);
    rulerSettleRef.current = window.setTimeout(() => {
      // A turn's direction rides along once, then is spent: whatever the next
      // notice is, it is not the same page turn.
      const dir = rulerDirRef.current;
      rulerDirRef.current = 0;
      relayRulerLayout(el, pagedNow ? dir : 0);
    }, RULER_SETTLE_MS);
  }, [
    chapters,
    chapterIdx,
    countChapterPages,
    isPdf,
    layoutModeRef,
    marginRef,
    pdfTrackScrolledPage,
    saveProgress,
    showPages,
  ]);

  // Recompute the page indicator when the setting or layout flips without a
  // scroll event; chapter switches and resizes re-report through `onScroll`.
  // `countChapterPages` changes with the layout and the typography, so this
  // re-measures after those too — the pages it counts are the reader's share
  // of the book, and a stale count is a wrong book length.
  //
  // `chapterData` is what actually re-paginates: a chapter switch lands on an
  // empty scroller while `useChapter` is still fetching, so the measurement
  // taken then is the chapter that just left. `tail` is the second half of the
  // same problem — the end-of-chapter spacer is measured off the chapter that
  // filled the scroller before this one, and until it is re-measured the
  // scroller is still as wide as that chapter, so the count read off it is
  // that chapter's again.
  useEffect(() => {
    // foliate books are paginated inside their own scrollport, so
    // this host has no horizontal overflow to measure — running the formula
    // anyway reported a bogus "1 / 1", which then shadowed foliate's real
    // counter in the indicator.
    if (!paged || !showPages || useFoliate) return;
    const el = scrollRef.current;
    if (!el) return;
    const pageMargin = marginX + (fullscreen ? FULLSCREEN_MARGIN_BONUS : 0);
    const pitch = columnPitch(el, layoutMode, pageMargin);
    if (pitch <= 0) return;
    // The chapter ends where its spacer puts the end, or at the scroller's own
    // width when there is no spacer to ask. Reading the spacer is also what
    // keeps this measuring again once it has been re-measured for this
    // chapter — an unbuilt spacer leaves the scroller as wide as the chapter
    // that filled it before.
    const contentEnd = tail === null ? el.scrollWidth : tail.left;
    const pages = Math.round((contentEnd - el.clientWidth) / pitch) + 1;
    // Nothing to say about a chapter that is not on screen yet: the number
    // would be the page count of whatever is, wearing this chapter's name.
    if (chapterData === null) return;
    setPageInfo({ page: Math.round(el.scrollLeft / pitch) + 1, pages });
    countChapterPages(pages);
  }, [
    chapterData,
    countChapterPages,
    fullscreen,
    tail,
    useFoliate,
    layoutMode,
    marginX,
    paged,
    showPages,
  ]);

  // A pending save is dropped on unmount, not flushed — the same as the
  // foliate one, which `useFoliateBook` clears for itself.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (rulerSettleRef.current !== null) window.clearTimeout(rulerSettleRef.current);
    };
  }, []);

  // A mouse-up over the article turns a completed selection into a pending
  // highlight, surfaced as a floating "高亮" button rather than saving blind.
  // The listener is attached through a ref so the reading viewport stays a plain
  // semantic scroll container instead of a synthetic widget.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onMouseUp = (event: MouseEvent) => {
      // A mouseup inside a PDF page's text layer belongs to that layer's own
      // handler — but a collapsed click there is a dismissal, same as over
      // prose: the layer's click handler only opens pills on annotation hits,
      // so without this the old pill would linger over the new tap.
      const target = event.target;
      if (target instanceof Element && target.closest("[data-pdf-layer]")) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) setPending(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || !displayChapterData) {
        setPending(null);
        return;
      }
      const range = resolveSelection(selection, displayChapterData.paragraphs);
      if (!range) {
        setPending(null);
        return;
      }
      const domRange = selection.getRangeAt(0);
      const rect = domRange.getBoundingClientRect();
      setPending({
        range,
        x: rect.left + rect.width / 2,
        y: rect.top,
        bottom: selectionBottom(domRange.getClientRects(), rect),
      });
    };
    el.addEventListener("mouseup", onMouseUp);
    return () => el.removeEventListener("mouseup", onMouseUp);
  }, [displayChapterData]);

  const createHighlight = (
    range: TextRange,
    color: string,
    style: AnnotationStyle,
    /** Runs with the new row. The note path hangs its note on the id here,
     *  inside the same round trip the highlight was created in. */
    onCreated?: (created: Annotation) => void,
  ) => {
    createAnnotation.mutate(
      {
        chapterIdx: pending?.chapterIdx ?? chapterIdx,
        startChar: range.start,
        endChar: range.end,
        text: range.text,
        color,
        style,
        ...(pending?.cfi !== undefined ? { cfi: pending.cfi } : {}),
      },
      {
        onSuccess: (created) => {
          // The ink becomes the reader's default, so the next highlight
          // starts where this one left off.
          settings.update({ highlightColor: color, highlightStyle: style });
          window.getSelection()?.removeAllRanges();
          setPending(null);
          if (created) onCreated?.(created);
        },
      },
    );
  };

  /** Restyles an existing highlight (the toolbar's edit mode). */
  const restyleHighlight = (id: string, color: string, style: AnnotationStyle) => {
    updateAnnotation.mutate({ id, color, style });
    settings.update({ highlightColor: color, highlightStyle: style });
  };

  /** Copies the selection and dismisses the toolbar. */
  const copySelection = () => {
    void navigator.clipboard.writeText(pending?.range.text ?? "").catch(() => {
      // Clipboard can be denied; the toolbar stays open either way.
    });
  };

  /** Searches the selection in the book: opens the panel, query pre-filled. */
  const searchSelection = () => {
    if (!pending) return;
    setSearchSeed(pending.range.text.trim());
    setPanel("search");
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  /** 词典 / 翻译 / 维基百科 popup anchored where the toolbar was. */
  const openLookup = (kind: LookupKind) => {
    if (!pending) return;
    setLookup({ kind, text: pending.range.text.trim(), x: pending.x, y: pending.y });
    setPending(null);
  };

  /** Asks the assistant about the current selection. */
  const askAboutSelection = (range: TextRange) => {
    setAiContext(range.text);
    setPanel("ai");
    window.getSelection()?.removeAllRanges();
    setPending(null);
  };

  /**
   * Landing the reader on a position named by a search hit or an AI citation:
   * here, after the chapter it names lands, or in another book.
   *
   * Aliased to the two names the panels already hand it over as.
   */
  const { pick: pickHit, follow: jumpToCitation } = useHitJumps({
    bookId,
    chapterIdx,
    paragraphs: displayChapterData?.paragraphs,
    goTo,
    setPendingFocus,
    scrollRef,
  });

  const total = chapters.length;
  const chapterTitle = chapterData?.title ?? "";
  // Each appearance keeps its own reading surface: a dark shell starts on the
  // night palette, and both stay user-changeable in the settings panel. Shared
  // with the shell's read-aloud chrome, which floats on this same paper — see
  // `useReadingSurface`.
  const surface = useReadingSurface(bookId);
  // Whether that page is on its night axis — the input the PDF's `follow`
  // resolves against, so the PDF and the paper it sits on cannot end up on
  // different answers to the same question.
  const pageNight = usePageIsNight(bookId);
  // The window's chrome wears the paper of the book being read — paper is per
  // book now, and the shell has no book of its own. Only the active pane
  // publishes; the other one clears on its way out.
  const setActiveSurface = useReaderSettings((state) => state.setActiveSurface);
  useEffect(() => {
    if (secondary) return;
    setActiveSurface(surface);
    return () => setActiveSurface(null);
  }, [secondary, surface, setActiveSurface]);
  // Re-root the glass token set on the reading surface: the header, footer and
  // every glass control inside the reader tint themselves from the same ink
  // and paper colours, so a sepia page reads warm edge to edge instead of
  // clashing with the app chrome.
  const readerVars = {
    background: surface.background,
    ...readerGlassVars(surface),
  } as CSSProperties;
  // The paper colour the foliate turn's View Transition snapshots are backed
  // with. It has to sit on the document root, not on the pane: `::view-transition`
  // hangs off `html` and inherits from there, so a var on a descendant never
  // reaches it — and only the night palette gives a section its own background
  // to snapshot, which is why a light surface used to flash white (globals.css
  // `--foliate-vt-bg`). `tint` rather than `background`: the latter may be a
  // gradient or a photo, and this is a colour slot.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--reader-page", surface.tint);
    return () => {
      root.style.removeProperty("--reader-page");
    };
  }, [surface.tint]);
  // Which axis a PDF page is rendered on. The three states resolve through the
  // page's own palette (`usePageIsNight`), so 跟随主题 means "whatever the page
  // is wearing" — a document is not re-inked because the shell went dark, and
  // a page pinned to 日间 keeps its file's own colours at midnight. The page
  // palette follows the app theme unless the reader pinned it, so the default
  // answer moves with the shell without anyone opening the panel.
  //
  // The colours themselves always come from the night palette, so pinning 夜间
  // on a light page still darkens it. `tint` rather than `background` for the
  // canvas: `background` may be a gradient the canvas cannot take.
  const nightPalette = resolveSurface(settings.nightSurface, customSurface);
  const pdfNightOn = pageIsNight(pdfNightAxis, pageNight);
  const pdfNight = pdfNightOn ? { fg: nightPalette.fg, bg: nightPalette.tint } : null;
  const fullscreenBonus = fullscreen ? FULLSCREEN_MARGIN_BONUS : 0;
  // 铺满屏幕: PDF pages meet the window edges like Preview; prose keeps the
  // user margins. Scroll slots and the spread padding both read from these.
  const margin = isPdf && pdfFill ? 0 : marginX + fullscreenBonus;
  const blockMargin = isPdf && pdfFill ? 0 : marginY + fullscreenBonus;

  // Typography and palette handed to the foliate renderer: the book keeps its
  // own CSS, the injected stylesheet wins over it for the reading settings.
  //
  // `font` is the *effective* key, not the stored one: while 霞鹜文楷's bundled
  // sheet is still being fetched the hook answers 楷体, because the rules that
  // style the section are read out of the CSSOM and are not there yet. Both
  // reading paths ask the same hook — they share one stylesheet's worth of
  // rules, and each asking for a different answer would show the reader two
  // fonts in one book.
  const font = useAdoptedFontKey(settings.fontFamily);
  const foliateStyle = useFoliateStyle({
    fontSize,
    font,
    lineHeightIdx,
    paraGapIdx,
    indent,
    bodyBold: settings.bodyBold,
    surface,
    invertImages: invertBookImages,
    fonts,
    writingMode: settings.writingMode,
    bookTypography: settings.bookTypography,
    quoteReplace: settings.quoteReplace,
    zhConvert: settings.zhConvert,
  });

  /** Column width for the paged layouts; `undefined` keeps flow layout. */
  const columnWidth = useMemo(() => {
    if (!paged || viewportW <= 0) return undefined;
    const content = viewportW - margin * 2;
    return layoutMode === "double" ? (content - margin) / 2 : content;
  }, [layoutMode, margin, paged, viewportW]);

  const chapterRemaining = Math.max(
    0,
    Math.round((chapters[chapterIdx]?.chars ?? 0) * (1 - fraction)),
  );
  const bookRemaining = remainingChars(chapters, chapterIdx, fraction);
  // Nothing to weigh: a PDF whose text is still owed, or whose extraction never
  // landed. Both estimates would answer "不到 1 分钟" for a 400-page book — a
  // wrong number dressed as a precise one — so report the speed as unknown
  // instead, which is what `estimateLabel` makes of it.
  // The remaining-time labels: the median stretch once there are enough of
  // them to take one, the running average until then. The median is the honest
  // one — an average still carries the ten minutes the app sat open on a page.
  const weighedSpeed = totalChars(chapters) > 0 ? (medianCpm(paceSamples) ?? readingSpeed) : 0;

  // Bookmark state is derived, not flashed: the icon stays filled while the
  // reading position sits on a bookmark (same chapter, within 1% of chapter
  // length) and eases back once you scroll away — that is also the dedupe
  // signal, so tapping again on a bookmarked spot never stacks a duplicate.
  const bookmarkData = bookmarksQuery.data;
  const atBookmark = useMemo(
    () =>
      (bookmarkData ?? []).some(
        (bookmark) =>
          bookmark.chapterIdx === chapterIdx &&
          Math.abs((bookmark.fraction ?? 0) - fraction) <= 0.01,
      ),
    [bookmarkData, chapterIdx, fraction],
  );

  const addBookmark = () => {
    const frac = fractionRef.current;
    const existing = (bookmarkData ?? []).find(
      (bookmark) =>
        bookmark.chapterIdx === chapterIdx && Math.abs((bookmark.fraction ?? 0) - frac) <= 0.01,
    );
    // Toggle: tapping a bookmarked spot again removes that bookmark.
    if (existing) {
      deleteBookmark.mutate(existing.id);
      return;
    }
    createBookmark.mutate({
      chapterIdx,
      fraction: frac,
      label: `${chapterTitle || `第 ${chapterIdx + 1} 章`} · ${Math.round(frac * 100)}%`,
    });
  };

  const transitionClass =
    pageTransition === "fade"
      ? "chapter-fade"
      : pageTransition === "paper" || pageTransition === "flip"
        ? nav === 1
          ? "chapter-paper-fwd"
          : "chapter-paper-back"
        : "";

  // The prose path composes the page itself, from the chapter text, the
  // annotations, the search matches and the voice's wash — the flow's style,
  // the paragraph split and the ink a highlight is drawn with are
  // `useProseReading`'s.
  const { articleStyle, renderedParagraphs, markInk } = useProseReading({
    displayChapterData,
    annotations,
    chapterIdx,
    search,
    speechSpan,
    fontSize,
    font,
    lineHeightIdx,
    bodyBold: settings.bodyBold,
    margin,
    blockMargin,
    columnWidth,
    viewportH,
    pinnedW,
    wallpaperPath,
    surface,
  });
  // The wash the voice draws, in the three shapes the paths need it: a value
  // for foliate's overlayer, inline style for the prose `<mark>`, and a
  // `::highlight` body for pdf.js's text layer. All three come from `washCss`,
  // so the marker cannot read differently depending on the book's format.
  const ttsWash = useMemo(
    () => ({ style: speechWashStyle, color: speechWashColor }),
    [speechWashStyle, speechWashColor],
  );
  const ttsWashCss = useMemo(
    () => washCss(ttsWash.style, ttsWash.color, surface.mode === "dark"),
    [ttsWash, surface.mode],
  );

  // pdf.js paints its text through the CSS Custom Highlight API, which takes no
  // inline style — so the wash's rule is installed rather than rendered. Off a
  // PDF there is no text layer to paint, and no rule to keep.
  useEffect(() => {
    if (!isPdf) return;
    setTtsWashRule(washRule(ttsWash.style, ttsWash.color, surface.mode === "dark"));
  }, [isPdf, ttsWash, surface.mode]);

  // A plate chapter is a part-title page: the chapter's own wallpaper plus at
  // most a short heading, no running text. Kindle paints these pages with a
  // full-page CSS background; the multicol prose path would split the title
  // and the art across columns, so they get a dedicated page-shaped view.
  const plate = useMemo(() => {
    if (!wallpaperPath) return null;
    const text = (chapterData?.paragraphs ?? []).filter((paragraph) => paragraph !== "").join("\n");
    return text.length <= 30 ? { imagePath: wallpaperPath, title: text } : null;
  }, [chapterData, wallpaperPath]);

  // The wallpaper behind a text page (the copyright page's paper) loads once
  // per chapter; plates draw the art themselves, so skip the double fetch.
  // foliate books paint their own paper inside the view — the
  // extracted wallpaper would only layer underneath it.
  const wallpaperUrl = useAssetUrl(bookId, plate || useFoliate ? null : wallpaperPath);

  // Leaving the reader hands the cover back to the shelf — the same object
  // that flew in, in the other direction. The header thumbnail is the origin;
  // the shelf tile the book came from registers itself as the landing while it
  // mounts (`BookCard`), and until then `BookCoverFlight` carries it on its own
  // and dissolves if nothing ever lands. Under reduced motion the flight clears
  // the handoff instead of running it, so the shelf tile is never left blank.
  const coverBoxRef = useRef<HTMLSpanElement>(null);
  const beginHandoff = useBookHandoff((s) => s.begin);
  const leaveReader = () => {
    const cover = reduce ? null : coverBoxRef.current;
    if (cover) beginHandoff({ id: bookId, coverUrl, from: boxOf(cover), side: "reader" });
    onBack();
  };
  // foliate sections replace the imported chapter list while reading, but only
  // when foliate actually found a TOC — an old MOBI6 has none.
  const headerIndex = hasToc
    ? foliateTocIdx + 1
    : isPdf && !paged && pdfScrollPage !== null
      ? pdfScrollPage
      : chapterIdx + 1;
  const headerTotal = hasToc ? foliateToc.length : total;
  const headerChapter = hasToc ? foliateSectionLabel : chapterTitle;

  // What the shell's player reads: which book, which chapter, under what cover.
  // Published rather than looked up, because the player has no book of its own —
  // it draws the same bar on 书架 and 设置, and only this page knows any of it.
  // The queue itself is published by `useReadAloud`, which is what builds it.
  const publishSession = useSpeechSession((state) => state.publish);
  useEffect(() => {
    // One session, one publisher: the pane in use. The companion's book is
    // not what the shell's player is playing, so it does not get to say so.
    if (secondary) return;
    publishSession({ bookId, title, coverUrl, chapter: headerChapter, chapterIdx, bookLanguage });
  }, [publishSession, bookId, title, coverUrl, headerChapter, chapterIdx, bookLanguage, secondary]);

  // The toolbar's edit mode: when the reader tapped a painted highlight,
  // `pending` carries its id — resolve it to the whole annotation so the ink
  // row can show (and change) what it is painted with.
  const pendingAnnotation = pending?.annotationId
    ? ((annotations ?? []).find((annotation) => annotation.id === pending.annotationId) ?? null)
    : null;

  /**
   * The toolbar's note field. A note hangs off a highlight, so a bare
   * selection gets one first — painted in the ink the toolbar is showing,
   * which is also what the reader's next selection starts from.
   *
   * Clearing never creates anything: an empty field over an un-highlighted
   * passage is a thought the reader changed their mind about, not a request
   * for an invisible annotation.
   */
  const noteOnSelection = (note: string | null) => {
    if (!pending) return;
    if (pendingAnnotation) {
      if (note !== pendingAnnotation.note) {
        setAnnotationNote.mutate({ id: pendingAnnotation.id, note });
      }
      setPending(null);
      return;
    }
    if (note === null) {
      setPending(null);
      return;
    }
    createHighlight(pending.range, settings.highlightColor, settings.highlightStyle, (created) =>
      setAnnotationNote.mutate({ id: created.id, note }),
    );
  };

  // Everything the tool cluster needs, in one place: the ordinary reader's
  // header mounts it inline, and a pair mounts the same cluster in its one
  // bottom bar — there the bar above the books belongs to both of them.
  //
  // 字号 / 标尺 / 简繁 / 纸色 are *not* per book: they live in one settings
  // store, so a change already applies to both panes at once. Panels (目录,
  // 搜索, 标注, 图谱, AI 导读, 设置) and the bookmark are per book by nature and
  // act on the active one.
  const toolProps = {
    isPdf,
    onTogglePanel: togglePanel,
    pdfZoom,
    onZoom: (next: number) => stepPdfZoom(next / pdfZoom),
    fontSize,
    onFontSize: setFontSize,
    atBookmark,
    onToggleBookmark: addBookmark,
    bookmarkPending: createBookmark.isPending || deleteBookmark.isPending,
    fullscreen,
    onToggleFullscreen: () => void toggleFullscreen(),
    rulerOn: settings.readingRuler,
    onToggleRuler: () => settings.update({ readingRuler: !settings.readingRuler }),
    zhAvailable,
    zhConvert: settings.zhConvert,
    onZhConvert: (mode: ZhConvertMode) => settings.update({ zhConvert: mode }),
    zhButton: settings.zhToolbarButton,
    onHideZhButton: () => settings.update({ zhToolbarButton: false }),
    paired: pair !== null,
    onOpenPair,
  } satisfies ReaderToolButtonsProps;

  const headerBar = (
    <ReaderHeaderBar
      onBack={leaveReader}
      backLabel={backLabel}
      bookId={bookId}
      coverUrl={coverUrl}
      coverBoxRef={coverBoxRef}
      title={title}
      index={headerIndex}
      total={headerTotal}
      chapterLabel={headerChapter}
      {...toolProps}
    />
  );

  // The player card is the shell's now; the footer only opens and closes it.
  const speechOpen = useSpeechSession((state) => state.open);
  const setSpeechOpen = useSpeechSession((state) => state.setOpen);

  // …and the shell's pill floats over this footer, so it has to be told how tall
  // it is rather than assume: a hand-measured constant drifts with the platform's
  // type metrics, and this footer is not a fixed height.
  const footerRef = useRef<HTMLElement | null>(null);
  const setFooterHeight = useChrome((state) => state.setReaderFooterHeight);
  // The companion pane has no footer, and reporting 0 while it is the one
  // without one keeps the shell's pill anchored to the pane that has it.
  useElementHeight(footerRef, setFooterHeight, !fullscreen && !secondary);

  const footerInner = (
    <ReaderFooterControls
      speechStatus={readAloud.status}
      onToggleSpeech={readAloud.toggle}
      onTogglePlayer={() => setSpeechOpen(!speechOpen, "speed")}
      speechRate={speechRate}
      paged={paged}
      autoScrolling={autoScrollOn}
      onToggleAutoScroll={toggleAutoScroll}
      onStepChapter={stepChapter}
      chapterIdx={chapterIdx}
      total={total}
      chapterRemaining={chapterRemaining}
      bookRemaining={bookRemaining}
      readingSpeed={weighedSpeed}
      progress={displayProgress}
      rsvpOn={readAloud.rsvpOpen}
      onRsvp={readAloud.toggleRsvp}
      bookId={bookId}
      // The pair's one bottom bar spans the whole window, but the full set
      // measures ~1109px against the ~994px a 1280px window still has beside
      // the sidebar — without this the row wraps into a pile.
      compact={pair !== null}
      // A pair's top bar already gives each book its own steppers; this bar
      // would otherwise ask "which book does 下一章 turn?".
      chapterNav={pair === null}
    />
  );

  // The pair's top bar names both books and gives each its own steppers; this
  // pane's half of that is published upward (see `SplitReader`). The step
  // wrapper is stable on purpose: `stepChapter` is rebuilt on most renders,
  // and the bar lives in another component — without this the identity would
  // republish every frame and re-render both blocks.
  const stepRef = useRef(stepChapter);
  useEffect(() => {
    stepRef.current = stepChapter;
  }, [stepChapter]);
  const pairStep = useCallback((dir: 1 | -1) => stepRef.current(dir), []);
  useEffect(() => {
    if (pair === null) return;
    onIdentity?.({
      coverUrl,
      title,
      index: headerIndex,
      total: headerTotal,
      isPdf,
      chapterLabel: headerChapter,
      backLabel,
      onBack,
      onStep: pairStep,
    });
  }, [
    pair,
    onIdentity,
    coverUrl,
    title,
    headerIndex,
    headerTotal,
    isPdf,
    headerChapter,
    backLabel,
    onBack,
    pairStep,
  ]);

  // The pair's one bottom bar, as this pane paints it. A portal moves DOM, not
  // state: every control in it still drives *this* reader, so 目录 opens this
  // book's contents and the voice reads from the pane that was active when it
  // started. The companion pane paints nothing. Outside a pair the chrome
  // renders inline, exactly as it always has.
  const slots = usePairSlots();
  const portaled = pair !== null && slots.bottom !== null;

  const inlineFooter = (
    // `flex-wrap`, and the scan chip is one flex unit so it wraps whole:
    // measured, the row's natural width is 1109px against the 1024px the
    // window can still be, so at the minimum size the chip goes to a second
    // line instead of squeezing every control on the first. The footer's
    // height is watched (`readerFooterHeight`), so the paper and the speech
    // pill both follow it down.
    <footer
      ref={footerRef}
      className="border-hairline flex flex-wrap items-center justify-center gap-3 border-t px-6 py-3"
    >
      {footerInner}
    </footer>
  );

  // A pair's one bottom bar: the active book's controls, with the tool cluster
  // that used to sit in the top bar. The bar above the books belongs to both
  // of them and carries no per-book controls.
  const pairFooter = (
    <footer
      ref={footerRef}
      className="border-hairline flex flex-wrap items-center justify-center gap-3 border-t px-6 py-3"
    >
      <ReaderToolButtons {...toolProps} menuPlacement="up" />
      <HeaderRule />
      {footerInner}
    </footer>
  );

  const topChrome =
    pair !== null ? null : !fullscreen ? (
      headerBar
    ) : (
      // Fullscreen: the toolbar lives above the top edge and slides in only
      // while the pointer rests on the top strip of the reading area.
      <div className="group/hud absolute inset-x-0 top-0 z-40">
        <div className="-translate-y-full opacity-0 transition-all duration-200 ease-out group-hover/hud:translate-y-0 group-hover/hud:opacity-100 motion-reduce:transition-none">
          {headerBar}
        </div>
      </div>
    );

  const bottomChrome =
    pair !== null ? (
      // A pair's bottom bar is always in the flow — no fullscreen HUD: the
      // reader already has two books' worth of paper on screen, and a bar
      // that hides itself on hover would keep taking the controls away.
      portaled && !secondary && slots.bottom ? (
        // The wrapper carries `readerVars`: a portaled bar is painted outside
        // this reader's root, so the paper colour and the re-rooted glass
        // tokens have to travel with it or a sepia/night page would wear the
        // app's own palette along its edges.
        createPortal(<div style={readerVars}>{pairFooter}</div>, slots.bottom)
      ) : null
    ) : !fullscreen ? (
      inlineFooter
    ) : (
      // Fullscreen: the function bar docks below the bottom edge and slides
      // up while the pointer rests on the bottom strip.
      <div className="group/hud-b absolute inset-x-0 bottom-0 z-40">
        <div className="h-7" aria-hidden />
        <div className="absolute inset-x-0 bottom-0 translate-y-full opacity-0 transition-all duration-200 ease-out group-hover/hud-b:translate-y-0 group-hover/hud-b:opacity-100 motion-reduce:transition-none">
          <footer className="border-hairline flex flex-wrap items-center justify-center gap-3 border-t bg-(--glass-btn) px-6 py-3 backdrop-blur-xl">
            {footerInner}
          </footer>
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col" style={readerVars}>
      {topChrome}

      {/* Reading viewport. In paged modes the flip arrows reveal on hover or
          pointer-down and fade out after 2s, so they never sit on the text.
          After `IDLE_MS` of stillness the pointer and the page number step off
          the page too — the cursor goes with `cursor: none`, which covers the
          prose and PDF paths; a foliate section is an iframe, so foliate hides
          the cursor inside it on its own clock. */}
      <div
        ref={viewportRef}
        data-reading-viewport
        className="relative flex min-h-0 flex-1"
        style={{ cursor: idle ? "none" : undefined }}
        onMouseMove={revealFlipHintOnMove}
        onPointerMove={wake}
        onPointerEnter={() => wake()}
        onPointerDown={() => {
          revealFlipHint();
          wake();
        }}
        onMouseLeave={() => setFlipHint(false)}
      >
        <div
          ref={scrollRef}
          data-reading-content
          onScroll={onScroll}
          className={cn(
            "min-h-0 flex-1",
            // foliate owns its own scrolling and paging; giving the host a
            // scroll container of its own would double-clip the pages.
            useFoliate
              ? "relative overflow-hidden"
              : paged
                ? isPdf && pdfZoom !== 1
                  ? "relative overflow-auto"
                  : "relative overflow-x-auto overflow-y-hidden"
                : isPdf && pdfZoom !== 1
                  ? "overflow-auto"
                  : "overflow-y-auto",
          )}
          // A chapter wallpaper (Kindle CSS page paper) paints the viewport
          // itself: the background stays put while pages slide over it, so
          // every page of the chapter reads as the same sheet of paper.
          style={{
            background: surface.background,
            // The prose path pins its `<article>`; foliate and PDF have no
            // article, so the host itself is what has to hold its width while
            // the sidebar spring runs.
            //
            // foliate re-paginates the whole book whenever its element is
            // resized, and a per-frame re-pagination of a whole book is what
            // made collapsing or hiding the sidebar janky — the pin turns ~30
            // re-paginations into one, after the spring settles. PDF pays the
            // same toll in rasterisation instead: `PdfPageView` watches its own
            // wrapper, so an unpinned pane re-renders every page on screen once
            // per frame, at 50–150 ms each on an illustrated book.
            //
            // `flexBasis`, not `width`: this box is `flex-1`, so its
            // `flex-basis` is `0%` and a `width` on a flex item with a
            // definite basis is ignored outright — the width pin was silently
            // doing nothing. `flexGrow`/`flexShrink` have to go to 0 as well,
            // or the box grows straight back to the pane's new width.
            ...(pinnedW !== null && (useFoliate || isPdf)
              ? { flexGrow: 0, flexShrink: 0, flexBasis: pinnedW }
              : {}),
            ...(wallpaperUrl
              ? {
                  backgroundImage: `url(${wallpaperUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }
              : {}),
          }}
        >
          <ReaderChapterView
            bookId={bookId}
            isPdf={isPdf}
            useFoliate={useFoliate}
            paged={paged}
            doublePage={layoutMode === "double"}
            chapterIdx={chapterIdx}
            total={total}
            transitionClass={transitionClass}
            margin={margin}
            blockMargin={blockMargin}
            images={bookImages}
            onOpenImage={openImageAt}
            foliateRef={foliateRef}
            pdf={{
              gap: pdfGap,
              zoom: pdfZoom,
              animated: pdfZoomAnimated,
              night: pdfNight,
              invertImages: pdfInvertImages,
              annotationsByPage,
              wash: readAloud.pdfWash,
              onSelection: onPdfSelection,
              onAnnotationClick: onPdfAnnotationClick,
              onLayout: handlePdfLayout,
            }}
            foliate={{
              format,
              startCfi,
              startFraction: startCfi ? null : initialProgress,
              layout: layoutMode,
              transition: pageTransition,
              style: foliateStyle,
              annotations,
              ttsWash,
              onSelect: onFoliateSelection,
              onAnnotationClick: onFoliateAnnotationClick,
              onAnchor: onFoliateAnchor,
              onImageOpen: openBookImage,
              onLocationChange: (relocate) => {
                rememberFoliateLocation(relocate);
                // A page turn moves the words, not the toolbar: re-anchor it.
                // Only worth measuring while there is one to move.
                if (toolbarOpen) remeasureSelection();
              },
              onTocLoaded: setFoliateToc,
              // A click on a book's text happens inside foliate's iframe and
              // never reaches this document — the pane learns about it here.
              onActivate: pair?.onActivate,
              // So does a move over it: the page number's 3-second clock is
              // restarted from the section's own document, because the pane
              // hears nothing while the pointer is on a foliate book.
              onPointerInBook: wake,
            }}
            plate={{ image: plate }}
            prose={{
              pending: chapter.isPending,
              paragraphs: renderedParagraphs,
              gap: PARA_GAPS[paraGapIdx],
              indent,
              invertImages: invertBookImages,
              darkSurface: surface.mode === "dark",
              style: articleStyle,
              annotations,
              onGoTo: goTo,
              onEditAnnotation: (annotation, x, y) =>
                setPending({
                  range: {
                    start: annotation.startChar,
                    end: annotation.endChar,
                    text: annotation.text,
                  },
                  x,
                  y,
                  annotationId: annotation.id,
                }),
              ink: markInk,
              ttsWash: ttsWashCss,
            }}
          />
          {/* Pull-to-bookmark. The prose scroller only: whether the page is at
            its top is the gesture's whole premise, and that is a scrollTop
            only this path owns — foliate and the PDF view keep their own
            scrollers, where a downward drag is a scroll up the page. */}
          <PullBookmark
            hostRef={viewportRef}
            scrollRef={scrollRef}
            enabled={!paged && !useFoliate && !isPdf}
            onTrigger={addBookmark}
          />
          {paged && tail && (
            <div
              aria-hidden
              data-tail-pad
              className="pointer-events-none absolute top-0 h-px"
              style={{ left: tail.left, width: tail.width }}
            />
          )}
        </div>

        {/* Reading ruler: a band parked at the reader's place, with the rest of
          the page washed toward the paper. A sibling of the scroller, not a
          child — a paged chapter is a long strip inside a moving window, and a
          ruler inside it would be carried off with the page that just left.
          Its body is inert, so only its two edges ever take a pointer (see
          `ReadingRuler`). */}
        <ReadingRuler
          ref={rulerRef}
          hostRef={viewportRef}
          // A pair shows the ruler in the book being read, not in both: the
          // band is a reading aid for the page the reader is working on, and
          // two of them at once halve the attention the aid is meant to focus.
          enabled={settings.readingRuler && !secondary}
          vertical={readsLeftward}
          columns={!readsLeftward && layoutMode === "double" ? 2 : 1}
          pitch={fontSize * (LINE_HEIGHTS[lineHeightIdx] ?? 1.8)}
          scrim={surface.tint}
          ink={surface.fg}
          lines={useFoliate ? foliateRulerLines : undefined}
          scroll={
            !paged && !isPdf
              ? { trigger: settings.rulerScrollTrigger, by: scrollFlowBy }
              : undefined
          }
        />

        {/* Page indicator (settings-gated) and a hairline progress rail that
            surfaces on activity and fades out after 2s of stillness. Above the
            ruler's wash, which covers the page bottom along with everything
            else outside the band. */}
        {paged && shownPages && (
          <p
            data-page-indicator
            className={cn(
              // All three positions sit in the same bottom gutter; only the
              // corner moves. 居中 is the original, and the only one that needs
              // a transform.
              "pointer-events-none absolute bottom-3 z-30 text-xs tabular-nums",
              // Auto-hidden it waits out `IDLE_MS` of stillness. Coming back is
              // quick (200ms) and leaving is slower and softer (500ms, 2px): a
              // number that vanishes fast reads as a glitch, and one that
              // drifts out of the page reads as the page letting go of it.
              "transition-[opacity,translate] motion-reduce:transition-none",
              pageIndicatorAutoHide && idle
                ? "translate-y-0.5 opacity-0 duration-500 ease-in-out"
                : "opacity-70 duration-200 ease-out",
              pageNumberPosition === "left" && "left-3",
              pageNumberPosition === "center" && "left-1/2 -translate-x-1/2",
              pageNumberPosition === "right" && "right-3",
            )}
            style={{ color: surface.fg }}
          >
            {shownPages.estimated && "约 "}
            {shownPages.page} / {shownPages.pages} 页
          </p>
        )}
        {/* Quiet progress rail in the text colour: a barely-there track that
            never competes with the page, and a whisper fill while active. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-px"
          style={{ background: surface.fg, opacity: 0.08 }}
        />
        <div
          className={cn(
            "absolute bottom-0 left-0 z-10 h-px transition-opacity duration-300 motion-reduce:transition-none",
            flipHint ? "opacity-40" : "opacity-0",
          )}
          style={{
            width: `${Math.round(displayProgress * 100)}%`,
            background: surface.fg,
          }}
        />

        {paged && (
          <>
            <button
              type="button"
              aria-label="上一页"
              // Hovering chrome sitting on top of the pane, so a native
              // snapshot of the pane would capture it: masked while one is
              // taken (see `data-turn-mask` in globals.css).
              data-turn-overlay
              onClick={() => flip(-1)}
              className={cn(
                "focus-visible:focus-ring glass shadow-panel text-text-2 hover:text-text-1 absolute top-1/2 left-3 z-20",
                "flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
                "transition-all duration-200 motion-reduce:transition-none",
                flipHint ? "opacity-100" : "pointer-events-none -translate-x-1 opacity-0",
              )}
            >
              <CaretLeft size={16} />
            </button>
            <button
              type="button"
              aria-label="下一页"
              data-turn-overlay
              onClick={() => flip(1)}
              className={cn(
                "focus-visible:focus-ring glass shadow-panel text-text-2 hover:text-text-1 absolute top-1/2 right-3 z-20",
                "flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full",
                "transition-all duration-200 motion-reduce:transition-none",
                flipHint ? "opacity-100" : "pointer-events-none translate-x-1 opacity-0",
              )}
            >
              <CaretRight size={16} />
            </button>
          </>
        )}

        {/* Speed reading: takes the whole reading area while it runs, and
            hands it back on close — the page is the same page underneath.
            Read-aloud's own bar and card are not here: they belong to the shell
            (`AppShell`), so that a session survives leaving this page. */}
        {!secondary && readAloud.rsvpOpen && (
          <RsvpPlayer
            onClose={readAloud.closeRsvp}
            tokens={readAloud.rsvpWords}
            chapter={headerChapter}
            wpm={rsvpWpm}
            onWpm={(value) => settings.update({ rsvpWpm: value })}
            onNextChapter={() => stepChapter(1)}
            hasNextChapter={chapterIdx < total - 1}
            background={surface.background}
          />
        )}
        <ReaderPanels
          // A secondary pane never paints a panel, whatever its own state says.
          // The effect above is what clears that state; this is what makes the
          // rule hold even for the frame before it runs.
          panel={secondary ? "none" : panel}
          bookId={bookId}
          verticalAvailable={useFoliate}
          zhAvailable={zhAvailable}
          boldAvailable={boldAvailable}
          // The drawer's own ✕. Same call as Escape's, so the two cannot drift
          // apart again — that drift is what left the highlights painted.
          onClose={closePanel}
          paired={pair !== null}
          toc={{
            chapters: hasToc ? foliateChapters : chapters,
            outline,
            currentIdx: hasToc ? foliateTocIdx : chapterIdx,
            bookmarks: bookmarks ?? [],
            busy: createBookmark.isPending || deleteBookmark.isPending,
            onJump: (idx) => {
              setPanel("none");
              if (hasToc) {
                foliateRef.current?.goToEntry(idx);
                return;
              }
              goTo(idx);
            },
            onJumpBookmark: (bookmark: Bookmark) => {
              setPanel("none");
              jumpTo(bookmark.chapterIdx, bookmark.fraction ?? 0);
            },
            onDeleteBookmark: (id) => deleteBookmark.mutate(id),
            onAddBookmark: addBookmark,
          }}
          graph={{
            onOpenChapter: (idx) => {
              setPanel("none");
              goTo(idx);
            },
          }}
          search={{
            useFoliate,
            seed: searchSeed,
            onFoliateSearch: (query) => foliateRef.current?.search(query) ?? Promise.resolve([]),
            onFoliatePick: (cfi) => {
              setPanel("none");
              foliateRef.current?.goToCfi(cfi);
            },
            onPick: (hit, needle) => {
              setSearch(needle);
              pickHit(hit);
            },
          }}
          annotations={{
            items: annotations ?? [],
            busy: deleteAnnotation.isPending || setAnnotationNote.isPending,
            onDelete: (id) => deleteAnnotation.mutate(id),
            onNote: (id, note) => setAnnotationNote.mutate({ id, note }),
            onShare: (annotation) => setShareAnnotation(annotation),
            onExport: () => setExportingNotes(true),
            onJump: useFoliate
              ? (annotation) => {
                  setPanel("none");
                  // A highlight with no anchor still has its text and the
                  // chapter it was recorded in, and those are enough: the
                  // chapter's own start is the landmark foliate can use,
                  // and the view mints the anchor from the text once it
                  // is there. The fraction is how the two numbering
                  // schemes meet (see `rememberFoliateLocation`).
                  foliateRef.current?.goToHighlight({
                    id: annotation.id,
                    cfi: annotation.cfi,
                    text: annotation.text,
                    fraction: globalProgress(chapters, annotation.chapterIdx, 0),
                  });
                }
              : undefined,
          }}
          ai={{
            context: aiContext,
            onClearContext: () => setAiContext(null),
            chapterTitle: chapterTitle || `第 ${chapterIdx + 1} 章`,
            paragraphs: displayChapterData?.paragraphs ?? [],
            onJumpCitation: jumpToCitation,
          }}
        />
      </div>

      {bottomChrome}

      {/* Fullscreen exit hint: pops on entering fullscreen, eases out after
          3s (see the exitHint effect). Non-interactive on purpose. */}
      {fullscreen && !secondary && (
        <div
          aria-hidden={!exitHint}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center",
            "transition-all duration-500 ease-out motion-reduce:transition-none",
            exitHint ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
          )}
        >
          <span className="glass-solid shadow-panel text-text-2 rounded-full px-4 py-1.5 text-xs">
            Esc 退出全屏
          </span>
        </div>
      )}

      {/* Selection toolbar (readest-style) or the 词典/翻译 popup — the
          AnimatePresence inside handles the mount/unmount pop. The companion
          pane of a pair leaves selection to the browser (a copy still works);
          a toolbar per pane would put two anchors over one gesture. */}
      {!secondary && (
        <SelectionOverlay
          toolbar={
            pending
              ? {
                  x: pending.x,
                  y: pending.y,
                  bottom: pending.bottom,
                  annotation: pendingAnnotation,
                  defaultColor: settings.highlightColor,
                  defaultStyle: settings.highlightStyle,
                  onCopy: copySelection,
                  onSearch: searchSelection,
                  onSpeak: () => {
                    if (!pending) return;
                    readAloud.speakFromSelection(pending.range);
                    window.getSelection()?.removeAllRanges();
                    setPending(null);
                  },
                  onAsk: () => {
                    if (!pending) return;
                    askAboutSelection(pending.range);
                  },
                  onLookup: openLookup,
                  onHighlight: (color, style) => {
                    if (!pending) return;
                    createHighlight(pending.range, color, style);
                  },
                  onRestyle: (color, style) => {
                    if (!pendingAnnotation) return;
                    restyleHighlight(pendingAnnotation.id, color, style);
                  },
                  onNote: noteOnSelection,
                  onDelete: () => {
                    if (!pendingAnnotation) return;
                    deleteAnnotation.mutate(pendingAnnotation.id);
                    setPending(null);
                  },
                  onClose: () => {
                    window.getSelection()?.removeAllRanges();
                    setPending(null);
                  },
                  // The range, not the box — see `selectionKeyOf`.
                  selectionKey: selectionKeyOf(pending, pendingAnnotation?.id ?? null, chapterIdx),
                }
              : null
          }
          lookup={lookup}
          onLookupClose={() => setLookup(null)}
        />
      )}

      {/* Lightbox viewer: blank areas close, Esc closes, arrows flip the book's images. */}
      <OverlayPortal>
        <AnimatePresence>
          {lightboxIdx !== null && lightboxIdx >= 0 && (
            <ImageLightbox
              bookId={bookId}
              images={bookImages}
              urls={urls}
              chapters={chapters}
              index={lightboxIdx}
              onClose={closeLightbox}
              onIndex={openImageAt}
              onJump={(target) => {
                closeLightbox();
                goTo(target);
              }}
            />
          )}
        </AnimatePresence>
      </OverlayPortal>

      {/* Exporting happens over the book, not instead of it: the drawer stays
          where it was, and closing the dialog puts the reader back on the list
          they were reading from. */}
      {exportingNotes && bookId && (
        <Suspense fallback={null}>
          <ExportNotesDialog
            subject={`《${title}》`}
            name={title}
            highlights={(annotations ?? []).length}
            notes={(annotations ?? []).filter((annotation) => annotation.note !== null).length}
            busy={exportNotes.isPending}
            error={exportNotes.error ? String(exportNotes.error) : null}
            onCancel={() => {
              setExportingNotes(false);
              exportNotes.reset();
            }}
            onConfirm={(path, exportFormat) =>
              exportNotes.mutate(
                { id: bookId, name: title, path, format: exportFormat },
                { onSuccess: () => setExportingNotes(false) },
              )
            }
          />
        </Suspense>
      )}

      {/* The share card rides alongside the export dialog: same reasoning —
          it draws a whole canvas, so it stays out of the initial bundle, and
          the reader stays on the drawer while it opens. */}
      <Suspense fallback={null}>
        <QuoteCardDialog
          annotation={shareAnnotation}
          open={shareAnnotation !== null}
          onOpenChange={(open) => setShareAnnotation(open ? shareAnnotation : null)}
        />
      </Suspense>
    </div>
  );
}

/** A non-negative integer query parameter, or `null` when absent or malformed. */
function readOffset(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Route entry: one reader, or a 对照阅读 pair.
 *
 * The URL is the record of what is open (`?book=A&pair=B`); the persisted
 * pair store is what a relaunch restores from. Both are kept in step here so
 * neither can tell a story the other contradicts: closing the pair clears
 * the store, and opening either book of a remembered pair puts the other one
 * back beside it.
 */
export function ReaderPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const bookId = searchParams.get("book");
  const pairedId = searchParams.get("pair");
  const initialChapter = readOffset(searchParams.get("chapter"));
  const initialOffset = readOffset(searchParams.get("at"));
  const initialQuery = searchParams.get("q") ?? "";
  // A `fangce://` link lands here as a plain query parameter, so the deep
  // link and a search result reach the reader the same way.
  const initialAnnotation = searchParams.get("annotation");
  const [picking, setPicking] = useState(false);

  // One effect keeps the URL and the store telling the same story, and the
  // order inside it is the whole point: a solo open of a book that is
  // remembered in a pair must *restore* the pair, while a pair the reader
  // just closed must stay closed — and both arrive as the same URL (`?book=A`
  // with no `pair`). They are told apart by what the close did first: it
  // cleared the store, so this reads it before anything can re-add the pair.
  useEffect(() => {
    if (bookId === null) {
      // Nothing to sync, and nothing to sweep. The shell keeps rendering the
      // reader it is leaving for a beat after the route changed (the route
      // transition sends the old page out while the new one arrives), and that
      // farewell render reads exactly like "a reader with no book" — clearing
      // here would forget the pair every time the shelf was opened *from* it.
      // The pair is forgotten by the 退出对照 that closes it, and by nothing
      // else: a pair is a relationship between two books, not a mode one of
      // them is in, and opening either of them later still brings the other
      // back.
      return;
    }
    if (pairedId !== null) {
      // The URL is the record. A book paired with itself is not a pair, so
      // that URL reads as solo and leaves nothing behind.
      if (pairedId === bookId) usePairView.getState().clearPair();
      else usePairView.getState().setPair(bookId, pairedId);
      return;
    }
    const store = usePairView.getState();
    const partner = partnerOf(store.pair, bookId);
    if (partner !== null) {
      // A pair is a relationship between two books: opening either one
      // brings the other back beside it.
      const next = new URLSearchParams(searchParams);
      next.set("pair", partner);
      setSearchParams(next, { replace: true });
    }
    // No partner: nothing to restore, and nothing to sweep. A pair that does
    // not involve this book stays remembered — opening one of *its* books
    // later still restores it — and a pair that *did* involve this book was
    // already cleared by the 退出对照 that closed it. Treating a plain solo
    // open as "forget the pair" would make the pair survive one book but not
    // two, which is not a rule anyone could predict.
  }, [bookId, pairedId, searchParams, setSearchParams]);

  // A book paired with itself is not a pair; the URL reads as solo so the
  // reader page never renders the same book twice.
  const split = bookId !== null && pairedId !== null && pairedId !== bookId;

  // One way out, shared by the seam's ✕ and the picker's own button.
  const exitPair = () => {
    // Forgetting the pair *first* is what keeps the sync effect above from
    // reading it back: the store is already empty by the time the effect
    // runs, so a closed pair stays closed.
    setPicking(false);
    usePairView.getState().clearPair();
    const next = new URLSearchParams(searchParams);
    next.delete("pair");
    setSearchParams(next);
  };

  const picker = (
    <PairPicker
      open={picking}
      currentId={bookId}
      partnerId={pairedId}
      onPick={(id) => {
        setPicking(false);
        const next = new URLSearchParams(searchParams);
        next.set("pair", id);
        setSearchParams(next);
      }}
      onClose={() => setPicking(false)}
      onExitPair={split ? exitPair : undefined}
    />
  );

  if (split) {
    return (
      <>
        <SplitReader
          bookId={bookId}
          partnerId={pairedId}
          initialChapter={initialChapter}
          initialQuery={initialQuery}
          initialOffset={initialOffset}
          initialAnnotation={initialAnnotation}
          onOpenPair={() => setPicking(true)}
          onExitPair={exitPair}
        />
        {picker}
      </>
    );
  }

  return (
    <>
      <ReaderHost
        bookId={bookId}
        initialChapter={initialChapter}
        initialQuery={initialQuery}
        initialOffset={initialOffset}
        initialAnnotation={initialAnnotation}
        onOpenPair={() => setPicking(true)}
      />
      {picker}
    </>
  );
}
