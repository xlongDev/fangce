import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, isDesktopRuntime, onDeleteProgress, onImportProgress } from "@/lib/ipc";
import { demoBooks, demoEnabled, demoFacets, demoLibraryStats } from "@/lib/demo";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { renderFirstPagePng } from "@/lib/pdf";
import { showToast } from "@/stores/toasts";
import type {
  BookInfoSummary,
  CleanupResult,
  CoverManagerData,
  CoverOpResult,
  BookMetadataPatch,
  BookQuery,
  BookSummary,
  DeleteProgress,
  ImportProgress,
  LibraryFacets,
  Operation,
  StorageSummary,
} from "@/types/ipc";

/** Shelf contents for one filter/sort/search combination. */
export function useBooks(query: BookQuery) {
  return useQuery<BookSummary[]>({
    // Every narrowing field is part of the key, or switching a filter would
    // show the previous shelf until the next invalidation.
    queryKey: [
      "books",
      query.filter,
      query.sort,
      query.search ?? "",
      query.tag ?? "",
      query.formats ?? [],
      query.languages ?? [],
      query.publishers ?? [],
      query.status ?? "any",
      query.hasCover ?? null,
      query.trash ?? false,
    ],
    queryFn: () => {
      // `?demo=1` is the sample shelf, and an explicit one: without it the web
      // build reads the books the reader imported here (IndexedDB), the same
      // way the desktop reads its own.
      //
      // The bin answers empty: the fixture is a shelf, and a demo that showed
      // the whole library under 回收站 would be showing something the real one
      // never would.
      if (demoEnabled()) return Promise.resolve(query.trash ? [] : demoBooks);
      return ipc.bookList(query);
    },
    staleTime: 10_000,
  });
}

/**
 * The counts behind the shelf's 筛选 panel, for the query on screen.
 *
 * Takes the same `BookQuery` the shelf is showing rather than the shelf's
 * unfiltered state: a facet is only honest next to the filters it is counted
 * against. Shares the `["books"]` prefix, so every existing invalidation —
 * import, edit, delete, tag change — refreshes it too.
 */
export function useBookFacets(query: BookQuery) {
  return useQuery<LibraryFacets>({
    queryKey: ["books", "facets", query],
    queryFn: () => {
      if (demoEnabled()) return Promise.resolve(demoFacets);
      return ipc.bookFacets(query);
    },
    staleTime: 10_000,
  });
}

/** Aggregate counts for the shelf header. */
export function useLibraryStats() {
  return useQuery({
    queryKey: ["books", "stats"],
    queryFn: () => {
      if (demoEnabled()) return Promise.resolve(demoLibraryStats);
      return ipc.bookStats();
    },
    staleTime: 10_000,
  });
}

/** Per-book footprint facts for the info sheet. Only the desktop reports real
    counts (they come from SQLite); the browser build has no such aggregation,
    so it gets a zeroed shape rather than a broken query. Keyed by id, and kept
    under the shared `["books"]` prefix so any shelf change refreshes it. */
export function useBookInfo(id: string | null) {
  return useQuery<BookInfoSummary | null>({
    queryKey: ["books", "info", id],
    queryFn: desktopQuery<BookInfoSummary | null>(null, () => ipc.bookInfo(id ?? "")),
    enabled: id !== null,
    staleTime: 10_000,
  });
}

/** Whole-library storage breakdown for the stats page. Directory walks are a
    desktop-only concern; the browser build shows the offline (zeroed) report. */
export function useStorage() {
  return useQuery<StorageSummary>({
    queryKey: ["books", "storage"],
    queryFn: desktopQuery<StorageSummary>(EMPTY_STORAGE, () => ipc.bookStorage()),
    staleTime: 30_000,
  });
}

const EMPTY_STORAGE: StorageSummary = {
  booksBytes: 0,
  coversBytes: 0,
  databaseBytes: 0,
  totalBytes: 0,
  byFormat: [],
  topBooks: [],
  orphanCoversBytes: 0,
  orphanCoversCount: 0,
};

const EMPTY_COVERS: CoverManagerData = {
  active: [],
  retired: [],
  activeBytes: 0,
  retiredBytes: 0,
  history: [],
  orphans: [],
  orphanBytes: 0,
  duplicateGroups: [],
  duplicateBytes: 0,
};

/** Everything the 设置 › 封面管理 section shows. Desktop-only: the browser
    has no covers directory to walk, so it gets an empty manager rather than a
    query it cannot answer (see `desktopQuery`). */
export function useCovers() {
  return useQuery<CoverManagerData>({
    queryKey: ["covers", "manager"],
    queryFn: desktopQuery<CoverManagerData>(EMPTY_COVERS, () => ipc.coverList()),
    staleTime: 15_000,
  });
}

/** Retire / restore / purge all change both the covers directory and the book
    rows, so every one refreshes the manager, the shelf and storage together. */
function useCoverMutation(fn: (keys: string[]) => Promise<CoverOpResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      const word = result.skipped > 0 ? `，跳过 ${result.skipped} 张` : "";
      showToast("success", `已处理 ${result.done} 张封面${word}`);
      void queryClient.invalidateQueries({ queryKey: ["covers"] });
      void queryClient.invalidateQueries({ queryKey: ["books"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

export function useRetireCovers() {
  return useCoverMutation((keys) => ipc.coverRetire(keys));
}

export function useRestoreCovers() {
  return useCoverMutation((keys) => ipc.coverRestore(keys));
}

export function usePurgeCovers() {
  return useCoverMutation((keys) => ipc.coverPurge(keys));
}

/** Cleanup / dedupe change files on disk but, unlike retire/restore, do not
 *  move a book between tabs. Both report reclaimed bytes, so the toast says so.
 *  Every one invalidates the storage card too: orphan cleanup removes bytes the
 *  footprint report counted as 「发现无主封面」. */
function useCoverCleanup<TVars>(fn: (vars: TVars) => Promise<CleanupResult>, success: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      showToast(
        "success",
        result.files > 0
          ? `${success} ${result.files} 张，回收 ${formatBytes(result.bytes)}`
          : "没有需要处理的文件",
      );
      void queryClient.invalidateQueries({ queryKey: ["covers"] });
      void queryClient.invalidateQueries({ queryKey: ["books"] });
      void queryClient.invalidateQueries({ queryKey: ["books", "storage"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useCleanupOrphanCovers() {
  return useCoverCleanup<string[]>((keys) => ipc.coverCleanupOrphans(keys), "已清理");
}

export function useDedupeCovers() {
  return useCoverCleanup<{ keeper: string; keys: string[] }>(
    ({ keeper, keys }) => ipc.coverDedupe(keeper, keys),
    "已合并",
  );
}

/** Exports selected covers to a folder picked in the UI. The shelf is not
 *  touched, so nothing to invalidate. */
export function useExportCovers() {
  return useMutation({
    mutationFn: ({ keys, dest }: { keys: string[]; dest: string }) => ipc.coverExport(keys, dest),
  });
}

function useInvalidateShelf() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["books"] });
}

/** Book ids whose cover backfill already ran this session, so a failure or a
    slow render never retries in a loop. */
const coverAttempted = new Set<string>();

/** A PDF's only cover is its first page, which Rust cannot rasterize — so the
    shelf backfills covers by rendering page 1 with pdf.js and handing the PNG
    to `book.cover_save`. Covers freshly imported PDFs too: they appear in the
    list without one and the invalidated query picks the cover up. */
export function usePdfCovers(books: BookSummary[]) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isDesktopRuntime) return;
    const pending = books.filter(
      (book) => book.format === "pdf" && !book.coverUrl && !coverAttempted.has(book.id),
    );
    if (pending.length === 0) return;
    /**
     * One at a time, and one invalidation for the whole pass.
     *
     * This used to fire every PDF at once and refresh the shelf once per
     * book: a shelf of thirty PDFs parsed thirty documents concurrently (each
     * one a `getDocument` plus a page render) and refetched the same query
     * thirty times. A cover measured 126 ms on WebKit, so the concurrent
     * version spent seconds of it fighting the shelf's own first paint.
     *
     * `coverAttempted` is still written before the work starts, so a failure
     * never retries in a loop, and the cleanup only stops the trailing
     * invalidation — a pass that is already running is allowed to finish.
     */
    let cancelled = false;
    void (async () => {
      for (const book of pending) {
        coverAttempted.add(book.id);
        try {
          const bytes = await renderFirstPagePng(book.id);
          await ipc.bookCoverSave(book.id, Array.from(new Uint8Array(bytes)));
        } catch {
          // Scanned or damaged PDFs simply keep the placeholder cover.
        }
      }
      if (!cancelled) await queryClient.invalidateQueries({ queryKey: ["books"] });
    })();
    return () => {
      cancelled = true;
    };
  }, [books, queryClient]);
}

/** Imports files by absolute path and refreshes the shelf when done.
 *
 * `password` is only consumed by encrypted `.ctzx` packs; every other format
 * ignores it, so a mixed batch needs at most one prompt.
 */
export function useImportBooks() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ paths, password }: { paths: string[]; password?: string }) =>
      ipc.bookImport(paths, password ?? null),
    onSettled: invalidate,
  });
}

/** Imports files the browser picked, and refreshes the shelf when done. Same
 *  outcomes as `useImportBooks`, so the sheet that reports them is shared.
 *
 *  `onProgress` is the browser build's stand-in for the desktop's
 *  `book://import-progress` event: one call per file, so the shelf shows each
 *  book as it lands instead of the whole batch arriving at the end. */
export function useImportFiles() {
  const invalidate = useInvalidateShelf();
  const refetch = useShelfRefetch();
  return useMutation({
    mutationFn: (files: File[]) => ipc.bookImportFiles(files, refetch),
    onSettled: invalidate,
  });
}

/** Saves a book's own file: to the path the save dialog gave (desktop), or to
 *  the downloads folder (browser, which ignores the path). Nothing to
 *  invalidate — the shelf is untouched and the bytes were already stored.
 */
export function useExportBookFile() {
  return useMutation({
    mutationFn: ({ id, path = "" }: { id: string; path?: string }) => ipc.bookExport(id, path),
  });
}

/** Writes one book to a `.ctz` / `.ctzx` pack. Nothing to invalidate: the
 * shelf is untouched, the file lands wherever the save dialog pointed.
 */
export function useExportPack() {
  return useMutation({
    mutationFn: ({
      id,
      path,
      password,
      includeAi,
    }: {
      id: string;
      path: string;
      password?: string;
      includeAi: boolean;
    }) => ipc.packExport(id, path, password ?? null, includeAi),
  });
}

export function useDeleteBook() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (id: string) => ipc.bookDelete(id),
    onSettled: invalidate,
  });
}

/** Deletes a whole selection in one transaction, for the shelf's batch bar.
 *
 * The per-id version refreshed the book list once per book — twenty books
 * meant twenty IPC round trips and twenty invalidations of the same query.
 * While the batch runs, `book://delete-progress` counts it down — see
 * [`useDeleteProgress`]. */
export function useDeleteBooks() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (ids: string[]) => ipc.bookDeleteMany(ids),
    onSettled: invalidate,
  });
}

/** Takes books back out of the bin. One command for one book and for many:
 *  a restore cannot fail half-way through, so there is nothing to batch. */
export function useRestoreBooks() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (ids: string[]) => ipc.bookRestore(ids),
    onSettled: invalidate,
  });
}

/** Deletes one book and its files for good — only offered from the bin. */
export function usePurgeBook() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (id: string) => ipc.bookPurge(id),
    onSettled: invalidate,
  });
}

export function usePurgeBooks() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: (ids: string[]) => ipc.bookPurgeMany(ids),
    onSettled: invalidate,
  });
}

/** Empties the bin in one transaction, returning how many books went. */
export function useEmptyTrash() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: () => ipc.bookEmptyTrash(),
    onSettled: invalidate,
  });
}

/** The library's own record of what changed — 设置 › 操作记录.
 *
 * Deliberately not part of the `["books"]` key space: a log is not shelf data,
 * and invalidating the shelf should not refetch it (nor the reverse). */
export function useOperations(limit = 50) {
  return useQuery<Operation[]>({
    queryKey: ["operations", limit],
    queryFn: () => ipc.opsList(limit),
    // The browser build has no operations table — its writes go to IndexedDB
    // and nothing records them. Asking would be an error the reader cannot act
    // on, so the section says so instead (see `OperationsSection`).
    enabled: isDesktopRuntime,
    staleTime: 10_000,
  });
}

/// Puts back what one logged call changed.
///
/// Invalidates both sides: the log itself (the call is no longer undoable) and
/// the shelf (the books just changed under it).
export function useUndoOperation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => ipc.opsUndo(callId),
    onSuccess: (outcome) => {
      const skipped = outcome.skipped > 0 ? `，${outcome.skipped} 本已不在书库` : "";
      showToast("success", `已撤销 ${outcome.undone} 本${skipped}`);
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
}

/** Book rows share the `books` prefix with facets, stats and storage — only
 *  the former are arrays of `BookSummary`. */
const isBookRows = (rows: unknown): rows is BookSummary[] =>
  Array.isArray(rows) && rows.every((row) => row && typeof row === "object" && "favorite" in row);

export function useSetFavorite() {
  const invalidate = useInvalidateShelf();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      ipc.bookSetFavorite(id, favorite),
    // The tap is answered by the cache, not by the IPC round trip: waiting for
    // the refetch let the star's animation finish on the old state. A failed
    // write is corrected by the settle refetch below.
    onMutate: async ({ id, favorite }) => {
      await queryClient.cancelQueries({ queryKey: ["books"] });
      queryClient.setQueriesData<BookSummary[]>(
        { queryKey: ["books"], predicate: (query) => isBookRows(query.state.data) },
        (rows) => rows?.map((row) => (row.id === id ? { ...row, favorite } : row)),
      );
    },
    onSettled: invalidate,
  });
}

/** Marks a whole selection, in one transaction. Same reason as
 *  [`useDeleteBooks`]. */
export function useSetFavorites() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ ids, favorite }: { ids: string[]; favorite: boolean }) =>
      ipc.bookSetFavoriteMany(ids, favorite),
    onSettled: invalidate,
  });
}

/** Rewrites a book's metadata (title, authors, description, …).
 *
 * The whole form travels, so a half-filled sheet never clears a field it did
 * not show — see `BookMetaDialog`. `onSuccess` rather than `onSettled`: a
 * rejected edit changed nothing, and refetching then would only re-render the
 * shelf with the values the reader was trying to replace.
 */
export function useUpdateBook() {
  const invalidate = useInvalidateShelf();
  const queryClient = useQueryClient();
  return useMutation({
    // The cover travels with the fields — one command, one transaction, one
    // log entry. `null` leaves the picture alone.
    mutationFn: ({
      id,
      patch,
      coverUrl,
      coverPath,
    }: {
      id: string;
      patch: BookMetadataPatch;
      coverUrl?: string | null;
      coverPath?: string | null;
    }) => ipc.bookUpdate(id, patch, coverUrl ?? null, coverPath ?? null),
    onSuccess: (_saved, vars) => {
      invalidate();
      // A picture changed: the manager caches its scan for 15 s, and the log
      // gained the source row it reads. Force both so a jump straight from
      // this save to 封面管理 shows the new cover, not a stale list.
      if (vars.coverUrl || vars.coverPath) {
        void queryClient.invalidateQueries({ queryKey: ["covers"] });
        void queryClient.invalidateQueries({ queryKey: ["operations"] });
      }
    },
  });
}

/** Live import progress from the backend. Returns `null` between batches so
 * the UI can switch between progress and summary states.
 */
export function useImportProgress(): ImportProgress | null {
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useTauriEvent(onImportProgress, setProgress);

  return progress;
}

/** Live batch-delete progress from the backend. Same shape of contract as
 * [`useImportProgress`]: `null` between batches, and the last count of a
 * finished batch stays readable until the next one starts — which is why the
 * toast that draws it is gated on the mutation being in flight. */
export function useDeleteProgress(): DeleteProgress | null {
  const [progress, setProgress] = useState<DeleteProgress | null>(null);

  useTauriEvent(onDeleteProgress, setProgress);

  return progress;
}

/** How long a burst of import progress is coalesced into one shelf refetch.
 *
 * A 75-book import emits 75 events; refetching the whole book list 75 times is
 * the cost the batch bar's single invalidation was built to avoid. One refetch
 * per quiet stretch keeps the shelf current — a book that lands shows up on
 * its own — while everything inside the window costs a single fetch. The call
 * trails, so the last book of a batch is never stranded inside the window. */
const SHELF_SYNC_MS = 400;

/** A shelf refetch that coalesces bursts — see [`SHELF_SYNC_MS`]. Stable, and
 *  it drops its pending timer when the caller unmounts. */
function useShelfRefetch(): () => void {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    }, SHELF_SYNC_MS);
  }, [queryClient]);
}

/** Keeps the shelf current while an import batch runs, so each book appears as
 *  it lands rather than the whole batch arriving at the end.
 *
 *  The desktop emits one `book://import-progress` per file, *after* that
 *  file's transaction commits — so a refetch at that moment sees the book.
 *  The browser build has no event channel (see `onImportProgress`); its twin
 *  reports through the callback `bookImportFiles` takes instead, wired in
 *  [`useImportFiles`]. */
export function useImportShelfSync(): void {
  const refetch = useShelfRefetch();
  useTauriEvent(onImportProgress, refetch);
}
