import { AnimatePresence } from "motion/react";

import { Reveal } from "@/components/motion/Reveal";
import { AnnotationList } from "@/features/reader/AnnotationList";
import { AskAiPanel } from "@/features/reader/AskAiPanel";
import { FoliateSearchPanel } from "@/features/reader/FoliateSearchPanel";
import type { FoliateSearchHit } from "@/features/reader/FoliateBookView";
import { GuidePanel } from "@/features/reader/GuidePanel";
import { ReaderDrawer } from "@/features/reader/ReaderDrawer";
import { SettingsPanel } from "@/features/reader/SettingsPanel";
import { SummaryPanel } from "@/features/reader/SummaryPanel";
import { TocPanel } from "@/features/reader/TocPanel";
import type { Panel } from "@/features/reader/ReaderChrome";
import { GraphPanel } from "@/features/graph/GraphPanel";
import { CharacterPanel } from "@/features/graph/CharacterPanel";
import { SearchPanel } from "@/features/search/SearchPanel";
import type { PdfOutlineItem } from "@/lib/pdf";
import type { Annotation, Bookmark, ChapterMeta, RagHit, SearchHit } from "@/types/ipc";

/** The drawer's title for a panel, kept next to the switch so the two never
    drift — the header buttons name the same things. */
export function panelTitle(panel: Exclude<Panel, "none">): string {
  switch (panel) {
    case "toc":
      return "目录与书签";
    case "settings":
      return "阅读设置";
    case "annotations":
      return "标注";
    case "search":
      return "搜索正文";
    case "graph":
      return "知识图谱";
    case "characters":
      return "角色卡";
    case "guide":
      return "AI 导读";
    case "summary":
      return "章节摘要";
    default:
      return "AI 助手";
  }
}

/**
 * The one side panel the reader has open, if any.
 *
 * Everything here is a switch the parent feeds: the panels own their own
 * queries and state, and this file only decides which one is in the drawer and
 * hands each the callbacks it needs to move the reader. Keeping the switch out
 * of the page is what lets the page's own render stay about the page.
 */
export function ReaderPanels({
  panel,
  bookId,
  onClose,
  paired = false,
  toc,
  summary,
  graph,
  search,
  annotations,
  ai,
  verticalAvailable,
  zhAvailable,
  boldAvailable,
}: {
  panel: Panel;
  bookId: string;
  onClose: () => void;
  /** True in a 对照阅读 pane — the drawer then fades in place instead of
   *  sliding, which would carry it across the seam onto the other book. */
  paired?: boolean;
  /** Whether this book has a paginator that can lay columns out vertically —
      a foliate book has one; prose and PDF are laid out here instead. */
  verticalAvailable: boolean;
  /** Whether the book has flowing text to convert — everything but PDF/CBZ. */
  zhAvailable: boolean;
  /** Whether the app sets the body text itself and can therefore weight it —
      the same set of books as `zhAvailable`, but a separate question: a
      converter rewrites characters, this one changes a typeface. */
  boldAvailable: boolean;
  toc: {
    chapters: ChapterMeta[];
    outline: PdfOutlineItem[];
    currentIdx: number;
    bookmarks: Bookmark[];
    busy: boolean;
    onJump: (idx: number) => void;
    onJumpBookmark: (bookmark: Bookmark) => void;
    onDeleteBookmark: (id: string) => void;
    onAddBookmark: () => void;
  };
  /**
   * The summary drawer's own chapter numbering.
   *
   * Not `toc`'s: for a foliate book the table of contents is the book's own nav
   * (16 entries here), while the summaries are keyed by the importer's chapters
   * (36 — every part *and* every chapter). Passing the nav's index in as a
   * chapter index truncated the list at an arbitrary row and sent 第 1 章 to
   * 第一部分, because `toc.onJump` reads its argument as a nav entry.
   */
  summary: {
    /** The reader's position as a chapter index, inclusive. */
    currentIdx: number;
    onJump: (idx: number) => void;
  };
  graph: {
    onOpenChapter: (idx: number) => void;
    onAskAbout: (name: string) => void;
  };
  search: {
    /** foliate books search inside their own renderer; the rest hit the index. */
    useFoliate: boolean;
    seed: string;
    onFoliateSearch: (query: string) => Promise<FoliateSearchHit[]>;
    onFoliatePick: (cfi: string) => void;
    onPick: (hit: SearchHit, needle: string) => void;
  };
  annotations: {
    items: Annotation[];
    busy: boolean;
    onDelete: (id: string) => void;
    onNote: (id: string, note: string | null) => void;
    onExport: () => void;
    /** `undefined` for a book the reader cannot navigate by anchor. */
    onJump: ((annotation: Annotation) => void) | undefined;
    /** Opens the share card for one highlight. */
    onShare: (annotation: Annotation) => void;
  };
  ai: {
    context: string | null;
    onClearContext: () => void;
    chapterTitle: string;
    /** The reader's position, for a spoiler-safe retrieval. */
    chapterIdx: number;
    paragraphs: string[];
    onJumpCitation: (hit: RagHit) => void;
    question: string;
  };
}) {
  return (
    // One drawer at a time; AnimatePresence keeps it mounted while it
    // slides out, and clicking the dimmed backdrop dismisses it.
    <AnimatePresence>
      {panel !== "none" && (
        <ReaderDrawer
          key="reader-drawer"
          title={panelTitle(panel)}
          onClose={onClose}
          paired={paired}
        >
          {/* Keyed so a swap rises in. The drawer stays put while its
              content changes, and cutting between panels as different as a
              chapter list and a settings sheet reads as a jump rather than
              a step sideways. `flex min-h-0 flex-1 flex-col` preserves
              every panel's own fill-the-drawer layout — they all root
              the same way. */}
          <Reveal key={panel} className="flex min-h-0 flex-1 flex-col">
            {panel === "toc" && (
              <TocPanel
                chapters={toc.chapters}
                outline={toc.outline}
                currentIdx={toc.currentIdx}
                bookmarks={toc.bookmarks}
                busy={toc.busy}
                onJump={toc.onJump}
                onJumpBookmark={toc.onJumpBookmark}
                onDeleteBookmark={toc.onDeleteBookmark}
                onAddBookmark={toc.onAddBookmark}
              />
            )}
            {panel === "settings" && (
              <SettingsPanel
                bookId={bookId}
                verticalAvailable={verticalAvailable}
                zhAvailable={zhAvailable}
                boldAvailable={boldAvailable}
              />
            )}
            {panel === "annotations" && (
              <AnnotationList
                annotations={annotations.items}
                busy={annotations.busy}
                onDelete={annotations.onDelete}
                onNote={annotations.onNote}
                onExport={annotations.onExport}
                onJump={annotations.onJump}
                onShare={annotations.onShare}
              />
            )}
            {panel === "search" &&
              (search.useFoliate ? (
                <FoliateSearchPanel
                  initialQuery={search.seed}
                  onSearch={search.onFoliateSearch}
                  onPick={search.onFoliatePick}
                />
              ) : (
                <SearchPanel bookId={bookId} initialQuery={search.seed} onPick={search.onPick} />
              ))}
            {panel === "graph" && (
              <GraphPanel
                bookId={bookId}
                onOpenChapter={graph.onOpenChapter}
                onAskAbout={graph.onAskAbout}
              />
            )}
            {panel === "characters" && (
              <CharacterPanel bookId={bookId} onAskAbout={graph.onAskAbout} />
            )}
            {panel === "ai" && (
              <AskAiPanel
                bookId={bookId}
                selection={ai.context}
                onClearSelection={ai.onClearContext}
                chapterTitle={ai.chapterTitle}
                chapterIdx={ai.chapterIdx}
                paragraphs={ai.paragraphs}
                onJump={ai.onJumpCitation}
                seedQuestion={ai.question}
              />
            )}
            {/* The drawer already knows the reader's position and how to jump
                — the same two things the table of contents uses. */}
            {panel === "summary" && (
              <SummaryPanel
                bookId={bookId}
                currentIdx={summary.currentIdx}
                onJump={summary.onJump}
              />
            )}
            {panel === "guide" && <GuidePanel bookId={bookId} />}
          </Reveal>
        </ReaderDrawer>
      )}
    </AnimatePresence>
  );
}
