import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowsIn,
  ArrowsOut,
  BookmarkSimple,
  Books,
  CaretLeft,
  CaretRight,
  Check,
  EyeSlash,
  Faders,
  Graph,
  HighlighterCircle,
  ListBullets,
  Lightning,
  MagnifyingGlass,
  Minus,
  Pause,
  Plus,
  Ruler,
  SpeakerHigh,
  Sparkle,
  Translate,
} from "@phosphor-icons/react";

import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { IconSwap } from "@/components/motion/IconSwap";
import { HeaderCover, HeaderRule } from "@/features/reader/ReaderHeader";
import { estimateLabel, planLabel } from "@/features/reader/progress";
import { ScanChip } from "@/features/reader/ScanChip";
import { MAX_PDF_ZOOM, MIN_PDF_ZOOM, PDF_ZOOM_STEP } from "@/features/reader/usePdfZoom";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "@/stores/reader";
import { ZH_MODES } from "@/features/reader/zhConvert";
import type { ZhConvertMode } from "@/features/reader/zhConvert";
import { cn } from "@/lib/cn";

/** Which side panel is open. Only one at a time, so they never stack. */
export type Panel =
  "none" | "annotations" | "search" | "ai" | "guide" | "graph" | "toc" | "settings";

/**
 * Reader chrome buttons: same anatomy as the sidebar's glass buttons, but
 * fill and hairline come from the re-rooted reading-surface tokens — the
 * fill is a wash of the paper colour (`--glass-btn`), so the circles read as
 * liquid glass over the page without darkening it like an ink fill would.
 */
export const CHROME_BTN = "bg-(--glass-btn) border-hairline-strong shadow-glass";

/** The controls a reader carries, independent of where they are mounted. */
export interface ReaderToolButtonsProps {
  /** PDF pages are fixed bitmaps: the steppers zoom the page, not the text. */
  isPdf: boolean;
  onTogglePanel: (panel: Exclude<Panel, "none">) => void;
  pdfZoom: number;
  onZoom: (next: number) => void;
  fontSize: number;
  onFontSize: (next: number) => void;
  atBookmark: boolean;
  onToggleBookmark: () => void;
  bookmarkPending: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Whether the reading ruler is on: the button shows it. */
  rulerOn: boolean;
  onToggleRuler: () => void;
  /** 简繁转换 needs a paginator or flowing prose; PDF pages and comics have
   *  neither, and a button that does nothing where it sits is worse than none. */
  zhAvailable: boolean;
  /** The active conversion mode; `off` means the book reads as published. */
  zhConvert: ZhConvertMode;
  onZhConvert: (mode: ZhConvertMode) => void;
  /** Whether the header carries the 简繁转换 button at all (设置里可关). */
  zhButton: boolean;
  /** Hides the shortcut from this header (the menu's own affordance). */
  onHideZhButton: () => void;
  /** Whether a companion book is open beside this one. */
  paired?: boolean;
  /** Opens the companion-book picker — to start a pair, or to change the
   *  book on the other side of one. Hidden when absent. */
  onOpenPair?: () => void;
  /** Which way the one popover in this cluster opens. A pair mounts the
   *  cluster in the bar at the bottom, where "down" is off-screen. */
  menuPlacement?: "down" | "up";
}

export interface ReaderHeaderBarProps extends ReaderToolButtonsProps {
  fullscreen: boolean;
  onBack: () => void;
  /** Where 返回 leads, named for the page it goes back to. */
  backLabel: string;
  bookId: string;
  coverUrl: string | null;
  coverBoxRef: RefObject<HTMLSpanElement | null>;
  title: string;
  /** 1-based position in the chapter list, or the page number for a PDF. */
  index: number;
  total: number;
  /** Chapter heading, shown for prose books only. */
  chapterLabel: string;
}

/**
 * The chrome's buttons, in one row that may become two.
 *
 * Shared by the ordinary reader's header and by the 对照阅读 pair's bottom bar:
 * a pair merges both bars' controls into the one bar at the bottom, so the
 * same cluster has to be mountable in either place. `paired` only changes what
 * a control *says* (对照阅读 vs 更换对照书) and which controls are pointless
 * mid-pair (a bookmark and a fullscreen toggle belong to a single book's
 * page).
 *
 * It wraps rather than shrinks. The cluster measures ~490px natural width, and
 * the pane it hangs in can be far less than that — a window dragged down to
 * 520px leaves this reader ~230px once the sidebar is paid for. An unwrapped
 * row does not squeeze there, it *escapes*: the reading pane is
 * `overflow-hidden`, which clips but does not stop `scrollLeft`, so the first
 * click past the right edge scrolls the whole reader sideways and takes the
 * settings drawer with it off the left of the window. The footer already wraps
 * for the same reason (measured 1109px against a 1024px minimum window); the
 * header now takes the same treatment.
 */
export function ReaderToolButtons({
  isPdf,
  onTogglePanel,
  pdfZoom,
  onZoom,
  fontSize,
  onFontSize,
  atBookmark,
  onToggleBookmark,
  bookmarkPending,
  fullscreen,
  onToggleFullscreen,
  rulerOn,
  onToggleRuler,
  zhAvailable,
  zhConvert,
  onZhConvert,
  zhButton,
  onHideZhButton,
  paired,
  onOpenPair,
  menuPlacement = "down",
}: ReaderToolButtonsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <GlassIconButton
        label="目录与书签"
        size="sm"
        className={CHROME_BTN}
        onClick={() => onTogglePanel("toc")}
      >
        <ListBullets size={16} />
      </GlassIconButton>
      <GlassIconButton
        label="搜索"
        size="sm"
        className={CHROME_BTN}
        onClick={() => onTogglePanel("search")}
      >
        <MagnifyingGlass size={16} />
      </GlassIconButton>
      <GlassIconButton
        label="标注"
        size="sm"
        className={CHROME_BTN}
        onClick={() => onTogglePanel("annotations")}
      >
        <HighlighterCircle size={16} />
      </GlassIconButton>
      <HeaderRule />
      <GlassIconButton
        label="知识图谱"
        size="sm"
        className={CHROME_BTN}
        onClick={() => onTogglePanel("graph")}
      >
        <Graph size={16} />
      </GlassIconButton>
      <GlassIconButton
        label="AI 导读"
        size="sm"
        className={CHROME_BTN}
        onClick={() => onTogglePanel("guide")}
      >
        <Sparkle size={16} />
      </GlassIconButton>
      <HeaderRule />
      {/* A reading-aid toggle, not a panel: pressed state instead of an open
          drawer, sitting with the other things that change the page itself. */}
      <GlassIconButton
        label={rulerOn ? "关闭阅读标尺" : "开启阅读标尺"}
        size="sm"
        className={CHROME_BTN}
        aria-pressed={rulerOn}
        onClick={onToggleRuler}
      >
        <span
          className={cn("inline-flex transition-colors duration-300", rulerOn && "text-accent")}
        >
          <Ruler size={16} weight={rulerOn ? "fill" : "regular"} />
        </span>
      </GlassIconButton>
      {/* 简繁转换 sits with the ruler: another thing that changes the page
          itself rather than opening a drawer. Hidden on PDF/comics and when
          the reader has turned the shortcut off in settings. */}
      {zhAvailable && zhButton && (
        <ZhConvertButton
          mode={zhConvert}
          onPick={onZhConvert}
          onHide={onHideZhButton}
          placement={menuPlacement}
        />
      )}
      {/* 对照阅读: opens a second book beside this one — or, mid-pair, changes
          which book is on the other side. Sits with the layout actions rather
          than the drawers: it rearranges the window. */}
      {onOpenPair && (
        <GlassIconButton
          label={paired ? "更换对照书" : "对照阅读"}
          size="sm"
          className={CHROME_BTN}
          aria-pressed={paired}
          onClick={onOpenPair}
        >
          <Books size={16} weight={paired ? "fill" : "regular"} />
        </GlassIconButton>
      )}
      <GlassIconButton
        label="阅读设置"
        size="sm"
        className={CHROME_BTN}
        onClick={() => onTogglePanel("settings")}
      >
        <Faders size={16} />
      </GlassIconButton>
      {isPdf ? (
        // PDF pages are fixed bitmaps; these steppers zoom the page.
        <>
          <GlassIconButton
            label="缩小页面"
            size="sm"
            className={CHROME_BTN}
            onClick={() => onZoom(pdfZoom / PDF_ZOOM_STEP)}
            disabled={pdfZoom <= MIN_PDF_ZOOM}
          >
            <Minus size={16} />
          </GlassIconButton>
          <GlassIconButton
            label="重置缩放"
            size="sm"
            className={CHROME_BTN}
            onClick={() => onZoom(1)}
          >
            <span className="text-[11px] font-semibold tabular-nums">
              {Math.round(pdfZoom * 100)}%
            </span>
          </GlassIconButton>
          <GlassIconButton
            label="放大页面"
            size="sm"
            className={CHROME_BTN}
            onClick={() => onZoom(pdfZoom * PDF_ZOOM_STEP)}
            disabled={pdfZoom >= MAX_PDF_ZOOM}
          >
            <Plus size={16} />
          </GlassIconButton>
        </>
      ) : (
        <>
          <GlassIconButton
            label="缩小字号"
            size="sm"
            className={CHROME_BTN}
            onClick={() => onFontSize(fontSize - 1)}
            disabled={fontSize <= MIN_FONT_SIZE}
          >
            <span className="text-[11px] font-semibold">A</span>
          </GlassIconButton>
          <GlassIconButton
            label="放大字号"
            size="sm"
            className={CHROME_BTN}
            onClick={() => onFontSize(fontSize + 1)}
            disabled={fontSize >= MAX_FONT_SIZE}
          >
            <span className="text-sm font-semibold">A</span>
          </GlassIconButton>
        </>
      )}
      {!paired && (
        <>
          <HeaderRule />
          <GlassIconButton
            label={atBookmark ? "取消本书签" : "添加书签"}
            size="sm"
            className={CHROME_BTN}
            onClick={onToggleBookmark}
            disabled={bookmarkPending}
          >
            {/* Remounting on state flip restarts the pop; the icon eases between
                outline and filled + accent instead of snapping. */}
            <span
              key={atBookmark ? "saved" : "idle"}
              className={cn(
                "inline-flex transition-colors duration-300",
                atBookmark && "text-accent animate-[bookmark-pop_0.45s_ease-out]",
              )}
            >
              <BookmarkSimple size={16} weight={atBookmark ? "fill" : "regular"} />
            </span>
          </GlassIconButton>
          <GlassIconButton
            label={fullscreen ? "退出全屏" : "全屏阅读"}
            size="sm"
            className={CHROME_BTN}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
          </GlassIconButton>
        </>
      )}
    </div>
  );
}

/**
 * The ordinary reader's header: which book, where in it, and the controls.
 *
 * A 对照阅读 pair does not use this — it has one top bar for both books
 * (`SplitReader`) and merges the controls into its bottom bar.
 */
export function ReaderHeaderBar({
  fullscreen,
  onBack,
  backLabel,
  bookId,
  coverUrl,
  coverBoxRef,
  title,
  index,
  total,
  isPdf,
  chapterLabel,
  ...tools
}: ReaderHeaderBarProps) {
  return (
    <header
      className={cn(
        // `flex-wrap` keeps the row inside its pane: the title block truncates
        // but the tool cluster cannot shrink below its own natural width, so on
        // a narrow pane the cluster wraps to a second line as one unit instead
        // of pushing the header — and with it the whole reader — out sideways.
        "border-hairline flex flex-wrap items-center gap-3 border-b px-6 py-3",
        fullscreen && "bg-(--glass-btn) backdrop-blur-xl",
      )}
    >
      <GlassIconButton label={backLabel} size="sm" onClick={onBack} className={CHROME_BTN}>
        <ArrowLeft size={16} />
      </GlassIconButton>
      <HeaderCover bookId={bookId} coverUrl={coverUrl} boxRef={coverBoxRef} />
      <div className="min-w-0 flex-1">
        <p className="text-text-1 truncate text-sm font-medium" data-reader-title>
          {title}
        </p>
        <p className="text-text-3 truncate text-xs" data-reader-chapter>
          第 {index} / {total} {isPdf ? "页" : "章"}
          {!isPdf && chapterLabel && ` · ${chapterLabel}`}
        </p>
      </div>
      <ReaderToolButtons {...tools} isPdf={isPdf} fullscreen={fullscreen} />
    </header>
  );
}

/**
 * The header's 简繁转换 button: pressed like the ruler (accent while a mode is
 * active), and opening a menu of the conversion modes readest offers — plain
 * direction swaps plus the Taiwan / Hong Kong regional and phrase variants.
 * The menu also carries the way to hide this shortcut from the header, so the
 * reader who never uses it learns the setting exists where the button is.
 */
function ZhConvertButton({
  mode,
  onPick,
  onHide,
  placement = "down",
}: {
  mode: ZhConvertMode;
  onPick: (mode: ZhConvertMode) => void;
  onHide: () => void;
  /** A pair mounts this button in the bottom bar, where a downward menu would
   *  open past the edge of the window. */
  placement?: "down" | "up";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const active = mode !== "off";
  const activeLabel = ZH_MODES.find((entry) => entry.key === mode)?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative">
      <GlassIconButton
        label={active ? `简繁转换：${activeLabel}` : "简繁转换"}
        size="sm"
        className={CHROME_BTN}
        aria-pressed={active}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={cn("inline-flex transition-colors duration-300", active && "text-accent")}>
          <Translate size={16} weight={active ? "fill" : "regular"} />
        </span>
      </GlassIconButton>
      {open && (
        <div
          role="menu"
          aria-label="简繁转换"
          className={cn(
            "glass shadow-glass absolute right-0 z-50 w-56 rounded-[14px] border p-1.5 backdrop-blur-xl",
            placement === "up" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]",
          )}
        >
          {ZH_MODES.map((entry) => {
            const on = entry.key === mode;
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  onPick(entry.key);
                  setOpen(false);
                }}
                className={cn(
                  "focus-visible:focus-ring text-text-2 hover:text-text-1 hover:bg-surface-2 flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
                  on && "text-accent",
                )}
              >
                {entry.label}
                {on && <Check size={13} weight="bold" />}
              </button>
            );
          })}
          <div className="border-hairline mt-1.5 border-t pt-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onHide();
              }}
              className="text-text-3 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors"
            >
              <EyeSlash size={13} />
              不在工具栏显示
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * Footer controls, shared by the in-flow bar and the fullscreen bottom hud.
 *
 * `speechStatus` drives the one button that means three things: start, pause
 * and resume. `paged` decides whether the wheel button scrolls or turns pages,
 * which is also what its label promises.
 */
export function ReaderFooterControls({
  speechStatus,
  onToggleSpeech,
  onTogglePlayer,
  speechRate,
  paged,
  autoScrolling,
  onToggleAutoScroll,
  onStepChapter,
  chapterIdx,
  total,
  chapterRemaining,
  bookRemaining,
  readingSpeed,
  progress,
  rsvpOn,
  onRsvp,
  bookId,
  compact = false,
  chapterNav = true,
}: {
  speechStatus: "idle" | "playing" | "paused";
  onToggleSpeech: () => void;
  onTogglePlayer: () => void;
  speechRate: number;
  paged: boolean;
  autoScrolling: boolean;
  onToggleAutoScroll: () => void;
  onStepChapter: (dir: 1 | -1) => void;
  chapterIdx: number;
  total: number;
  chapterRemaining: number;
  bookRemaining: number;
  /** Words per minute, from the reader's own measured reading speed. */
  readingSpeed: number;
  progress: number;
  /** Speed reading is running: the button shows it rather than only opening it. */
  rsvpOn: boolean;
  onRsvp: () => void;
  /** The book, for the one control here that is about the page rather than
   *  about reading: the scan chip. */
  bookId: string;
  /** Half a window (对照阅读): drop the units that only fit a full-width
   *  row. The footer's natural width measures ~1109px; a paired pane is
   *  ~500px, so the full set wraps into a three-line pile under the paper
   *  instead of one row. The transport and the chapter nav are what a
   *  comparison needs; the estimates, the flip hint and the scan chip
   *  return the moment the pair closes. */
  compact?: boolean;
  /** Whether the bar carries 上一章/下一章. A pair's top bar already gives
   *  each book its own steppers, so the bottom bar keeps only the progress
   *  readout and no longer asks "which book does this turn?". */
  chapterNav?: boolean;
}) {
  /** Speech first, then the player, then auto-scroll — see the footer's own
   *  note on why the scroll button is not available in every layout. */
  const autoScrollLabel = paged
    ? "自动滚动仅在滚动排版下可用"
    : autoScrolling
      ? "暂停自动滚动"
      : "开始自动滚动";

  /** What finishing the book in a week would ask of each day, or nothing — a
   *  book with minutes left has no plan worth printing. */
  const plan = planLabel(bookRemaining, readingSpeed);

  const speechLabel =
    speechStatus === "paused"
      ? "继续朗读"
      : speechStatus === "playing"
        ? "暂停朗读"
        : "从当前位置朗读";

  return (
    <>
      <GlassIconButton
        label={speechLabel}
        size="sm"
        className={CHROME_BTN}
        onClick={onToggleSpeech}
      >
        <IconSwap state={speechStatus}>
          {speechStatus === "playing" ? <Pause size={16} /> : <SpeakerHigh size={16} />}
        </IconSwap>
      </GlassIconButton>
      {/* The rate, and a shortcut past the card's tiles: the button says 1× and
          opens 语速, which is where a reader who pressed it is going. Opening the
          card on its transport view instead would be one tap more for the same
          answer, and the tiles it skips are the card's own table of contents.

          9px, and not out of timidity: the box is 32px with no padding, and the
          longest rate in the reader's range is `1.75×` — five characters. At 11px
          that measured **33px against a 32px button**, so the text was wider than
          the circle holding it. 9px puts it at 27px, which is the same fraction
          the shortest label (`0.5×`) occupied at 11px, so every rate in the range
          now breathes the same. `tabular-nums` stays: the label changes under the
          reader's finger and must not jitter. */}
      <GlassIconButton label="倍速" size="sm" className={CHROME_BTN} onClick={onTogglePlayer}>
        <span className="text-[9px] font-semibold tabular-nums">{speechRate}×</span>
      </GlassIconButton>
      {/* Speed reading, third next to listening and scrolling: it is the same
          job — taking in the chapter without moving your hands — done by the
          eye instead of the ear. */}
      <GlassIconButton
        label="速读（RSVP）"
        size="sm"
        className={cn(CHROME_BTN, rsvpOn && "text-accent")}
        aria-pressed={rsvpOn}
        onClick={onRsvp}
      >
        <Lightning size={16} weight={rsvpOn ? "fill" : "regular"} />
      </GlassIconButton>
      <GlassIconButton
        // Auto-scroll is a rolling viewport; a paged one has no flow to roll,
        // so the control is off there rather than re-pointed at page turns —
        // two behaviours under one icon was how "自动滚动" came to mean
        // "每隔几秒跳一屏" to readers who had picked the other layout.
        label={autoScrollLabel}
        title={paged ? autoScrollLabel : undefined}
        size="sm"
        className={CHROME_BTN}
        disabled={paged}
        onClick={onToggleAutoScroll}
      >
        <IconSwap state={autoScrolling ? "on" : "off"}>
          {autoScrolling ? <Pause size={16} /> : <ArrowDown size={16} />}
        </IconSwap>
      </GlassIconButton>
      {chapterNav && (
        <GlassButton
          variant="subtle"
          size="sm"
          onClick={() => onStepChapter(-1)}
          disabled={chapterIdx === 0}
        >
          <CaretLeft size={14} /> 上一章
        </GlassButton>
      )}
      {/* Two readings of the same number: how much is left, and what finishing
          it would ask of a day. The second is absent on short books and before
          the reader's own pace has been measured — see `planLabel`. */}
      {!compact && (
        <span className="text-text-3 text-xs">
          本章 {estimateLabel(chapterRemaining, readingSpeed)} · 全书{" "}
          {estimateLabel(bookRemaining, readingSpeed)}
          {plan ? ` · ${plan}` : ""}
        </span>
      )}
      {/* The readout pops as it changes: progress arriving silently next to
          buttons that all respond reads as frozen, not as steady. */}
      <motion.span
        key={Math.round(progress * 100)}
        data-reader-progress
        initial={{ opacity: 0.35 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="text-text-3 text-xs tabular-nums"
      >
        {Math.round(progress * 100)}%
      </motion.span>
      {chapterNav && (
        <GlassButton
          variant="subtle"
          size="sm"
          onClick={() => onStepChapter(1)}
          disabled={chapterIdx >= total - 1}
        >
          下一章 <CaretRight size={14} />
        </GlassButton>
      )}
      {/* The key hint repeats what the header's steppers already say; a half
          pane spends its width better on the chapter nav it sits between. */}
      {!compact && <span className="text-text-3 text-xs">{paged ? "← → 翻页" : "← → 翻章"}</span>}
      {/* Last, and the only thing here that is about the *page* rather than
          about reading it: a page with no text layer, and the two ways to give
          it one. It sits in the footer rather than on the paper — a notice
          drawn over the page covers the page, and one drawn per page slot
          covers a spread twice. */}
      {!compact && <ScanChip bookId={bookId} page={chapterIdx + 1} />}
    </>
  );
}
