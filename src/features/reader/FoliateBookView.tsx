import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ipc, isDesktopRuntime } from "../../lib/ipc";
import { demoBookBytes, demoEnabled } from "../../lib/demo";
import { Overlayer } from "foliate-js/overlayer.js";
import type { FoliateRelocate, View, makeBook } from "foliate-js/view.js";
import type { Annotation } from "@/types/ipc";
import type { LayoutMode, PageTransition } from "./theme";
import { DEFAULT_MARGIN_X } from "@/stores/reader";
import { speechUnits, unitsFromOffset } from "./speech";
import type { SpeechUnit, Span } from "./speech";
import { foliateWash } from "./ttsWash";
import type { TtsWashStyle } from "./ttsWash";
import { buildStyleSheet, verticalQuotes } from "./foliateStyle";
import { applySectionText } from "./sectionText";
import type { TextLayer } from "./sectionText";
import { loadZhConverter } from "./zhConvert";
import type { ZhConverter } from "./zhConvert";
import { lineRects, relayRulerLayout, relaySectionKeys } from "./rulerPointer";
import type { RulerRect } from "./rulerPointer";
import { effectiveKeys, shortcutMatches } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";
import { useSettings } from "@/stores/settings";
import { CapturedPageTurn } from "./capturedTurn";
import { markLoneFigures } from "./loneFigure";
import type { FoliateStyle } from "./foliateStyle";

/**
 * Whether this sheet forces the vertical axis. 跟随书籍 (`auto`) injects no
 * writing-mode, so the injected axis is horizontal from our side even when the
 * book's own sections turn out vertical — the paginator handles those on its
 * own; what this component acts on is a change *we* caused.
 */
const injectedVertical = (style: FoliateStyle): boolean => style.writingMode === "vertical";
import { inkWash, selectionBottom } from "./selection";
import { bookPageFromLocation } from "./progress";
import { findInSections, findRange, indexText } from "./textAnchor";
import type { TextIndex } from "./textAnchor";

/**
 * Every text rewrite that is on right now, in the order they apply — 替换引号
 * first, then 简繁转换. Module scope rather than a memo: it captures nothing,
 * so a section that mounts and a section that is already up go through
 * exactly the same pipeline, and an effect can depend on the flags alone.
 */
function sectionTextLayers(quoteReplace: boolean, converter: ZhConverter | null): TextLayer[] {
  const layers: TextLayer[] = [];
  if (quoteReplace) layers.push(verticalQuotes);
  if (converter) layers.push(converter);
  return layers;
}

/** Where the reader is. `cfi` is opaque — hand it back to foliate verbatim. */
export type FoliateLocation = {
  cfi: string;
  /** Progress through the whole book, 0..1, foliate's own section progress. */
  fraction: number;
  /** Label of the covering TOC entry, or "" when the book has no TOC. */
  label: string;
  /** Page within the current section, paginated layouts only. */
  page: { current: number; total: number } | null;
  /**
   * Where the reader is, in whole-book pages, or `null` before foliate has
   * built its section-progress table.
   *
   * This is foliate's own `location` counter — the size domain, 1500 bytes a
   * page — not an estimate off the section on screen. See
   * `bookPageFromLocation`: the counter is a property of the book, so it does
   * not move as the book is read, which is what an estimate could not manage.
   */
  bookPage: { page: number; pages: number } | null;
};

/**
 * A completed selection inside a section, ready to become an annotation.
 *
 * `cfi` is foliate's own anchor and the only thing that can re-locate the
 * range: Kindle sections do not line up with the chapter indices our importer
 * extracts, so the (chapter, offset) pair the prose path stores is meaningless
 * here. `section` and the two offsets are still recorded — the section index
 * keeps the annotation list ordered, and the offsets make a row stable enough
 * to delete without resolving the CFI.
 */
export type FoliateSelection = {
  cfi: string;
  text: string;
  /** foliate section index; stored as the annotation's `chapterIdx`. */
  section: number;
  /** In-section UTF-16 offsets, so the list can sort and the pill can delete. */
  startChar: number;
  endChar: number;
  /** Viewport coordinates of the selection box, for the floating pill. */
  x: number;
  y: number;
  /** Bottom edge of the selection box in host window coordinates — the last
   *  line that carries text, not the range's bounding box (see
   *  `selectionBottom`). */
  bottom: number;
};

/** One full-text match, with the words around it for the hit list. */
export type FoliateSearchHit = {
  /** Jump target; also the key foliate highlights the match under. */
  cfi: string;
  /** The section's TOC label, empty when the book has none. */
  label: string;
  pre: string;
  match: string;
  post: string;
};

/** One entry of the book's own table of contents, flattened for a list. */
export type FoliateTocEntry = {
  label: string;
  /** The href foliate resolves to a section + anchor; empty means "no link". */
  href: string;
  /** Nesting depth in the book's TOC, 0 at the top level. */
  depth: number;
};

/** One highlight the parent wants the view to navigate to. */
export type FoliateHighlight = {
  id: string;
  /** The stored anchor, `null` while the highlight has never been anchored. */
  cfi: string | null;
  /** The highlight's text: the only handle an unanchored one has. */
  text: string;
  /** Where the chapter it was recorded in begins, as a whole-book fraction. */
  fraction: number;
};

/** Imperative navigation the parent drives from the chrome. */
export type FoliateHandle = {
  /** One page (paginated) or one scroll step, like the flip arrows. */
  flip: (dir: 1 | -1) => void;
  /** One section — the chapter arrows. */
  section: (dir: 1 | -1) => void;
  /** True at the first/last page of the current section, with a neighbour. */
  atEdge: (dir: 1 | -1) => boolean;
  /** Jump to a TOC entry by its index in the flattened list. */
  goToEntry: (index: number) => void;
  /**
   * Navigates to a highlight, minting its anchor on the way when it has none.
   *
   * A highlight made before foliate rendered this format — or imported from a
   * clippings file — carries text and a chapter, not a CFI. The way there is
   * the chapter's fraction (the two index schemes do not agree), then the text
   * search that ends in an anchor; from that point the highlight is an ordinary
   * one, stored and painted like any other.
   */
  goToHighlight: (highlight: FoliateHighlight) => void;
  /** Advances the scrolled flow by whole `delta` px, `subpixel` carried as a
   *  composited transform; no-op outside the scroll layout. Returns how far the
   *  flow actually went — the browser clamps the scrollport to the content
   *  extent, and the reading ruler holds its band on its line by scrolling
   *  exact block distances, so it needs to know when a clamp ate part of one. */
  scrollByPx: (delta: number, subpixel: number) => number;
  /** True parked on the very end of the book (auto-scroll stop). */
  bookEnd: () => boolean;
  /** Jumps to a foliate anchor string (a CFI). */
  goToCfi: (cfi: string) => void;
  /** Jumps to a whole-book fraction, the only anchor a bookmark or a chapter
   *  index from the importer can offer inside a foliate book. */
  goToFraction: (fraction: number) => void;
  /** Full-text search across every section; every hit stays highlighted in
   *  the book until `clearSearch`. */
  search: (query: string) => Promise<FoliateSearchHit[]>;
  /** Undoes `search`: drops every match highlight from the sections. */
  clearSearch: () => void;
  /** Read-aloud units of the section on screen, starting at the first block
   *  the reader can actually see. Waits out a pending section change; resolves
   *  empty at the end of the book. */
  readFrom: () => Promise<SpeechUnit[]>;
  /** The same units, but starting at the sentence holding the reader's
   *  selection inside the section. */
  readFromSelection: () => Promise<SpeechUnit[]>;
  /** Brings the unit `readFrom` handed out into view, and washes `span` — the
   *  whole unit, or the word the engine reported. `"block"` washes everything
   *  the unit sits in (the paragraph level) and `null` scrolls without
   *  painting: at word granularity nothing is washed until the voice says
   *  where it is, so the sentence never flashes first. */
  focusUnit: (unit: SpeechUnit, span: Span | null | "block") => void;
  /** Re-washes a narrower run of the unit already in view, without scrolling
   *  — the word-level update that lands several times inside one sentence. */
  paintSpan: (unit: SpeechUnit, span: Span) => void;
  /** Drops the read-aloud wash. */
  clearTts: () => void;
  /** Where the live selection sits now, in host window coordinates — or
   *  `null` when the section has nothing selected. The host's own
   *  `getSelection` cannot see inside a section iframe, so the pill asks here
   *  to follow the words it belongs to across a page turn or a scroll. */
  selectionBox: () => { x: number; y: number; bottom: number } | null;
  /**
   * The lines of type the reader can see, in host window coordinates — the
   * reading ruler's own geometry, which it cannot gather for itself: the words
   * are in section iframes, and a rect inside one says nothing about where the
   * section sits on the reader's screen.
   *
   * Every loaded section is walked, not just the one on screen, and the frame's
   * own box is the conversion (the same one `rangeInHostView` makes), because a
   * paginated section is one long strip shown through a moving window: the
   * off-screen columns come back as rects far outside the reading area, where
   * the ruler's "nearest line" rule can never pick them.
   *
   * Each section's rects are also cut to the page the paginator is actually
   * painting — see `pageBox`.
   */
  rulerLines: () => readonly RulerRect[];
};

/**
 * foliate renders every book section in its own blob: iframe. Once the reader
 * clicks into the book text, focus lives inside that iframe, and keydown
 * events dispatched there never bubble to the parent window — so the global
 * pager in ReaderPage (bound on `window`) stops receiving ArrowLeft/Right and
 * Escape. Forward the keys we actually handle from the section document up to
 * the parent window, where the existing handler runs. Editable targets (rare
 * in books, but possible) keep their native behaviour.
 *
 * **Global hotkeys are part of "the keys we handle".** ⌘K, ⌘, and ⌘B live on
 * the parent window's command registry (`useHotkeys`), so a press carrying a
 * modifier was dead the moment the reader clicked into the text — ⌘K opened
 * the palette everywhere except inside a book, which is where one reads. The
 * registry decides, rather than a list of keys kept here: a rebound key works
 * in the book on the same day it starts working outside it.
 *
 * It has to be the registry and not "every modified press": ⌘C/⌘V/⌘A belong to
 * the book's own selection. `preventDefault` below kills the native action in
 * the iframe, and the synthetic event dispatched on the parent window carries
 * no default action of its own — forwarding those would have quietly broken
 * copy from the page.
 */
const FORWARDED_KEYS = new Set(["ArrowLeft", "ArrowRight", "Escape"]);

/** Whether any command is bound to this press — the same question `useHotkeys`
 *  asks, so the two cannot disagree about what a shortcut is. */
function commandBoundTo(event: KeyboardEvent): boolean {
  const { commands } = useCommandStore.getState();
  const { keyOverrides } = useSettings.getState();
  for (const command of commands) {
    if (command.isEnabled && !command.isEnabled()) continue;
    const keys = effectiveKeys(command.id, command.shortcut, keyOverrides);
    if (keys?.some((shortcut) => shortcutMatches(event, shortcut))) return true;
  }
  return false;
}

const forwardKeyFromSection = (event: KeyboardEvent) => {
  if (!FORWARDED_KEYS.has(event.key) && !commandBoundTo(event)) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  ) {
    return;
  }
  // Stop the iframe from scrolling/acting on the key; the parent window
  // handler performs the page turn. The synthetic event is trusted=false but
  // the handler only reads `key`/`code`/modifiers, so it works regardless.
  event.preventDefault();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      cancelable: true,
      bubbles: true,
    }),
  );
};

/**
 * Payload of foliate's `draw-annotation`: the caller owns the ink, and only
 * it knows which colour and shape a highlight should be. `annotation` echoes
 * whatever the caller passed to `addAnnotation`.
 */
type DrawAnnotationDetail = {
  draw?: (paint: typeof Overlayer.highlight, options?: Record<string, unknown>) => void;
  annotation?: { value?: string; color?: string | null; style?: string | null };
};

/** Payload of foliate's `show-annotation`: a click on a painted highlight. */
type ShowAnnotationDetail = {
  value?: string;
  range?: Range;
};

/**
 * Block-level elements that carry running text. Read-aloud walks these and
 * takes the innermost ones, so a wrapper `<div>` full of `<p>`s is not read
 * as one giant block after its children.
 */
const BLOCK_SELECTOR =
  "p, li, blockquote, dd, dt, figcaption, pre, h1, h2, h3, h4, h5, h6, td, th, div";

/** Overlayer key of the transient read-aloud wash (one unit at a time). */
const TTS_KEY = "fangce-tts";

/**
 * Smallest rendered box (px, each axis) that opens the image viewer when
 * clicked. Below this a picture is decoration — a rule, a bullet, a heading
 * ornament — and opening a full-screen viewer over it would be noise.
 */
/**
 * Which section a section document belongs to. Keyed weakly: a document dies
 * with its iframe, and the entry with it.
 */
const sectionOfDoc = new WeakMap<Document, number>();

const MIN_VIEWABLE_IMAGE = 48;

/**
 * Night for a fixed-layout page. Those pages are the book's own art: they
 * carry no typography to override and the injected stylesheet never reaches
 * them, so a filter on the page frame is the only lever — and it inverts the
 * page's pictures along with its paper, which is why it follows the
 * image-inversion setting instead of the surface.
 *
 * It must stay off for reflowable books. The paginator marks *every* section
 * frame with `part="filter"` exactly like `foliate-fxl` does
 * (paginator.js `setAttribute('part', 'filter')`), so flagging the view here
 * inverted the finished night page: dark paper with light ink came back out
 * light with dark ink, photographs and all.
 */
const syncPageInvert = (view: View, style: FoliateStyle) => {
  if (style.dark && style.invertImages && view.isFixedLayout) {
    view.setAttribute("data-fxl-night", "");
  } else {
    view.removeAttribute("data-fxl-night");
  }
};

/** Container name + MIME handed to `makeBook`, per format. */
const CONTAINER: Record<string, { ext: string; type: string }> = {
  mobi: { ext: "mobi", type: "application/x-mobipocket-ebook" },
  azw: { ext: "azw", type: "application/x-mobipocket-ebook" },
  azw3: { ext: "azw3", type: "application/x-mobipocket-ebook" },
  prc: { ext: "prc", type: "application/x-mobipocket-ebook" },
  epub: { ext: "epub", type: "application/epub+zip" },
};

type Props = {
  bookId: string;
  format: string;
  /** CFI captured from a previous session; ignored when empty. */
  startCfi?: string | null;
  /**
   * Where to land when there is no CFI yet — a book first opened under
   * foliate. The importer's chapter indices do not line up with foliate
   * sections, so the closest available anchor is the whole-book fraction.
   */
  startFraction?: number | null;
  /** Reading layout, mapped onto the foliate renderer's attributes. */
  layout: LayoutMode;
  /** Page turn animation; `slide`/`pan` = native clipped pan, `fade`/`paper` = VT. */
  transition: PageTransition;
  /** Page margins in px, fed to the paginator's margin attributes. */
  marginX: number;
  marginY: number;
  /** Reader typography and palette, injected as a stylesheet. */
  style: FoliateStyle;
  /**
   * Saved highlights. Only the ones carrying a `cfi` can be painted: foliate
   * anchors on CFIs, so a highlight imported from a clippings file is searched
   * for by its text the first time its section mounts and gains one through
   * `onAnchor`. It sits in the highlight list until then rather than being
   * painted in the wrong place.
   */
  annotations?: readonly Annotation[];
  /** The read-aloud wash the reader chose: shape and ink. */
  ttsWash: { style: TtsWashStyle; color: string | null };
  /** A completed selection, or `null` when the user cleared it. */
  onSelect?: (selection: FoliateSelection | null) => void;
  /** A click on a painted highlight: `cfi` plus viewport coordinates. */
  onAnnotationClick?: (cfi: string, x: number, y: number) => void;
  /**
   * A highlight that arrived without a foliate anchor — an import from a Kindle
   * clippings file knows only the text it quotes — once it has been located in
   * the section that carries it. The reader stores the CFI, so the next open
   * paints it straight away; until then it is a row in the highlight list with
   * nothing on the page.
   */
  onAnchor?: (id: string, cfi: string) => void;
  /**
   * A click on a picture in the book, with its archive entry path — the key
   * `book_images` hands out. Only raised for images big enough to be worth
   * opening; icons and rules are ignored.
   *
   * The browser build gets two more arguments and needs both: `src`, the blob
   * URL foliate decoded the picture into (the desktop loads the entry back
   * through `book_asset`, which has no browser answer), and `section`, the
   * section index the lightbox's chapter label and jump key address.
   */
  onImageOpen?: (path: string, src?: string, section?: number) => void;
  onLocationChange?: (location: FoliateLocation) => void;
  /** Called once the book is open, with the flattened table of contents. */
  onTocLoaded?: (entries: FoliateTocEntry[]) => void;
  /** A pointer went down on the book's text. It happens inside the section's
   *  iframe, where this document hears nothing; the section handler forwards
   *  it so 对照阅读 can hand the window's controls to the pane that was
   *  clicked. */
  onActivate?: () => void;
  /**
   * The pointer moved inside a section. Same reason as `onActivate` — an
   * iframe keeps its own events — and what restarts the page number's
   * stillness clock: a foliate book's text is not the host's own element, so
   * the pane's `pointermove` never fires while the pointer is on the page.
   */
  onPointerInBook?: (event: PointerEvent) => void;
};

/**
 * Whether this element still paints anything. The flip arrows fade themselves
 * out two seconds after the last pointer event, and a turn that finds them gone
 * has nothing to mask. An engine without `checkVisibility` says "paints" — a
 * wasted paint wait beats arrows baked into the turning sheet.
 */
const paints = (node: HTMLElement) =>
  typeof node.checkVisibility === "function"
    ? node.checkVisibility({ opacityProperty: true })
    : true;

/**
 * Our page transitions onto foliate's turn pipeline.
 *
 * **`pan`** — foliate's native scroll pan (the default turn in stock foliate,
 * and readest's "Push"): we set `animated` but no `turn-style`, so the
 * paginator's `#layeredTurn` is null and the page physically scrolls via
 * `cssAnimateScroll` / `rafAnimateScroll` (a transform on the column strip).
 * It runs inside the renderer div, which our reading pane clips with
 * `overflow:hidden`, so the animation never bleeds into the sidebar — exactly
 * the EPUB prose path's `scrollTo({behavior:"smooth"})`.
 *
 * **`slide`（覆盖）/ `fade`** — the fork's layered View Transition styles
 * (readest#555): the outgoing page is snapshotted and animated over the live
 * incoming one. These paint in the viewport-fixed top layer (escaping ancestor
 * `overflow:hidden`), so the host is marked `data-view-transition-root` and
 * foliate's `#vtSetup` names that element `foliate-turn`; globals.css then
 * clips that group back to the reading pane. The paginator gates them on
 * `document.startViewTransition` on its own (`#layeredTurn`); an engine without
 * it falls back to the native pan by itself.
 *
 * **`flip`（翻牌）** — `curl` in the table below, and *always* the View
 * Transition: the sheet swings about the spine with perspective. A card flip,
 * not a curl — a CSS transform cannot bend a sheet. This is what「仿真」was
 * before it grew a real paper curl, kept as its own option under the name that
 * describes what it actually does.
 *
 * **`paper`（仿真）** — the same View Transition, but here it is only the
 * *browser* fallback: on the desktop build `CapturedPageTurn` takes the turn
 * first — a native snapshot of the pane bent around a cylinder mesh in WebGL,
 * which is what readest's desktop does. `turn-style` stays set so any turn that
 * slips past the captured path (a partial step, a book boundary, a snapshot
 * failure) still animates rather than jumping.
 *
 * `animated` is the master switch; without it (`none`) every turn is instant.
 */
const ANIMATED: Record<PageTransition, boolean> = {
  none: false,
  pan: true,
  slide: true,
  fade: true,
  flip: true,
  paper: true,
};
const TURN_STYLE: Record<PageTransition, string | null> = {
  none: null,
  pan: null,
  slide: "slide",
  fade: "fade",
  flip: "curl",
  paper: "curl",
};

/**
 * foliate's own page-box width — `--_max-inline-size` in `paginator.js`.
 *
 * The box is capped here, which is why the side margin cannot be a plain
 * padding: `--_margin-*` are grid tracks *outside* the box, so raising the
 * margin widens the container the columns are measured against and the text
 * gets wider, not narrower (the reader's「窄更宽、宽更窄」).
 */
const PAGE_WIDTH = 720;

/** Page box is never squeezed below this, whatever the margin says. */
const MIN_PAGE_WIDTH = 240;

/**
 * The box cap that makes a bigger side margin mean a narrower page.
 *
 * Box + both margins stays constant, so the cap shrinks by twice what each
 * margin grows by and the columns are measured against less width. Calibrated
 * so the default margin (96) lands on foliate's own 720 — the look before this
 * existed is unchanged.
 */
const pageWidthFor = (marginX: number) =>
  Math.max(MIN_PAGE_WIDTH, PAGE_WIDTH + 2 * (DEFAULT_MARGIN_X - marginX));

/**
 * Maps our layout mode onto the foliate paginator's attributes:
 * scroll = one continuous flow, single = one column, double = a spread.
 * Setting an attribute triggers the paginator's own re-render, and it
 * anchors the current position while reflowing. Page margins ride the same
 * channel (`margin-*` attributes feed the paginator's `--_margin-*` vars).
 *
 * Every write is skipped when the attribute already holds that value, because
 * each one is a full re-columnisation of the section (about a second per
 * chapter in WebKit): writing all seven unconditionally turned 单页 → 双页 —
 * one attribute's worth of change — into seven reflows and ~6s of dead time.
 */
const applyLayout = (
  view: View,
  layout: LayoutMode,
  transition: PageTransition,
  margin: { x: number; y: number },
) => {
  const renderer = view.renderer;
  if (!renderer) return;
  /** Set (or clear) one attribute, but only when it actually changes. */
  const put = (name: string, value: string | null) => {
    if (value === null) {
      if (renderer.hasAttribute(name)) renderer.removeAttribute(name);
    } else if (renderer.getAttribute(name) !== value) {
      renderer.setAttribute(name, value);
    }
  };
  if (layout === "scroll") {
    put("flow", "scrolled");
    put("max-column-count", null);
    put("animated", null);
    put("turn-style", null);
  } else {
    // Column count before flow: while the paginator is still scrolled, writing
    // it re-renders cheaply (a scrolled flow has no columns to lay out), and
    // the one expensive re-columnisation then happens on the flow switch.
    // The other order pays for two — 滚动 → 单页 was 1.8s on a book whose whole
    // text is a single section, against 0.9s this way. Both writes land in the
    // same task, so the half-applied state is never painted.
    put("max-column-count", layout === "double" ? "2" : "1");
    put("flow", "paginated");
    // `animated` is the master switch. `pan` omits `turn-style` so foliate uses
    // its native scroll pan (clipped to the reading pane); `slide` / `fade` /
    // `paper` set a layered `turn-style` for VT effects, scoped to
    // `data-view-transition-root`.
    if (ANIMATED[transition]) {
      put("animated", "");
      put("turn-style", TURN_STYLE[transition] ?? null);
    } else {
      put("animated", null);
      put("turn-style", null);
    }
  }
  put("max-inline-size", `${pageWidthFor(margin.x)}px`);
  put("margin-left", `${margin.x}px`);
  put("margin-right", `${margin.x}px`);
  put("margin-top", `${margin.y}px`);
  put("margin-bottom", `${margin.y}px`);
};

/**
 * The page a section is painted on, in host window coordinates — the box
 * foliate's paginator actually clips that section to, or `null` when it has not
 * been laid out yet.
 *
 * A paginated section is one long strip of pages inside a single iframe, and
 * the page on screen is a *window onto it*: the iframe is as wide as the whole
 * chapter, and the paginator clips it to a page box narrower than the reading
 * pane (the pane keeps an outer margin on each side, and the page sits centred
 * in it). Nothing of the pages either side is painted, and the reading area's
 * own coordinates cannot tell that from text: the next page starts inside the
 * pane's margin, so its first line — a fragment a couple of hundred pixels long
 * — passes any "is it inside the pane" test the ruler could write.
 *
 * The box is read rather than derived. The paginator's own view element is the
 * one that clips (an `overflow: hidden` box whose width is the page, not the
 * strip), and asking the DOM for it survives every re-layout: the sidebar
 * collapsing, fullscreen, a change of column count. Reconstructing it from the
 * column pitch and the pane's centre is arithmetic that has to be redone
 * whenever foliate changes how it spaces pages.
 */
const pageBox = (frame: HTMLElement, strip: DOMRect): RulerRect | null => {
  // `frame` → the view element that clips it → the container that clips that.
  // The first ancestor narrower than the strip is the page.
  for (let el = frame.parentElement; el; el = el.parentElement) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.width < strip.width) {
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    }
  }
  return null;
};

/** One text node of a block, with its offset inside the block's raw text. */
type TextNodeAt = { node: Text; start: number };

/** A block of running text, addressable by character offsets. */
type TextBlock = { text: string; nodes: TextNodeAt[] };

/**
 * Read-aloud blocks of one section document: the innermost text blocks, in
 * document order, each with its text nodes so any character range in
 * `spokenBlocks`' own coordinate space maps back to a DOM `Range`.
 *
 * `getSentences` from foliate's TTS module would segment by sentence, but it
 * builds its ranges with the *host* `document`, and handing it nodes from a
 * blob: iframe is a cross-document Range write — fine in some engines,
 * `WrongDocumentError` in others. Walking block elements keeps every range in
 * the section's own document.
 */
const readBlocks = (doc: Document): TextBlock[] => {
  const root = doc.body ?? doc.documentElement;
  const leaves = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (el) => el.querySelector(BLOCK_SELECTOR) === null,
  );
  const out: TextBlock[] = [];
  for (const el of leaves) {
    const block = blockOf(el);
    if (block) out.push(block);
  }
  if (out.length === 0) {
    // Books that put running text straight into <body> with no block elements.
    const block = blockOf(root);
    if (block) out.push(block);
  }
  return out;
};

/** `el`'s raw text plus the text nodes it is made of, or `null` when empty. */
const blockOf = (el: Element): TextBlock | null => {
  const doc = el.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: TextNodeAt[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push({ node: textNode, start: text.length });
    text += textNode.data;
  }
  if (text.trim() === "") return null;
  return { text, nodes };
};

/**
 * A `Range` over `[start, end)` of a block's raw text. Offsets past the last
 * node (or between two of them) clamp to the nearest position, so a unit whose
 * trailing whitespace was collapsed still resolves.
 */
const rangeIn = (block: TextBlock, start: number, end: number): Range | null => {
  const first = block.nodes[0];
  if (!first) return null;
  const doc = first.node.ownerDocument;
  const point = (offset: number) => {
    for (const { node, start: at } of block.nodes) {
      if (offset < at + node.data.length) return { node, offset: offset - at };
    }
    const last = block.nodes[block.nodes.length - 1]!;
    return { node: last.node, offset: last.node.data.length };
  };
  const from = point(Math.min(start, block.text.length));
  const to = point(Math.min(end, block.text.length));
  const range = doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
};

/** Index of the first block the reader can see in `host` — the block "read
 *  from here" starts at. Falls back to the top of the section. */
const firstVisibleBlock = (blocks: readonly TextBlock[], host: HTMLElement | null): number => {
  if (!host) return 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const range = rangeIn(block, 0, Math.min(1, block.text.length));
    if (range && rangeInHostView(host, range)) return i;
  }
  return 0;
};

/**
 * Utterance units of a section, dropped up to `block`/`offset` — the reader's
 * own position, in the section's block coordinates. When the position falls
 * inside a sentence the first utterance is trimmed to it, so 「朗读此处」 on
 * three selected words starts with those words. Keeping the block indices
 * intact (rather than renumbering) is what lets `focusUnit` map a unit back to
 * the block it came from.
 */
const unitsFrom = (blocks: readonly TextBlock[], block: number, offset: number): SpeechUnit[] =>
  unitsFromOffset(
    speechUnits(blocks.map((entry, index) => ({ index, text: entry.text }))),
    block,
    offset,
  );

/**
 * Viewport coordinates of a box measured inside a section iframe, translated
 * to the host window — the floating pill is `position: fixed` in that space.
 */
const toHostPoint = (owner: Document | null, rect: { left: number; top: number }) => {
  const frame = owner?.defaultView?.frameElement?.getBoundingClientRect();
  return { x: rect.left + (frame?.left ?? 0), y: rect.top + (frame?.top ?? 0) };
};

/**
 * The live selection's box in host window coordinates, or `null` when the
 * section has nothing selected. The one place the pill's anchor is measured,
 * so its first placement and every later re-measurement agree.
 */
function measureSelection(
  doc: Document,
): { range: Range; owner: Document; box: { x: number; y: number; bottom: number } } | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const box = range.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const owner = range.startContainer.ownerDocument ?? doc;
  const point = toHostPoint(owner, box);
  // `toHostPoint` shifts by the section iframe's own origin, so the last
  // line's in-frame bottom needs that same shift added back.
  const frameY = point.y - box.top;
  return {
    range,
    owner,
    box: {
      x: point.x + box.width / 2,
      y: point.y,
      bottom: selectionBottom(range.getClientRects(), box) + frameY,
    },
  };
}

/**
 * True when a range inside a section falls inside the view's own box.
 *
 * Both axes have to be tested, not just the vertical one. The two flows move
 * different things: `scrolled` grows each section iframe to its full content
 * height and scrolls the host, `paginated` translates a column strip inside a
 * fixed iframe. Under pagination every column shares the same vertical band —
 * a paragraph on page 40 has the same `top` as one on page 1 — so a
 * vertical-only test passes for the whole section and "read from here" lands
 * on the first paragraph of the chapter. The horizontal half is what tells the
 * columns apart, and the host's box is still the one space both flows agree
 * on.
 */
const rangeInHostView = (host: HTMLElement, range: Range): boolean => {
  const box = range.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  const owner = range.startContainer.ownerDocument;
  const frame = owner?.defaultView?.frameElement?.getBoundingClientRect();
  const left = box.left + (frame?.left ?? 0);
  const top = box.top + (frame?.top ?? 0);
  const hostBox = host.getBoundingClientRect();
  return (
    top + box.height > hostBox.top + 2 &&
    top < hostBox.bottom - 2 &&
    left + box.width > hostBox.left + 2 &&
    left < hostBox.right - 2
  );
};

/** A node of the book's nested TOC (structurally foliate's own shape). */
type TocNode = { label?: string; href?: string; subitems?: TocNode[] };

/** Flattens foliate's nested TOC into a depth-tagged list. */
const flattenToc = (toc: TocNode[] | undefined): FoliateTocEntry[] => {
  const out: FoliateTocEntry[] = [];
  const walk = (items: TocNode[], depth: number) => {
    for (const item of items) {
      out.push({ label: item.label?.trim() ?? "", href: item.href ?? "", depth });
      if (item.subitems?.length) walk(item.subitems, depth + 1);
    }
  };
  walk(toc ?? [], 0);
  return out.filter((entry) => entry.label !== "");
};

/**
 * Kindle-format reader powered by foliate-js.
 *
 * MOBI/AZW3 (KF6/KF7/KF8) are the one family our plain-paragraph pipeline
 * cannot render faithfully: the page's own stylesheet paints wallpapers,
 * part-title plates and drop caps that a text extract throws away. foliate
 * reassembles each KF8 skeleton with its fragments and hands the browser the
 * original XHTML + CSS, which is what readest does — so the book looks like
 * its designer made it, not like our extraction.
 *
 * The element is created once per book and driven imperatively: foliate owns
 * paging, scrolling, selection and its own history stack.
 */
const FoliateBookView = forwardRef<FoliateHandle, Props>(function FoliateBookView(
  {
    bookId,
    format,
    startCfi,
    startFraction,
    layout,
    transition,
    marginX,
    marginY,
    style,
    annotations,
    ttsWash,
    onSelect,
    onAnnotationClick,
    onAnchor,
    onImageOpen,
    onLocationChange,
    onTocLoaded,
    onActivate,
    onPointerInBook,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read-aloud wash. The prose path draws the same one with a `<mark>`, so a
  // reader switching a book's format sees one marker, not two styles.
  // Mirrored into refs for `focusUnit`/`paintTts`, which are created once and
  // cannot capture a changing value.
  const ttsRef = useRef<Overlayer | null>(null);
  const ttsPaintRef = useRef(foliateWash(ttsWash.style, ttsWash.color, style.dark));
  const ttsRangeRef = useRef<Range | null>(null);
  // The listener lives for the lifetime of the element, so it reads the
  // latest callback through a ref instead of re-opening the book on every
  // parent render.
  const report = useRef(onLocationChange);
  useEffect(() => {
    report.current = onLocationChange;
  }, [onLocationChange]);
  // Same for the two selection-facing callbacks.
  const selectReport = useRef(onSelect);
  const clickReport = useRef(onAnnotationClick);
  const imageReport = useRef(onImageOpen);
  // And for the pane activation, which the per-section handler calls.
  const activateReport = useRef(onActivate);
  // And for pointer movement inside a section, relayed out of the iframe.
  const moveReport = useRef(onPointerInBook);
  useEffect(() => {
    selectReport.current = onSelect;
    clickReport.current = onAnnotationClick;
    imageReport.current = onImageOpen;
    activateReport.current = onActivate;
    moveReport.current = onPointerInBook;
  }, [onSelect, onAnnotationClick, onImageOpen, onActivate, onPointerInBook]); // Read through a ref inside the open effect: layout and style changes are
  // applied by the dedicated effects below, and reopening the book on a
  // settings switch would lose the reading position.
  const layoutRef = useRef(layout);
  const styleRef = useRef(style);
  const transitionRef = useRef(transition);
  const marginsRef = useRef({ x: marginX, y: marginY });
  // Owned by the open effect but reached from the layout one: 「仿真」 is the
  // only transition that parks a GPU surface, and it has to hand it back the
  // moment the reader picks another.
  const capturedRef = useRef<CapturedPageTurn | null>(null);
  const tocRef = useRef<FoliateTocEntry[]>([]);
  // Same reason as `report`: the TOC is announced from inside the open
  // effect, which must not re-run because a parent handed us a new closure.
  const tocReport = useRef(onTocLoaded);
  useEffect(() => {
    tocReport.current = onTocLoaded;
  }, [onTocLoaded]);
  // Highlights and read-aloud units, read by the section handlers below.
  const annotationsRef = useRef<readonly Annotation[]>(annotations ?? []);
  // Finding an anchor for a highlight that arrived without one. The callback
  // goes through a ref for the same reason as the others: the search runs from
  // the section handlers, which are created once.
  const anchorReport = useRef(onAnchor);
  useEffect(() => {
    anchorReport.current = onAnchor;
  }, [onAnchor]);
  // `id|section` pairs already looked at. A section re-mounts on every layout
  // and style change, and re-searching the whole list each time is the one cost
  // of this that a reader would feel.
  const searchedRef = useRef<Set<string>>(new Set());
  // Painted highlights: CFI → the ink signature it was painted with, so a
  // restyle repaints even though the anchor has not changed.
  const paintedRef = useRef<Map<string, string>>(new Map());
  const blocksRef = useRef<TextBlock[]>([]);
  // Where the last selection started, parked for 「朗读此处」: the pill clears
  // the browser's own selection the instant it is tapped.
  const spotAnchor = useRef<{ node: Node; offset: number } | null>(null);

  /**
   * Locates the highlights that have no anchor yet.
   *
   * Two kinds arrive that way: one imported from a Kindle clippings file, and
   * one made before foliate rendered this format — both know their text, and
   * foliate cannot paint what it cannot anchor. The text is the one handle that
   * survives, so every section the paginator mounts is searched for it and the
   * CFI that comes out is handed back to be stored — after that the highlight
   * is an ordinary one everywhere: painting, clicking, jumping to it, and the
   * next open has it before the first page renders.
   *
   * Sections that are not on screen yet are simply not searched yet, so this
   * converges as the book is read rather than loading the whole book up front.
   * Until it lands, the highlight is in the list, which is where the reader
   * finds it either way — and `goToHighlight` is how the list reaches one that
   * is not on screen.
   */
  const resolveAnchors = useCallback(() => {
    const view = viewRef.current;
    const announce = anchorReport.current;
    const renderer = view?.renderer;
    if (!view || !renderer || !announce) return;
    const pending = annotationsRef.current.filter(
      (annotation) => !annotation.cfi && annotation.text !== "",
    );
    if (pending.length === 0) return;

    for (const { index, doc } of renderer.getContents()) {
      if (!doc || index === undefined) continue;
      const body = doc.body ?? doc.documentElement;
      if (!body) continue;
      // Flattened on the first annotation that actually needs it: a section
      // with nothing left to look for pays for a filter, not a walk.
      let searched: TextIndex | null = null;
      for (const annotation of pending) {
        const key = `${annotation.id}|${index}`;
        if (searchedRef.current.has(key)) continue;
        searched ??= indexText(body);
        searchedRef.current.add(key);
        const range = findRange(searched, annotation.text);
        if (!range) continue;
        const cfi = view.getCFI(index, range);
        if (cfi) announce(annotation.id, cfi);
      }
    }
  }, []);

  /**
   * The anchor for `text`, minted from whichever section is on screen.
   *
   * `goToFraction` resolves before the paginator has rendered the section it
   * landed on, so this looks a few times before giving up — the same wait
   * `collectBlocks` does, and for the same reason. Giving up is not a failure:
   * the reader is already standing in the right chapter by then, and the
   * highlight stays in the list either way.
   */
  const mintAnchor = useCallback(
    (text: string): Promise<{ index: number; range: Range } | null> => {
      const renderer = viewRef.current?.renderer;
      if (!renderer) return Promise.resolve(null);
      // The recursive poll `collectBlocks` uses: the section can still be a
      // frame away, and the same rule applies — look a few times, then stop.
      const poll = (attempt: number): Promise<{ index: number; range: Range } | null> => {
        const found = findInSections(renderer.getContents(), text);
        if (found) return Promise.resolve(found);
        if (attempt >= 15) return Promise.resolve(null);
        return new Promise((resolve) => window.setTimeout(resolve, 100)).then(() =>
          poll(attempt + 1),
        );
      };
      return poll(0);
    },
    [],
  );

  /**
   * Paints every CFI-bearing highlight and unpaints the ones that are gone.
   *
   * foliate resolves each CFI to a section and hands the range back through
   * the `draw-annotation` event; sections that are not loaded simply resolve
   * to nothing, so this is safe to call for the whole list at once and is
   * repeated whenever a section mounts.
   *
   * Painted state is keyed by CFI but valued by an ink signature, so a
   * restyle (the toolbar's re-colour path) repaints even though the anchor
   * has not changed.
   */
  const syncAnnotations = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const ink = (annotation: Annotation) => `${annotation.color ?? ""}|${annotation.style ?? ""}`;
    const next = new Map<string, Annotation>();
    for (const annotation of annotationsRef.current) {
      if (annotation.cfi) next.set(annotation.cfi, annotation);
    }
    for (const [cfi, signature] of paintedRef.current) {
      const saved = next.get(cfi);
      if (!saved || ink(saved) !== signature) void view.deleteAnnotation({ value: cfi });
    }
    for (const [cfi, saved] of next) {
      if (paintedRef.current.get(cfi) !== ink(saved)) {
        void view.addAnnotation({ value: cfi, color: saved.color, style: saved.style });
      }
    }
    paintedRef.current = new Map([...next.entries()].map(([cfi, saved]) => [cfi, ink(saved)]));
    // Runs after the anchored ones are painted, so a highlight that gained its
    // CFI since the last pass is drawn in the same breath rather than a frame
    // later.
    resolveAnchors();
  }, [resolveAnchors]);

  /** Turns a section's DOM selection into a CFI-anchored `FoliateSelection`. */
  const captureSelection = useCallback((doc: Document) => {
    const view = viewRef.current;
    const renderer = view?.renderer;
    const measured = view && renderer ? measureSelection(doc) : null;
    if (!view || !renderer || !measured) {
      spotAnchor.current = null;
      selectReport.current?.(null);
      return;
    }
    const { range, owner, box } = measured;
    spotAnchor.current = { node: range.startContainer, offset: range.startOffset };
    const index = renderer.getContents().find((entry) => entry.doc === owner)?.index;
    const text = range.toString();
    if (index === undefined || text.trim() === "") {
      selectReport.current?.(null);
      return;
    }
    // In-section character offsets: the length of the text running from the
    // top of the body to the selection start. They order the annotation list
    // and give the pill something to delete, without needing the CFI.
    const head = owner.createRange();
    head.selectNodeContents(owner.body ?? owner.documentElement);
    head.setEnd(range.startContainer, range.startOffset);
    const startChar = head.toString().length;
    selectReport.current?.({
      cfi: view.getCFI(index, range),
      text: text.trim(),
      section: index,
      startChar,
      endChar: startChar + text.length,
      ...box,
    });
  }, []);

  // The three view events that carry annotations: paint requests, clicks on a
  // painted highlight, and a freshly mounted section (whose overlayer is new,
  // so every highlight in it has to be drawn again).
  /**
   * Paints one annotation in its own ink: a translucent wash, an underline or
   * a squiggle, in the colour the reader picked. The legacy default (no
   * stored colour) is the marker yellow the reader has always seen.
   */
  const onDrawAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent<DrawAnnotationDetail>).detail;
    const draw = detail?.draw;
    if (!draw) return;
    const hex = detail.annotation?.color ?? "#ffd12e";
    switch (detail.annotation?.style ?? "highlight") {
      case "underline":
        draw(Overlayer.underline, { color: hex, width: 2 });
        return;
      case "squiggly":
        draw(Overlayer.squiggly, { color: hex, width: 1.5 });
        return;
      default:
        draw(Overlayer.highlight, {
          // Dark paper needs a lighter hand: the same wash reads heavier
          // against it (the legacy ink's two alphas, kept).
          color: inkWash(hex, styleRef.current.dark ? 0.26 : 0.36),
          radius: 2,
        });
    }
  }, []);

  const onShowAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent<ShowAnnotationDetail>).detail;
    const cfi = detail?.value;
    if (!cfi) return;
    const owner = detail.range?.startContainer.ownerDocument ?? null;
    const rect = detail.range?.getBoundingClientRect();
    const point = toHostPoint(owner, rect ?? { left: 0, top: 0 });
    clickReport.current?.(cfi, point.x, point.y);
  }, []);

  // A section's overlayer is created with the section, so every highlight
  // inside it has to be drawn again when it mounts.
  const onOverlay = useCallback(() => {
    syncAnnotations();
  }, [syncAnnotations]);

  /**
   * A click inside a section document. Only a picture is interesting, and one
   * big enough to be worth opening full screen: the books in this library
   * paint rules, bullets and tiny inline icons as images too, and those would
   * otherwise open the viewer by accident. The container path the picture came
   * from rides on the element (`data-path`, stamped by our patched foliate) —
   * the `src` is a `blob:` URL by then, which the library's image list cannot
   * be looked up by.
   */
  const onSectionClick = useCallback((event: MouseEvent) => {
    // No `instanceof Element`: the section lives in a blob: iframe with its own
    // realm, and a node from another realm fails the parent window's
    // prototype test — the guard would silently swallow every click.
    const image = (event.target as Element | null)?.closest?.("img, image");
    if (!image) return;
    const box = image.getBoundingClientRect();
    if (box.width < MIN_VIEWABLE_IMAGE || box.height < MIN_VIEWABLE_IMAGE) return;
    const path = image.getAttribute("data-path");
    if (!path) return;
    const doc = image.ownerDocument;
    imageReport.current?.(path, image.getAttribute("src") ?? undefined, sectionOfDoc.get(doc));
  }, []);

  /**
   * `load` listener on the paginator: every section document arrives here, and
   * we hook the three things the parent window cannot see — paging keys,
   * selections made inside the book's iframe, and clicks on its pictures.
   * Idempotent: the sections `open` already rendered are walked through this
   * same door, and a document must not end up hooked twice (a double keydown
   * handler turns one press into two page turns).
   */
  const hookedRef = useRef(new WeakSet<Document>());
  /**
   * The page foliate last reported. Hoisted out of the open effect because the
   * style effect needs it too: a change of writing-mode makes the paginator
   * rebuild, and it has to be told which page to rebuild *on*.
   */
  const locatedRef = useRef("");
  // The way the page last turned, relayed to the reading ruler once the turn's
  // relocation reports it (see `onRelocate` in the mount effect below).
  const rulerDirRef = useRef<1 | -1 | 0>(0);
  /**
   * The writing-mode the mounted sections were laid out in. foliate resolves a
   * section's axis once, when it loads it, and caches it — `setStyles` only
   * swaps the sheet, so a change from horizontal to vertical is something this
   * component has to notice and act on itself.
   */
  const verticalRef = useRef(injectedVertical(style));
  /**
   * 简繁转换: the dictionaries are a lazy chunk, so the converter arrives
   * *after* the sections have mounted. `zhLoadedRef` holds it (with the mode
   * it belongs to), `null` until then; sections mounting earlier are caught up
   * by the flip effect below.
   */
  const zhLoadedRef = useRef<{ mode: string; converter: ZhConverter } | null>(null);
  const attachSection = useCallback(
    (event: Event) => {
      // foliate announces which section a document belongs to; the lightbox's
      // chapter label and jump key are answered from it.
      const detail = (event as CustomEvent<{ doc?: Document; index?: number }>).detail;
      const doc = detail?.doc;
      if (!doc || hookedRef.current.has(doc)) return;
      hookedRef.current.add(doc);
      // 替换引号 + 简繁转换, one pipeline over the published text: the
      // section is never reloaded for either, so both are applied here at
      // load and replayed on a flip by the effects below.
      applySectionText(
        doc,
        sectionTextLayers(styleRef.current.quoteReplace, zhLoadedRef.current?.converter ?? null),
      );
      if (typeof detail.index === "number") sectionOfDoc.set(doc, detail.index);
      // A book can pin its own colour scheme with a meta tag, and that form
      // outranks the `color-scheme: normal` our stylesheet sets: WebKit then
      // paints the iframe's transparent-root canvas opaque and the page goes
      // black over the `#background` layer. Drop the tag and the scheme is
      // ours again. The `:root { color-scheme }` form is covered by the sheet.
      doc.querySelector('meta[name="color-scheme" i]')?.remove();
      markLoneFigures(doc);
      doc.addEventListener("keydown", forwardKeyFromSection, true);
      doc.addEventListener("mouseup", () => captureSelection(doc), true);
      doc.addEventListener("click", onSectionClick, true);
      // A press on the book's own text. It is the only signal this document
      // ever gets from inside a section iframe, and in 对照阅读 it is what
      // decides which pane owns the keyboard — without it a book could be
      // selected and scrolled while the window kept answering for the other.
      doc.addEventListener("pointerdown", () => activateReport.current?.(), true);
      // The reader's pointer, moving over the book. A section is an iframe and
      // a document keeps its own events: the host never sees a move, which is
      // why the page number's stillness clock cannot be restarted from the
      // pane (a prose book needs no such thing — its text is the pane). Same
      // door as the pointer-down above.
      doc.addEventListener("pointermove", (move) => moveReport.current?.(move), true);
    },
    [captureSelection, onSectionClick],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let view: View | null = null;
    // The captured-turn controller, created with the view (it needs its
    // renderer) but disposed from the effect's own cleanup — an in-flight curl
    // still holds a rAF and an overlay canvas over the pane. It also outlives
    // the effect that applies layout, which is what turns it off again when
    // 「仿真」 stops being the transition.
    let captured: CapturedPageTurn | null = null;
    // Half of what decides whether the controller's idle snapshot is still a
    // picture of this page (it adds the typography and the pane's geometry
    // itself), and the destination a rebuild has to be aimed at.
    const onRelocate = (event: Event) => {
      const detail = (event as CustomEvent<FoliateRelocate>).detail;
      locatedRef.current = detail.cfi ?? "";
      report.current?.({
        cfi: detail.cfi ?? "",
        fraction: detail.fraction ?? 0,
        label: detail.tocItem?.label ?? "",
        page: detail.page ?? null,
        bookPage: bookPageFromLocation(detail.location),
      });
      // The reading ruler parks its band at a fraction of the page and then
      // snaps it to whole lines, so every relayout is new geometry: a page
      // turn inside a section is a translated strip, not a DOM change in the
      // reader's document, and nothing over there would notice on its own.
      // The turn's direction rides along once — a page the reader arrived on
      // meets the band at its start — and is spent on the first notice, since
      // every relocation after that is the same page settling.
      const dir = rulerDirRef.current;
      rulerDirRef.current = 0;
      relayRulerLayout(viewRef.current, dir);
    };

    /**
     * The page has been laid out again from scratch — a pane that changed
     * width, a repagination — and the new geometry is final: the ruler
     * measures once more, so its band is sized to the lines that are actually
     * on the page. `dir` is zero on purpose: a re-layout moves the page *under*
     * the band, which is not the same event as arriving on a new page.
     */
    const onStabilized = () => relayRulerLayout(viewRef.current);

    void (async () => {
      try {
        // Kick off the foliate chunk load immediately so it parses in parallel
        // with the (fast) source-URL lookup or the whole-file transfer below.
        const viewModule = import("foliate-js/view.js");
        let book: Awaited<ReturnType<typeof makeBook>>;
        // A browser has no backend to read a book file from; the fixture serves
        // its own container (`?demo=1&epub=1`, `?demo=1&kindle=1` — see
        // `lib/demo.ts`). `null` for every other book, so this drops through to
        // the real path below.
        const demoBytes = !isDesktopRuntime && demoEnabled() ? await demoBookBytes(bookId) : null;
        if (demoBytes) {
          const container = CONTAINER[format] ?? CONTAINER.epub!;
          const { makeBook } = await viewModule;
          book = await makeBook(
            new File([demoBytes], `${bookId}.${container.ext}`, { type: container.type }),
          );
        } else if (format === "epub" && isDesktopRuntime) {
          // EPUB streams over the 方册 protocol with HTTP Range requests,
          // so opening no longer waits on the whole file crossing IPC.
          try {
            const sourceUrl = await ipc.bookSourceUrl(bookId);
            if (cancelled) return;
            const { makeBook } = await viewModule;
            book = await makeBook(sourceUrl);
          } catch (cause) {
            // The scheme is unreachable on this platform, or streaming failed:
            // fall back to the whole-file IPC transfer (same as every other format).
            console.warn("协议流式打开失败，回退整文件传输", cause);
            const bytes = await ipc.bookFile(bookId);
            if (cancelled) return;
            const { makeBook } = await viewModule;
            book = await makeBook(
              new File([bytes], `${bookId}.epub`, { type: "application/epub+zip" }),
            );
          }
        } else {
          const bytes = await ipc.bookFile(bookId);
          if (cancelled) return;
          // foliate only needs a File-like: it reads the container by range.
          const container = CONTAINER[format] ?? CONTAINER.mobi!;
          const file = new File([bytes], `${bookId}.${container.ext}`, {
            type: container.type,
          });
          const { makeBook } = await viewModule;
          book = await makeBook(file);
        }
        if (cancelled) return;
        view = document.createElement("foliate-view") as View;
        // A `const` for the callbacks below: TypeScript cannot narrow a `let`
        // captured by a closure, and every one of them outlives this block.
        const live = view;
        // Custom elements default to `display: inline`, which collapses the
        // paginator's size chain; the host box must be the viewport.
        view.style.cssText = "display:block;width:100%;height:100%";
        // foliate re-exports the renderer's parts onto the renderer element,
        // which sits inside this element's shadow root; forwarding them once
        // more is what lets a document stylesheet reach `::part(filter)` —
        // the hook foliate gives for tinting a fixed-layout page.
        view.setAttribute("exportparts", "head,foot,filter,container");
        view.addEventListener("relocate", onRelocate);
        // Registered before `open` so the very first section's overlayer is
        // covered; `addAnnotation` emits `draw-annotation` synchronously.
        view.addEventListener("draw-annotation", onDrawAnnotation);
        view.addEventListener("show-annotation", onShowAnnotation);
        view.addEventListener("create-overlay", onOverlay);
        // The reader takes the pointer off the page after `IDLE_MS` of
        // stillness, same as the page number does. The pane's own
        // `cursor: none` cannot reach a section — it is an iframe, and a
        // document decides the cursor for its own content — so foliate's
        // hider is armed here and clones itself onto every section it loads.
        view.setAttribute("autohide-cursor", "");
        host.append(view);
        await view.open(book);
        // Before `init`, never after: foliate reads a section's `writing-mode`
        // off its computed style as the section loads and lays the columns out
        // on the axis it finds there, then caches it. A sheet injected once the
        // first section is already up leaves the whole book horizontal.
        view.renderer?.setStyles?.(buildStyleSheet(styleRef.current));
        // Same reason as the sheet: the paginator's own default is a
        // two-column spread, so a book opened in 单页 painted a spread first
        // and re-columnised once the layout effect ran after `init` — the
        // double-then-single flash. Attributes here, before any section is
        // rendered, make the first paint the chosen layout.
        applyLayout(view, layoutRef.current, transitionRef.current, marginsRef.current);
        await view.init(startCfi ? { lastLocation: startCfi } : {});
        if (!startCfi && startFraction && view.book?.splitTOCHref) {
          await view.goToFraction(startFraction);
        }
        viewRef.current = view;
        // The renderer (and its section iframes) exist only after `open()`.
        // Binding the `load` listener before `open` was a silent no-op —
        // `view.renderer` was still null, so nothing ever attached and
        // keyboard paging died whenever focus sat inside the book's iframe
        // (e.g. right after a TOC jump). Bind it now and backfill onto every
        // section doc `open` already loaded, so the first page is covered.
        const renderer = view.renderer;
        if (renderer) {
          renderer.addEventListener("load", attachSection);
          // The page is re-columnised whenever the reading area's width
          // changes, and the paginator says when the new geometry is final.
          // That notice is the ruler's only one for a re-layout nobody else
          // hears: collapsing, hiding or showing the sidebar leaves the article
          // pinned through the spring and lets go of it half a second later, so
          // the pane's own `ResizeObserver` has long since stopped firing while
          // the page is still being laid out again underneath the band — and a
          // band measured against the layout that is going away stays parked on
          // lines that are no longer where it put them.
          renderer.addEventListener("stabilized", onStabilized);
          for (const { doc } of renderer.getContents()) {
            if (!doc) continue;
            // Through the same door as a later section: the paginator does not
            // announce the sections `open` already put on screen, and hooking
            // them by hand here is how the image click went missing once.
            attachSection(new CustomEvent("load", { detail: { doc } }));
          }
        }
        if (cancelled) return;
        // The style effect predates the view, so a book opened straight into
        // the night palette needs the fixed-layout tint applied here too.
        syncPageInvert(view, styleRef.current);

        // 「仿真」on the desktop build: instead of letting the paginator animate
        // a View Transition, snapshot the reading pane natively and curl that
        // bitmap away over the page the live view has already turned to
        // (readest#555 — see `capturedTurn.ts`). Wrapping `next`/`prev` is what
        // puts every turn on this path: the flip handle and the keyboard both
        // arrive here, and so does foliate's own internal navigation.
        //
        // Read through `originals`, never through `view.next` — the two are
        // about to be replaced by the wrappers below.
        const originals: { next: () => Promise<void>; prev: () => Promise<void> } = {
          next: view.next.bind(view),
          prev: view.prev.bind(view),
        };
        const controller = new CapturedPageTurn({
          pane: () => hostRef.current?.closest<HTMLElement>("[data-reading-content]") ?? null,
          capture: (region) => ipc.webviewCaptureRegion(region),
          columns: () => live.renderer?.columnCount ?? 1,
          rtl: () => live.book?.dir === "rtl",
          // The tint the paginator paints its page fill with — the paper every
          // page is cut from, so the sheet's back reads as the same stock.
          // Reading it here rather than off the pane's computed background
          // covers the custom-image surface, which is a gradient and a photo
          // with no colour layer of its own.
          paper: () => styleRef.current.bg,
          // What the pane is showing: foliate's own anchor for the page, plus
          // the style the section was laid out in (`JSON.stringify` because the
          // payload is all primitives and this runs once per turn). An empty
          // anchor — foliate has not reported yet — disables the warm path.
          key: () =>
            locatedRef.current ? `${locatedRef.current}|${JSON.stringify(styleRef.current)}` : "",
          maskChrome: () => {
            const viewport = hostRef.current?.closest<HTMLElement>("[data-reading-viewport]");
            if (!viewport) return null;
            // Only what actually paints: the arrows fade themselves out two
            // seconds after the last pointer event, so a turn from the keyboard
            // (or after the reader has been still) finds them gone, and hiding
            // them would buy nothing at the cost of a painted frame.
            const overlays = [...viewport.querySelectorAll<HTMLElement>("[data-turn-overlay]")];
            if (!overlays.some(paints)) return null;
            viewport.setAttribute("data-turn-mask", "");
            return () => viewport.removeAttribute("data-turn-mask");
          },
          navigate: async (forward) => {
            // The paginator's animated paths (the push slide and the layered VT
            // turns) all gate on the `animated` attribute; dropping it makes the
            // underlying turn an instant jump, which is the point — the overlay
            // hides it.
            const pager = live.renderer;
            if (!pager) return;
            const wasAnimated = pager.hasAttribute("animated");
            pager.removeAttribute("animated");
            try {
              await (forward ? originals.next() : originals.prev());
            } finally {
              if (wasAnimated) pager.setAttribute("animated", "");
            }
          },
        });
        captured = controller;
        capturedRef.current = controller;
        controller.setEnabled(
          transitionRef.current === "paper" && !injectedVertical(styleRef.current),
        );
        // Snapshot the page the book opened on, so the first tap is as quick as
        // the ones after it (`capturedTurn.ts` also re-arms this once a turn
        // has settled). Desktop only: a browser has no capture command, and
        // asking for one there would retire the whole effect on a warning.
        if (isDesktopRuntime) controller.warm();
        const capturedTurn = async (forward: boolean, distance?: number) => {
          if (cancelled) return;
          const pager = live.renderer;
          // An explicit `distance` is a partial step, not a page edge, and a
          // book boundary has no page left to turn: both stay on the renderer's
          // own animation.
          const boundary = forward ? pager?.atEnd : pager?.atStart;
          if (
            distance === undefined &&
            !boundary &&
            transitionRef.current === "paper" &&
            layoutRef.current !== "scroll" &&
            isDesktopRuntime &&
            (await controller.turn(forward)) === "turned"
          ) {
            return;
          }
          // Reached when the capture was refused or failed — never because
          // another turn is still playing: the controller supersedes that one
          // instead of dropping this one (`capturedTurn.ts`).
          await (forward ? originals.next() : originals.prev());
        };
        live.next = (distance?: number) => capturedTurn(true, distance);
        live.prev = (distance?: number) => capturedTurn(false, distance);

        tocRef.current = flattenToc(view.book.toc);
        tocReport.current?.(tocRef.current);
        syncAnnotations();
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      captured?.dispose();
      captured = null;
      capturedRef.current = null;
      viewRef.current = null;
      paintedRef.current = new Map();
      searchedRef.current = new Set();
      ttsRef.current = null;
      if (view) {
        view.renderer?.removeEventListener("load", attachSection);
        view.renderer?.removeEventListener("stabilized", onStabilized);
        view.removeEventListener("relocate", onRelocate);
        view.removeEventListener("draw-annotation", onDrawAnnotation);
        view.removeEventListener("show-annotation", onShowAnnotation);
        view.removeEventListener("create-overlay", onOverlay);
        view.close();
        view.remove();
      }
    };
  }, [
    bookId,
    format,
    startCfi,
    startFraction,
    attachSection,
    onDrawAnnotation,
    onShowAnnotation,
    onOverlay,
    syncAnnotations,
  ]);

  // Layout, turn animation and margins apply to the live element: the
  // paginator's attributeChangedCallback re-renders and keeps the anchor.
  useEffect(() => {
    layoutRef.current = layout;
    transitionRef.current = transition;
    marginsRef.current = { x: marginX, y: marginY };
    capturedRef.current?.setEnabled(transition === "paper" && !injectedVertical(styleRef.current));
    const view = viewRef.current;
    if (view) applyLayout(view, layout, transition, { x: marginX, y: marginY });
  }, [layout, transition, marginX, marginY]);

  // Typography and palette: injected into the section documents, which the
  // paginator keeps across section changes.
  useEffect(() => {
    styleRef.current = style;
    // 「仿真」 peels a horizontal sheet, and foliate has a two-phase turn of its
    // own for the vertical axis, so the captured curl stands down when the
    // columns run top-to-bottom. `setEnabled(false)` makes `turn()` decline and
    // the caller falls through to the renderer's own animation.
    capturedRef.current?.setEnabled(transitionRef.current === "paper" && !injectedVertical(style));
    const view = viewRef.current;
    if (!view) return;
    view.renderer?.setStyles?.(buildStyleSheet(style));
    syncPageInvert(view, style);
    // The sheet alone cannot turn the page sideways: foliate resolves a
    // section's axis once, at load, and caches it. Handing it the page it is
    // already on is what makes it re-read the axis — `goTo` sees the
    // difference, throws every view away and rebuilds them on the new one.
    if (verticalRef.current !== injectedVertical(style)) {
      verticalRef.current = injectedVertical(style);
      if (locatedRef.current) void view.goTo(locatedRef.current);
    }
  }, [style]);

  /**
   * The two settings that live in the section text rather than in the sheet —
   * 替换引号 and 简繁转换 — replayed over the sections already on screen.
   *
   * Neither can go through `goTo`: the paginator reuses an already-mounted
   * view for the section it is on and never re-fires `load`, so the old
   * "flip → re-open the view" route did nothing inside the current section
   * (turning 替换引号 off left the corner brackets on the page). Both now
   * replay the whole pipeline from each node's published string, which
   * `sectionText.ts` captured on first sight — so turning one off leaves the
   * other's work standing, and the reading position never moves.
   */
  useEffect(() => {
    const mode = style.zhConvert;
    const replay = (converter: ZhConverter | null) => {
      const layers = sectionTextLayers(style.quoteReplace, converter);
      for (const { doc } of viewRef.current?.renderer?.getContents() ?? []) {
        if (doc) applySectionText(doc, layers);
      }
    };
    if (mode === "off") {
      zhLoadedRef.current = null;
      replay(null);
      return;
    }
    const loaded = zhLoadedRef.current;
    // Already loaded: the flip lands in this frame, not in a microtask.
    if (loaded?.mode === mode) {
      replay(loaded.converter);
      return;
    }
    let cancelled = false;
    void loadZhConverter(mode).then((converter) => {
      if (cancelled) return;
      zhLoadedRef.current = { mode, converter };
      replay(converter);
    });
    return () => {
      cancelled = true;
    };
  }, [style.quoteReplace, style.zhConvert]);

  // Highlights: repaint whenever the list changes. foliate draws each one
  // through `draw-annotation`, so a brand-new highlight appears immediately.
  useEffect(() => {
    annotationsRef.current = annotations ?? [];
    syncAnnotations();
  }, [annotations, syncAnnotations]);

  /**
   * Paints the read-aloud wash over one run (a sentence, or a word inside it).
   * The section's overlayer is created with the section, so the previous run is
   * un-painted first — `Overlayer.add` replaces by key, so a word-level update
   * costs one SVG group, not one per word. A section change destroys its
   * overlayer outright, leaving a stale ref the next paint simply drops.
   */
  const paintTts = useCallback((range: Range) => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return;
    const entry = renderer
      .getContents()
      .find((content) => content.doc === range.startContainer.ownerDocument);
    if (!entry?.overlayer) return;
    if (ttsRef.current && ttsRef.current !== entry.overlayer) ttsRef.current.remove(TTS_KEY);
    ttsRef.current = entry.overlayer;
    ttsRangeRef.current = range;
    const paint = ttsPaintRef.current;
    const draw = {
      highlight: Overlayer.highlight,
      underline: Overlayer.underline,
      strikethrough: Overlayer.strikethrough,
      squiggly: Overlayer.squiggly,
      outline: Overlayer.outline,
    }[paint.draw];
    entry.overlayer.add(TTS_KEY, range, draw, {
      color: paint.color,
      // Match the prose path's `<mark>` corners, so the wash reads the same
      // whether the page is ours or the book's own. The line painters take the
      // width readest's own annotations are drawn at.
      ...(paint.draw === "highlight"
        ? { radius: 2 }
        : paint.draw === "squiggly"
          ? { width: 1.5 }
          : { width: 2 }),
    });
  }, []);

  /** Drops the read-aloud wash (voice stopped, or the book closed). */
  const clearTts = useCallback(() => {
    ttsRef.current?.remove(TTS_KEY);
    ttsRef.current = null;
    ttsRangeRef.current = null;
  }, []);

  // A style or ink change redraws the run the voice is on, rather than waiting
  // for the next sentence — the reader is looking at that run while they change
  // it. The wash is otherwise only repainted when the position moves.
  useEffect(() => {
    ttsPaintRef.current = foliateWash(ttsWash.style, ttsWash.color, style.dark);
    const range = ttsRangeRef.current;
    if (range) paintTts(range);
  }, [ttsWash, style.dark, paintTts]);

  /**
   * The text blocks of the section on screen, waiting out a section switch:
   * the paginator renders the next section a frame or two after
   * `nextSection()` resolves, so a chapter roll-over would otherwise fall
   * silent instead of reading on.
   */
  const collectBlocks = useCallback(async (): Promise<TextBlock[]> => {
    const renderer = viewRef.current?.renderer;
    if (!renderer) return [];
    const collect = () => {
      const contents = renderer.getContents();
      const primary =
        contents.find((entry) => entry.index === renderer.primaryIndex) ?? contents[0];
      return primary?.doc ? readBlocks(primary.doc) : [];
    };
    const poll = (attempt: number): Promise<TextBlock[]> => {
      const blocks = collect();
      if (blocks.length > 0) return Promise.resolve(blocks);
      if (attempt >= 15 || (renderer.atEnd && attempt > 0)) return Promise.resolve([]);
      return new Promise((resolve) => window.setTimeout(resolve, 100)).then(() =>
        poll(attempt + 1),
      );
    };
    return poll(0);
  }, []);

  /**
   * Where the reader's selection starts, in the section's own block
   * coordinates: which block, and how far into its raw text.
   *
   * Read from the anchor parked at selection time rather than from the live
   * selection: the pill clears the browser's selection as soon as the reader
   * taps, and collecting the section's blocks is asynchronous — by the time
   * this runs there is nothing left to ask. Blocks are matched by text-node
   * identity, which stays exact even when a whitespace-only block was dropped
   * from the list.
   */
  const selectionSpot = useCallback(
    (blocks: readonly TextBlock[]): { block: number; offset: number } | null => {
      const anchor = spotAnchor.current;
      if (!anchor) return null;
      const node = anchor.node;
      const inner = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      const leaf = inner?.closest(BLOCK_SELECTOR) ?? null;
      const doc = leaf?.ownerDocument;
      if (!leaf || !doc) return null;
      const block = blocks.findIndex(
        (entry) => entry.nodes[0]?.node.parentElement?.closest(BLOCK_SELECTOR) === leaf,
      );
      const first = blocks[block]?.nodes[0];
      if (!first) return null;
      const probe = doc.createRange();
      try {
        probe.setStart(first.node, 0);
        probe.setEnd(node, anchor.offset);
      } catch {
        // A backwards pair means the selection started above this block.
        return null;
      }
      return { block, offset: probe.toString().length };
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      flip: (dir) => {
        rulerDirRef.current = dir;
        const view = viewRef.current;
        if (!view) return;
        void (dir === 1 ? view.next() : view.prev());
      },
      section: (dir) => {
        rulerDirRef.current = dir;
        const renderer = viewRef.current?.renderer;
        if (!renderer) return;
        void (dir === 1 ? renderer.nextSection() : renderer.prevSection());
      },
      atEdge: (dir) => {
        const renderer = viewRef.current?.renderer;
        // The fixed-layout renderer has no column edges to report — one page
        // is one section there, and `next()` already crosses.
        if (!renderer?.isAtSectionEdge) return false;
        return renderer.isAtSectionEdge(dir);
      },
      goToEntry: (index) => {
        const view = viewRef.current;
        const href = tocRef.current[index]?.href;
        if (!view || !href) return;
        void view.goTo(href);
      },
      selectionBox: () => {
        // Every mounted section is searched, not just the one on screen: a
        // selection can outlive the page turn that carried its section away,
        // and its own section is still the only place that knows where it is.
        for (const entry of viewRef.current?.renderer?.getContents() ?? []) {
          const measured = measureSelection(entry.doc);
          if (measured) return measured.box;
        }
        return null;
      },
      rulerLines: () => {
        const rects: RulerRect[] = [];
        for (const entry of viewRef.current?.renderer?.getContents() ?? []) {
          const frame = entry.doc.defaultView?.frameElement as HTMLElement | null;
          if (!frame) continue;
          const box = frame.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) continue;
          // The arrows the reader presses with the caret in here have to reach
          // the reader's own window, or the page goes quiet the moment foliate
          // focuses a section — which is after every page it lays out.
          relaySectionKeys(entry.doc);
          // Cut to the page the paginator paints: the strip is a chapter wide,
          // and the page next door starts inside the pane's own margin — so its
          // first line has a box there, and nothing on the screen.
          const clip = pageBox(frame, box);
          rects.push(...lineRects(entry.doc, null, box.left, box.top, clip));
        }
        return rects;
      },
      scrollByPx: (delta, subpixel) => {
        const renderer = viewRef.current?.renderer;
        if (!renderer?.scrolled) return 0;
        renderer.subpixelOffset = subpixel;
        // The browser clamps the scrollport to the content extent, so an
        // overshooting delta parks at the end where `bookEnd` stops the loop.
        const before = renderer.containerPosition;
        renderer.containerPosition = before + delta;
        return renderer.containerPosition - before;
      },
      bookEnd: () => viewRef.current?.renderer?.atEnd ?? false,
      goToCfi: (cfi) => {
        const view = viewRef.current;
        if (!view || cfi === "") return;
        void view.goTo(cfi);
      },
      goToFraction: (fraction) => {
        const view = viewRef.current;
        // foliate resolves a fraction through its section-progress table,
        // which it only builds for books whose TOC it can map onto the
        // spine; on the rest the call would reject and move nothing.
        if (!view?.book?.splitTOCHref) return;
        void view.goToFraction(fraction);
      },
      goToHighlight: (highlight) => {
        const view = viewRef.current;
        if (!view) return;
        if (highlight.cfi) {
          void view.goTo(highlight.cfi);
          return;
        }
        // Unanchored: foliate cannot resolve a position it has never been
        // given, so the chapter is as far as it can be told to go. The text
        // search that follows is what turns the rest of the way into an
        // ordinary anchored highlight, and it is the only thing stored.
        if (highlight.text === "" || !view.book?.splitTOCHref) return;
        void (async () => {
          await view.goToFraction(highlight.fraction);
          const found = await mintAnchor(highlight.text);
          if (!found) return;
          const cfi = view.getCFI(found.index, found.range);
          if (!cfi) return;
          anchorReport.current?.(highlight.id, cfi);
          void view.goTo(cfi);
        })();
      },
      search: async (query) => {
        const view = viewRef.current;
        if (!view || query.trim() === "") return [];
        const hits: FoliateSearchHit[] = [];
        for await (const result of view.search({ query })) {
          if (result === "done") break;
          const item = result as {
            cfi?: string;
            label?: string;
            excerpt?: { pre: string; match: string; post: string };
            subitems?: { cfi: string; excerpt?: { pre: string; match: string; post: string } }[];
          };
          if (item.subitems) {
            for (const sub of item.subitems) {
              if (!sub.cfi) continue;
              hits.push({
                cfi: sub.cfi,
                label: item.label ?? "",
                pre: sub.excerpt?.pre ?? "",
                match: sub.excerpt?.match ?? "",
                post: sub.excerpt?.post ?? "",
              });
            }
          } else if (item.cfi) {
            hits.push({
              cfi: item.cfi,
              label: item.label ?? "",
              pre: item.excerpt?.pre ?? "",
              match: item.excerpt?.match ?? "",
              post: item.excerpt?.post ?? "",
            });
          }
        }
        return hits;
      },
      clearSearch: () => {
        viewRef.current?.clearSearch();
      },
      readFrom: async () => {
        const blocks = await collectBlocks();
        if (blocks.length === 0) return [];
        blocksRef.current = blocks;
        // Where the reader is looking, not the top of the section: tapping
        // read-aloud mid-page must not restart the chapter.
        return unitsFrom(blocks, firstVisibleBlock(blocks, hostRef.current), 0);
      },
      readFromSelection: async () => {
        const blocks = await collectBlocks();
        if (blocks.length === 0) return [];
        blocksRef.current = blocks;
        const spot = selectionSpot(blocks);
        return unitsFrom(blocks, spot?.block ?? 0, spot?.offset ?? 0);
      },
      focusUnit: (unit, span) => {
        const renderer = viewRef.current?.renderer;
        const block = blocksRef.current[unit.source];
        if (!renderer || !block) return;
        const whole = span === "block";
        const range = rangeIn(
          block,
          whole ? 0 : (span?.start ?? unit.start),
          whole ? block.text.length : (span?.end ?? unit.end),
        );
        if (!range) return;
        void renderer.scrollToAnchor(range);
        if (span !== null) paintTts(range);
      },
      paintSpan: (unit, span) => {
        const block = blocksRef.current[unit.source];
        if (!block) return;
        const range = rangeIn(block, span.start, span.end);
        if (range) paintTts(range);
      },
      clearTts,
    }),
    [paintTts, clearTts, collectBlocks, selectionSpot, mintAnchor],
  );

  if (error) {
    return <p className="text-text-3 p-6 text-sm">这本书的 Kindle 容器打不开：{error}</p>;
  }
  return <div ref={hostRef} className="h-full w-full" data-view-transition-root />;
});

export default FoliateBookView;
