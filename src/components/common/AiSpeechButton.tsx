import { useEffect, useMemo, useRef } from "react";
import { SpeakerHigh, Stop } from "@phosphor-icons/react";

import { aiSpeechUnits } from "@/features/reader/aiSpeech";
import type { Tts } from "@/features/reader/tts";
import { useTtsHostOptional } from "@/features/reader/TtsHost";
import { useAiSpeech } from "@/hooks/useAiSpeech";
import { cn } from "@/lib/cn";
import { useReaderSettings } from "@/stores/reader";

interface AiSpeechButtonProps {
  /** Stable identity of this answer, so only its own control becomes "stop". */
  id: string;
  /** The answer as written, Markdown included. */
  text: string;
  /** What the player calls the session. */
  title: string;
  chapter?: string;
  /** True while the answer is still streaming — the queue is not final yet. */
  disabled?: boolean;
  /**
   * The stream's own state, for 「生成完自动朗读」. Callers with several
   * answers on screen pass it only for the one that was just generated; a
   * history of ten turns must not start ten voices on one `done` event.
   */
  streaming?: boolean;
  label?: string;
  className?: string;
}

/**
 * The one read-aloud control every AI answer shares.
 *
 * It is deliberately a bare icon in a row, not a glass button: the assistant
 * drawer is 272px wide and a 38px pill beside every answer would compete with
 * the answer. The glyph follows the same pair the reader's footer uses
 * (`SpeakerHigh` / `Pause`), with a stop square because pressing this one ends
 * the session rather than holding it.
 *
 * Without a `TtsHost` there is no engine to speak through, so nothing is
 * drawn. Panels are rendered alone in unit tests, and a control that cannot
 * work is worse than one that is absent. The whole feature also disappears
 * when the reader turns AI read-aloud off.
 */
export function AiSpeechButton(props: AiSpeechButtonProps) {
  const host = useTtsHostOptional();
  const enabled = useReaderSettings((state) => state.aiSpeechEnabled);
  if (!enabled || host === null) return null;
  return <AiSpeechControl {...props} tts={host.tts} />;
}

function AiSpeechControl({
  id,
  text,
  title,
  chapter,
  disabled = false,
  streaming = false,
  label = "朗读这段回答",
  className,
  tts,
}: AiSpeechButtonProps & { tts: Tts }) {
  const { playing, error, toggle } = useAiSpeech(id, tts);
  const autoPlay = useReaderSettings((state) => state.aiSpeechAutoPlay);
  // Only worth parsing when it could be pressed: while a delta stream is
  // arriving this would otherwise re-cut the whole answer on every frame.
  const speakable = useMemo(() => !disabled && aiSpeechUnits(text).length > 0, [disabled, text]);

  /**
   * 「生成完自动朗读」 is a falling edge, not a state. An answer that was
   * already cached arrives with `streaming` false from the first frame and
   * must stay silent; only an answer that was actually being written gets a
   * voice when the model stops.
   *
   * The ref is updated before anything else so a re-render caused by `toggle`
   * (which changes identity per render) cannot fire the same edge twice.
   */
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    const finished = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (!finished || !autoPlay || playing) return;
    toggle(text, { title, chapter });
  }, [streaming, autoPlay, playing, text, title, chapter, toggle]);

  return (
    <button
      type="button"
      aria-label={playing ? "停止朗读" : label}
      aria-pressed={playing}
      title={error ?? undefined}
      disabled={!speakable && !playing}
      onClick={() => toggle(text, { title, chapter })}
      className={cn(
        "focus-visible:focus-ring text-text-3 hover:text-text-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40",
        playing && "text-accent hover:text-accent",
        error && "text-danger",
        className,
      )}
    >
      {playing ? <Stop size={14} weight="fill" /> : <SpeakerHigh size={14} />}
    </button>
  );
}
