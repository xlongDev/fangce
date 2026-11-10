import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onDeleteProgress, onImportProgress } from "@/lib/ipc";
import { demoBooks, demoEnabled, demoFacets, demoLibraryStats } from "@/lib/demo";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { renderFirstPagePng } from "@/lib/pdf";
import type {
  BookMetadataPatch,
  BookQuery,
  BookSummary,
  DeleteProgress,
  ImportProgress,
  LibraryFacets,
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
    mutationFn: ({ id, path, password }: { id: string; path: string; password?: string }) =>
      ipc.packExport(id, path, password ?? null),
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

export function useSetFavorite() {
  const invalidate = useInvalidateShelf();
  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) =>
      ipc.bookSetFavorite(id, favorite),
    // Optimistic-free is fine at this size; the query is refreshed after.
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
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: BookMetadataPatch }) =>
      ipc.bookUpdate(id, patch),
    onSuccess: invalidate,
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
