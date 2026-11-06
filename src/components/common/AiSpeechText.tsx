import { useMemo, type CSSProperties, type ReactNode } from "react";

import {
  aiSpeechLayout,
  aiSpeechSpans,
  type AiSpeechRun,
  type AiSpeechSpan,
} from "@/features/reader/aiSpeech";
import { useTtsHostOptional } from "@/features/reader/TtsHost";
import { washCss } from "@/features/reader/ttsWash";
import { useActiveReadingSurface } from "@/hooks/useReadingSurface";
import { useReaderSettings } from "@/stores/reader";
import { useSpeechSession } from "@/stores/speech";

/** One run's text, split around the washed ranges. */
function washed(text: string, spans: AiSpeechSpan[] | undefined, style: CSSProperties): ReactNode {
  if (!spans || spans.length === 0) return text;
  const parts: ReactNode[] = [];
  const sorted = spans.toSorted((a, b) => a.start - b.start);
  let cursor = 0;
  sorted.forEach((span, index) => {
    const from = Math.max(cursor, Math.min(span.start, text.length));
    const to = Math.max(from, Math.min(span.end, text.length));
    if (to <= from) return;
    if (from > cursor) parts.push(text.slice(cursor, from));
    // Position is the key: while an answer streams, a run's text grows but its
    // place in the answer does not. `Markdown.tsx` keys its blocks the same way.
    const markKey = `w${index}`;
    parts.push(
      <mark key={markKey} style={style}>
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * An AI answer drawn as the blocks the voice reads, with the words the voice
 * is on washed in the reader's own ink.
 *
 * This replaces `Markdown` on the reading guide on purpose. The wash is
 * measured against spoken characters, so the text it paints has to be the
 * exact string the engine was given — markup stripped. The panel keeps
 * `Markdown.tsx`'s type styles and list marks, so the only visible difference
 * is that inline bold/code markers are no longer styled.
 *
 * One clip is one sentence, so the three levels are simple: the word the
 * engine reported, the clip, or the whole display block. Only the word level
 * needs a position at all. The shape and colour come from `washCss`, the one
 * place the reader's own wash is resolved.
 */
export function AiSpeechText({ id, text }: { id: string; text: string }) {
  const layout = useMemo(() => aiSpeechLayout(text), [text]);
  const host = useTtsHostOptional();
  const active = useSpeechSession((state) => state.origin === "ai" && state.activeId === id);
  const highlight = useReaderSettings((state) => state.aiSpeechHighlight);
  const granularity = useReaderSettings((state) => state.speechGranularity);
  const shape = useReaderSettings((state) => state.speechWashStyle);
  const ink = useReaderSettings((state) => state.speechWashColor);
  const surface = useActiveReadingSurface();
  const wash = useMemo(
    () => washCss(shape, ink, surface.mode === "dark"),
    [shape, ink, surface.mode],
  );

  const boundary = granularity === "word" ? (host?.tts.boundary ?? null) : null;
  const unit = active && highlight ? (host?.tts.unit ?? null) : null;

  const byRun = useMemo(() => {
    const map = new Map<number, AiSpeechSpan[]>();
    if (unit === null) return map;
    const clip = layout.units[unit]?.text;
    if (clip === undefined) return map;
    let range: { start: number; end: number };
    if (granularity === "paragraph") {
      const piece = layout.segments[unit]?.[0];
      const run = piece ? layout.runs[piece.run] : undefined;
      if (piece && run) {
        map.set(piece.run, [{ run: piece.run, start: 0, end: run.text.length }]);
      }
      return map;
    } else if (granularity === "sentence") {
      range = { start: 0, end: clip.length };
    } else {
      // Nothing is washed until the engine says where the voice is: painting
      // the whole clip and snapping down to a word reads as a flash, not a
      // highlight. The reader's own wash waits for the same reason.
      if (boundary === null || boundary.unit !== unit) return map;
      range = {
        start: boundary.charIndex,
        end: boundary.charIndex + Math.max(1, boundary.charLength),
      };
    }
    for (const span of aiSpeechSpans(layout, unit, range.start, range.end)) {
      const list = map.get(span.run) ?? [];
      list.push(span);
      map.set(span.run, list);
    }
    return map;
  }, [unit, layout, granularity, boundary]);

  // `mark` has a UA background; only the highlight shape wants one. A rule or
  // an outline must not sit inside a yellow box.
  const markStyle = useMemo<CSSProperties>(
    () => ({ backgroundColor: "transparent", color: "inherit", ...wash }),
    [wash],
  );

  const nodes: ReactNode[] = [];
  let list: { run: AiSpeechRun; index: number }[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    const key = `list-${list[0]!.index}`;
    nodes.push(
      <ul key={key} className="space-y-1.5">
        {list.map(({ run, index }) => {
          const itemKey = `l${index}`;
          return (
            <li key={itemKey} className="text-text-1 flex gap-2 text-[13px] leading-relaxed">
              {run.ordered ? (
                <span className="text-text-3 w-4 shrink-0 text-right tabular-nums">
                  {run.order}.
                </span>
              ) : (
                <span aria-hidden className="bg-text-3 mt-[9px] size-1 shrink-0 rounded-full" />
              )}
              <span className="min-w-0">{washed(run.text, byRun.get(index), markStyle)}</span>
            </li>
          );
        })}
      </ul>,
    );
    list = [];
  };

  layout.runs.forEach((run, index) => {
    if (run.kind === "list") {
      list.push({ run, index });
      return;
    }
    flushList();
    const body = washed(run.text, byRun.get(index), markStyle);
    const runKey = `b${index}`;
    if (run.kind === "heading") {
      nodes.push(
        <p
          key={runKey}
          className={
            run.level <= 2
              ? "text-text-1 pt-1.5 text-[13.5px] leading-snug font-medium"
              : "text-text-2 pt-1 text-[12.5px] leading-snug font-medium"
          }
        >
          {body}
        </p>,
      );
    } else if (run.kind === "quote") {
      nodes.push(
        <p
          key={runKey}
          className="border-hairline text-text-2 border-l-2 pl-3 text-[12.5px] leading-relaxed"
        >
          {body}
        </p>,
      );
    } else {
      nodes.push(
        <p key={runKey} className="text-text-1 text-[13px] leading-relaxed">
          {body}
        </p>,
      );
    }
  });
  flushList();

  return <div className="space-y-3">{nodes}</div>;
}
