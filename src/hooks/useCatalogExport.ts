import { useMutation } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

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
