import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  Check,
  Gauge,
  GenderFemale,
  GenderMale,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  Timer,
  X,
} from "@phosphor-icons/react";

import { IconSwap } from "@/components/motion/IconSwap";
import { cn } from "@/lib/cn";
import type { SleepChoice, SleepTimer } from "@/hooks/useSleepTimer";
import { EASE_OUT, SPRING, useMotion } from "@/lib/motion";

import { unitAtChar, type SpeechStatus, type SpeechUnit, type SpeechView } from "./speech";
import { Countdown, Cover, LoadingBars, Transport, dragWindow } from "./ttsParts";
import {
  DEFAULT_VOICE_NAME,
  bookLangVoices,
  defaultVoice,
  defaultVoiceMissing,
  languageName,
  voiceGroups,
  voiceZhName,
  type Voice,
  type VoiceGender,
} from "./voice";

/**
 * The read-aloud player, as a panel.
 *
 * One object with two homes, like the capsule beside it: inside the app it
 * opens over the reading surface that asked for it, and on the desktop it is
 * the face of the floating bar itself — which is why a reader can open the
 * player without bringing the whole app back. Nothing here reaches for a store,
 * an engine or a query: every fact arrives as a prop and every gesture leaves
 * as a callback, so the same card can be driven by a mounted reader on one
 * screen and by an event payload on the other.
 *
 * That is also why the catalogue comes in whole and the *derivations* stay
 * here: `defaultVoice`, `bookLangVoices` and `voiceGroups` are pure functions
 * over the list, so the two hosts agree on which voice is the current one by
 * construction rather than by both computing it.
 *
 * One thing travels the other way: which view is up. The bar is a *window*, and
 * a window has to be the size of what is being drawn in it — the drill-downs are
 * a third the height of the main view — so the card announces its view and the
 * host that owns a frame acts on it.
 *
 * The drill-downs move once each, and by one rule: **the row arrives, and it
 * brings its chips.** 语速, 定时关闭 and the voice picker each put a block of
 * their own where the tiles were, and that block is the whole animation — it
 * rises into the place they left and its contents are simply there. An earlier
 * cut staggered the chips in one at a time; a picker of seven rates then read as
 * seven separate events rather than as one list, and a list is a thing, so it
 * arrives once. `useMotion`'s vocabulary decides how much of that survives
 * `prefers-reduced-motion`, which is why the numbers come from there rather than
 * from this file.
 */

/** Rates the speed view offers, in picker order. */
const SPEECH_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Sleep-timer choices. */
const SLEEP_MINUTES = [5, 15, 30, 60] as const;

/** Cross-fade shared by the card's view switches. Opacity only, and short: a
 *  view change is a change of *size* here — four views, four heights — and the
 *  card takes the new size in the frame the switch happens rather than
 *  animating its own box. Animating it would be a transform, and a transform
 *  on a box that is changing height is a scale: measured at 2.9× through the
 *  moment 语速 opens, which is long enough to watch the play button turn into
 *  an ellipse. The size is the host's to make — the app hugs its content, the
 *  floating bar's window is resized by the backend — so all that is left to
 *  animate is the ink, and the incoming rows' own rise (below) carries the
 *  rest. */
const VIEW_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.12 },
};

/** Leaving a drill-down. The entrance belongs to the row itself — it rises in
 *  whole — so this is the exit alone, and a quick one: by the time it runs the
 *  reader has already turned away, and the view taking its place is already on
 *  screen and should not have to share the row with it. */
const VIEW_OUT = { exit: { opacity: 0, transition: { duration: 0.08 } } };

/**
 * One choice in a drill-down.
 *
 * A plain button, not a motion one. The row it sits in brings the movement and
 * the chips ride it, so there is nothing here to animate — and a motion element
 * with nothing to animate is not free: the moment one animates a transform it
 * leaves `transform: none` inline, and an inline style beats the `press`
 * utility's `:active` scale. Every chip in the card is a finger target first.
 */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      // The picked one is a fill and the rest are not, which is a state only
      // the eye reads. Everywhere else in the app a chosen chip says so.
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "press focus-visible:focus-ring shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium",
        active ? "bg-accent text-on-accent" : "text-text-2 hover:text-text-1 bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

/** One of the three tiles at the foot of the card. Each is its own card rather
 *  than a column under one rule: the row used to read as a single flat strip
 *  with three labels, and the tap targets were impossible to see. */
function SettingsRow({
  icon,
  label,
  caption,
  onClick,
}: {
  icon: ReactNode;
  label: ReactNode;
  caption: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press bg-surface-2 hover:bg-surface-3 focus-visible:focus-ring flex flex-1 flex-col items-center gap-1 rounded-md px-1 py-2"
    >
      <span className="text-text-2">{icon}</span>
      <span className="text-text-1 max-w-full truncate text-[12px] font-medium">{label}</span>
      <span className="text-text-3 text-[11px]">{caption}</span>
    </button>
  );
}

/** Label for the sleep row: what the timer will do, in three words or less. */
const sleepLabel = (sleep: SleepTimer): ReactNode => {
  if (!sleep) return "关闭";
  if (sleep.kind === "chapter") return "本章结束";
  return <Countdown endsAt={sleep.endsAt} />;
};

/**
 * The little ♀ / ♂ beside a voice.
 *
 * A reader picking a voice for a novel is asking for a voice, and "Yunxi" says
 * nothing about which one it is. The mark is a hint and not a fact, so a voice
 * the service did not tag gets the empty slot — the names stay in one column,
 * and nothing is guessed.
 */
function GenderMark({ gender }: { gender: VoiceGender | null }) {
  if (gender === null) return <span aria-hidden className="size-3 shrink-0" />;
  const Icon = gender === "female" ? GenderFemale : GenderMale;
  return (
    <span className={cn("shrink-0", gender === "female" ? "text-voice-female" : "text-voice-male")}>
      <Icon size={13} weight="bold" aria-hidden />
      <span className="sr-only">{gender === "female" ? "女声" : "男声"}</span>
    </span>
  );
}

export interface SpeechCardProps {
  title: string;
  chapter: string;
  coverUrl: string | null;
  /** The queue the voice is walking, one row each. */
  units: readonly SpeechUnit[];
  /** Which of them the voice is on. */
  index: number | null;
  status: SpeechStatus;
  loading: boolean;
  error: string | null;
  /** The two clocks, already formatted — the same strings the capsule draws. */
  elapsed: string;
  remaining: string;
  /** 0–100, for the scrubber's own fill. */
  percent: number;
  /** Characters spoken and in total: the scrubber's value and its range. */
  spoken: number;
  total: number;
  rate: number;
  /** The voice in use, as the id `useReaderSettings` stores. Resolved here
   *  against the catalogue rather than passed resolved, so both hosts agree on
   *  which row is the current one. */
  voice: string | null;
  voices: readonly Voice[];
  bookLanguage: string | null;
  /** The service the online voices come from is unreachable. */
  edgeError: string | null;
  sleep: SleepTimer;
  /** 设置 → 朗读 → 播放器样式. 简约 drops the sentence list and the three tiles
   *  and keeps the transport, for a reader who set the voice once. */
  minimal: boolean;
  /** Whether the card's header is the floating window's drag handle. Only that
   *  window has one to move; over the page the card does not move at all. */
  dragHandle?: boolean;
  /** Reported whenever the panel on screen changes, for the host that has to
   *  resize a window around it. The floating bar is the only one: each view is a
   *  different height, and a webview cannot see its own frame.
   *
   *  A notification rather than a prop to be controlled by — the view is the
   *  card's own business, and the app's host, which has no window to resize,
   *  leaves this out entirely. */
  onView?: (view: SpeechView) => void;
  /** Which view to open on, read once — the card is mounted fresh each time it
   *  opens. The reader's 倍速 button is a shortcut past the tiles; 简约 has no
   *  tiles to skip and stays on the transport either way. */
  initialView?: SpeechView;
  onClose: () => void;
  onToggle: () => void;
  /** One utterance. */
  onStep: (dir: 1 | -1) => void;
  /** One paragraph. */
  onSkip: (dir: 1 | -1) => void;
  /** Jumps the voice to an utterance. */
  onSeek: (index: number) => void;
  onRate: (rate: number) => void;
  onVoice: (uri: string) => void;
  onSleep: (choice: SleepChoice) => void;
  /** Tries the online catalogue again. Only the app has the store that fetch
   *  fills, so the floating bar leaves it out and the failure is stated without
   *  the way out — the next successful load is published to it anyway. */
  onReloadVoices?: () => void;
  /** How the host sizes the panel: the app caps it, the bar's window is it. */
  className?: string;
}

export function SpeechCard({
  title,
  chapter,
  coverUrl,
  units,
  index,
  status,
  loading,
  error,
  elapsed,
  remaining,
  percent,
  spoken,
  total,
  rate,
  voice,
  voices,
  bookLanguage,
  edgeError,
  sleep,
  minimal,
  dragHandle = false,
  onView,
  initialView = "main",
  onClose,
  onToggle,
  onStep,
  onSkip,
  onSeek,
  onRate,
  onVoice,
  onSleep,
  onReloadVoices,
  className,
}: SpeechCardProps) {
  // `rise` collapses to 0 under reduced motion, which is the whole of what the
  // drill-downs do with it: their rows take the tiles' place instead of rising
  // into it.
  const { rise, reduce } = useMotion();

  const [view, setView] = useState<SpeechView>(initialView);
  // A minimal player has nothing behind the drill-downs, so the card is always
  // on the transport view. Derived rather than reset, which would take an
  // effect and a frame showing a view that no longer exists.
  const shown = minimal ? "main" : view;

  // What the host is told to make room for — and the same `shown` the panes
  // render from, so the window can never be sized for a view the card is not
  // drawing. Announced rather than derived by the host because only the card
  // knows when 简约 has swallowed a view it was already on.
  useEffect(() => {
    onView?.(shown);
  }, [shown, onView]);

  const active = defaultVoice(voices, voice);
  // A book in a known language leads the picker with that language's voices;
  // `null` from `bookLangVoices` (no tag, or nothing in the catalogue) means
  // the full list — an empty picker helps no one.
  const bookVoices = bookLangVoices(voices, bookLanguage);
  const [allLangs, setAllLangs] = useState(false);
  const groups = voiceGroups(bookVoices !== null && !allLangs ? bookVoices : voices);
  const missingDefault = defaultVoiceMissing(voices);

  // The scrollable sentence list: the active sentence glides to the middle of
  // the stack, and any sentence clicked becomes the one being read. Reduced
  // motion jumps instead of gliding.
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    const row = index === null ? undefined : rowRefs.current.get(index);
    const list = listRef.current;
    if (!row || !list) return;
    const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }, [index, reduce]);

  // The sleep timer's custom minutes, kept as text while it is being typed —
  // prefilled from a non-preset timer already running, blank otherwise.
  const [customMinutes, setCustomMinutes] = useState(() =>
    sleep?.kind === "minutes" && !SLEEP_MINUTES.some((preset) => preset === sleep.minutes)
      ? String(sleep.minutes)
      : "",
  );
  const isCustomSleep =
    sleep?.kind === "minutes" && !SLEEP_MINUTES.some((preset) => preset === sleep.minutes);
  const applyCustomSleep = () => {
    const minutes = Math.round(Number(customMinutes));
    if (!Number.isFinite(minutes) || minutes < 1) return;
    onSleep(Math.min(minutes, 720));
  };

  return (
    <motion.div
      data-tts-card
      className={cn(
        "glass-liquid pointer-events-auto relative flex flex-col overflow-hidden rounded-lg p-4",
        // In the floating window this card sits on the desktop, and 84% lets a
        // browser window behind it show straight through the sentence list.
        // 100% is the fill `surface-3` already has — the same density
        // `glass-solid` gave this card before the window became transparent —
        // and it keeps the highlight, rim and inset edges that make it glass
        // rather than a flat panel. The in-app card keeps the lighter fill;
        // there it floats over the page it is reading, which is the point.
        dragHandle && "[--liquid-density:100%]",
        className,
      )}
      // The whole card is the handle where the window has no frame. It used to
      // be the header alone, which left the sentence list — most of the
      // surface — impossible to drag the window by. `dragWindow` already skips
      // anything interactive under the pointer, and waits for 4px of travel
      // before taking the window, so clicks still land.
      onPointerDown={dragHandle ? dragWindow : undefined}
    >
      {/* The header doubles as the window's handle where there is one: nothing
          in it is a control but the two buttons at its ends, and the title that
          fills the middle is exactly what a reader would reach for. */}
      <header className="flex items-start gap-3">
        {/* The leading slot changes identity with the view — a book's cover, or
            the way back — and it changes it *outright*. A cross-fade was the
            wrong tool here and `IconSwap` made it worse than a cross-fade: its
            `mode="wait"` holds the outgoing glyph for its whole exit before the
            incoming one is even mounted, so the header ran a beat behind the
            panel. Measured: the cover was still on screen 180ms after 语速
            opened, and on the way back the arrow lingered 200ms in a card that
            had already grown. The glyph a reader is reaching for must not
            arrive late; the pane underneath cross-fades, the header states
            where you are. (`IconSwap` is still the right tool for play/pause,
            where the two glyphs are the same control in two states.) */}
        <div className="grid size-11 shrink-0 place-items-center">
          {shown === "main" ? (
            <Cover url={coverUrl} className="shadow-panel size-11 rounded-md" />
          ) : (
            <button
              type="button"
              aria-label="返回"
              onClick={() => setView("main")}
              className="text-text-2 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-11 place-items-center rounded-sm transition-colors"
            >
              <CaretLeft size={16} weight="bold" />
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-text-1 truncate text-[13.5px] font-medium">{title}</p>
          <p className="text-text-3 mt-0.5 truncate text-[11px]">
            {chapter !== "" ? chapter : "朗读"}
          </p>
        </div>
        <button
          type="button"
          aria-label="收起播放器"
          onClick={onClose}
          className="text-text-3 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-7 shrink-0 place-items-center rounded-full transition-colors"
        >
          <X size={14} weight="bold" />
        </button>
      </header>

      {/* The sentence stack, readest-style: one row per unit, the voice's row
          kept mid-list by the scroll effect above, any row clicked becoming the
          one read. The highlight is a shared-layout element, so it glides from
          row to row as the voice moves.

          The area clips, on purpose. `popLayout` pins the outgoing pane at the
          box it had, and by then the card has stepped into a shorter one: left
          unclipped, the sentence list a reader was on lands on top of the
          transport. Clipped, a view change reads as the panel closing on the
          view being left while the next one is already arriving.

          No height animation on any of this — see the note on `VIEW_FADE`.

          And it only *grows* while it has something to grow for — the sentence
          stack and the voice picker, which are both scrolls. 语速 and 定时关闭
          are rows that hug the transport, and a `flex-1` pane holding nothing
          but them would be half the panel in the floating bar, where the card
          is a fixed height. The picker used to live *below* the transport for
          that reason, which cost more than it saved: the transport is the one
          control that must not move, and opening the list sent it a panel's
          height up the card. It belongs in the pane with the sentences. */}
      <div
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden",
          (shown === "main" || shown === "voice") && "flex-1",
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {shown === "main" && (
            <motion.div key="main" className="flex min-h-0 flex-1 flex-col" {...VIEW_FADE}>
              {error !== null && (
                <p className="text-text-2 mt-3 text-[12px] leading-relaxed">{error}</p>
              )}
              {/* The sentence stack is what makes the card worth the space; a
                reader who asked for the minimal player gets the clock and the
                scrubber and nothing else. */}
              {!minimal && (
                <div
                  ref={listRef}
                  className="scroll-fade relative mt-3 min-h-0 flex-1 overflow-y-auto"
                  aria-live="polite"
                >
                  {units.length === 0 ? (
                    <p className="text-text-3 px-2 py-1.5 text-[13px] leading-relaxed">
                      选一段开始朗读
                    </p>
                  ) : (
                    units.map((unit, i) => {
                      const isActive = i === index;
                      return (
                        <button
                          key={`${unit.source}:${unit.start}`}
                          type="button"
                          ref={(el) => {
                            if (el === null) rowRefs.current.delete(i);
                            else rowRefs.current.set(i, el);
                          }}
                          onClick={() => onSeek(i)}
                          aria-current={isActive || undefined}
                          className={cn(
                            // The gap between the line being read and the rest is
                            // spacing and weight, never opacity: the dim tier is
                            // already at 5.3:1 on the darkest card, and a fade
                            // takes it under AA.
                            "relative flex w-full items-start gap-2 rounded-sm px-2 text-left leading-relaxed transition-colors",
                            isActive
                              ? "text-text-1 py-2 text-[13.5px] font-medium"
                              : "text-text-3 hover:bg-surface-2 hover:text-text-2 py-1 text-[13px]",
                          )}
                        >
                          {isActive && (
                            <motion.span
                              layoutId="tts-active-sentence"
                              aria-hidden
                              className="absolute inset-0 rounded-sm bg-(--accent-soft)"
                              transition={reduce ? { duration: 0 } : SPRING.layout}
                            />
                          )}
                          <span className="relative flex-1">{unit.text}</span>
                          {isActive && loading && <LoadingBars className="mt-1" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}

              <div className="text-text-3 mt-3 flex items-center gap-3 text-[11px] tabular-nums">
                <span>{elapsed}</span>
                <input
                  type="range"
                  className="range flex-1"
                  min={0}
                  max={Math.max(total, 1)}
                  value={spoken}
                  disabled={units.length < 2}
                  aria-label="朗读进度"
                  onChange={(event) => onSeek(unitAtChar(units, Number(event.target.value)))}
                  style={{ "--range-fill": `${percent}%` } as CSSProperties}
                />
                <span>-{remaining}</span>
              </div>
            </motion.div>
          )}

          {shown === "voice" && (
            // The picker is the one view that replaces a scroll of prose with a
            // scroll of choices, so it arrives as one block: the language switch
            // and the list are inside it, not after it. It lives in the pane the
            // sentence stack lives in, so the transport below never moves when
            // the list opens — and the list takes the pane's height, not its own
            // content's, which is what makes it scroll instead of overflow.
            <motion.div
              key="voice"
              className="mt-3 flex min-h-0 flex-1 flex-col"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.26, ease: EASE_OUT }}
            >
              {edgeError !== null ? (
                <p className="text-text-3 mb-2 text-[12px] leading-relaxed">
                  {edgeError}
                  {onReloadVoices !== undefined && (
                    <button
                      type="button"
                      onClick={onReloadVoices}
                      className="focus-visible:focus-ring text-accent ml-1 underline"
                    >
                      重试
                    </button>
                  )}
                </p>
              ) : (
                missingDefault && (
                  <p className="text-text-3 mb-2 text-[12px] leading-relaxed">
                    没有找到 {DEFAULT_VOICE_NAME}，朗读会用下面选中的语音；连上网络即可使用 Edge
                    在线语音里的 {DEFAULT_VOICE_NAME}。
                  </p>
                )
              )}
              {/* The book's language against the whole catalogue. Only
                rendered when the book carries a language the catalogue
                can speak — otherwise there is nothing to switch. */}
              {bookVoices !== null && (
                <div className="mb-2 flex gap-1.5">
                  <Chip active={!allLangs} onClick={() => setAllLangs(false)}>
                    {languageName(bookLanguage ?? "")}
                  </Chip>
                  <Chip active={allLangs} onClick={() => setAllLangs(true)}>
                    全部语言
                  </Chip>
                </div>
              )}
              {/* One scroll, two headings deep — the engine, then the language —
                and neither of them is a bar. The engine used to be a full-width
                strip with a second strip pinned under it, which put two grey
                bands on top of each other: the picker opened looking like a
                table with a header row, and on the dark card the lower band was
                almost the card's own colour, so it read as a stray stripe.

                What is left is the app's own group label (see the search
                results' book headings): the engine brighter and medium, the
                language a step quieter under it, rows a step brighter again.
                The language heading no longer sticks — a sticky row needs a
                background to hide what scrolls under it, and that background
                was the band. The tabs above say which catalogue is on screen,
                and the sections here are short. */}
              <div className="border-hairline min-h-0 flex-1 overflow-y-auto border-t py-1">
                {groups.map((group, groupAt) => (
                  <section
                    key={group.engine}
                    className={cn(groupAt > 0 && "border-hairline mt-2 border-t")}
                  >
                    <p className="text-text-3 px-2 pt-2 pb-1 text-[11px] font-medium">
                      {group.label}
                    </p>
                    {group.sections.map((section) => (
                      <div key={section.lang}>
                        <p className="text-text-2 px-2 pt-2 pb-0.5 text-[11.5px] font-medium">
                          {section.label}
                        </p>
                        {section.voices.map((row) => {
                          const picked = row.uri === active?.uri;
                          const zh = voiceZhName(row.name);
                          return (
                            <button
                              key={row.uri}
                              type="button"
                              onClick={() => onVoice(row.uri)}
                              aria-current={picked || undefined}
                              className="press focus-visible:focus-ring hover:bg-surface-2 flex w-full items-center gap-2 rounded-xs px-2 py-2 text-left"
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                <GenderMark gender={row.gender} />
                                {/* The Chinese name leads and the Latin one
                                    follows it: the service only ever ships
                                    "Xiaoxiao", which tells a reader nothing
                                    about who is speaking. */}
                                <span
                                  className={cn(
                                    "truncate text-[12px]",
                                    picked ? "text-accent font-medium" : "text-text-1",
                                  )}
                                >
                                  {zh ?? row.name}
                                </span>
                                {zh !== null && (
                                  <span className="text-text-3 shrink-0 truncate text-[11px]">
                                    {row.name}
                                  </span>
                                )}
                              </span>
                              {/* The service tags nearly every voice "General";
                                the label only earns its row when it actually
                                tells voices apart. */}
                              {row.categories !== "" && row.categories !== "General" && (
                                <span className="text-text-3 shrink-0 text-[11px]">
                                  {row.categories}
                                </span>
                              )}
                              {/* The check keeps its slot on every row. Drawing
                                it only on the picked one pushed that row's
                                category 21px out of the column the rest were
                                on, which read as a broken list rather than as a
                                selection. */}
                              <span className="text-accent grid size-3.5 shrink-0 place-items-center">
                                {picked && <Check size={12} weight="bold" />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Transport sits outside the view switch: tuning the rate or picking a
          voice is something you do *while listening*, and the old drill-down
          took play/pause away with the text. */}
      <div className="mt-2.5 flex items-center justify-center gap-2.5">
        {!minimal && (
          <>
            <Transport label="上一段" onClick={() => onSkip(-1)}>
              <CaretDoubleLeft size={15} weight="bold" />
            </Transport>
            <Transport label="上一句" onClick={() => onStep(-1)}>
              <SkipBack size={15} weight="fill" />
            </Transport>
          </>
        )}
        <button
          type="button"
          aria-label={status === "playing" ? "暂停" : "播放"}
          onClick={onToggle}
          className="bg-accent text-on-accent focus-visible:focus-ring mx-1 grid size-12 place-items-center rounded-full transition-opacity hover:opacity-90"
        >
          <IconSwap state={status}>
            {status === "playing" ? (
              <Pause size={19} weight="fill" />
            ) : (
              <Play size={19} weight="fill" />
            )}
          </IconSwap>
        </button>
        {!minimal && (
          <>
            <Transport label="下一句" onClick={() => onStep(1)}>
              <SkipForward size={15} weight="fill" />
            </Transport>
            <Transport label="下一段" onClick={() => onSkip(1)}>
              <CaretDoubleRight size={15} weight="bold" />
            </Transport>
          </>
        )}
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {!minimal && shown === "main" && (
          <motion.div key="main" className="mt-3 flex gap-1.5" {...VIEW_FADE}>
            <SettingsRow
              icon={<Gauge size={16} />}
              label={`${rate}×`}
              caption="语速"
              onClick={() => setView("speed")}
            />
            <SettingsRow
              icon={<SpeakerHigh size={16} />}
              label={active?.name ?? "默认"}
              caption={active?.engine === "edge" ? "在线语音" : "语音"}
              onClick={() => setView("voice")}
            />
            <SettingsRow
              icon={<Timer size={16} />}
              label={sleepLabel(sleep)}
              caption="定时关闭"
              onClick={() => setView("timer")}
            />
          </motion.div>
        )}
        {shown === "speed" && (
          // The row rises into the place the tiles left, and the ladder of
          // rates comes with it: one movement, which is what a list of choices
          // is.
          <motion.div
            key="speed"
            {...VIEW_OUT}
            className="mt-3 flex flex-wrap gap-1.5"
            initial={{ y: rise }}
            animate={{ y: 0 }}
            transition={SPRING.enter}
          >
            {SPEECH_RATES.map((value) => (
              <Chip key={value} active={value === rate} onClick={() => onRate(value)}>
                {value}×
              </Chip>
            ))}
          </motion.div>
        )}
        {shown === "timer" && (
          // Both groups and the sentence under them arrive with the pane: a
          // timer is one decision, so the panel makes one movement.
          <motion.div
            key="timer"
            {...VIEW_OUT}
            className="mt-3 space-y-3"
            initial={{ y: rise }}
            animate={{ y: 0 }}
            transition={SPRING.enter}
          >
            <div>
              <p className="text-text-3 px-1 pb-1.5 text-[11px] font-medium">常用</p>
              <div className="flex flex-wrap gap-1.5">
                <Chip active={sleep === null} onClick={() => onSleep("off")}>
                  关闭
                </Chip>
                {SLEEP_MINUTES.map((minutes) => (
                  <Chip
                    key={minutes}
                    active={sleep?.kind === "minutes" && sleep.minutes === minutes}
                    onClick={() => onSleep(minutes)}
                  >
                    {minutes} 分钟
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <p className="text-text-3 px-1 pb-1.5 text-[11px] font-medium">其他</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip active={sleep?.kind === "chapter"} onClick={() => onSleep("chapter")}>
                  本章结束
                </Chip>
                {/* Custom minutes: type a number, Enter or 开始 arms it. A form,
                    so the keyboard comes for free. The armed state is a ring,
                    not the accent fill — the input has to stay readable on
                    whatever it sits on. */}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    applyCustomSleep();
                  }}
                  className={cn(
                    "bg-surface-2 focus-within:ring-accent flex shrink-0 items-center gap-1 rounded-full py-1 pr-1 pl-3.5 focus-within:ring-1",
                    isCustomSleep && "ring-accent ring-1",
                  )}
                >
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={720}
                    value={customMinutes}
                    onChange={(event) => setCustomMinutes(event.target.value)}
                    placeholder="自定义"
                    aria-label="自定义定时分钟数"
                    className="text-text-1 placeholder:text-text-3 w-11 [appearance:textfield] bg-transparent text-center text-[12px] outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span className="text-text-3 text-[12px]">分钟</span>
                  <button
                    type="submit"
                    className="press bg-accent text-on-accent focus-visible:focus-ring rounded-full px-2.5 py-1 text-[12px] font-medium"
                  >
                    开始
                  </button>
                </form>
              </div>
            </div>
            <p className="text-text-3 text-[12px] leading-relaxed">
              {sleep === null ? (
                "到点自动停止朗读，适合睡前听。"
              ) : sleep.kind === "chapter" ? (
                "读完当前章节后停止。"
              ) : (
                <>
                  还剩 <Countdown endsAt={sleep.endsAt} /> 停止朗读。
                </>
              )}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
