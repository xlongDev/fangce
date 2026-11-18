import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import type { BatchExportKind } from "@/lib/bindings";

/**
 * The shelf's inventory as a CSV at a path the save panel chose.
 *
 * The row names its own outcome, so this opts out of the global write-failure
 * toast exactly as `useExportBackup` does — saying the same thing twice on a
 * settings row is noise, and the backend's reason is more useful here.
 */
export function useCatalogExport() {
  return useMutation({
    mutationFn: (path: string) => ipc.libraryExportCatalog(path),
    meta: { silent: true },
  });
}

/**
 * One book as one row of the same table. The card's export menu opens the
 * save panel; this hook only owns the write and its failure reporting.
 */
export function useBookCatalogExport() {
  return useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) =>
      ipc.libraryExportBookCatalog(id, path),
    meta: { silent: true },
  });
}

/**
 * The batch bar's selection as one file: the same four shapes the single-book
 * dialog offers, with the three file shapes wrapped in one ZIP. One
 * destination, one write.
 */
export function useBatchExport() {
  return useMutation({
    mutationFn: ({
      ids,
      path,
      kind,
      password,
      includeAi,
    }: {
      ids: string[];
      path: string;
      kind: BatchExportKind;
      password?: string;
      includeAi: boolean;
    }) => ipc.libraryExportBatch(ids, path, kind, password ?? null, includeAi),
    meta: { silent: true },
  });
}

/**
 * Restores the books named in a catalogue CSV. A restore writes metadata,
 * labels and reading marks, so the shelf, the tag index and the undo list all
 * have to be asked again.
 */
export function useCatalogImport() {
  const query = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => ipc.libraryImportCatalog(path),
    onSuccess: () => {
      void query.invalidateQueries({ queryKey: ["books"] });
      void query.invalidateQueries({ queryKey: ["tags"] });
      void query.invalidateQueries({ queryKey: ["operations"] });
      void query.invalidateQueries({ queryKey: ["reading"] });
    },
    meta: { silent: true },
  });
}
