import { useEffect } from "react";
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
        {error ? (
          <AiErrorCard message={error} />
        ) : text ? (
          <Markdown text={text} />
        ) : (
          <p className="text-text-3 text-[13px] leading-relaxed">正在读这本书…</p>
        )}
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
