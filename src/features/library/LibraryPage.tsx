import type { DragEvent } from "react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Trash, Upload } from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { GlassDialog, OverlayPortal } from "@/components/glass/overlay";
import { ContinueReadingCard } from "@/features/library/ContinueReadingCard";
import { DropImportOverlay } from "@/features/library/DropImportOverlay";
import { ImportSummary } from "@/features/library/ImportSummary";
import { pickBookFiles, pickPaths } from "@/features/library/importFiles";
import { ShelfBatchBar } from "@/features/library/ShelfBatchBar";
import { ShelfGrid } from "@/features/library/ShelfGrid";
import { ShelfHeader } from "@/features/library/ShelfHeader";
import { ShelfToolbar } from "@/features/library/ShelfToolbar";
import { TagBar } from "@/features/library/TagBar";
import { DeleteBookDialog } from "@/features/library/BookCard";
import { pickContinueReading, sortOptions, titleForFilter } from "@/features/library/format";
import { shelfSections } from "@/features/library/group";
import { batchNeedsPassword } from "@/features/library/pack";
import { editionTwins, type Edition } from "@/features/library/migrate";
import {
  NO_FILTERS,
  buildBookQuery,
  resolveTagFilter,
  type LibraryFilter,
  type ShelfFilters,
} from "@/features/library/shelfQuery";
import { useShelfSelection } from "@/features/library/useShelfSelection";
import { useDragDropImport } from "@/hooks/useDragDropImport";
import { useShelfWindow } from "@/hooks/useShelfWindow";
import { useAssignTags, useTags } from "@/hooks/useTags";
import {
  useBooks,
  useBookFacets,
  useDeleteBook,
  useDeleteBooks,
  useDeleteProgress,
  useEmptyTrash,
  useExportBookFile,
  useExportPack,
  useImportBooks,
  useImportFiles,
  useImportProgress,
  useImportShelfSync,
  useLibraryStats,
  usePdfCovers,
  usePurgeBooks,
  useRestoreBooks,
  useSetFavorite,
  useSetFavorites,
  useUpdateBook,
} from "@/hooks/useLibrary";
import { useMigrateEdition } from "@/hooks/useMigrateEdition";
import { showToast } from "@/stores/toasts";
import { useMotion } from "@/lib/motion";
import { isDesktopRuntime } from "@/lib/ipc";
import { useBookHandoff } from "@/stores/book-handoff";
import { useSettings, type ShelfView } from "@/stores/settings";
import type { BookQuery, BookSummary, ImportOutcome } from "@/types/ipc";

// Dialog chunks load on first open; local disk, so no spinner is needed.
const ExportPackDialog = lazy(() =>
  import("@/features/library/PackDialog").then((m) => ({ default: m.ExportPackDialog })),
);
const PackPasswordDialog = lazy(() =>
  import("@/features/library/PackDialog").then((m) => ({ default: m.PackPasswordDialog })),
);
const SourceDialog = lazy(() =>
  import("@/features/source/SourceDialog").then((m) => ({ default: m.SourceDialog })),
);
const TagDialog = lazy(() =>
  import("@/features/library/TagDialog").then((m) => ({ default: m.TagDialog })),
);
const ClippingsDialog = lazy(() =>
  import("@/features/library/ClippingsDialog").then((m) => ({ default: m.ClippingsDialog })),
);
const BookMetaDialog = lazy(() =>
  import("@/features/library/BookMetaDialog").then((m) => ({ default: m.BookMetaDialog })),
);
/** A whole-shelf scan the reader opens by hand — keep it out of the first load. */
const DuplicateDialog = lazy(() =>
  import("@/features/library/DuplicateDialog").then((m) => ({
    default: m.DuplicateDialog,
  })),
);
/** Only ever shown after a successful import, so it is worth its own chunk. */
const MigrateEditionDialog = lazy(() =>
  import("@/features/library/MigrateEditionDialog").then((m) => ({
    default: m.MigrateEditionDialog,
  })),
);

/**
 * Where the shelf was left, per filter.
 *
 * The router is a memory router, so the browser's own scroll restoration never
 * applies, and this list is unmounted on every trip into the reader — without
 * this the reader comes back to the top of a shelf they had scrolled halfway
 * down, which also means the cover flying home has no tile to land on. Module
 * scope rather than a store: it is a number per view, and it should not survive
 * a reload.
 */
const shelfScroll = new Map<LibraryFilter, number>();

/** One shared empty list, so the books keep their identity while the query is
 *  still loading — a fresh `[]` per render is a new dependency everywhere it
 *  is used. */
const NO_BOOKS: BookSummary[] = [];

/**
 * The shelf. Owns the scroll position and the ways a book arrives or leaves;
 * the chrome it is made of lives in its own modules.
 */
export function LibraryPage({ filter }: { filter: LibraryFilter }) {
  const navigate = useNavigate();
  const meta = titleForFilter(filter);
  /** The bin: the same page reading a different set of rows. Declared first
   *  because half of what follows asks it something. */
  const trashed = filter === "trash";
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** The card grid. Owned here and handed to `useShelfWindow`, which measures
   *  it: a ref returned by a hook cannot be told apart from the data beside it. */
  const gridRef = useRef<HTMLDivElement>(null);
  // Before paint, or the reader sees the top of the shelf for a frame and then
  // a jump. The place is remembered as it is scrolled rather than on unmount:
  // the route transition keeps the outgoing shelf mounted until its exit
  // animation ends, so a save in the cleanup lands *after* the incoming shelf
  // has already restored — which is exactly nothing.
  const remember = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) shelfScroll.set(filter, scroller.scrollTop);
  }, [filter]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = shelfScroll.get(filter) ?? 0;
    // Not saved in the cleanup. The outgoing shelf outlives the incoming one —
    // the route keeps it for the length of its exit animation — and by then
    // `popLayout` has taken it out of flow, so the position it reports is a
    // pixel off. Written there it would overwrite the value the incoming shelf
    // has already restored, and the next visit would land a pixel away.
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [filter, remember]);

  /**
   * Real input on the shelf ends a cover that is still in the air.
   *
   * A flight is aimed once (`useLandingBox`) and lands on the slot its tile had
   * when it left. A scroll under it therefore ends with the cover hopping from
   * the slot it landed on to wherever its tile actually went — measured: a 60px
   * scroll left the flight at y=347 and its tile at y=288, and the cover image
   * jumped those 59px the instant the handoff ended. Dropping the handoff at the
   * gesture moves that discontinuity to the moment the reader started moving the
   * shelf: the content under the cover is moving anyway, and the cover is back on
   * its own tile in the same frame.
   *
   * Driven by input events rather than by `scroll`, because the shelf restores
   * its own scroll position as it mounts — and that fires `scroll` too, which
   * would cancel every flight home at birth.
   *
   * Only a flight *coming home* (`side === "reader"`): on the way out the cover
   * is heading for the reader's header, which is not moving, and its tile is on
   * a page that is already on its way out — cancelling there would jump the
   * cover back to a slot that is disappearing.
   */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const drop = () => {
      const handoff = useBookHandoff.getState();
      if (handoff.id !== null && handoff.side === "reader") handoff.end();
    };
    scroller.addEventListener("wheel", drop, { passive: true });
    scroller.addEventListener("pointerdown", drop);
    return () => {
      scroller.removeEventListener("wheel", drop);
      scroller.removeEventListener("pointerdown", drop);
    };
  }, []);

  /** Leaving for the reader: the place is saved here, synchronously, because a
   *  scroll listener only reports the last position it was told about.
   *
   *  A trashed book is not openable. The bin renders cards as checkboxes, so
   *  this cannot be reached from the grid — it is the guard for the one path
   *  that could: a card that was already mounted when the shelf changed. */
  const openBook = useCallback(
    (target: BookSummary) => {
      if (trashed) return;
      remember();
      navigate(`/reader?book=${target.id}`);
    },
    [navigate, remember, trashed],
  );

  /**
   * How this shelf is arranged, from the settings store — so a trip into the
   * reader, which unmounts the shelf, comes back to the same view, and so
   * does a restart. Each filter has its own record: see `ShelfView`.
   *
   * `collapsed` is deliberately *not* in it. Which piles are folded shut is a
   * gesture of the moment, and a shelf that comes back with piles closed tells
   * the reader nothing about what is underneath them.
   */
  const view = useSettings((s) => s.shelfViews[filter]);
  const setShelfView = useSettings((s) => s.setShelfView);
  const update = (patch: Partial<ShelfView>) => setShelfView(filter, patch);
  const { search, sort, descending, group } = view;
  /** True while the shelf reads the backend's order backwards. Every order
   *  arrives in its own direction — 最近添加 is already descending, 书名
   *  already ascending — and `descending` names the way the reader wants it,
   *  so the flip is the difference between the two. Reversing the array gives
   *  all seven orders both directions for free, with no second `ORDER BY`
   *  per option. */
  const defaultDesc = sortOptions.find((option) => option.value === sort)?.desc ?? false;
  const reversed = defaultDesc !== descending;
  /** The piles whose cards are folded away, by section key.
   *
   *  Not cleared when the grouping changes: keys from another dimension simply
   *  match nothing, and coming back to this one finds the piles as they were. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<BookSummary | null>(null);
  const [lockedBatch, setLockedBatch] = useState<string[] | null>(null);
  const [lastOutcomes, setLastOutcomes] = useState<ImportOutcome[] | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The import-clippings sheet; a file picker plus a preview lives inside. */
  const [clippingsOpen, setClippingsOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  /** True when the import button was clicked in the browser, which has no backend. */
  /** Books the label sheet is open for; one book = edit, several = add. */
  const [tagTarget, setTagTarget] = useState<BookSummary[] | null>(null);
  /** The book whose metadata sheet is open; one book at a time, since a title
   *  is not something a multi-selection could share. */
  const [metaTarget, setMetaTarget] = useState<BookSummary | null>(null);
  /** A re-import the shelf thinks is a new edition of something already here.
   *  One at a time: it is a question about one book, and a queue of them would
   *  be a queue of decisions the reader did not ask to make. */
  const [edition, setEdition] = useState<Edition | null>(null);
  const [editionError, setEditionError] = useState<string | null>(null);
  /** The 筛选 panel's narrowing. Not persisted: it is a way of looking at the
   *  shelf right now, and a saved one would be a shelf of its own (that is what
   *  tags are for). */
  const [filters, setFilters] = useState<ShelfFilters>(NO_FILTERS);
  /** The 清空回收站 confirmation, which is the only irreversible action here. */
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);

  const tags = useTags();
  /** The label this shelf is narrowed to; see `resolveTagFilter` for why a
   *  remembered label that no longer exists falls back to the whole shelf. */
  const tag = resolveTagFilter(view.tag, tags.data);

  const query: BookQuery = useMemo(
    () => buildBookQuery(filter, sort, search, tag, filters),
    [filter, sort, search, tag, filters],
  );

  const books = useBooks(query);
  const facets = useBookFacets(query);
  const stats = useLibraryStats();
  const assignTags = useAssignTags();
  const importBooks = useImportBooks();
  const importFiles = useImportFiles();
  const migrateEdition = useMigrateEdition();
  const exportPack = useExportPack();
  const exportFile = useExportBookFile();
  const deleteBook = useDeleteBook();
  const setFavorite = useSetFavorite();
  const setFavorites = useSetFavorites();
  const deleteBooks = useDeleteBooks();
  const restoreBooks = useRestoreBooks();
  const purgeBooks = usePurgeBooks();
  const emptyTrash = useEmptyTrash();
  const updateBook = useUpdateBook();
  const progress = useImportProgress();
  const deleteProgress = useDeleteProgress();
  // Each book shows up as it lands; without this the shelf waits for the
  // whole batch, which on 75 books is most of a minute of a shelf that has
  // not changed.
  useImportShelfSync();
  // A trashed book needs no cover: nothing on the bin's grid opens, and the
  // rasteriser is the expensive half of drawing a PDF tile.
  usePdfCovers(trashed ? NO_BOOKS : (books.data ?? []));

  const list = useMemo(
    () => (reversed ? (books.data ?? NO_BOOKS).toReversed() : (books.data ?? NO_BOOKS)),
    [books.data, reversed],
  );
  /**
   * The shelf as piles.
   *
   * `cards` is the same books in a different order — every dimension is
   * exclusive, so nothing is counted twice and the grid keeps rendering one
   * card per book, keyed by book id. `sections` is where each pile begins, and
   * that is what the window cuts the list into lines with: a heading takes a
   * line of its own and the cards of a pile are cut *within* it, so a pile
   * always starts on a fresh line.
   *
   * The order is chosen first (`list`) and grouping reorders the piles, never
   * the books inside them — the two controls answer different questions.
   */
  const { cards, sections } = useMemo(() => shelfSections(list, group), [list, group]);
  const shelfLayout = useSettings((s) => s.shelfLayout);
  const setShelfLayout = useSettings((s) => s.setShelfLayout);
  const continueReading = filter === "all" ? pickContinueReading(list) : undefined;

  /**
   * Only the lines the viewport can reach are rendered (see `useShelfWindow`);
   * the rest of the list is held open by the two spacers in `ShelfGrid`.
   *
   * Declared *here*, after the scroll restore above: the window has to be
   * measured from the restored position. Effects run in the order they are
   * written, and a window measured before the restore would be the top of the
   * list — which is where the cover flying home would then fail to find a tile.
   *
   * The grouping is *not* part of the content key: folding a pile changes what
   * is drawn but not which books are on the shelf, so nothing should replay its
   * entrance over it.
   */
  const shelf = useShelfWindow(
    scrollerRef,
    gridRef,
    sections,
    cards.length,
    collapsed,
    `${filter}|${sort}|${reversed}|${group}|${search}|${tag ?? ""}`,
    shelfScroll.get(filter) ?? 0,
    shelfLayout,
  );
  /**
   * The label line is part of every tile in a list that has labels anywhere, so
   * that rows keep one height — the window's arithmetic has no way to know that
   * the fourth card of a row is a line taller than its neighbours. Taken over
   * the whole list rather than the window, because a window that scrolls into
   * tagged books would otherwise change the row height under the reader.
   */
  const tagRow = useMemo(() => cards.some((book) => book.tags.length > 0), [cards]);

  const selection = useShelfSelection({
    list: cards,
    // One transaction per batch rather than one per book: twenty selected
    // books used to mean twenty IPC round trips, and each of those refreshed
    // the whole book list. The batch mutations refresh it once.
    onFavorite: (ids, favorite) => setFavorites.mutate({ ids, favorite }),
    // The bar's danger button means two different things, and the shelf knows
    // which: on a shelf it moves books to the bin, in the bin it removes them.
    onDelete: (ids) => (trashed ? purgeBooks.mutate(ids) : deleteBooks.mutate(ids)),
    onRestore: (ids) => restoreBooks.mutate(ids),
    onRequestTags: setTagTarget,
    // Nothing on a trashed book can be opened, tagged or favourited, so the
    // bin is a selection surface and only a selection surface.
    alwaysManaging: trashed,
  });

  // Native dialog picks and window drops both funnel into the same mutation.
  // An encrypted pack cannot be opened without a password, so the batch is
  // held back until one is supplied rather than failing the file.
  const importPaths = (paths: string[], password?: string) => {
    if (paths.length === 0) return;
    if (password === undefined && batchNeedsPassword(paths)) {
      setLockedBatch(paths);
      return;
    }
    setLockedBatch(null);
    importBooks.mutate(
      { paths, password },
      {
        onSuccess: (outcomes) => {
          setLastOutcomes(outcomes);
          void offerMigration(outcomes);
        },
      },
    );
  };

  /**
   * Whether the run just made a second edition of a book already on the shelf,
   * and if so, ask before anything is merged.
   *
   * The shelf is refetched here rather than read from `books.data`: the import
   * invalidated it, and the new rows are what the match needs — their authors
   * are half of it.
   */
  const offerMigration = async (outcomes: ImportOutcome[]) => {
    const created = outcomes
      .filter(
        (outcome): outcome is Extract<ImportOutcome, { kind: "imported" }> =>
          outcome.kind === "imported",
      )
      .map((outcome) => outcome.id);
    if (created.length === 0) return;
    const { data: rows } = await books.refetch();
    const all = rows ?? [];
    const [first] = editionTwins(
      all.filter((book) => created.includes(book.id)),
      all,
    );
    if (first) setEdition(first);
  };

  const keepBoth = () => {
    setEdition(null);
    setEditionError(null);
  };

  const runMigration = (pair: Edition) => {
    setEditionError(null);
    migrateEdition.mutate(
      { from: pair.from.id, to: pair.to.id },
      {
        onSuccess: (moved) => {
          setEdition(null);
          const lost = moved.unlocated > 0 ? `，有 ${moved.unlocated} 条在新版本里找不到原文` : "";
          showToast("success", `已迁移 ${moved.annotations} 条标注${lost}`);
        },
        onError: (error) => setEditionError(String(error)),
      },
    );
  };

  // Tauri intercepts native drops and reports absolute file paths.
  const dragging = useDragDropImport((paths) => importPaths(paths));

  // The web build has no native drag-drop channel, but the page can see an
  // HTML5 one: same overlay, same mutation, only the source of the files
  // differs. `dragleave` fires for every child the pointer crosses, so it only
  // counts when the pointer leaves the shelf itself.
  const [dropping, setDropping] = useState(false);
  const browserDrop = isDesktopRuntime
    ? {}
    : {
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDropping(true);
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropping(false);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDropping(false);
          const files = [...event.dataTransfer.files];
          if (files.length > 0) {
            importFiles.mutate(files, { onSuccess: (outcomes) => setLastOutcomes(outcomes) });
          }
        },
      };

  // Both builds import; they only differ in what the picker hands over. The
  // desktop gets absolute paths from the native dialog, the browser gets the
  // `File`s themselves, and the shelf stores the same book either way.
  const startImport = () => {
    if (!isDesktopRuntime) {
      void pickBookFiles().then((files) => {
        if (files.length > 0) {
          importFiles.mutate(files, { onSuccess: (outcomes) => setLastOutcomes(outcomes) });
        }
      });
      return;
    }
    void pickPaths().then(importPaths);
  };

  const m = useMotion();
  const picking = importBooks.isPending || importFiles.isPending;

  return (
    <div className="flex h-full flex-col" {...browserDrop}>
      <ShelfHeader
        filter={filter}
        meta={meta}
        importing={picking}
        onClippings={() => setClippingsOpen(true)}
        onSource={() => setSourceOpen(true)}
        onImport={startImport}
        trashEmpty={!stats.data || stats.data.trashed === 0}
        onEmptyTrash={() => setEmptyTrashOpen(true)}
      />

      <div
        ref={scrollerRef}
        data-shelf-scroller
        className="flex-1 overflow-y-auto px-8 pb-8 [overflow-anchor:none]"
      >
        {filter === "all" && <ContinueReadingCard book={continueReading} onOpen={openBook} />}

        {filter === "tags" && (
          <TagBar
            tags={tags.data ?? []}
            selected={tag}
            onSelect={(next) => update({ tag: next })}
          />
        )}

        <ShelfToolbar
          search={search}
          onSearch={(value) => update({ search: value })}
          sort={sort}
          onSort={(value) => update({ sort: value })}
          descending={descending}
          onDescending={(next) => update({ descending: next })}
          group={group}
          onGroup={(value) => update({ group: value })}
          filters={filters}
          onFilters={setFilters}
          facets={facets.data}
          layout={shelfLayout}
          onLayout={setShelfLayout}
          managing={selection.managing}
          onToggleManaging={() => (selection.managing ? selection.exit() : selection.begin())}
          onDuplicates={() => setDuplicatesOpen(true)}
          trash={trashed}
          stats={stats.data}
        />

        {/* The headings live inside the grid, as lines of it — see
            `ShelfGrid`. This used to be a sticky bar floating over the top,
            which cost the window nothing but could only ever name one pile at
            a time: the boundary had to go past before the reader learned what
            was under it. A heading in the flow shows the pile *and* where the
            next one starts, which is the thing a reader is actually looking
            for, and it was worth rewriting the window's arithmetic for. */}

        <ShelfGrid
          pending={books.isPending}
          error={books.error}
          search={search}
          list={cards}
          shelf={shelf}
          gridRef={gridRef}
          layout={shelfLayout}
          tagRow={tagRow}
          collapsed={collapsed}
          onToggleSection={toggleSection}
          managing={selection.managing}
          selected={selection.selected}
          busy={
            setFavorite.isPending ||
            setFavorites.isPending ||
            deleteBook.isPending ||
            deleteBooks.isPending ||
            restoreBooks.isPending ||
            purgeBooks.isPending
          }
          onToggleSelect={selection.toggle}
          onOpen={openBook}
          onToggleFavorite={(target) =>
            setFavorite.mutate({ id: target.id, favorite: !target.favorite })
          }
          onAskDelete={setDeleteTarget}
          onAskExport={setExportTarget}
          // No dialog: a download has nothing to choose. Failures surface
          // through the shared mutation toast, like every other write.
          onExportFile={(target) => exportFile.mutate({ id: target.id })}
          onEditTags={(target) => setTagTarget([target])}
          onEditMeta={setMetaTarget}
          onImport={startImport}
          // The shelf's own way out of a search that matched nothing. It used
          // to be the 13px ✕ inside the search field and nothing else, so a
          // reader who searched from the 标签 shelf had no visible next step.
          onClearSearch={() => update({ search: "" })}
          // The shelf's own way out of a failed read. The query is the only
          // thing that can be wrong here, and re-asking it is the one action
          // that can help — a reader cannot retry by reloading, this is a
          // desktop app with no address bar.
          onRetry={() => void books.refetch()}
          empty={
            trashed ? (
              // A bin with nothing in it must not offer the import button the
              // empty shelf does: books do not arrive here, they are sent here.
              <EmptyState
                className="min-h-[40vh]"
                icon={<Trash size={26} weight="duotone" />}
                title="回收站是空的"
                description="删掉的书会先放在这里，可以随时恢复。"
              />
            ) : undefined
          }
        />
      </div>

      <ShelfBatchBar
        anchorRef={scrollerRef}
        selection={selection}
        busy={{
          favorite: setFavorites.isPending,
          delete: deleteBooks.isPending || purgeBooks.isPending,
        }}
        mode={trashed ? "trash" : "shelf"}
      />

      {sourceOpen && (
        <Suspense fallback={null}>
          <SourceDialog open onClose={() => setSourceOpen(false)} />
        </Suspense>
      )}

      {clippingsOpen && (
        <Suspense fallback={null}>
          {/* Unmounted when closed: the sheet holds a picked path and a preview
              report, and reopening it should start from an empty picker. */}
          <ClippingsDialog open onClose={() => setClippingsOpen(false)} />
        </Suspense>
      )}

      {duplicatesOpen && (
        <Suspense fallback={null}>
          <DuplicateDialog
            open
            onClose={() => setDuplicatesOpen(false)}
            onLocate={(term) => {
              setDuplicatesOpen(false);
              update({ search: term });
            }}
          />
        </Suspense>
      )}

      <AnimatePresence>{(dragging || dropping) && <DropImportOverlay />}</AnimatePresence>

      {picking && progress && (
        <OverlayPortal>
          <motion.div
            initial={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={m.panel}
            className="glass-2 shadow-panel text-text-1 fixed right-6 bottom-6 z-40 flex items-center gap-3 rounded-2xl px-5 py-4"
          >
            <Upload size={16} className="text-accent" />
            <span className="text-sm">
              正在导入 {progress.done}/{progress.total}
            </span>
          </motion.div>
        </OverlayPortal>
      )}

      {/* A batch delete with books in it is seconds of work on a big shelf —
          enough that a disabled bar and a shelf that has not changed yet reads
          as a frozen page. The count comes from `book://delete-progress`, one
          event per book, the same contract import uses. A one-book delete is
          excluded: a counter reading 1/1 is noise, and its dialog already
          shows a pending state on the confirm button. */}
      {deleteBooks.isPending && deleteProgress && deleteProgress.total > 1 && (
        <OverlayPortal>
          <motion.div
            initial={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={m.panel}
            className="glass-2 shadow-panel text-text-1 fixed right-6 bottom-6 z-40 flex items-center gap-3 rounded-2xl px-5 py-4"
            data-delete-progress
          >
            <Trash size={16} className="text-danger" />
            <span className="text-sm">
              正在删除 {deleteProgress.done}/{deleteProgress.total}
            </span>
          </motion.div>
        </OverlayPortal>
      )}

      {lastOutcomes && (
        <ImportSummary outcomes={lastOutcomes} onClose={() => setLastOutcomes(null)} />
      )}

      {lockedBatch && (
        <PackPasswordDialog
          count={lockedBatch.length}
          busy={importBooks.isPending}
          onCancel={() => setLockedBatch(null)}
          onConfirm={(password) => importPaths(lockedBatch, password)}
        />
      )}

      {edition && (
        <Suspense fallback={null}>
          <MigrateEditionDialog
            edition={edition}
            busy={migrateEdition.isPending}
            error={editionError}
            onMigrate={runMigration}
            onKeepBoth={keepBoth}
          />
        </Suspense>
      )}

      {exportTarget && (
        <Suspense fallback={null}>
          <ExportPackDialog
            book={exportTarget}
            busy={exportPack.isPending || exportFile.isPending}
            error={
              exportPack.error
                ? String(exportPack.error)
                : exportFile.error
                  ? String(exportFile.error)
                  : null
            }
            onCancel={() => {
              setExportTarget(null);
              exportPack.reset();
              exportFile.reset();
            }}
            // Both go through the same dialog and the same save panel; only the
            // command behind them differs — the book's own bytes, or a pack
            // that also carries what was read and marked in it.
            onConfirm={({ book, path, kind, password }) => {
              const done = { onSuccess: () => setExportTarget(null) };
              if (kind === "original") exportFile.mutate({ id: book.id, path }, done);
              else exportPack.mutate({ id: book.id, path, password }, done);
            }}
          />
        </Suspense>
      )}

      {tagTarget && (
        <Suspense fallback={null}>
          {/* Keyed by the target: reopening for another book must not inherit
              the previous book's chip selection. */}
          <TagDialog
            key={tagTarget.map((book) => book.id).join(",")}
            books={tagTarget}
            allTags={tags.data ?? []}
            busy={assignTags.isPending}
            onCancel={() => setTagTarget(null)}
            onSave={(change) =>
              assignTags.mutate(
                { ids: tagTarget.map((book) => book.id), ...change },
                { onSuccess: () => setTagTarget(null) },
              )
            }
          />
        </Suspense>
      )}

      {metaTarget && (
        <Suspense fallback={null}>
          <BookMetaDialog
            book={metaTarget}
            busy={updateBook.isPending}
            onCancel={() => {
              setMetaTarget(null);
              // A failed save left its error on the mutation; the next open must
              // not inherit it.
              updateBook.reset();
            }}
            onSave={(patch, coverUrl) =>
              updateBook.mutate(
                { id: metaTarget.id, patch, coverUrl },
                { onSuccess: () => setMetaTarget(null) },
              )
            }
          />
        </Suspense>
      )}

      <DeleteBookDialog
        book={deleteTarget}
        busy={deleteBook.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(book) =>
          deleteBook.mutate(book.id, {
            onSuccess: () => setDeleteTarget(null),
          })
        }
      />

      {/* The one action in this page with no undo behind it, so it is the one
          that asks. The count is in the sentence because "清空" alone does not
          say how much is about to go. */}
      <GlassDialog
        open={emptyTrashOpen}
        onOpenChange={setEmptyTrashOpen}
        title="清空回收站？"
        description={`回收站里的 ${stats.data?.trashed ?? 0} 本书会被彻底删除，书籍文件、封面、笔记和阅读进度会一并删除，此操作无法撤销。`}
        widthClass="w-[min(92vw,440px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setEmptyTrashOpen(false)}
            disabled={emptyTrash.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            disabled={emptyTrash.isPending}
            onClick={() =>
              emptyTrash.mutate(undefined, {
                onSuccess: () => {
                  setEmptyTrashOpen(false);
                  selection.exit();
                },
              })
            }
          >
            清空
          </GlassButton>
        </div>
      </GlassDialog>
    </div>
  );
}
