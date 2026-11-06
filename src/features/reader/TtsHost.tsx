import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { SleepTimerControls } from "@/hooks/useSleepTimer";
import { useSleepTimer } from "@/hooks/useSleepTimer";
import { useReaderSettings } from "@/stores/reader";

import { useTts, type Tts } from "./tts";

/**
 * The read-aloud engine, hosted by the shell rather than by the reader.
 *
 * `useTts` used to be called from `ReaderPage`, which meant the voice was tied
 * to that page's lifetime: leaving the reader cancelled it mid-sentence. Here it
 * is mounted once, above the routes, so a session outlives the page it started
 * on — that is the whole of "background playback".
 *
 * The sleep timer comes along for the same reason: it stops the voice, so it
 * belongs with whatever holds the voice. The reader still asks it whether a
 * chapter-scoped timer has fired (that is navigation's question), and the player
 * still draws its countdown.
 *
 * `children` is handed straight through, so the hook's own re-renders — one per
 * sentence while the voice moves — reach the two consumers below and nothing
 * else in the tree.
 */
interface TtsHostValue {
  tts: Tts;
  sleep: SleepTimerControls;
}

const TtsHostContext = createContext<TtsHostValue | null>(null);

export function TtsHost({ children }: { children: ReactNode }) {
  // The word-level wash is the only thing that re-renders per word, and it is a
  // reading preference, not a reader's: the engine watches from up here.
  const word = useReaderSettings((state) => state.speechGranularity === "word");
  const tts = useTts({ trackBoundary: word });
  const stop = tts.stop;
  const sleep = useSleepTimer(stop);
  // Both halves are already identity-stable — `useTts` memoises on its own state
  // and the timer's callbacks never change — so this only keeps a re-render of
  // the shell (a route, the chrome) from handing every consumer a new value.
  const value = useMemo<TtsHostValue>(() => ({ tts, sleep }), [tts, sleep]);
  return <TtsHostContext.Provider value={value}>{children}</TtsHostContext.Provider>;
}

/**
 * The same host, without the requirement that there is one.
 *
 * A read-aloud control drawn outside the shell — a panel rendered alone in a
 * unit test, say — has no engine to talk to and must not pretend otherwise. It
 * renders nothing rather than throwing; `useTtsHost` stays strict for the
 * surfaces that cannot work without a voice.
 */
export function useTtsHostOptional(): TtsHostValue | null {
  return useContext(TtsHostContext);
}

/** The engine every read-aloud surface talks to. */
export function useTtsHost(): TtsHostValue {
  const value = useTtsHostOptional();
  if (value === null) throw new Error("useTtsHost 必须在 TtsHost 内使用");
  return value;
}
