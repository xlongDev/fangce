import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen } from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { useAnnotations } from "@/hooks/useAnnotations";
import { useBook, useReaderToc } from "@/hooks/useReader";
import { useChrome } from "@/stores/chrome";
// The ReaderView import closes a cycle with ReaderPage (which renders
// SplitReader, which renders this). Both sides only call the other's function
// declarations at render time, so the live bindings resolve; the alternative
// was moving a 2,500-line component into a file of its own.
import { ReaderView } from "./ReaderPage";
import type { PairIdentity } from "./pairLayout";
import type { ChapterMeta } from "@/types/ipc";

/**
 * What the 返回 button is called, by the route it goes back to.
 *
 * The shelf routes are absent on purpose: they all read "返回书库", which is
 * what the button has always said and what every shelf-side test looks for.
 */
const BACK_LABELS: Record<string, string> = {
  "/notes": "返回笔记",
  "/search": "返回搜索",
  "/stats": "返回统计",
};

export interface ReaderHostProps {
  bookId: string | null;
  /**
   * Pair wiring handed to the surface. `null` (or absent) is the ordinary
   * reader: the only one in the window, with the whole chrome and all
   * window-level input. A pair splits those between the two panes — see
   * `ReaderView`'s `pair` prop.
   */
  pair?: { active: boolean; onActivate?: () => void } | null;
  /** Chapter given in the URL, or `null` to resume the saved position. */
  initialChapter?: number | null;
  /** Search term carried over from a result, highlighted in the chapter. */
  initialQuery?: string;
  /** Character offset of a search hit, scrolled into view once rendered. */
  initialOffset?: number | null;
  /**
   * A highlight named by a `fangce://` link the reader followed. Wins
   * over the saved position: following a link means "show me this", not
   * "carry on where I left off".
   */
  initialAnnotation?: string | null;
  /** Opens the companion-book picker. Without it the chrome hides the button. */
  onOpenPair?: () => void;
  /** Reports which book this is and where it is open, for the pair's top bar
   *  to name both books and give each its own steppers. Pair mode only. */
  onIdentity?: (identity: PairIdentity) => void;
}

/**
 * One book, arranged for reading: load it, guard the ways it can fail, and
 * mount the surface.
 *
 * Split out of the route so a 对照阅读 pair can mount two of these side by
 * side — each book's queries, guards and surface are its own, and only the
 * window-level pieces (chrome, keyboard, the voice) are divided between them
 * by the `pair` wiring.
 */
export function ReaderHost({
  bookId,
  pair = null,
  initialChapter = null,
  initialQuery = "",
  initialOffset = null,
  initialAnnotation = null,
  onOpenPair,
  onIdentity,
}: ReaderHostProps) {
  const navigate = useNavigate();
  // Where this book was opened from. The shell wrote it down on the way in.
  const returnPath = useChrome((s) => s.readerReturnPath);
  const backLabel = BACK_LABELS[returnPath] ?? "返回书库";
  const goBack = useCallback(() => navigate(returnPath), [navigate, returnPath]);

  const book = useBook(bookId);
  const toc = useReaderToc(bookId);
  // Only when a link named a highlight: the row carries the position, and the
  // reader has to be arranged around it *before* it mounts. Resolving it later
  // would mean opening the book in the wrong place and then jumping — a scroll
  // the reader would see. `null` leaves the query idle, so an ordinary open
  // pays for nothing.
  const linkedAnnotations = useAnnotations(initialAnnotation === null ? null : bookId);

  const content = useMemo(() => {
    if (!bookId) {
      return (
        <EmptyState
          className="h-full p-2"
          icon={<BookOpen size={26} weight="duotone" />}
          title="从书库选一本书"
          description="在书库里点开一本书，正文会出现在这里。"
        />
      );
    }
    if (book.isPending || toc.isPending) {
      return <p className="text-text-3 text-sm">正在打开…</p>;
    }
    if (book.isError || toc.isError) {
      return (
        <EmptyState
          className="h-full p-2"
          icon={<BookOpen size={26} weight="duotone" />}
          // Two ways a book can be unopenable and only one of them is the
          // app's fault: the index may have failed to build, or the file the
          // index was built from may no longer be in the data directory (a
          // move, or a restore that did not finish). Both are answered from
          // the shelf, and the backend says which one it is when it can.
          title="这本书打不开"
          description="章节索引加载失败。若这本书的文件已不在数据目录里，可从备份恢复或重新导入；否则回到书库再试一次。"
          action={
            <GlassButton variant="subtle" onClick={goBack}>
              {backLabel}
            </GlassButton>
          }
        />
      );
    }
    if (initialAnnotation !== null && linkedAnnotations.isPending) {
      return <p className="text-text-3 text-sm">正在定位这条标注…</p>;
    }
    return null;
  }, [
    bookId,
    book.isPending,
    book.isError,
    toc.isPending,
    toc.isError,
    goBack,
    backLabel,
    initialAnnotation,
    linkedAnnotations.isPending,
  ]);

  if (content) {
    return <div className="flex h-full flex-col px-8 py-6">{content}</div>;
  }

  const chapters: ChapterMeta[] = toc.data ?? [];
  const bookSummary = book.data;

  if (!bookId || !bookSummary || chapters.length === 0) {
    return (
      <div className="flex h-full flex-col px-8 py-6">
        <EmptyState
          className="h-full p-2"
          icon={<BookOpen size={26} weight="duotone" />}
          title="这本书没有章节"
          description="这本书的格式暂时无法提取正文，重新导入可能可以解决。"
          action={
            <GlassButton variant="subtle" onClick={goBack}>
              {backLabel}
            </GlassButton>
          }
        />
      </div>
    );
  }

  return (
    <ReaderView
      bookId={bookId}
      pair={pair}
      title={bookSummary.title}
      coverUrl={bookSummary.coverUrl}
      bookLanguage={bookSummary.language}
      format={bookSummary.format}
      chapters={chapters}
      initialProgress={bookSummary.progress ?? 0}
      initialCfi={bookSummary.location}
      initialChapter={initialChapter}
      initialQuery={initialQuery}
      initialOffset={initialOffset}
      initialAnnotation={initialAnnotation}
      backLabel={backLabel}
      onBack={goBack}
      onOpenPair={onOpenPair}
      onIdentity={onIdentity}
    />
  );
}
