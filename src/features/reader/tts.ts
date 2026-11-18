import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { createEdgeEngine, useEdgeVoices, type EdgeEngine } from "./edge";
import type { SpeechBoundary, SpeechStatus } from "./speech";
import { engineOf, resolveVoice, systemVoices, type Voice } from "./voice";

// The two engine-facing types are part of this hook's contract, but they are
// defined with the speech model so a second engine can name its own output
// without importing the hook.
export type { SpeechBoundary, SpeechStatus };

type Options = {
  /** Whether the word-level wash is watching. Both engines report the voice's
   *  position from the first word either way — that is what a settings change
   *  restarts the utterance from — but only a watcher is worth re-rendering the
   *  reader per word, so this gates what is published as state, and with it the
   *  fallback that hands a whole utterance over when a voice reports no
   *  position at all. */
  trackBoundary?: boolean;
};

/** A watcher that needs the voice's position without a per-word render. */
type BoundaryListener = (spot: SpeechBoundary | null) => void;

/** How long a fresh utterance may stay silent about its position before the
 *  engine gives up on it reporting one. A voice that reports boundaries does
 *  so within a frame or two of speaking, so anything still quiet when this
 *  fires reports none at all — Chinese system voices are the usual case. */
const BLIND_BOUNDARY_MS = 500;

/** `speechSynthesis` republishes its list asynchronously, and hands back a fresh
 *  array on every call — so the snapshot is cached and only replaced when the
 *  list's length changes. */
const subscribeVoices = (onChange: () => void) => {
  const synth = window.speechSynthesis;
  if (!synth) return () => {};
  synth.addEventListener("voiceschanged", onChange);
  return () => synth.removeEventListener("voiceschanged", onChange);
};

let voiceSnapshot: SpeechSynthesisVoice[] = [];
let voiceCount = 0;

const snapshotVoices = () => {
  const list = window.speechSynthesis?.getVoices() ?? [];
  if (list.length !== voiceCount) {
    voiceCount = list.length;
    voiceSnapshot = list;
  }
  return voiceSnapshot;
};

/** Every voice the platform itself offers, re-read whenever it republishes. */
export function useSystemVoices(): Voice[] {
  const system = useSyncExternalStore(subscribeVoices, snapshotVoices);
  return useMemo(() => systemVoices(system), [system]);
}

/**
 * Every voice available for read-aloud, across both engines.
 *
 * The service's list comes first: `defaultVoice` takes the first match for the
 * reader's default, and that default is Yunjian, which only the service has.
 * When the service cannot be reached its voices simply are absent and the
 * default degrades to the platform's own — which is the correct behaviour, and
 * the reason the two lists are merged here rather than chosen between.
 */
export function useSpeechVoices(): { voices: Voice[]; edgeError: string | null } {
  const system = useSystemVoices();
  const edge = useEdgeVoices();
  const voices = useMemo(() => [...edge.voices, ...system], [edge.voices, system]);
  return { voices, edgeError: edge.error };
}

/**
 * Read-aloud over two engines.
 *
 * The platform's `speechSynthesis` owns its own queue, so one utterance per
 * unit keeps the visible progress in step with the voice, and `cancel()` tears
 * the whole thing down in one call. Its quirks are handled here: a generation
 * counter guards against a platform that still fires `onend` for a cancelled
 * utterance — a late event from an abandoned queue must not restart the reader.
 *
 * The Edge engine is a different shape entirely (one request per utterance,
 * scheduled ahead in `edge.ts`), but the reader must not be able to tell: both
 * are driven through the same four calls, and the stored voice's prefix is the
 * only thing that says which one answers.
 */
export function useTts({ trackBoundary = false }: Options = {}) {
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [unit, setUnit] = useState<number | null>(null);
  const [boundary, setBoundary] = useState<SpeechBoundary | null>(null);
  /** Set when the service could not be reached; the player says so rather than
   *  going quiet for no visible reason. */
  const [error, setError] = useState<string | null>(null);
  /** True while the Edge engine is waiting on a clip it does not have cached —
   *  the gap between asking to speak and hearing anything. The platform engine
   *  starts instantly, so it never raises this. */
  const [loading, setLoading] = useState(false);

  // Speaks only while `generation` matches: every play/stop bumps it.
  const generation = useRef(0);
  /** True once a voice has failed to report a boundary in time, i.e. it does
   *  not report them at all. Later utterances then hand the whole text over
   *  straight away rather than leaving the wash blank while a timer runs. */
  const blind = useRef(false);
  /** Where the voice last said it was. Kept whether or not the word-level wash
   *  is listening: the reader can ask for words mid-sentence, and a rate or a
   *  voice change restarts the utterance from where the voice has got to. */
  const lastBoundary = useRef<SpeechBoundary | null>(null);
  /** The page follower listens here: it needs every word, but a React state
   *  update per word would re-render the whole reader. */
  const boundaryListeners = useRef(new Set<BoundaryListener>());
  const rate = useRef(1);
  // A URI, not the platform object: `getVoices()` fills asynchronously and can
  // change under us, so the voice is resolved at speak time.
  const voiceUri = useRef<string | null>(null);
  // Read from inside `speak`, which is created once per session.
  const trackBoundaryRef = useRef(trackBoundary);
  // What the Edge engine calls when its queue runs out. Kept in a ref because
  // the engine is built once and the reader passes a fresh callback per play.
  const finishRef = useRef<(() => void) | undefined>(undefined);
  const edgeRef = useRef<EdgeEngine | null>(null);

  useEffect(() => {
    // Only flips the switch: both engines report the voice's position from the
    // first word regardless (the Edge engine tracks its clip continuously, a
    // system voice reports every word), so asking for the word-level wash
    // mid-utterance is answered by the next report — a frame away on the
    // service, one word away from the platform.
    trackBoundaryRef.current = trackBoundary;
  }, [trackBoundary]);

  /** The one announcement point for both engines. `lastBoundary` serves a
   *  settings change even when nobody is washing words; listeners serve the
   *  page follower; React state only moves when a wash is watching. */
  const publishBoundary = useCallback((spot: SpeechBoundary | null) => {
    lastBoundary.current = spot;
    for (const listener of boundaryListeners.current) listener(spot);
    if (trackBoundaryRef.current) setBoundary(spot);
  }, []);

  const onBoundary = useCallback((listener: BoundaryListener) => {
    boundaryListeners.current.add(listener);
    return () => {
      boundaryListeners.current.delete(listener);
    };
  }, []);

  // The Edge engine is built once. Reaching the announcer through a ref keeps
  // that callback identity stable — both hook lint rules agree on refs.
  const publishRef = useRef(publishBoundary);
  useEffect(() => {
    publishRef.current = publishBoundary;
  }, [publishBoundary]);

  useEffect(() => {
    // The *app* going away must not leave a voice behind. Deliberately not "the
    // reader going away": the session outlives that page now (see `TtsHost`),
    // and cancelling here would end it every time the reader browsed their
    // shelf. `speechSynthesis` is absent where the shell is mounted without a
    // browser speech API — jsdom — and the teardown has to survive it.
    return () => {
      window.speechSynthesis?.cancel();
      edgeRef.current?.stop();
    };
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    window.speechSynthesis.cancel();
    edgeRef.current?.stop();
    finishRef.current = undefined;
    // The failure text belongs to the session stop ends. The pill is drawn
    // while `status !== "idle" || error !== null`, so leaving it set made the
    // close button dead exactly when the engine had failed — the one state a
    // reader most needs it in.
    setError(null);
    setStatus("idle");
    setUnit(null);
    setLoading(false);
    publishBoundary(null);
  }, [publishBoundary]);

  /** The Edge engine, built on first use. Constructed inside a call rather than
   *  during render so the hook's own callbacks keep a stable identity — the
   *  reader hangs an effect off `play`, and a new one would re-apply its
   *  pending scroll. */
  const edgeEngine = useCallback((): EdgeEngine => {
    edgeRef.current ??= createEdgeEngine({
      status: setStatus,
      unit: setUnit,
      loading: setLoading,
      // Both engines announce through one place; see `publishBoundary`.
      boundary: (spot) => publishRef.current(spot),
      done: () => {
        const finish = finishRef.current;
        finishRef.current = undefined;
        finish?.();
      },
      fail: (message) => {
        finishRef.current = undefined;
        setError(message);
        setStatus("idle");
        setUnit(null);
        setLoading(false);
        publishRef.current(null);
      },
    });
    return edgeRef.current;
  }, []);

  /**
   * Reads `units` from `from`, then calls `onFinish` once the last one ends
   * (the reader uses it to roll into the next chapter). `trim` cuts characters
   * off the head of that first utterance, so 「朗读此处」 starts on the character
   * the reader selected rather than the top of its sentence.
   */
  const play = useCallback(
    (units: string[], from: number, onFinish?: () => void, trim = 0) => {
      const uri = voiceUri.current;
      if (engineOf(uri) === "edge" && uri !== null) {
        setError(null);
        finishRef.current = onFinish;
        edgeEngine().play(units, from, { trim, voice: uri, rate: rate.current });
        return;
      }

      generation.current += 1;
      const current = generation.current;
      window.speechSynthesis.cancel();
      blind.current = false;
      setStatus("playing");
      // The blind-voice fallback timer for the utterance being spoken. Cleared
      // as soon as the voice reports a position, or replaced by the next one.
      let fallback = 0;

      const speak = (index: number) => {
        if (generation.current !== current) return;
        window.clearTimeout(fallback);
        if (index >= units.length) {
          setStatus("idle");
          setUnit(null);
          publishBoundary(null);
          onFinish?.();
          return;
        }
        const raw = units[index];
        const text = index === from && trim > 0 ? raw?.slice(trim) : raw;
        setUnit(index);
        // A voice that has shown it never reports boundaries hands the whole
        // utterance over at once; the rest wait to be told where the voice is.
        publishBoundary(
          blind.current && text !== undefined
            ? { unit: index, charIndex: 0, charLength: text.length }
            : null,
        );
        if (text === undefined || text.trim() === "") {
          speak(index + 1);
          return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = rate.current;
        // `lang` rides along with the voice: without it an engine that ignores
        // `voice` still picks the right language for the text.
        const voice = resolveVoice(window.speechSynthesis.getVoices(), uri);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        // Attached whether or not words are being washed: `publishBoundary`
        // decides what to publish, and the position is kept either way, so a
        // reader who turns the word-level wash on mid-sentence is answered by
        // the next word rather than by the next sentence.
        utterance.addEventListener("boundary", (event) => {
          if (generation.current !== current) return;
          window.clearTimeout(fallback);
          blind.current = false;
          publishBoundary({
            unit: index,
            charIndex: event.charIndex,
            charLength: event.charLength ?? 0,
          });
        });
        utterance.addEventListener("end", () => {
          if (generation.current !== current) return;
          speak(index + 1);
        });
        utterance.addEventListener("error", () => {
          if (generation.current !== current) return;
          setStatus("idle");
          setUnit(null);
          publishBoundary(null);
        });
        window.speechSynthesis.speak(utterance);
        // What the wash does while nothing has been reported: rather than
        // painting the sentence and snapping down to a word a moment later
        // (a flash, not a highlight), wait out the first word. A voice that
        // reports none gets its whole utterance handed over here, which is
        // the fallback the sentence-level wash has always been.
        if (trackBoundaryRef.current) {
          fallback = window.setTimeout(() => {
            if (generation.current !== current) return;
            blind.current = true;
            publishBoundary({ unit: index, charIndex: 0, charLength: text.length });
          }, BLIND_BOUNDARY_MS);
        }
      };
      speak(from);
    },
    [edgeEngine, publishBoundary],
  );

  /** Applies a new rate; a session in progress is restarted from where the
   *  voice is, since the utterance being spoken was already synthesised. */
  const setRate = useCallback((value: number) => {
    rate.current = value;
    edgeRef.current?.setRate(value);
  }, []);

  /** Applies a new voice; a session in progress is restarted from where the
   *  voice is — the engine has already committed the one being spoken.
   *
   *  Crossing engines is the exception: neither can hand its queue to the
   *  other, so the session ends rather than carrying on in a voice the reader
   *  just replaced. */
  const setVoice = useCallback(
    (uri: string | null) => {
      const was = engineOf(voiceUri.current);
      voiceUri.current = uri;
      // A different voice reports boundaries on its own terms; whether the old
      // one was blind says nothing about it.
      blind.current = false;
      setError(null);
      if (engineOf(uri) !== was) {
        window.speechSynthesis.cancel();
        edgeRef.current?.stop();
        finishRef.current = undefined;
        setStatus("idle");
        setUnit(null);
        setLoading(false);
        publishBoundary(null);
        return;
      }
      edgeRef.current?.setVoice(uri);
    },
    [publishBoundary],
  );

  const pause = useCallback(() => {
    if (engineOf(voiceUri.current) === "edge") {
      edgeRef.current?.pause();
      return;
    }
    window.speechSynthesis.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    if (engineOf(voiceUri.current) === "edge") {
      edgeRef.current?.resume();
      return;
    }
    window.speechSynthesis.resume();
    setStatus("playing");
  }, []);

  /** The voice's position as last reported, read through a call rather than
   *  from the state above: the word-level wash is the only thing that needs a
   *  re-render per word, but a settings change restarts the utterance from
   *  here even while the reader is only washing sentences. */
  const boundaryAt = useCallback((): SpeechBoundary | null => lastBoundary.current, []);

  return useMemo(
    () => ({
      status,
      unit,
      boundary,
      error,
      loading,
      play,
      stop,
      pause,
      resume,
      setRate,
      setVoice,
      boundaryAt,
      onBoundary,
    }),
    // One object, not a fresh one per render. This hook is read through a
    // context in the shell (`TtsHost`), and a value that changes identity every
    // render would re-render every consumer — including the whole reader — for
    // reasons that have nothing to do with the voice. The dependencies are the
    // engine's own state and its (all stable) callbacks, so the identity moves
    // when, and only when, a consumer has something new to draw.
    [
      status,
      unit,
      boundary,
      error,
      loading,
      play,
      stop,
      pause,
      resume,
      setRate,
      setVoice,
      boundaryAt,
      onBoundary,
    ],
  );
}

/**
 * What one engine binding hands back. Named so the reader-level layer above it
 * (`useReadAloud`) can take the binding as an argument rather than owning it:
 * the reader itself needs `stop` before that layer can exist, because every
 * chapter change stops the voice.
 */
export type Tts = ReturnType<typeof useTts>;
