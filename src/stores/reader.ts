import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { PaceSample } from "@/features/reader/pace";
import { pushPace } from "@/features/reader/pace";
import { DEFAULT_WPM } from "@/features/reader/rsvp";
import type {
  LayoutMode,
  PageTransition,
  ReadingSurface,
  WritingMode,
} from "@/features/reader/theme";
import type { SpeechGranularity, SpeechPlayerStyle } from "@/features/reader/speech";
import type { TtsWashStyle } from "@/features/reader/ttsWash";
import type { ZhConvertMode } from "@/features/reader/zhConvert";
import type { AnnotationStyle } from "@/types/ipc";

/**
 * The settings a book may keep for itself: its page's typography and paper.
 *
 * 对照阅读 puts two books side by side, and a reader who enlarges one of them
 * is talking about that book, not about the app. Everything *not* in this list
 * — voices, speeds, the ruler's appearance, reading positions — stays one
 * value for the whole app, because those are properties of the reader rather
 * than of a page.
 */
export const BOOK_SETTINGS = [
  "fontFamily",
  "fontSize",
  "lineHeightIdx",
  "paraGapIdx",
  "indent",
  "marginX",
  "marginY",
  "bodyBold",
  "layoutMode",
  "zhConvert",
  "readingRuler",
  "pageTheme",
  "surface",
  "nightSurface",
  "customSurface",
] as const;

export type BookSetting = (typeof BOOK_SETTINGS)[number];
export type BookSettings = Partial<Pick<ReaderState, BookSetting>>;

const BOOK_SET: ReadonlySet<string> = new Set(BOOK_SETTINGS);

/** Reading typography and viewing preferences, persisted across sessions. */
interface ReaderState {
  /** Body font size in px. */
  fontSize: number;
  setFontSize: (size: number) => void;
  /** Speech rate for read-aloud, a Web Speech `utterance.rate` value. Set from
   *  the player's speed view through `update`. */
  speechRate: number;
  /** Chosen read-aloud voice, a `SpeechSynthesisVoice.voiceURI`; `null` keeps
   *  the default pick (Yunjian), resolved at speak time. */
  speechVoiceURI: string | null;
  /** How much of the page the voice washes: sentence, word or paragraph. */
  speechGranularity: SpeechGranularity;
  /** The wash's shape: the marker band, a rule under the line, or an outline
   *  around the letters (see `ttsWash.ts` for what each one paints). */
  speechWashStyle: TtsWashStyle;
  /** The wash's ink, `#rrggbb`; `null` keeps the app's own accent tint, which
   *  is what the voice has always been washed in. */
  speechWashColor: string | null;
  /** Inks the reader pinned from the picker, shown after `HIGHLIGHT_COLORS`. */
  speechWashColors: string[];
  /** How much of the player is on screen while a session runs: the whole card,
   *  or the transport and the scrubber alone. */
  speechPlayerStyle: SpeechPlayerStyle;
  /** Whether the floating bar comes out when the main window is put away while
   *  a session is on. It is the only thing that can control the voice from
   *  outside the app, apart from the menu-bar icon. */
  speechMiniPlayer: boolean;
  /** Body typeface, a key into `FONT_STACKS`. */
  fontFamily: string;
  /** Index into `LINE_HEIGHTS`. */
  lineHeightIdx: number;
  /** Index into `PARA_GAPS`. */
  paraGapIdx: number;
  /** Side page margin in px, shared by paged gutters and scroll padding. */
  marginX: number;
  /** Top/bottom page margin in px. */
  marginY: number;
  /** Two-em text-indent at the start of every paragraph. */
  indent: boolean;
  /**
   * 正文加粗: set the body text in the bold weight.
   *
   * An accessibility override rather than a typographic preference — the
   * reader who needs it needs it in every book — so it stands **outside** the
   * 使用书籍排版 deal and applies whichever way that gate is set. That is not
   * a detail: 跟随书籍 is the default, so gating it on the same switch would
   * leave it doing nothing out of the box, which is the one shape this panel
   * refuses to ship.
   *
   * Deliberately two states and not a weight scale. Measured (2026-10-16, on
   * both engines): a family with a single face renders at most **two**
   * distinct weights — everything below 600 and a synthesised bold from 600
   * up — so nine steps would be seven dead positions on six of the seven
   * paths a reader can be on, and the same control would be a real mid-weight
   * on 苹方 alone. Two states are what every path can honour: a path with a
   * real bold face picks it, a single-face path synthesises one.
   */
  bodyBold: boolean;
  /**
   * The writing direction the reader asks for. `auto` — the default — keeps
   * the book's own: a 古籍 or 日漫 that typesets itself vertical-rl reads
   * exactly as its author set it, with nothing injected. `horizontal` and
   * `vertical` force the direction onto every text element the way the old
   * boolean did.
   */
  writingMode: WritingMode;
  /**
   * 使用书籍排版: leave the book's own paragraph styles — line height, paragraph
   * gap, first-line indent, and the typeface, unless 原书字体 is unset — alone
   * instead of winning them with `!important`. On by default: the reader is
   * the guest here, and a book that was designed is designed.
   */
  bookTypography: boolean;
  /**
   * 替换引号: rewrite the book's western curly quotes (“ ” ‘ ’) into the
   * corner brackets vertical CJK is set with (﹁ ﹂ ﹃ ﹄). A vertical column
   * rotates a western quote with the line, which reads as punctuation lying on
   * its side; the corner brackets stand upright. Offered in the panel only
   * while the layout is vertical, and applied at section load — the view is
   * re-opened when the flag flips.
   */
  quoteReplace: boolean;
  /**
   * 简繁转换: rewrite the displayed text between Simplified and Traditional
   * Chinese (with the regional phrase variants readest offers). Display only —
   * the corpus, the search index and the book source stay as published. The
   * dictionaries load in a lazy chunk per direction; a flip re-opens the
   * foliate view (the conversion lives in the section text) and re-derives the
   * prose paragraphs.
   */
  zhConvert: ZhConvertMode;
  /**
   * Whether the reader header shows the 简繁转换 button. The conversion itself
   * is configured in the settings panel either way; this only hides the
   * shortcut for readers who never use it.
   */
  zhToolbarButton: boolean;
  /**
   * Reading ruler: a band parked at the reader's place on the page, with
   * everything outside it washed toward the paper. Worth most on a dense CJK
   * page, where the lines are long and the paragraphs are one block.
   */
  readingRuler: boolean;
  /** How many whole lines the band spans. */
  rulerLines: number;
  /** The band's colour: a `RULER_COLORS` key, `clear` for no fill, or a custom
   *  `#rrggbb`. */
  rulerColor: string;
  /** How far the page outside the band fades toward the paper. */
  rulerOpacity: number;
  /** Where the band sits along the reading axis, as a percentage — moved by
   *  dragging the band's own edges. */
  rulerPosition: number;
  /**
   * Where the band stops walking and the page starts stepping under it, as a
   * fraction of the reading axis (滚动排版 only). */
  rulerScrollTrigger: number;
  /** Speed-reading rate, in words per minute (RSVP). */
  rsvpWpm: number;
  /** Reading surface for the light appearance, a `READING_SURFACES` key or `"custom"`. */
  surface: string;
  /** Reading surface for the dark appearance, same key space. */
  nightSurface: string;
  /** Custom background image as a data URL, shown under a day scrim. */
  customSurface: string | null;
  /** Chapter switch animation, a key into `PAGE_TRANSITIONS`. */
  pageTransition: PageTransition;
  /** Vertical scroll, single page or two-page spread. */
  layoutMode: LayoutMode;
  /**
   * 手柄翻页: a gamepad or a Bluetooth page-turner turns the page — shoulder
   * buttons and the D-pad, and a stick pushed left or right. On by default: a
   * pad plugged into a reading app is there to page, and nothing else in here
   * could mean it. Off is for the reader whose pad is shared with something
   * else — a game that also uses the shoulders — and who would rather it did
   * nothing here at all.
   */
  gamepadPaging: boolean;
  /** Auto-scroll speed in px per second. */
  autoScrollSpeed: number;
  /** Sustained reading speed in chars per minute, measured while scrolling. */
  readingSpeed: number;
  /**
   * Finished reading stretches, oldest first, capped at `PACE_WINDOW`.
   *
   * The remaining-time estimate is the median of these when there are enough
   * of them, and `readingSpeed` — a running average — otherwise. Two
   * estimators because they answer the question under different conditions:
   * the average has a value from the first minute, the median only becomes
   * truthful after a handful of stretches, and it is the one that survives a
   * reader leaving the app open on a page.
   */
  paceSamples: PaceSample[];
  /** Records one finished stretch. */
  recordPace: (sample: PaceSample) => void;
  /** How much of the "N / M 页" page indicator to show in paged layouts. */
  pageNumbers: PageNumberScope;
  /** Which corner of the bottom gutter that indicator sits in. */
  pageNumberPosition: PageNumberPosition;
  /** Whether the indicator waits for the pointer: off the page until the
   *  reader hovers the page, so a page number never sits on the paper
   *  uninvited. */
  pageIndicatorAutoHide: boolean;
  /**
   * Where the page's palette comes from — the app theme, or a fixed choice.
   * `null` is 跟随主题 and the shipped default: the page wears whatever the
   * app theme wears, so a reader whose system goes dark at dusk gets a dark
   * book without opening anything.
   *
   * Following is not free on a foliate book — foliate's `setStyles` re-injects
   * the stylesheet into every loaded section and `expand()`s each one, so a
   * theme switch re-paginates the whole book. The page used to be pinned to
   * the theme of the first launch to dodge that, which broke the promise
   * instead of keeping it cheap: the pin never re-ran, so a reader who
   * switched themes later got a shell that changed colour around a book that
   * did not, with nothing in the UI saying why. Pinning is now only ever
   * something the reader does themselves, in 书页配色, and the row says what
   * it costs.
   */
  pageTheme: PageTheme | null;
  /** PDF only: pages fill the window edge to edge, ignoring the prose margins. */
  pdfFill: boolean;
  /**
   * PDF only: which axis the page renders on — 原色, the colours the file was
   * published with, or the night palette (text and vectors re-mapped, and
   * optionally the pictures with them).
   *
   * Three states rather than a boolean, and the default is `follow`: a PDF is
   * a *document*, and a document is not supposed to be re-inked because the
   * reader's shell is dark. The old boolean could not say that — it had one
   * answer for both questions, so shipping it as `true` meant every PDF was
   * night-rendered even in daylight, and shipping it as `false` meant a reader
   * who wanted a dark PDF on a light page had no way back. `follow` reads the
   * same answer the page itself wears (`pageIsNight`), so 日间 gives the file
   * its own colours and 夜间 darkens it, and either can be pinned.
   */
  pdfNight: PdfNight;
  /** PDF only: gutter between the two pages of a spread, in px (0 = seamless). */
  pdfGap: number;
  /** PDF only: invert images along with the text. Off keeps photographs in
   *  their real colours; on rescues scanned books, whose pages are one bright
   *  bitmap each and would otherwise glare on a dark surface. */
  pdfInvertImages: boolean;
  /** Books (EPUB / Kindle / comics) on a night page: invert their pictures
   *  too. Off by default — the injected palette already darkens the paper,
   *  and an inverted photograph is a defect rather than a feature. On is for
   *  readers who want the whole page dim, e.g. a comic whose pages are one
   *  bright bitmap each. */
  invertBookImages: boolean;
  /** Last ink colour the reader picked in the selection toolbar (hex). */
  highlightColor: string;
  /** Last paint style the reader picked in the selection toolbar. */
  highlightStyle: AnnotationStyle;
  /** Applies a partial settings patch in one call. */
  update: (
    patch: Partial<
      Omit<
        ReaderState,
        "update" | "setFontSize" | "setReadingSpeed" | "setOriginalLayout" | "recordPace"
      >
    >,
  ) => void;
  setReadingSpeed: (charsPerMinute: number) => void;
  /** The values each book keeps for itself, keyed by book id. */
  byBook: Record<string, BookSettings>;
  /** Merges a patch into one book's own values. */
  setBook: (bookId: string, patch: BookSettings) => void;
  /**
   * The paper the reader on screen is painting, published so the window's
   * chrome can wear it. Paper is per book now, and the shell has no book of
   * its own: it wears whichever one is being read.
   */
  activeSurface: ReadingSurface | null;
  setActiveSurface: (surface: ReadingSurface | null) => void;
}

/** Inclusive bounds for the font size stepper. */
export const MIN_FONT_SIZE = 15;
export const MAX_FONT_SIZE = 26;

/**
 * What the page indicator counts.
 *
 * `chapter` is the unit the layout actually measured — a chapter on the prose
 * pager, a foliate section in a Kindle book. `book` is the whole book: for a
 * foliate book, the counter foliate itself numbers reading positions with (a
 * property of the book's bytes, so it never moves); for the prose pager, what
 * the layout has measured plus the rest of the book weighed at that density
 * (`bookPagesOf`) — an estimate, and the only one that says 约 in front of it.
 */
export type PageNumberScope = "off" | "chapter" | "book";

/** Where the indicator sits in the bottom gutter. The page box is centred and
 *  the indicator is a line of small type under it, so all three positions are
 *  in the same gutter — only the corner changes. */
export type PageNumberPosition = "left" | "center" | "right";

/** Chip labels for the 页码 row, in display order. */
export const PAGE_NUMBER_SCOPES: { key: PageNumberScope; label: string }[] = [
  { key: "off", label: "隐藏" },
  { key: "chapter", label: "当前章" },
  // The label does not say 约; the indicator itself does, every time, which is
  // where a reader who forgot what they picked will see it.
  { key: "book", label: "全书" },
];

/** Chip labels for the indicator's position row. */
export const PAGE_NUMBER_POSITIONS: { key: PageNumberPosition; label: string }[] = [
  { key: "left", label: "左下" },
  { key: "center", label: "居中" },
  { key: "right", label: "右下" },
];

/**
 * Where the page's own palette comes from.
 *
 * `follow` ties the page to the app theme, and it is the default: a reader
 * whose system goes dark gets a dark book. On a foliate book that is also the
 * expensive choice — foliate's `setStyles` re-injects the whole stylesheet
 * into every loaded section and then calls `expand()` on each one, so
 * switching the app theme re-paginates the book. Pinning the page to `day` or
 * `night` means an app-theme switch touches only the chrome, and the book
 * never re-paginates; that is a trade the reader makes in 书页配色, not one
 * the app makes for them on first launch.
 */
export type PageTheme = "follow" | "day" | "night";

/** Chip labels for the 书页配色 row, in display order. */
export const PAGE_THEMES: { key: PageTheme; label: string }[] = [
  { key: "follow", label: "跟随主题" },
  { key: "day", label: "日间" },
  { key: "night", label: "夜间" },
];

/**
 * PDF only: the axis a page is rendered on. Same three states as the page's
 * own palette, for the same reason — `follow` is what lets the shell decide,
 * and a pinned state is what keeps a document looking like itself.
 */
export type PdfNight = "follow" | "day" | "night";

/** Chip labels for the PDF 页面 row, in display order. */
export const PDF_NIGHTS: { key: PdfNight; label: string }[] = [
  { key: "follow", label: "跟随主题" },
  { key: "day", label: "原色" },
  { key: "night", label: "夜间反色" },
];

/** The same three keys as a lookup, for the migration: what it accepts is
 *  `PDF_NIGHTS` itself, so a fourth state added there cannot be silently
 *  refused here. */
const PDF_NIGHT_KEYS: Record<PdfNight, true> = { follow: true, day: true, night: true };

/**
 * Whether the page wears its night palette, given the app theme and the
 * reader's own choice.
 *
 * `follow` is the only branch that reads the app theme, so it is the only one
 * that can change under a foliate book when the reader switches the app theme
 * — which costs a re-pagination of every loaded section, and is the price of
 * the page honestly tracking the shell. `null` is the shipped default and
 * reads as `follow`.
 */
export function pageIsNight(pageTheme: PageTheme | null, appIsDark: boolean): boolean {
  return pageTheme === "night" || (pageTheme !== "day" && appIsDark);
}

/** Line height presets, index-selectable in reading settings. */
export const LINE_HEIGHTS = [1.6, 1.8, 2.0, 2.2] as const;

/** Paragraph gap presets in em. */
export const PARA_GAPS = [0.6, 0.9, 1.2, 1.6] as const;

/** Horizontal page margin presets in px; the slider fine-tunes around them.
 * 标准 (86) is the old 特宽 look, promoted per the wider-page-margins brief.
 * 2026-10-24: 两端各让开一格（32 → 224），foliate 的页宽上限按边距反向收窄，
 * 所以这里的 px 现在是「真的会变窄的 px」，宽的那一端才值得给足。 */
export const MARGIN_X_PRESETS = [32, 86, 160, 224] as const;

/** Bounds for the continuous side/top/bottom margin sliders, and defaults. */
export const MIN_MARGIN_X = 1;
export const MAX_MARGIN_X = 224;
export const MIN_MARGIN_Y = 1;
export const MAX_MARGIN_Y = 160;
export const DEFAULT_MARGIN_X = 86;
export const DEFAULT_MARGIN_Y = 54;

/**
 * Auto-scroll speed bounds in px per second, and the initial speed.
 *
 * The scale was halved: at 300 CPM a reader covers roughly 40 px of a normal
 * page per second, so the old 适中 (80) was already twice reading pace and
 * 极快 (320) was a firehose. The presets below are the new scale; a stored
 * speed from before is halved by the migration rather than left behind.
 */
export const MIN_AUTO_SCROLL_SPEED = 20;
export const MAX_AUTO_SCROLL_SPEED = 240;
export const DEFAULT_AUTO_SCROLL_SPEED = 40;

/** Ink palette of the selection toolbar, in display order. The first entry is
 *  the legacy marker yellow, so old highlights and new ones read alike. */
export const HIGHLIGHT_COLORS = [
  { hex: "#ffd12e", label: "黄色" },
  { hex: "#f76f6f", label: "红色" },
  { hex: "#7cd92c", label: "绿色" },
  { hex: "#56aee2", label: "蓝色" },
  { hex: "#b08fe8", label: "紫色" },
] as const;

/**
 * The reading ruler's colours, in display order. `clear` is the default and the
 * odd one out: the band takes no fill at all and is drawn as a pair of
 * hairlines, which is the reading the reference ships — on a page whose paper
 * is already the reader's choice, an unfilled band dims the page without
 * tinting the words under it.
 */
export type RulerColor = "clear" | "yellow" | "green" | "blue" | "red";

export const RULER_COLORS: { key: RulerColor; hex: string | null; label: string }[] = [
  { key: "clear", hex: null, label: "仅描边" },
  { key: "yellow", hex: "#ffd12e", label: "黄色" },
  { key: "green", hex: "#7cd92c", label: "绿色" },
  { key: "blue", hex: "#56aee2", label: "蓝色" },
  { key: "red", hex: "#f76f6f", label: "红色" },
];

/**
 * The band's fill for a stored colour: a preset key resolves to its hex, a
 * custom value is its own hex, and `clear` — or anything unrecognisable, which
 * an older build could have written — fills nothing.
 */
export function rulerHex(color: string): string | null {
  if (color === "clear") return null;
  const preset = RULER_COLORS.find((entry) => entry.key === color);
  if (preset) return preset.hex;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

/** Whether a stored colour is one of the presets, which is what the picker
 *  needs to know to light the custom swatch instead. */
export function isPresetRulerColor(color: string): boolean {
  return color === "clear" || RULER_COLORS.some((entry) => entry.key === color);
}

/** Bounds for the reading ruler's steppers, and the parked band's default
 *  place — a third of the way down, which is where the reference parks it. The
 *  opacity ceiling is the reference's too: at 1.0 the page outside the band is
 *  unreadable, and the reader has lost the text they were about to read next. */
export const MIN_RULER_LINES = 1;
export const MAX_RULER_LINES = 6;
export const MIN_RULER_OPACITY = 0.1;
export const MAX_RULER_OPACITY = 0.9;
export const DEFAULT_RULER_POSITION = 33;
/** Where the scrolled layout's auto-scroll takes over: low enough that the band
 *  keeps a screenful of the text it is walking toward below it, high enough that
 *  it still gets to cross most of the window before the page starts following. */
export const MIN_RULER_SCROLL_TRIGGER = 0.3;
export const MAX_RULER_SCROLL_TRIGGER = 0.9;
export const DEFAULT_RULER_SCROLL_TRIGGER = 2 / 3;

/**
 * Folds one animation frame of auto-scroll into a whole-pixel delta plus the
 * fractional remainder carried to the next frame. Browsers snap scroll offsets
 * to device pixels, so adding a sub-pixel step each frame (a slow speed on a
 * 120 Hz display moves ~0.3 px per frame) rounds back to zero and the page
 * never moves; accumulating the fraction across frames keeps every speed moving.
 */
export function foldScrollDelta(
  speedPxPerSec: number,
  dt: number,
  carry: number,
): { delta: number; carry: number } {
  const total = carry + speedPxPerSec * dt;
  const delta = Math.trunc(total);
  return { delta, carry: total - delta };
}

/** Bounds for the measured reading speed, keeping the estimate sane. */
const MIN_READING_SPEED = 80;
const MAX_READING_SPEED = 1500;
/** Initial chars-per-minute assumption before enough reading is measured. */
const DEFAULT_READING_SPEED = 300;

/**
 * Folds one scrolling session into the sustained speed estimate: an EWMA over
 * chars-per-minute samples, with implausible sessions (too short, too long, no
 * progress) ignored. Returns the previous estimate untouched when discarded.
 */
export function updateReadingSpeed(prev: number, chars: number, elapsedMs: number): number {
  const seconds = elapsedMs / 1000;
  if (chars <= 0 || seconds < 5 || seconds > 1800) return prev;
  const sample = (chars / seconds) * 60;
  const clamped = Math.min(Math.max(sample, MIN_READING_SPEED), MAX_READING_SPEED);
  return Math.round(prev * 0.7 + clamped * 0.3);
}

/**
 * Every reading preference at its shipping value.
 *
 * Split out from the store body so that "restore everything" is one write
 * rather than a second list of defaults that can drift from the first — see
 * `resetAllSettings`. The actions are deliberately not in here: a reset
 * replaces what the reader chose, not what the store can do.
 */
export const DEFAULT_READER_SETTINGS = {
  fontSize: 18,
  speechRate: 1,
  speechVoiceURI: null,
  // 词语: the wash follows the voice word by word, so it reads as *where the
  // voice is* rather than which sentence it is somewhere inside. v14 carries
  // this to installed stores.
  speechGranularity: "word",
  fontFamily: "book",
  lineHeightIdx: 1,
  paraGapIdx: 1,
  marginX: DEFAULT_MARGIN_X,
  marginY: DEFAULT_MARGIN_Y,
  // On: the two-em indent is the one paragraph style a Chinese page is
  // expected to carry, and the control only exists while the reader has taken
  // the layout back (跟随书籍 hides the whole group). v14 carries this too.
  indent: true,
  bodyBold: false,
  writingMode: "auto",
  bookTypography: true,
  quoteReplace: false,
  zhConvert: "off",
  zhToolbarButton: true,
  readingRuler: false,
  rulerLines: 2,
  rulerColor: "clear",
  rulerOpacity: 0.5,
  rulerPosition: DEFAULT_RULER_POSITION,
  rulerScrollTrigger: DEFAULT_RULER_SCROLL_TRIGGER,
  rsvpWpm: DEFAULT_WPM,
  surface: "standard",
  nightSurface: "night",
  customSurface: null,
  pageTransition: "pan",
  // Single page for every book, deliberately (2026-10-21): a paged reader that
  // opens two columns by default asks a first-time reader to work out what the
  // right-hand page is, and the scroll default before this hid paging entirely
  // behind a setting. 单页 is the one layout that needs no explaining; 双页 and
  // 滚动 stay one click away in the layout switcher. **v12 migrate carries this
  // to installs that already have the app** — see the note there, it is the
  // half of the change that actually reaches them.
  layoutMode: "single",
  gamepadPaging: true,
  autoScrollSpeed: DEFAULT_AUTO_SCROLL_SPEED,
  readingSpeed: DEFAULT_READING_SPEED,
  paceSamples: [],
  pageNumbers: "off",
  pageNumberPosition: "center",
  pageIndicatorAutoHide: true,
  pageTheme: null,
  pdfFill: true,
  pdfNight: "follow",
  pdfGap: 0,
  pdfInvertImages: false,
  invertBookImages: false,
  highlightColor: HIGHLIGHT_COLORS[0]!.hex,
  highlightStyle: "highlight",
  // The wash the voice has always drawn: the app's own tint, no shape of the
  // reader's choosing. Picking a colour is what turns it into a marker.
  speechWashStyle: "highlight",
  speechWashColor: null,
  speechWashColors: [],
  speechPlayerStyle: "full",
  speechMiniPlayer: true,
  byBook: {},
  activeSurface: null,
} satisfies Partial<ReaderState>;

export const useReaderSettings = create<ReaderState>()(
  persist(
    (set) => ({
      ...DEFAULT_READER_SETTINGS,
      setFontSize: (size) =>
        set({ fontSize: Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE) }),
      update: (patch) => set(patch),
      setActiveSurface: (surface) => set({ activeSurface: surface }),
      setBook: (bookId, patch) =>
        set((state) => ({
          byBook: { ...state.byBook, [bookId]: { ...state.byBook[bookId], ...patch } },
        })),
      setReadingSpeed: (charsPerMinute) =>
        set({
          readingSpeed: Math.min(
            Math.max(Math.round(charsPerMinute), MIN_READING_SPEED),
            MAX_READING_SPEED,
          ),
        }),
      recordPace: (sample) =>
        set((state) => ({ paceSamples: pushPace(state.paceSamples, sample) })),
    }),
    {
      // Bump only when a stored value changes meaning; a newly added key needs
      // no bump — the default merge layers the persisted state over the
      // initial one.
      name: "fangce.reader",
      version: 14,
      // v1 stored the auto-scroll speed as an index into [40, 80, 160, 320];
      // v2 stored the margin as an index into [16, 32, 48, 64]. Margins are
      // continuous px now and the scale was rebased (old 特宽 = new 标准).
      // v4: `pan` was briefly removed then restored; coerce any orphaned
      //   stored `pan` → `slide` (both resolve to the same native pan path).
      // v5: the single `peel` was split into two corner-grab variants;
      //   coerce stored `peel` → `peel-br` (the bottom-right grab).
      // v6: the left-right slide and both corner peels were dropped from the
      //   picker — the reader kept none / pan / fade / paper. Every one of
      //   those values falls back to `pan`, which is the same native pan path
      //   `slide` used, so a stored preference degrades to what it looked
      //   like rather than to nothing. v4's `pan → slide` coercion is gone
      //   with it: `pan` is a real option again.
      // v7: the page indicator's boolean became a three-way scope (off /
      //   current chapter / whole book). A stored `true` becomes "chapter" —
      //   the display it already had — and anything unrecognised becomes
      //   "off" rather than leaving the row with no chip selected.
      // v8: the page palette is snapshotted from the app theme on first run
      //   now, so "never chose" and "chose follow" have to be told apart. A
      //   stored `follow` is the old default and means the former — drop it to
      //   `null` so the snapshot happens on this launch. A stored `day` or
      //   `night` is a real choice and stays: pinning a page for someone who
      //   pinned it themselves is not a migration, it is a regression.
      // v9: auto-scroll speeds were halved (see `MAX_AUTO_SCROLL_SPEED`). A
      //   stored px/s is halved with them, so a reader who chose 适中 keeps
      //   the speed they chose — only the number behind it changes.
      // v12: the default layout became 单页 and `pdfNight` became a three-way
      //   axis with `follow` at its head. Both live in the migrate body rather
      //   than only in the defaults — an installed store keeps the old values,
      //   and a default nobody reads is not a change.
      // v13: the page palette is no longer snapshotted on first run — 跟随主题
      //   is the default again, and the pin the snapshot left in the top-level
      //   slot is dropped back to `null`.
      // v14: 段首缩进 ships on and the read-aloud wash ships 词语. Both are
      //   written into the migrate body for v12's reason — the defaults only
      //   reach a machine that has never run this build.
      migrate: (persisted) => {
        const state = persisted as Partial<ReaderState> & {
          autoScrollIdx?: number;
          marginIdx?: number;
          showPageNumbers?: boolean;
        };
        const next = { ...state } as ReaderState;
        if (typeof next.autoScrollSpeed !== "number") {
          // v1's index into the *old* scale; the halving below finishes it.
          next.autoScrollSpeed = [40, 80, 160, 320][state.autoScrollIdx ?? 1] ?? 80;
        }
        next.autoScrollSpeed = Math.min(
          Math.max(Math.round(next.autoScrollSpeed / 2), MIN_AUTO_SCROLL_SPEED),
          MAX_AUTO_SCROLL_SPEED,
        );
        if (typeof next.marginX !== "number") {
          next.marginX = MARGIN_X_PRESETS[state.marginIdx ?? 1] ?? DEFAULT_MARGIN_X;
          next.marginY = DEFAULT_MARGIN_Y;
        }
        const scope = next.pageNumbers as string | undefined;
        if (scope !== "off" && scope !== "chapter" && scope !== "book") {
          next.pageNumbers = state.showPageNumbers === true ? "chapter" : "off";
        }
        const stored = next.pageTransition as string;
        if (
          stored === "slide" ||
          stored === "peel" ||
          stored === "peel-br" ||
          stored === "peel-tr"
        ) {
          next.pageTransition = "pan";
        }
        if (next.pageTheme !== "day" && next.pageTheme !== "night") {
          next.pageTheme = null;
        }
        // v10: 原书 became the default typeface and the paragraph styles got a
        // 使用书籍排版 switch (on by default, no stored key needed). A stored
        // "system" font was the *old* default rather than a choice — anyone who
        // wanted the system face picks it again from one chip over. The
        // vertical boolean became the three-way writing mode: a stored `true`
        // is the explicit 竖排, `false` was the old forced-horizontal default
        // and maps to 跟随书籍.
        if (next.fontFamily === "system") next.fontFamily = "book";
        // v11: no build carries a bundled CJK face any more — 霞鹜文楷 became a
        // catalogue entry the reader installs with one click. A stored `lxgw`
        // is the old bundled key and now resolves to nothing, which would drop
        // the reader onto the system *sans* without a word. 楷体 is the family
        // that stack fell through to, so this leaves the page looking exactly
        // as it did; the face itself is one download away, under the same name.
        if (next.fontFamily === "lxgw") next.fontFamily = "kai";
        const legacyVertical = (state as { vertical?: unknown }).vertical;
        if (typeof legacyVertical === "boolean") {
          next.writingMode = legacyVertical ? "vertical" : "auto";
          delete (next as { vertical?: unknown }).vertical;
        }
        // v12: two defaults moved, and both were reached by the same two-step
        // dance — change `DEFAULT_READER_SETTINGS`, which only a fresh install
        // ever sees. An installed reader's persisted store still carries the old
        // values, so without a line here the change ships and nothing happens
        // for the people it was made for.
        //
        // **滚动 → 单页** (`layoutMode`). The default flipped a day earlier
        // (87558c4) and this is the half of it that reaches anyone who already
        // had the app. Only the top-level slot is rewritten: `layoutMode` is in
        // `BOOK_SETTINGS`, so every change the reader makes in the panel goes
        // to `byBook[bookId]` and the shared value is never theirs — it is
        // simply the last default, so moving it is not overriding a choice.
        const layout = next.layoutMode as string;
        if (layout === "scroll" || (layout !== "single" && layout !== "double")) {
          // An unrecognised value is not a preference to keep — it is a layout
          // the panel has no chip for and `paged = layoutMode !== "scroll"`
          // would read as paged anyway. Fall to the default rather than let it
          // through as a page whose mode nothing can name. (`layout` is read as
          // a plain string so the type checker does not collapse the union to
          // just the two valid states and reject the final 异常值 guard.)
          next.layoutMode = "single";
        }
        //
        // **`pdfNight` 的布尔 → 三态**. `true` was the old default — every PDF
        // night-rendered whatever the theme — so it means "never chose" and
        // becomes `follow`, the same answer the fresh install gets. `false` was
        // a reader who turned it *off*, and `follow` would hand it back to the
        // night palette at dusk; it stays `day`, which is the pin they picked.
        // Read off `state` rather than `next` on purpose: `next` is typed as
        // the *new* shape, so the boolean this branch exists for is invisible
        // to the compiler — which is exactly the value being read.
        const legacyPdfNight = state.pdfNight as boolean | PdfNight | undefined;
        next.pdfNight =
          legacyPdfNight === false
            ? "day"
            : legacyPdfNight === true
              ? "follow"
              : legacyPdfNight !== undefined && legacyPdfNight in PDF_NIGHT_KEYS
                ? legacyPdfNight
                : "follow";
        //
        // v13: the page palette stopped being snapshotted, so `null` — 跟随主题
        // — is a real default again rather than a launch that gets pinned
        // within a frame. Every install carries a pinned value in the top-level
        // slot, because the snapshot is the only thing that ever wrote it: a
        // reader's own choice goes to `byBook[bookId]` (`pageTheme` is in
        // `BOOK_SETTINGS`), so the shared slot was never theirs. Drop it back
        // to `null` and the page follows the theme the way a fresh install
        // does. Per-book values are real choices and are left alone.
        next.pageTheme = null;
        // v14: 段首缩进 ships on, and the voice washes 词语 rather than 句子.
        // Same lesson as v12: a changed default only reaches a fresh install
        // unless it is also written here.
        //
        // `indent` only in the top-level slot. It is in `BOOK_SETTINGS`, so a
        // reader's own toggle lives in `byBook[bookId]` — a stored `false`
        // there is a choice and stays; the shared slot is never anything but
        // the default.
        next.indent = true;
        // `speechGranularity` is app-wide and the panel is its only writer, so
        // a stored `sentence` is the old default and means "never chose".
        if (next.speechGranularity === "sentence") next.speechGranularity = "word";
        return next;
      },
    },
  ),
);

/**
 * The reader settings as one book sees them: the app-wide values with that
 * book's own on top, and an `update` that writes to the book.
 *
 * Only `BOOK_SETTINGS` keys are kept per book. A patch that also carries an
 * app-wide value (a voice, a speed) writes that one to the shared store, so
 * the settings panel keeps working without knowing which is which.
 *
 * `null` means "no book" — the ordinary reader before one is open, and the
 * chrome outside the reader — and then this is just the shared store.
 */
export function useBookSettings(bookId: string | null | undefined): ReaderState {
  const settings = useReaderSettings();
  const setBook = useReaderSettings((state) => state.setBook);

  return useMemo(() => {
    const own = bookId ? settings.byBook[bookId] : undefined;
    const merged = own ? { ...settings, ...own } : settings;

    const write = (patch: Partial<ReaderState>) => {
      if (!bookId) {
        settings.update(patch);
        return;
      }
      const mine: Record<string, unknown> = {};
      const shared: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (BOOK_SET.has(key)) mine[key] = value;
        else shared[key] = value;
      }
      if (Object.keys(mine).length > 0) setBook(bookId, mine as BookSettings);
      if (Object.keys(shared).length > 0) settings.update(shared as Partial<ReaderState>);
    };

    return {
      ...merged,
      update: write,
      // The stepper is a book's too: it is the same number `update` writes.
      setFontSize: (size: number) =>
        write({ fontSize: Math.min(Math.max(size, MIN_FONT_SIZE), MAX_FONT_SIZE) }),
    };
  }, [bookId, settings, setBook]);
}
