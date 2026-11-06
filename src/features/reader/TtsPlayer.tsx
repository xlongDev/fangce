import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PictureInPicture } from "@phosphor-icons/react";

import { useActiveReadingSurface } from "@/hooks/useReadingSurface";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useResolvedTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/cn";
import {
  ipc,
  onMiniBarAsk,
  onSpeechControl,
  publishMiniBarState,
  publishMiniBarVoices,
  type MiniBarState,
  type MiniBarVoices,
} from "@/lib/ipc";
import { SPRING } from "@/lib/motion";
import { useChrome } from "@/stores/chrome";
import { useReaderSettings } from "@/stores/reader";
import { useSpeechSession } from "@/stores/speech";

import { reloadEdgeVoices } from "./edge";
import { SpeechCard } from "./SpeechCard";
import {
  formatClock,
  paragraphIndex,
  queuePosition,
  speechSeconds,
  stepIndex,
  type SpeechTransport,
} from "./speech";
import { readerGlassVars } from "./theme";
import { useTtsHost } from "./TtsHost";
import { barClock, LoadingBars, minimizeWindow, Pill, Transport } from "./ttsParts";
import { useSpeechVoices } from "./tts";
import { defaultVoice } from "./voice";

/**
 * Read-aloud, drawn by the shell rather than by the reader.
 *
 * Two surfaces over one session: the pill, which is up whenever the voice is,
 * and the card behind it — `SpeechCard`, the same panel the floating bar opens
 * — with the sentence list, the scrubber and the three settings. Both take no
 * modal — the page stays readable under them, which is the point of listening
 * to a book you are also looking at.
 *
 * Neither belongs to `ReaderPage` any more. The engine outlives that page (see
 * `TtsHost`), so a reader who walks off to their shelf keeps listening; what the
 * reader lends while it *is* on screen is the transport, and it gets it back the
 * moment the page mounts again. Everything else — what is being read, how far
 * in, the settings — is either published to `useSpeechSession` or reached
 * through the engine.
 *
 * This file is now the *wiring*: it owns the two events the bar speaks, the
 * session, the engine and the settings, and hands the card the plain facts it
 * draws. The card itself is shared with the bar, which has none of those.
 */
export function TtsPlayer({
  onReadingSurface,
  liftForFooter,
}: {
  /** A reader is on screen, so this chrome is floating on the reading surface —
   *  the page's own ink and paper, not the app's. */
  onReadingSurface: boolean;
  /** …and the reader's footer is on screen too, which is what takes the content
   *  pane's bottom edge away from us. */
  liftForFooter: boolean;
}) {
  const reduce = useReducedMotion();
  // The reader's footer, measured by the reader. `0` on every other route.
  const footerHeight = useChrome((state) => state.readerFooterHeight);
  const navigate = useNavigate();
  const { tts, sleep: sleepTimer } = useTtsHost();
  const { voices, edgeError } = useSpeechVoices();
  const session = useSpeechSession();
  const surface = useActiveReadingSurface();
  const minimal = useReaderSettings((state) => state.speechPlayerStyle === "minimal");
  const rate = useReaderSettings((state) => state.speechRate);
  const storedVoice = useReaderSettings((state) => state.speechVoiceURI);
  const updateSettings = useReaderSettings((state) => state.update);

  const { status, unit: index, error, loading } = tts;
  const { sleep, choose: onSleep } = sleepTimer;
  const units = session.units;
  const origin = useSpeechSession((state) => state.origin);
  const endAi = useSpeechSession((state) => state.endAi);

  /**
   * An answer's session ends with the voice, by whichever route it ended —
   * the queue ran out, the player's stop, a tray command, a chapter change,
   * or a synthesis failure. One rule here covers all of them; a callback
   * handed to `play` would only cover the first.
   *
   * `play` publishes `playing` synchronously, so the frame that starts an
   * answer cannot be mistaken for the idle frame that ends it.
   */
  useEffect(() => {
    if (origin === "ai" && status === "idle") endAi();
  }, [origin, status, endAi]);

  // The reading surface's glass tokens, and only while a reader is under us: on
  // the shelf there is no page, and the app's own tokens are the ones that
  // match. Applied to the whole layer so the card is the same material as the
  // pill it replaces.
  const surfaceVars = useMemo(
    () => (onReadingSurface ? readerGlassVars(surface) : undefined),
    [onReadingSurface, surface],
  );

  // `open` is the reader's, but only while there is something to draw behind it:
  // a session left behind on another route has no controls to lend, and an idle
  // card over the shelf is a card with nothing in it.
  const live = status !== "idle" || error !== null;
  const open = session.open && (live || session.controls !== null);

  // Esc closes the card. It is not modal, so nothing else claims the key while
  // it is open; the reader's own shortcuts are behind this listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") session.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, session]);

  /* The voice the picker marks as the current one: the saved pick, resolved
     against the live catalogue so a voice a macOS update removed degrades
     instead of going silent. The card resolves the row from this id itself, so
     the two hosts cannot disagree about which one it is. */
  const voiceUri = useMemo(
    () => storedVoice ?? defaultVoice(voices, null)?.uri ?? null,
    [storedVoice, voices],
  );

  const { spoken, total } = queuePosition(units, index);
  const elapsed = speechSeconds(spoken, rate);
  const remaining = speechSeconds(total - spoken, rate);
  const percent = total > 0 ? Math.round((spoken / total) * 100) : 0;

  /**
   * The floating bar, for a reader who puts the app away.
   *
   * Two halves, and they are two different questions. `watch` is whether the
   * bar should exist at all — a session is on *and* the setting allows it, and
   * both are answers only this window has. The payloads below are what it
   * should draw, pushed on every change, because the bar is a second webview
   * with no store of its own to read.
   *
   * The catalogue travels on its own event: it is a hundred-odd rows and it
   * changes about as often as the network does, while this payload is published
   * once per sentence.
   */
  const miniBarAllowed = useReaderSettings((state) => state.speechMiniPlayer);
  const theme = useResolvedTheme();
  useEffect(() => {
    // The bar's whole way back is 「回到阅读」 — a chapter position. An answer
    // has no chapter to return to (`bookId` is deliberately null), so a bar
    // offering that button would be offering a jump to nowhere.
    void ipc.miniBarWatch(miniBarAllowed && live && origin !== "ai");
  }, [miniBarAllowed, live, origin]);

  // Memoised on the values rather than rebuilt per render: the shell re-renders
  // for reasons of its own, and every one of them would otherwise push a fresh
  // payload at a window that has nothing new to draw.
  const barState = useMemo<MiniBarState>(
    () => ({
      live,
      playing: status === "playing",
      loading,
      title: session.title,
      chapter: session.chapter,
      coverUrl: session.coverUrl,
      elapsed: formatClock(elapsed),
      remaining: formatClock(remaining),
      percent,
      error,
      theme,
      // The queue as the card lists it, and the scale its scrubber works on.
      units,
      index,
      spoken,
      total,
      rate,
      voice: voiceUri,
      bookLanguage: session.bookLanguage,
      sleep,
      minimal,
    }),
    [
      live,
      status,
      loading,
      session.title,
      session.chapter,
      session.coverUrl,
      session.bookLanguage,
      elapsed,
      remaining,
      percent,
      error,
      theme,
      units,
      index,
      spoken,
      total,
      rate,
      voiceUri,
      sleep,
      minimal,
    ],
  );
  const catalogue = useMemo<MiniBarVoices>(() => ({ voices, edgeError }), [voices, edgeError]);

  useEffect(() => {
    void publishMiniBarState(barState);
  }, [barState]);
  useEffect(() => {
    void publishMiniBarVoices(catalogue);
  }, [catalogue]);

  // A bar that was just built has missed everything published so far — it is
  // created the moment it is needed, which is *after* the payload it would have
  // drawn — so it asks, and the freshest payloads answer. `useTauriEvent` reads
  // the handler through a ref, so an inline arrow does not resubscribe.
  useTauriEvent(onMiniBarAsk, () => {
    void publishMiniBarState(barState);
    void publishMiniBarVoices(catalogue);
  });

  /**
   * The transport the bar and the card drive.
   *
   * While a reader is on screen it is the reader's own: that layer knows the
   * page's geometry, the wash and what a finished chapter rolls into. With no
   * reader the engine is driven directly — the queue still plays to its end, but
   * there is nothing to roll into, so the voice simply stops there. A rate or a
   * voice changed on this path reaches the next utterance rather than restarting
   * the current one, which is the one thing only a page can do.
   */
  const detached = useMemo<SpeechTransport>(() => {
    const jump = (at: number) =>
      tts.play(
        units.map((unit) => unit.text),
        at,
      );
    return {
      toggle: () => (tts.status === "playing" ? tts.pause() : tts.resume()),
      step: (dir) => jump(stepIndex(units, tts.unit ?? 0, dir)),
      skip: (dir) => {
        const at = paragraphIndex(units, tts.unit ?? 0, dir);
        if (at >= 0) jump(at);
      },
      seek: jump,
      applySettings: (change) => {
        if (change.rate !== undefined) {
          updateSettings({ speechRate: change.rate });
          tts.setRate(change.rate);
        }
        if (change.voice !== undefined) {
          updateSettings({ speechVoiceURI: change.voice });
          tts.setVoice(change.voice);
        }
      },
      // With no reader there is no page to bring anything into view on. The
      // player answers「回到阅读」itself in that case, by navigating (see the
      // control handler below), so this is honestly nothing.
      reveal: () => {},
    };
  }, [tts, units, updateSettings]);
  const transport = session.controls ?? detached;

  /**
   * What the tray menu and the bar ask for, wired to the same transport the
   * pill drives.
   *
   * This is the one control surface that has to work with the window hidden on
   * the other side of the Dock, which is why it is here rather than in the
   * reader: the shell is mounted either way, and the transport already knows
   * how to drive the engine with no page behind it. The bar's card asks for
   * more than a menu entry can name — a sentence to jump to, a chip's value —
   * so those arrive as objects; both shapes are handled in one place because
   * both are the same question.
   */
  useTauriEvent(onSpeechControl, (control) => {
    if (typeof control !== "string") {
      switch (control.kind) {
        case "seek":
          transport.seek(control.index);
          break;
        case "skip":
          transport.skip(control.dir);
          break;
        case "rate":
          transport.applySettings({ rate: control.value });
          break;
        case "voice":
          transport.applySettings({ voice: control.uri });
          break;
        case "sleep":
          // The timer is not the transport's: it belongs to the engine's host,
          // which is where `useSleepTimer` was mounted and where the voice it
          // stops lives.
          onSleep(control.choice);
          break;
        default:
          break;
      }
      return;
    }
    switch (control) {
      case "toggle":
        transport.toggle();
        break;
      case "prev":
        transport.step(-1);
        break;
      case "next":
        transport.step(1);
        break;
      case "stop":
        tts.stop();
        break;
      case "focus":
        void ipc.miniBarReveal();
        // Where the reader is told to go is the reader's business, and only a
        // mounted one can move its own page: a prose scroller, a Kindle
        // section and a PDF page are three different answers. With none on
        // screen the way back is a navigation, and the chapter is what a
        // freshly opened reader can act on — the prose path then centres the
        // sentence the voice is on, once the chapter has rendered.
        if (session.bookId === null) break;
        if (session.controls !== null) session.controls.reveal();
        else navigate(`/reader?book=${session.bookId}&chapter=${session.chapterIdx}`);
        break;
      default:
        // A name this build does not know. The backend forwards whatever the
        // menu item is called, and the two spellings are not generated from
        // each other — so an unknown one is ignored, not guessed at.
        break;
    }
  });

  return (
    /* One layer over the content pane, holding both surfaces: the pill while
       the voice is on, the card while it is open. Anchored to the pane rather
       than to the window, so it follows the reader from route to route rather
       than dying with the page it was born on. While the reader's own footer is
       on screen the pane's bottom edge is spoken for, so the whole layer is
       lifted by exactly that footer's height and both surfaces keep the 20px of
       air they had when they lived inside the reading viewport. Fullscreen docks
       the footer past the bottom edge, so nothing lifts.
       ponytail: the height is the reader's to report (`readerFooterHeight`, fed
       by a `ResizeObserver` on the footer itself), not a number written down
       here. It used to be 58px, measured by hand, with a note admitting it would
       drift — and it did: a platform whose type metrics are taller than ours grew
       the footer to 78px and left the pill 8px above the reader's controls
       instead of 20. */
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-40",
        // `translate`, not `transform`: the individual property is what a
        // `translate-y` utility sets, so transitioning the shorthand would leave
        // the lift snapping instead of easing.
        "transition-[translate] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{
        ...surfaceVars,
        translate: liftForFooter && footerHeight > 0 ? `0 -${footerHeight}px` : undefined,
      }}
    >
      <AnimatePresence>
        {live && !open && (
          <motion.div
            key="tts-pill"
            className="absolute inset-x-0 bottom-5 flex justify-center px-4"
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0, y: 12 }}
            transition={SPRING.panel}
          >
            <Pill
              coverUrl={session.coverUrl}
              title={session.title}
              chapter={session.chapter}
              line={
                error ??
                (loading ? (
                  <LoadingBars />
                ) : (
                  <>{barClock(status === "paused", formatClock(elapsed), formatClock(remaining))}</>
                ))
              }
              percent={percent}
              status={status}
              onOpen={() => session.setOpen(true)}
              openLabel="展开朗读播放器"
              onPrev={() => transport.step(-1)}
              onToggle={transport.toggle}
              onNext={() => transport.step(1)}
              onStop={tts.stop}
              trailing={
                /* The window and the bar are two surfaces of one session, and
                   this is the seam between them. It is safe to hand the session
                   over because the bar is the transport that outlives the
                   window — which is the whole reason the bar exists — so the
                   button sends the app to the Dock rather than to silence. */
                <Transport label="最小化到悬浮条" onClick={minimizeWindow}>
                  <PictureInPicture size={14} weight="bold" />
                </Transport>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            key="tts-card"
            className="absolute inset-x-0 top-5 bottom-5 flex items-end justify-center px-4"
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0, y: 16 }}
            transition={SPRING.panel}
          >
            {/* Capped, not `max-h-full`: a card free to grow fills the reading
                viewport and the page behind it stops being worth looking at.
                Sentence stack and voice list both take what is left of the cap.
                The card hugs its content, so the four views are four heights —
                and it *takes* each height in the frame the view changes rather
                than animating between them, because motion's way of animating a
                box is a transform, and a transform on a box that is changing
                height stretches what is inside it. See `VIEW_FADE`. */}
            <SpeechCard
              className="max-h-[min(68vh,520px)] w-[min(92vw,420px)]"
              title={session.title}
              chapter={session.chapter}
              coverUrl={session.coverUrl}
              units={units}
              index={index}
              status={status}
              loading={loading}
              error={error}
              elapsed={formatClock(elapsed)}
              remaining={formatClock(remaining)}
              percent={percent}
              spoken={spoken}
              total={total}
              rate={rate}
              voice={voiceUri}
              voices={voices}
              bookLanguage={session.bookLanguage}
              edgeError={edgeError}
              sleep={sleep}
              minimal={minimal}
              // The card mounts fresh on every open, so this is read once — and
              // it is how the reader's 倍速 button skips the tiles.
              initialView={session.openAt}
              onClose={() => session.setOpen(false)}
              onToggle={transport.toggle}
              onStep={(dir) => transport.step(dir)}
              onSkip={(dir) => transport.skip(dir)}
              onSeek={(at) => transport.seek(at)}
              onRate={(value) => transport.applySettings({ rate: value })}
              onVoice={(uri) => transport.applySettings({ voice: uri })}
              onSleep={onSleep}
              onReloadVoices={reloadEdgeVoices}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
