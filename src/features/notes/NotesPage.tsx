import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowSquareOut,
  BookOpen,
  Check,
  CheckSquare,
  Export,
  MagnifyingGlass,
  Notebook,
  NotePencil,
  Trash,
  X,
} from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { SPRING, useMotion } from "@/lib/motion";
import { displayTitle } from "@/lib/title";
import { useSettings, type NotesView } from "@/stores/settings";
import { useBooks } from "@/hooks/useLibrary";
import {
  useAnnotationsByBook,
  useDeleteAnnotation,
  useDeleteAnnotations,
  useExportNotesSelection,
  useSetAnnotationNote,
} from "@/hooks/useAnnotations";
import { GlassButton } from "@/components/glass/button";
import { GlassDialog, OverlayPortal } from "@/components/glass/overlay";
import { PageHeader } from "@/components/layout/PageHeader";
import { NoteCell } from "@/features/reader/AnnotationNote";
import { EmptyState } from "@/components/common/EmptyState";
import { QueryError } from "@/components/common/QueryError";
import { authorLine } from "@/features/library/format";
import {
  exportPayload,
  filterNotes,
  groupByBook,
  inkColor,
  keepEntries,
  tally,
  unitLabel,
  type BookNotes,
  type NoteEntry,
} from "@/features/notes/aggregate";
import type { BookQuery } from "@/types/ipc";

/**
 * Notes — the highlights the reader made *in books*, gathered in one place.
 *
 * This is a view, not a store. Every row is a row of the same `annotations`
 * table the reader writes to, on the same query key, so a note edited here is
 * the note the reader shows next time the book is opened, and vice versa —
 * there is no copy to fall out of step and no sync step to forget.
 *
 * The consequence worth knowing: deleting here deletes the highlight in the
 * book too, exactly as it does from the reader's own annotation list. There is
 * no undo on either surface.
 */

/** Recent-first, which is the order the page groups in: the book you were last
 *  in is the one whose notes you are most likely looking for. */
const SHELF_QUERY: BookQuery = { filter: "all", sort: "recentlyRead" };

// `satisfies` so the two cannot drift: a value added here that the store does
// not know about is a compile error, not a filter that silently resets.
const FILTERS = [
  { value: "all", label: "全部" },
  { value: "noted", label: "有笔记" },
] as const satisfies readonly { value: NotesView["filter"]; label: string }[];

type FilterValue = (typeof FILTERS)[number]["value"];

/** Reaches for the native save dialog, so it is kept out of this route's own
 *  chunk — the same split the reader makes for the same reason. */
const ExportNotesDialog = lazy(() =>
  import("@/features/reader/ExportNotesDialog").then((module) => ({
    default: module.ExportNotesDialog,
  })),
);

/** Which set an open export dialog is about. `null` means there is none. */
type ExportScope = "shown" | "selection";

export function NotesPage() {
  const m = useMotion();
  const navigate = useNavigate();
  const books = useBooks(SHELF_QUERY);
  const bookIds = useMemo(() => (books.data ?? []).map((book) => book.id), [books.data]);
  const annotations = useAnnotationsByBook(bookIds);
  const { byBook, error: notesError, refetch: retryNotes } = annotations;

  // What the list is narrowed to, from the settings store: following a
  // highlight into its book unmounts this page, and a reader who narrows to
  // 有笔记 and comes back wants the same list, not the whole one again.
  const view = useSettings((s) => s.notesView);
  const setNotesView = useSettings((s) => s.setNotesView);
  const { query, filter } = view;

  /** Batch-manage mode: rows toggle selection instead of opening. */
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState<ExportScope | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** The page root, so the batch bar can be centred on the pane rather than on
   *  the window (see the placement effect below). */
  const pageRef = useRef<HTMLDivElement>(null);
  const batchBarRef = useRef<HTMLDivElement>(null);

  const removeMany = useDeleteAnnotations();
  const exportSelection = useExportNotesSelection();

  // Memoised on the query's own data rather than on `?? []`, which would be a
  // fresh array every render and re-group the whole shelf on each keystroke.
  const shelf = useMemo(() => books.data ?? [], [books.data]);
  const everything = useMemo(() => groupByBook(shelf, byBook), [shelf, byBook]);
  const shown = useMemo(
    () => filterNotes(everything, { query, onlyNoted: filter === "noted" }),
    [everything, query, filter],
  );

  /**
   * What the selection actually covers: the checked rows that are still on
   * screen.
   *
   * Derived rather than stored, so narrowing the search narrows the selection
   * instead of leaving the bar counting rows the reader cannot see — and
   * widening brings them back, because `selected` still remembers them. The
   * count, the delete and the export all read this, which is what keeps the
   * bar from promising more than it will do.
   */
  const picked = useMemo(() => keepEntries(shown, selected), [shown, selected]);

  // Both halves count. Until the shelf answers there are no ids to ask about,
  // so the annotation queries have not started and report themselves settled —
  // reading only their flag would flash "还没有标注" over a library that has
  // plenty, which is a lie the reader has no way to tell from the truth.
  const loading = books.isPending || annotations.loading;
  // The read failure, surfaced the same way the shelf does: a human sentence
  // plus the one action that can help (re-ask both halves). A quiet empty
  // shelf is NOT an error and must never become a toast — <QueryError> only.
  const readError = books.error ?? notesError;
  const retryRead = () => {
    void books.refetch();
    void retryNotes();
  };

  const total = tally(everything);
  const visible = tally(shown);
  const pickedCount = tally(picked).highlights;
  const narrowed = query.trim() !== "" || filter !== "all";

  /** The set an open dialog is about — the selection, or the whole screen. */
  const target = exporting === "selection" ? picked : shown;
  const targetCount = tally(target);

  const open = useCallback(
    (entry: NoteEntry) => {
      navigate(`/reader?book=${entry.book.id}&annotation=${entry.annotation.id}`);
    },
    [navigate],
  );

  const exitManaging = useCallback(() => {
    setManaging(false);
    setSelected(new Set());
    setConfirmDelete(false);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const shownIds = useMemo(
    () => shown.flatMap((group) => group.entries.map((entry) => entry.annotation.id)),
    [shown],
  );
  const allSelected = visible.highlights > 0 && pickedCount === visible.highlights;
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(shownIds));

  const confirmBatchDelete = () => {
    removeMany.mutate([...selected], {
      onSuccess: () => {
        setSelected(new Set());
        setConfirmDelete(false);
      },
    });
  };

  /**
   * Escape leaves batch-manage mode.
   *
   * A key handler rather than a click target, for the reason the shelf learned
   * the hard way: the rows are the mode's own selection surface, so any layer
   * that catches a click "outside" catches clicks on the rows too — a selection
   * mode whose selection surface is behind a dismiss layer is not a mode. There
   * is deliberately no scrim here for the same reason.
   *
   * Suppressed while a dialog is up, so Escape there closes the dialog rather
   * than the mode behind it.
   */
  useEffect(() => {
    if (!managing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || confirmDelete || exporting !== null) return;
      exitManaging();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managing, confirmDelete, exporting, exitManaging]);

  /**
   * Where the batch bar belongs, horizontally.
   *
   * The bar is `position: fixed` in the shell's overlay host, and that host is
   * the window — so a plain `left: 50%` is the *window's* middle, while the bar
   * acts on the pane the sidebar pushes right of it (measured on the shelf at
   * 1440 with the rail open: bar centre 720, pane centre 850).
   *
   * Written as the pane's *gutters* — padding on a full-width wrapper — rather
   * than as a `left` on the bar itself, and that is not a style preference: an
   * absolutely positioned box with a `left` and no `right` is shrink-to-fit
   * against the space between that `left` and the viewport edge, so a bar told
   * to sit at the pane's centre is silently capped at (viewport − centre) wide
   * and its labels wrap to one character per line.
   *
   * Straight onto the element rather than into state: the sidebar animates its
   * own width over ~340ms, so this has to track the spring frame by frame.
   */
  useLayoutEffect(() => {
    if (!managing) return;
    const pane = pageRef.current;
    const bar = batchBarRef.current;
    if (!pane || !bar) return;
    const place = () => {
      const box = pane.getBoundingClientRect();
      bar.style.paddingLeft = `${box.left}px`;
      bar.style.paddingRight = `${window.innerWidth - box.right}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [managing]);

  return (
    // `data-notes-page` is what the batch bar's placement effect measures and
    // what the e2e measures with it, so the assertion and the implementation
    // cannot drift apart — the same contract `[data-shelf-scroller]` carries
    // for the shelf's bar.
    <div ref={pageRef} data-notes-page className="flex h-full flex-col">
      {/* The second clause of that subtitle is the one worth saying: a note
          edited here is the same row the reader reads, not a copy. The
          sentence it replaced tried to say that as 「这里改动的那一份，就是书里
          的那一份」 and only managed to be unclear about which copy was which. */}
      <PageHeader title="笔记" subtitle="划线和笔记按书归到这里，改动会写回书里。" />

      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        <motion.div
          initial={m.reduce ? false : { opacity: 0, y: m.rise }}
          animate={{ opacity: 1, y: 0 }}
          transition={m.enter}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <Toolbar
            query={query}
            onQuery={(value) => setNotesView({ query: value })}
            filter={filter}
            onFilter={(value) => setNotesView({ filter: value })}
            total={total}
            visible={visible}
            narrowed={narrowed}
            managing={managing}
            onToggleManaging={() => (managing ? exitManaging() : setManaging(true))}
            onExport={() => setExporting("shown")}
          />

          <div className="min-h-0 flex-1 overflow-y-auto">
            {readError ? (
              <QueryError
                error={readError}
                onRetry={retryRead}
                icon={<Notebook size={26} weight="duotone" />}
                title="笔记读不出来"
                description="标注或书库这次没有读出来。先重试一次；如果还是不行，多半是本地的数据库文件出了问题。"
                className="min-h-[40vh]"
              />
            ) : loading && everything.length === 0 ? (
              <p className="text-text-3 flex h-full items-center justify-center text-[13px]">
                正在读取标注…
              </p>
            ) : shown.length === 0 ? (
              <Board
                narrowed={narrowed}
                hasAny={total.highlights > 0}
                onClear={() => setNotesView({ query: "", filter: "all" })}
              />
            ) : (
              <div className="pb-4">
                {shown.map((group) => (
                  <BookSection
                    key={group.book.id}
                    group={group}
                    onOpen={open}
                    managing={managing}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      <OverlayPortal>
        {/* No scrim behind the bar — see the Escape handler above for what one
            cost the shelf. The wrapper is always mounted, with the bar itself
            inside `AnimatePresence`: the placement effect writes the pane's
            gutters onto the wrapper as padding, and a `fixed inset-x-0` box has
            no width ceiling for those gutters to run into. Empty it is
            zero-height and `pointer-events-none`, so it costs nothing between
            uses. */}
        <div
          ref={batchBarRef}
          className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center"
        >
          <AnimatePresence>
            {managing && (
              <motion.div
                initial={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                transition={m.panel}
                // Centred by the wrapper's flex, not by a `-translate-x-1/2`:
                // motion writes `transform` for the spring, and a half-width
                // nudge is only safe in a property it does not touch.
                className="glass-2 shadow-panel pointer-events-auto flex items-center gap-1.5 rounded-2xl p-2 pl-4 whitespace-nowrap"
                data-batch-bar
              >
                <span className="text-text-2 mr-1 text-sm whitespace-nowrap">
                  已选{" "}
                  <motion.span
                    key={pickedCount}
                    initial={{ y: 8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={SPRING.tap}
                    className="text-text-1 inline-block font-semibold tabular-nums"
                  >
                    {pickedCount}
                  </motion.span>{" "}
                  条
                </span>
                <GlassButton size="sm" variant="subtle" onClick={toggleSelectAll}>
                  {allSelected ? "取消全选" : "全选"}
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={pickedCount === 0}
                  onClick={() => setExporting("selection")}
                >
                  <Export size={13} /> 导出所选
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={pickedCount === 0 || removeMany.isPending}
                  onClick={() => setConfirmDelete(true)}
                >
                  删除
                </GlassButton>
                <GlassButton size="sm" variant="primary" onClick={exitManaging}>
                  完成
                </GlassButton>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </OverlayPortal>

      <GlassDialog
        open={confirmDelete}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(false);
        }}
        title={`删除选中的 ${pickedCount} 条标注？`}
        description="这些标注会从它们所在的书里一并消失，写在旁边的笔记也一样。此操作无法撤销。"
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setConfirmDelete(false)}
            disabled={removeMany.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            onClick={confirmBatchDelete}
            disabled={removeMany.isPending}
          >
            删除
          </GlassButton>
        </div>
      </GlassDialog>

      {/* Exporting happens over the page, not instead of it: the list stays
          where it was, and closing the dialog puts the reader back on the rows
          they were reading from. */}
      {exporting !== null && (
        <Suspense fallback={null}>
          <ExportNotesDialog
            subject={
              target.length === 1
                ? `《${target[0]?.book.title ?? ""}》`
                : `这 ${target.length} 本书`
            }
            name={target.length === 1 ? (target[0]?.book.title ?? "") : "笔记"}
            highlights={targetCount.highlights}
            notes={targetCount.notes}
            busy={exportSelection.isPending}
            error={exportSelection.error ? String(exportSelection.error) : null}
            onCancel={() => {
              setExporting(null);
              exportSelection.reset();
            }}
            onConfirm={(path, format) =>
              exportSelection.mutate(
                {
                  ...exportPayload(target),
                  path,
                  name: target.length === 1 ? (target[0]?.book.title ?? "") : "笔记",
                  format,
                },
                { onSuccess: () => setExporting(null) },
              )
            }
          />
        </Suspense>
      )}
    </div>
  );
}

function Toolbar({
  query,
  onQuery,
  filter,
  onFilter,
  total,
  visible,
  narrowed,
  managing,
  onToggleManaging,
  onExport,
}: {
  query: string;
  onQuery: (value: string) => void;
  filter: FilterValue;
  onFilter: (value: FilterValue) => void;
  total: { highlights: number; notes: number };
  visible: { highlights: number; notes: number };
  narrowed: boolean;
  managing: boolean;
  onToggleManaging: () => void;
  onExport: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="border-hairline flex flex-wrap items-center gap-3 border-b px-4 py-3">
      <div className="relative min-w-[180px] flex-1">
        <MagnifyingGlass
          size={14}
          className="text-text-3 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索原文、笔记或书名"
          aria-label="搜索标注"
          className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 h-8 w-full rounded-md border pr-8 pl-8 text-[13px] transition-colors focus-visible:outline-none"
        />
        {query !== "" && (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => onQuery("")}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Segmented control; the highlight is one element shared between the two
          cells, so the fill slides rather than cross-fading. The cells carry
          `aria-pressed` themselves — the shelf's layout switch does the same,
          and a `role="group"` wrapper on a `div` is not worth a `fieldset`. */}
      <div className="glass flex items-center rounded-full p-0.5">
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onFilter(option.value)}
              className={cn(
                "focus-visible:focus-ring relative flex h-7 items-center rounded-full px-3 text-[12.5px] transition-colors",
                active ? "text-text-1" : "text-text-3 hover:text-text-2",
              )}
            >
              {active && (
                <motion.span
                  layoutId="notes-filter-pill"
                  className="bg-surface-3 shadow-glass absolute inset-0 rounded-full"
                  transition={reduce ? { duration: 0 } : SPRING.layout}
                />
              )}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>

      <p className="text-text-3 shrink-0 text-[12px]">
        {narrowed
          ? `${visible.highlights} / ${total.highlights} 条`
          : `${total.highlights} 条标注 · ${total.notes} 条笔记`}
      </p>

      {/* Exporting the screen is the reader's plain reading of "导出" — what is
          on it, filtered and all. Exporting a *selection* is the batch bar's
          job, and says so. */}
      <GlassButton
        size="sm"
        variant="subtle"
        disabled={visible.highlights === 0}
        onClick={onExport}
      >
        <Export size={14} /> 导出
      </GlassButton>
      {/* Disabled with nothing to manage: entering a selection mode over an
          empty list is a mode with no way to leave except the bar's 完成, which
          reads as a dead end. */}
      <GlassButton
        size="sm"
        variant={managing ? "primary" : "subtle"}
        disabled={!managing && visible.highlights === 0}
        onClick={onToggleManaging}
      >
        <CheckSquare size={14} /> {managing ? "完成" : "选择"}
      </GlassButton>

      {/* A resident live region carrying one sentence, rather than a region
          inserted with its text already in it: screen readers announce changes
          to a region they already know about far more reliably than they
          announce a region that arrived mid-sentence. */}
      <output className="sr-only">
        {narrowed
          ? `筛选后 ${visible.highlights} 条标注，其中 ${visible.notes} 条写了笔记`
          : `共 ${total.highlights} 条标注，其中 ${total.notes} 条写了笔记`}
      </output>
    </div>
  );
}

/** One book's highlights, under a header that names the book. */
function BookSection({
  group,
  onOpen,
  managing,
  selected,
  onToggleSelect,
}: {
  group: BookNotes;
  onOpen: (entry: NoteEntry) => void;
  managing: boolean;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
}) {
  const { book, entries } = group;
  return (
    <section className="px-4 pt-4 first:pt-3">
      <header className="flex items-center gap-3 px-1 pb-2">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className="border-hairline h-9 w-[27px] shrink-0 rounded-[3px] border object-cover"
          />
        ) : (
          <span className="border-hairline text-text-3 flex h-9 w-[27px] shrink-0 items-center justify-center rounded-[3px] border">
            <BookOpen size={13} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-text-1 truncate text-[13.5px] font-medium" title={book.title}>
            {displayTitle(book.title)}
          </h2>
          <p className="text-text-3 truncate text-[11.5px]">{authorLine(book)}</p>
        </div>
        <span className="text-text-3 shrink-0 text-[11.5px]">{entries.length} 条</span>
      </header>

      <ul className="space-y-0.5">
        {entries.map((entry) => (
          <NoteRow
            key={entry.annotation.id}
            entry={entry}
            onOpen={onOpen}
            managing={managing}
            selected={selected.has(entry.annotation.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * One highlight: the passage, where it lives, and the note hanging off it.
 *
 * The row owns its own mutations rather than taking them as props, because the
 * cache patch a note write performs is keyed by book — a single shared mutation
 * would have to be re-pointed at a different book for every row.
 *
 * In manage mode the row becomes one big target: an overlay button carries the
 * gesture and takes its name from the passage, and the content underneath drops
 * pointer events so a click anywhere on the row — passage, meta line or note —
 * lands on it. The passage stops being a button in that mode rather than
 * becoming a second one, because a focusable control buried under an overlay is
 * reachable by Tab and clickable by nobody.
 */
function NoteRow({
  entry,
  onOpen,
  managing,
  selected,
  onToggleSelect,
}: {
  entry: NoteEntry;
  onOpen: (entry: NoteEntry) => void;
  managing: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const { annotation, book } = entry;
  const setNote = useSetAnnotationNote(book.id);
  const remove = useDeleteAnnotation(book.id);
  const busy = setNote.isPending || remove.isPending;
  const [editing, setEditing] = useState(false);
  /** Names the overlay button after the passage it stands for: an empty overlay
   *  has no accessible name of its own, and the passage is the one thing that
   *  tells this row apart from its neighbours. */
  const passageId = useId();

  return (
    <li
      className={cn(
        "relative flex gap-2.5 rounded-lg px-2 py-2.5 transition-colors",
        selected ? "bg-surface-2" : "hover:bg-surface-1",
      )}
    >
      {managing && (
        <button
          type="button"
          aria-pressed={selected}
          aria-labelledby={passageId}
          onClick={() => onToggleSelect(annotation.id)}
          className="focus-visible:focus-ring absolute inset-0 z-10 rounded-lg"
        />
      )}

      {/* The ink the passage carries in the book, so a row is recognisable as
          the highlight it is rather than as a generic quotation. */}
      <span
        aria-hidden
        className="pointer-events-none w-[3px] shrink-0 self-stretch rounded-full"
        style={{ background: inkColor(annotation) }}
      />
      <div className={cn("min-w-0 flex-1", managing && "pointer-events-none")}>
        {managing ? (
          <p id={passageId} className="text-text-1 text-[13px] leading-relaxed">
            {annotation.text}
          </p>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(entry)}
            title="在书中打开"
            className="focus-visible:focus-ring text-text-1 block w-full rounded-md text-left text-[13px] leading-relaxed"
          >
            {annotation.text}
          </button>
        )}

        <div className="mt-1 flex items-center gap-1">
          <p className="text-text-3 flex-1 text-[11px]">
            第 {annotation.chapterIdx + 1} {unitLabel(book.format)}
          </p>
          {managing ? (
            <CheckMark selected={selected} />
          ) : (
            <>
              {/* An explicit way into the note. Clicking the note's own text has
                  always opened the editor, but nothing said so — a pencil next
                  to the other two row actions is the affordance the text could
                  not be. Disabled while the field is open, so it does not read
                  as a second, competing action. */}
              <button
                type="button"
                aria-label="编辑笔记"
                title="编辑笔记"
                disabled={busy || editing}
                onClick={() => setEditing(true)}
                className="focus-visible:focus-ring text-text-3 hover:text-text-1 rounded p-1.5 transition-colors disabled:opacity-40"
              >
                <NotePencil size={13} />
              </button>
              <button
                type="button"
                aria-label="在书中打开"
                title="在书中打开"
                onClick={() => onOpen(entry)}
                className="focus-visible:focus-ring text-text-3 hover:text-text-1 rounded p-1.5 transition-colors"
              >
                <ArrowSquareOut size={13} />
              </button>
              <button
                type="button"
                aria-label="删除标注"
                title="删除标注"
                disabled={busy}
                onClick={() => remove.mutate(annotation.id)}
                className="focus-visible:focus-ring text-text-3 hover:text-danger rounded p-1.5 transition-colors disabled:opacity-50"
              >
                <Trash size={13} />
              </button>
            </>
          )}
        </div>

        {/* In manage mode the note is read-only prose rather than a cell: the
            reader still needs it to judge the row, but there is nothing to edit
            on the way to a delete. */}
        {managing ? (
          annotation.note !== null && (
            <p className="border-hairline text-text-2 mt-1.5 border-l pl-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
              {annotation.note}
            </p>
          )
        ) : (
          <div className="mt-1.5">
            <NoteCell
              note={annotation.note}
              disabled={busy}
              editing={editing}
              onEditingChange={setEditing}
              onSave={(note) => setNote.mutate({ id: annotation.id, note })}
            />
          </div>
        )}
      </div>
    </li>
  );
}

/** The selected state of a row in manage mode — the same mark the shelf's tiles
 *  wear, so the two selection modes read as one gesture. */
function CheckMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        selected ? "border-accent bg-accent text-on-accent" : "border-hairline",
      )}
    >
      <motion.span
        initial={false}
        animate={{ scale: selected ? 1 : 0.4, opacity: selected ? 1 : 0 }}
        transition={SPRING.tap}
        className="flex"
      >
        <Check size={12} weight="bold" />
      </motion.span>
    </span>
  );
}

/**
 * Nothing to show — either because nothing was ever marked, or because the
 * filter excluded everything. The two want different sentences: one is a
 * starting point, the other is a dead end with a way out of it.
 */
function Board({
  narrowed,
  hasAny,
  onClear,
}: {
  narrowed: boolean;
  hasAny: boolean;
  onClear: () => void;
}) {
  if (narrowed && hasAny) {
    return (
      <EmptyState
        icon={<MagnifyingGlass size={22} weight="duotone" />}
        title="没有匹配的标注"
        description="换一个词试试，或者把筛选放宽。"
        action={
          <button
            type="button"
            onClick={onClear}
            className="press focus-visible:focus-ring border-hairline text-text-2 hover:text-text-1 rounded-md border px-3.5 py-1.5 text-[13px] transition-colors"
          >
            清空筛选
          </button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={<Notebook size={22} weight="duotone" />}
      title="还没有标注"
      description="在阅读器里选中正文就能划线和写笔记，它们会按书归到这里。"
    />
  );
}
