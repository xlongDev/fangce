import { useCallback } from "react";

import { aiSpeechUnits } from "@/features/reader/aiSpeech";
import type { Tts } from "@/features/reader/tts";
import { useSpeechSession } from "@/stores/speech";

/** Where an answer's session says it came from, drawn in the player. */
export interface AiSpeechLabel {
  title: string;
  chapter?: string;
}

/**
 * Read one AI answer aloud, through the shell's one engine.
 *
 * The button owns no audio of its own: `id` is the identity of the answer,
 * stored in the session so that only its own control turns into a stop button
 * while the voice is on it. Every other answer can start a new one, which
 * simply replaces the queue — the engine is a single voice, and a second one
 * cannot be mixed into it.
 *
 * The engine is passed in rather than looked up so a surface without a
 * `TtsHost` can decline to draw the control at all (see `AiSpeechButton`).
 */
export function useAiSpeech(id: string, tts: Tts) {
  const active = useSpeechSession((state) => state.activeId === id);
  const startAi = useSpeechSession((state) => state.startAi);
  const endAi = useSpeechSession((state) => state.endAi);

  const playing = active && (tts.status !== "idle" || tts.error !== null);

  const toggle = useCallback(
    (text: string, label: AiSpeechLabel) => {
      if (playing) {
        tts.stop();
        endAi();
        return;
      }
      const units = aiSpeechUnits(text);
      if (units.length === 0) return;
      startAi({ id, title: label.title, chapter: label.chapter ?? "", units });
      // `play` replaces whatever the engine was saying, book or answer. No
      // `onFinish`: the shell's idle-voice effect ends the session instead, so
      // every way of stopping (player, tray, chapter change) is covered by one
      // rule rather than by a callback that only some paths call.
      tts.play(
        units.map((unit) => unit.text),
        0,
      );
    },
    [playing, tts, endAi, startAi, id],
  );

  return { playing, error: active ? tts.error : null, toggle };
}
