import { useState } from "react";
import { X } from "@phosphor-icons/react";

import { Markdown } from "@/components/common/Markdown";
import { useAiChat } from "@/hooks/useAi";
import { useIndexBook, useRagStatus } from "@/hooks/useRag";
import { cn } from "@/lib/cn";
import type { RagHit } from "@/types/ipc";

/** One question, one streamed answer. The context is the quoted selection when
 * there is one, otherwise the whole current chapter; the exchange restarts on
 * every drawer open, so nothing here needs clearing logic of its own. With
 * retrieval enabled the backend picks the context and returns citations.
 */
export function AskAiPanel({
  bookId,
  selection,
  onClearSelection,
  chapterTitle,
  paragraphs,
  onJump,
}: {
  bookId: string;
  selection: string | null;
  onClearSelection: () => void;
  chapterTitle: string;
  paragraphs: string[];
  onJump: (hit: RagHit) => void;
}) {
  const [question, setQuestion] = useState("");
  const [ragMode, setRagMode] = useState(false);
  const ai = useAiChat();
  const status = useRagStatus(bookId);
  const indexBook = useIndexBook(bookId);

  const ragReady = (status.data?.embeddingModel ?? "") !== "";
  const thisBookIndexed = (status.data?.bookChunks ?? 0) > 0;

  const ask = () => {
    const trimmed = question.trim();
    if (!trimmed || ai.streaming) return;
    if (ragMode) {
      // Whole-library scope: `null` lets the backend search every indexed book.
      ai.askRag(trimmed, null);
      return;
    }
    const context = selection ?? paragraphs.join("\n");
    const content = selection
      ? `引用片段：\n${selection}\n\n问题：${trimmed}`
      : `当前章节：${chapterTitle}\n\n${context}\n\n问题：${trimmed}`;
    ai.send([{ role: "user", content }]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {selection && !ragMode && (
          <div className="glass mb-3 rounded-lg p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-text-3 text-[11px]">引用片段</p>
              <button
                type="button"
                aria-label="清除引用"
                onClick={onClearSelection}
                className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
            <p className="text-text-2 line-clamp-4 text-[12.5px] leading-relaxed">{selection}</p>
          </div>
        )}

        {ai.error && <p className="text-danger mb-3 text-[12.5px] leading-relaxed">{ai.error}</p>}
        {ai.text && <Markdown text={ai.text} />}
        {ai.streaming && !ai.text && <p className="text-text-3 text-[12.5px]">正在思考…</p>}
        {!ai.text && !ai.streaming && !ai.error && (
          <p className="text-text-3 text-[13px] leading-relaxed">
            选中正文点「问 AI」可以针对片段提问；不带引用时，助手会读整章再回答。
          </p>
        )}

        {ai.citations.length > 0 && (
          <div className="border-hairline mt-3 border-t pt-3">
            <p className="text-text-3 mb-1.5 text-[11px]">来源</p>
            <ul className="space-y-1.5">
              {ai.citations.map((hit, index) => (
                <li key={`${hit.bookId}-${hit.chapterIdx}-${hit.startChar}`}>
                  <button
                    type="button"
                    onClick={() => onJump(hit)}
                    className="focus-visible:focus-ring text-text-2 hover:text-accent w-full rounded-md text-left text-[12.5px] leading-relaxed transition-colors"
                  >
                    [{index + 1}] 《{hit.bookTitle}》 第 {hit.chapterIdx + 1} 章
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {ragReady && (
        <div className="border-hairline flex items-center justify-between gap-2 border-t px-3 py-2">
          <button
            type="button"
            aria-pressed={ragMode}
            onClick={() => setRagMode((on) => !on)}
            className={cn(
              "focus-visible:focus-ring rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              ragMode
                ? "bg-accent text-on-accent border-transparent"
                : "border-hairline text-text-2 hover:text-text-1",
            )}
          >
            检索全书库
          </button>
          {ragMode && !thisBookIndexed && (
            <button
              type="button"
              disabled={indexBook.build.isPending}
              onClick={() => indexBook.build.mutate()}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 text-[12px] transition-colors disabled:opacity-60"
            >
              {indexBook.build.isPending && indexBook.progress
                ? `索引中 ${indexBook.progress.done}/${indexBook.progress.total}`
                : "本书未索引，点此建立"}
            </button>
          )}
        </div>
      )}

      <form
        className="border-hairline flex items-center gap-2 border-t px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={
            ragMode ? "就全书内容提问…" : selection ? "就这段内容提问…" : "就本章内容提问…"
          }
          aria-label="问题"
          disabled={ai.streaming}
          className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent h-8 min-w-0 flex-1 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={ai.streaming || question.trim() === ""}
          className="focus-visible:focus-ring bg-accent text-on-accent rounded-full px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {ai.streaming ? "回答中" : "提问"}
        </button>
      </form>
    </div>
  );
}
