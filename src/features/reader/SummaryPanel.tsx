import { AiErrorCard } from "@/components/common/AiErrorCard";
import { AiSpeechButton } from "@/components/common/AiSpeechButton";
import { useAiChat } from "@/hooks/useAi";
import { useChapterSummaries, useSummaryBuild } from "@/hooks/useSummary";
import { cn } from "@/lib/cn";
import { isDesktopRuntime } from "@/lib/ipc";

/**
 * The chapter-summary drawer: what happened in each chapter the reader has
 * already passed, and one paragraph tying them together.
 *
 * Two things it deliberately is not. It is not automatic — every chapter is a
 * model call, and a chapter opened is not a chapter the reader wants summarised.
 * And it never shows a chapter past the reader's position: the list is filtered
 * in the backend, so the drawer cannot spoil the book even by accident.
 */
export function SummaryPanel({
  bookId,
  currentIdx,
  onJump,
}: {
  bookId: string;
  /** The reader's position, inclusive. */
  currentIdx: number;
  onJump: (idx: number) => void;
}) {
  const list = useChapterSummaries(bookId, currentIdx);
  const { build, progress } = useSummaryBuild(bookId, currentIdx);
  const recap = useAiChat();

  if (list.isPending) {
    // Every panel roots in its own scroller: the drawer measures the first
    // `.overflow-y-auto` inside it to prove nothing spills sideways, and a bare
    // paragraph has none.
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="text-text-3 text-[13px]">正在加载…</p>
      </div>
    );
  }

  const rows = list.data ?? [];
  const ready = rows.filter((row) => row.summary !== "").length;
  // Three states, not two. A row with a timestamp and no text is a chapter the
  // backend decided has nothing to summarise — a cover, a copyright page — and
  // offering to 补齐 it would be a button that never finishes.
  const textless = rows.filter((row) => row.summary === "" && row.createdAt > 0).length;
  const missing = rows.filter((row) => row.summary === "" && row.createdAt === 0).length;
  const building = build.isPending;

  if (rows.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="text-text-3 text-[12.5px] leading-relaxed">
          {isDesktopRuntime
            ? "这本书还没有可摘要的正文。等章节解析完成后再打开这里。"
            : "章节摘要要调用模型逐章生成，只在桌面端可用。"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline shrink-0 space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-text-3 text-[11.5px]">
            已读 {rows.length} 章 · {ready} 章有摘要
            {textless > 0 && ` · ${textless} 章无正文`}
          </p>
          <button
            type="button"
            disabled={building || missing === 0}
            onClick={() => build.mutate()}
            className="glass-liquid text-accent focus-visible:focus-ring shrink-0 rounded-full px-3 py-1 text-[11.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {building
              ? progress
                ? `${progress.done}/${progress.total} 章`
                : "读取章节…"
              : missing === 0
                ? "已补齐"
                : `补齐 ${missing} 章`}
          </button>
        </div>

        <button
          type="button"
          disabled={ready === 0 || recap.streaming}
          onClick={() => recap.sendRecap(bookId, currentIdx)}
          className="border-hairline text-text-2 hover:text-text-1 focus-visible:focus-ring w-full rounded-lg border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-45"
        >
          {recap.streaming ? "正在整理前情…" : recap.text ? "重新生成前情提要" : "生成前情提要"}
        </button>

        {build.error !== null && <AiErrorCard message={String(build.error)} />}
      </div>

      {(recap.text || recap.error) && (
        <div className="border-hairline shrink-0 border-b px-4 py-3">
          {recap.error ? (
            <AiErrorCard message={recap.error} />
          ) : (
            <div className="flex items-start gap-2">
              <p className="text-text-1 min-w-0 flex-1 text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {recap.text}
              </p>
              <AiSpeechButton
                id={`recap:${bookId}:${currentIdx}`}
                text={recap.text}
                title="前情提要"
                chapter={`已读 ${rows.length} 章`}
                disabled={recap.streaming}
                streaming={recap.streaming}
                label="朗读前情提要"
              />
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((row) => (
          // The row stays one jump button, and the speaker is its sibling:
          // a button inside a button is not a control the browser can focus.
          // It sits over the row's right edge, with enough padding inside the
          // button that a long chapter title never runs under it.
          <div key={row.idx} className="relative">
            <button
              type="button"
              onClick={() => onJump(row.idx)}
              className={cn(
                "focus-visible:focus-ring hover:bg-surface-2/50 block w-full border-l-2 py-2.5 pl-4 text-left transition-colors",
                row.summary ? "pr-10" : "pr-4",
                row.idx === currentIdx ? "border-accent bg-surface-2/40" : "border-transparent",
              )}
            >
              <p className="text-text-1 truncate text-[12.5px] font-medium">
                {row.idx + 1}. {row.title}
              </p>
              <p
                className={cn(
                  "mt-0.5 text-[12px] leading-relaxed",
                  row.summary ? "text-text-2" : "text-text-3",
                )}
              >
                {row.summary ||
                  (row.createdAt > 0
                    ? // The count, not a guess about what the page is. 「封面、版权页
                      // 或目录」 was wrong for a dedication page, and a reader who
                      // sees 「只有 10 字」 stops wondering whether extraction broke.
                      `这一章只有 ${row.chars} 字，没有可摘要的正文`
                    : "还没有摘要")}
              </p>
            </button>
            {row.summary && (
              <AiSpeechButton
                className="absolute top-2 right-2"
                id={`summary:${bookId}:${row.idx}`}
                text={row.summary}
                title={`第 ${row.idx + 1} 章摘要`}
                chapter={row.title}
                label="朗读这章摘要"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
