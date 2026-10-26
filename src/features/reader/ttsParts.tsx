import {
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion, useReducedMotion } from "motion/react";
import { BookOpen, Pause, Play, SkipBack, SkipForward, X } from "@phosphor-icons/react";

import { IconSwap } from "@/components/motion/IconSwap";
import { cn } from "@/lib/cn";
import { isDesktopRuntime } from "@/lib/ipc";

import { formatClock, type SpeechStatus } from "./speech";

/**
 * The pieces the bar and the card both draw.
 *
 * They used to live in the card, which was the only surface there was. Now that
 * the bar is the one on screen most of the time, the shared bits sit in the
 * middle rather than one of them owning the other.
 */

/** How far a press has to travel before it is a drag rather than a click. */
const DRAG_SLOP = 4;

/** The boxes that own their own gestures. */
const INTERACTIVE = "button, a, input, select, textarea, [role='button']";

/** …and the ones that own a press *and* a drag, which is how a title gets to be
 *  both the way into the player and the way to move the window it sits in. */
const DRAG_ZONE = "[data-tts-drag]";

/**
 * Moves the window, from wherever on the surface the press landed.
 *
 * The bar *is* a window with no frame, so this is the only way to move it, and
 * practically the whole capsule is the handle: a first version hung
 * `data-tauri-drag-region` on the title and the clock, and dragging it by the
 * glass around them — most of it — did nothing, because the attribute is
 * checked on the node it sits on and can only ever cover the boxes it is
 * written into. This covers everything the pointer can reach, and skipping the
 * controls is what keeps their clicks.
 *
 * The press is not handed over at once, and that is what lets one box be both
 * the handle and a button. `startDragging` takes the whole mouse-down for
 * itself — a press that becomes a drag never produces a click, so a control
 * under the pointer would go dead — and here the press is watched instead: only
 * a pointer that has actually travelled 4px hands the window over, and one that
 * stays put releases into an ordinary click on whatever it landed on.
 *
 * Nothing is lost by waiting. The frame is placed from the cursor's position at
 * the moment the drag starts, and tao synthesises the left-mouse-down the
 * system asks for out of the event already in flight (`tao::drag_window`), so a
 * drag that begins on the third pixel of movement moves exactly as far as one
 * that began on the first.
 */
export function dragWindow(event: ReactPointerEvent<HTMLDivElement>) {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest(INTERACTIVE) !== null && event.target.closest(DRAG_ZONE) === null) {
    return;
  }
  if (!isDesktopRuntime) return;
  const from = { x: event.clientX, y: event.clientY };
  // One listener pair, taken off together — including from inside the handler
  // that fires it, which is exactly what `abort` is for.
  const press = new AbortController();
  window.addEventListener(
    "pointermove",
    (moved) => {
      if (Math.hypot(moved.clientX - from.x, moved.clientY - from.y) < DRAG_SLOP) return;
      press.abort();
      void getCurrentWindow().startDragging();
    },
    { signal: press.signal },
  );
  window.addEventListener("pointerup", () => press.abort(), { signal: press.signal });
}

/**
 * Puts the main window away and leaves the floating bar on the desktop.
 *
 * The reader who presses this has just decided that the app is in the way and
 * the voice is not — which is the one thing the in-app transport cannot do for
 * itself, because the transport *is* the window. Minimizing rather than hiding
 * keeps the way back in the Dock, where it does not depend on knowing about a
 * tray menu; and everything downstream is already in place, since a minimized
 * main window counts as "away" to the backend and the bar comes up on its own.
 */
export function minimizeWindow() {
  if (!isDesktopRuntime) return;
  void getCurrentWindow().minimize();
}

/** Cover thumbnail, falling back to a glyph when the book has no artwork. */
export function Cover({ url, className }: { url: string | null; className?: string }) {
  if (url) {
    return <img src={url} alt="" draggable={false} className={cn("object-cover", className)} />;
  }
  return (
    <span className={cn("bg-surface-2 text-text-3 grid place-items-center", className)}>
      <BookOpen size={14} />
    </span>
  );
}

/**
 * The capsule, which is the whole of read-aloud when it is closed.
 *
 * One object with two homes: inside the shell's window it floats over the page,
 * and on the desktop it *is* a small always-on-top window. So it lives here
 * rather than twice, and the two callers differ in two ways — whether the
 * capsule is the window's own drag surface, and what sits at its far end (the
 * bar's way back to the text and its fold-away; nothing, in the app).
 *
 * What the cover and the title do is the same on both: they open the player.
 * The card the bar opens is drawn in the bar's own window, so a reader who
 * wants the transport back does not have to bring the whole app up to get it.
 *
 * The second line is a node, not a string: it is a clock, a failure, or three
 * loading bars, and which of the three is the caller's business.
 */
export function Pill({
  coverUrl,
  title,
  chapter,
  line,
  percent,
  status,
  onOpen,
  openLabel,
  onPrev,
  onToggle,
  onNext,
  onStop,
  dragHandle = false,
  trailing,
  className,
}: {
  coverUrl: string | null;
  title: string;
  chapter: string;
  line: ReactNode;
  /** 0–100. Drawn on the capsule's own bottom edge, and only mid-way: a bar
   *  flush against either end is a fact the clock already states. */
  percent: number;
  status: SpeechStatus;
  onOpen: () => void;
  openLabel: string;
  onPrev: () => void;
  onToggle: () => void;
  onNext: () => void;
  onStop: () => void;
  /** Whether the capsule is the floating window's drag handle. Only that
   *  window has one to move; over the page there is nothing to drag. */
  dragHandle?: boolean;
  /** One more control at the far end, for the surface that has one to add. */
  trailing?: ReactNode;
  /** The capsule's width, which the two windows disagree about. */
  className?: string;
}) {
  const scrolled = percent > 0 && percent < 100;

  const heading = (
    <>
      <p className="text-text-1 truncate text-[12px] font-medium">
        {title}
        {chapter !== "" && <span className="text-text-3"> · {chapter}</span>}
      </p>
      <p className="text-text-3 truncate text-[11px] tabular-nums">{line}</p>
    </>
  );

  return (
    <div
      data-tts-pill
      onPointerDown={dragHandle ? dragWindow : undefined}
      className={cn(
        "glass-liquid pointer-events-auto relative flex w-[min(92vw,380px)] items-center gap-2.5 overflow-hidden rounded-full py-1.5 pr-2 pl-1.5",
        dragHandle && "select-none",
        className,
      )}
    >
      {/* The cover opens the card too: a target this obvious should not be dead
          surface when the title beside it already opens. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        title={openLabel}
        className="press focus-visible:focus-ring shrink-0 rounded-xs"
      >
        <Cover url={coverUrl} className="shadow-panel size-8 rounded-md" />
      </button>
      {/* The title is the way into the player on either surface, and on the
          desktop it is also the window's handle: the drag only begins once the
          press has travelled, so one box answers to both. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        data-tts-drag={dragHandle ? "" : undefined}
        className="focus-visible:focus-ring min-w-0 flex-1 rounded-xs text-left"
      >
        {heading}
      </button>
      <Transport label="上一句" onClick={onPrev}>
        <SkipBack size={14} weight="fill" />
      </Transport>
      <button
        type="button"
        aria-label={status === "playing" ? "暂停" : "继续"}
        onClick={onToggle}
        className="bg-accent text-on-accent focus-visible:focus-ring grid size-9 shrink-0 place-items-center rounded-full transition-opacity hover:opacity-90"
      >
        <IconSwap state={status}>
          {status === "playing" ? (
            <Pause size={15} weight="fill" />
          ) : (
            <Play size={15} weight="fill" />
          )}
        </IconSwap>
      </button>
      <Transport label="下一句" onClick={onNext}>
        <SkipForward size={14} weight="fill" />
      </Transport>
      <Transport label="停止朗读" onClick={onStop}>
        <X size={14} weight="bold" />
      </Transport>
      {trailing}
      {scrolled && (
        <span
          aria-hidden
          className="bg-accent absolute inset-x-0 bottom-0 h-0.5 origin-left"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      )}
    </div>
  );
}

/**
 * The capsule's clock line, worded once for both bars.
 *
 * Both figures arrive already formatted: the in-app pill has the queue and the
 * speech rate to work them out, and the floating bar is *told* them in exactly
 * this form — a window that only draws should not have to reconstruct what
 * `-4:12` means.
 */
export function barClock(paused: boolean, elapsed: string, remaining: string): string {
  return `${paused ? "已暂停 · " : ""}${elapsed} · -${remaining}`;
}

/** One round icon button of the transport. */
export function Transport({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "press text-text-2 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-8 shrink-0 place-items-center rounded-full",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Three rising bars: the service is synthesising and the voice has nothing to
 *  say yet. Reduced motion holds a low, steady bar — the movement carries no
 *  information the label does not. */
export function LoadingBars({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <output
      className={cn("inline-flex h-3 shrink-0 items-end gap-[3px]", className)}
      aria-label="正在加载语音"
    >
      {[0, 1, 2].map((bar) => (
        <motion.span
          key={bar}
          className="bg-accent h-3 w-[3px] origin-bottom rounded-full"
          initial={{ scaleY: 0.3 }}
          animate={reduce ? undefined : { scaleY: [0.3, 1, 0.3] }}
          transition={
            reduce
              ? undefined
              : { duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: bar * 0.18 }
          }
        />
      ))}
    </output>
  );
}

/** One tick a second. Never read during render: the countdown below is the
 *  only consumer, and it mounts only while a timer is armed, so an idle reader
 *  runs no clock at all. */
const subscribeTick = (onTick: () => void) => {
  const id = window.setInterval(onTick, 1000);
  return () => window.clearInterval(id);
};

const snapshotSecond = () => Math.floor(Date.now() / 1000);

/** `m:ss` left before `endsAt`, ticking. */
export function Countdown({ endsAt }: { endsAt: number }) {
  const second = useSyncExternalStore(subscribeTick, snapshotSecond);
  return <>{formatClock(Math.max(0, endsAt / 1000 - second))}</>;
}
