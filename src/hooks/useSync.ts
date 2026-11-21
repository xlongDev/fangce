import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc } from "@/lib/ipc";
import type { SyncConfig } from "@/types/ipc";

/** Browser dev mode has no backend; the settings form still needs a shape. */
const OFFLINE_CONFIG: SyncConfig = { url: "", username: "", password: "" };

/** Persisted WebDAV config. `staleTime: Infinity` — it only changes here. */
export function useSyncConfig() {
  return useQuery<SyncConfig>({
    queryKey: ["sync", "config"],
    queryFn: desktopQuery(OFFLINE_CONFIG, () => ipc.syncGetConfig()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Saves the config; the query refreshes so the form shows the stored form. */
export function useSaveSyncConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: SyncConfig) => ipc.syncSetConfig(config),
    meta: { silent: true },
    // `onSettled` would run on failure too, where `saved` is `undefined` — and
    // writing that into the cache blanks the form it is meant to refresh.
    onSuccess: (saved) => {
      queryClient.setQueryData(["sync", "config"], saved);
      // The credential banner spans every sealed row; re-check after a save
      // so it clears once no row is left sealed by an older master key.
      void queryClient.invalidateQueries({ queryKey: ["system", "secrets"] });
    },
  });
}

/** Proves the server is reachable and authorized. Does not persist. */
export function useTestSyncConfig() {
  return useMutation({
    mutationFn: (config: SyncConfig) => ipc.syncTest(config),
    meta: { silent: true },
  });
}

/** Runs one full sync cycle; the shelf and any open reader refresh with what moved. */
export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: SyncConfig) => ipc.syncNow(config),
    meta: { silent: true },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
      // Highlights and bookmarks ride along in the same state document, so a
      // pull may have rewritten them: drop their caches rather than patch.
      void queryClient.invalidateQueries({ queryKey: ["annotations"] });
      void queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
    },
  });
}
