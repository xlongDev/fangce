import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";

import { AiErrorCard } from "@/components/common/AiErrorCard";
import { Markdown } from "@/components/common/Markdown";
import { useAiChat } from "@/hooks/useAi";

/**
 * The AI reading guide for one book: a summary written from the book's own
 * metadata, table of contents and chapter openings.
 *
 * Opening the drawer *is* the request. The backend answers from its cache when
 * a guide was written before, so there is no "nothing here yet, press generate"
 * state to design: either a guide arrives, or no model is configured and the
 * error says exactly that.
 */
export function GuidePanel({ bookId }: { bookId: string }) {
  const { text, streaming, error, sendDigest } = useAiChat();

  useEffect(() => {
    sendDigest(bookId);
  }, [bookId, sendDigest]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? <AiErrorCard message={error} /> : text ? <Markdown text={text} /> : <Waiting />}
      </div>

      <div className="border-hairline flex items-center justify-between gap-3 border-t px-3 py-2">
        <p className="text-text-3 text-[11px] leading-snug">
          由书名、目录与章节开头生成，缓存在本机
        </p>
        <button
          type="button"
          disabled={streaming}
          onClick={() => sendDigest(bookId, true)}
          className="glass-liquid text-text-2 hover:text-text-1 focus-visible:focus-ring flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors disabled:opacity-60"
        >
          <ArrowClockwise size={12} />
          {streaming ? "生成中" : "重新生成"}
        </button>
      </div>
    </div>
  );
}

/** How long a wait is still "instant" — below this, no placeholder at all. */
const QUIET_MS = 250;

/**
 * What the panel shows while the guide is being written.
 *
 * Two things were wrong with the single grey line this replaced. It arrived on
 * the first frame, so a cached guide — the common case — flashed a placeholder
 * and then the text; and once the wait got long it was indistinguishable from a
 * hang. The delay fixes the first, the seconds fix the second: a counter that
 * moves is the cheapest possible proof that something is still happening, and
 * it is honest about how long the reader has actually waited.
 *
 * The bars are shaped like prose rather than like a loading bar, because what
 * is coming is prose.
 */
function Waiting() {
  const [visible, setVisible] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const reveal = setTimeout(() => setVisible(true), QUIET_MS);
    return () => clearTimeout(reveal);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const tick = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(tick);
  }, [visible]);

  if (!visible) return null;

  return (
    <div aria-live="polite">
      <div className="space-y-2.5">
        {[88, 96, 72, 92, 58].map((width) => (
          <div
            key={width}
            className="bg-hairline h-2.5 animate-pulse rounded-full"
            style={{ width: `${width}%` }}
          />
        ))}
      </div>
      <p className="text-text-3 mt-5 text-[12px]">
        正在读目录与章节开头
        {seconds > 0 ? ` · ${seconds} 秒` : "…"}
      </p>
    </div>
  );
}
