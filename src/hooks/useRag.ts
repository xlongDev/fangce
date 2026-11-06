import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, onRagLibraryProgress, onRagProgress } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { RagProgress } from "@/types/ipc";

/** Index status for one book. Refreshed after every index build. */
export function useRagStatus(bookId: string) {
  return useQuery({
    queryKey: ["rag", "status", bookId],
    queryFn: () => {
      return desktopQuery(
        {
          bookChunks: 0,
          libraryChunks: 0,
          embeddingModel: "",
          staleBooks: 0,
          bookStale: false,
        },
        () => ipc.ragStatus(bookId),
      )();
    },
    staleTime: 5_000,
  });
}

/** Rebuilds one book's embedding index, tracking live progress. */
export function useIndexBook(bookId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RagProgress | null>(null);

  useTauriEvent(onRagProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.ragIndexBook(bookId),
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["rag", "status"] });
    },
  });

  return { build, progress };
}

/**
 * Rebuilds every book that carries an index, against the model configured now.
 *
 * The reason this exists at all: retrieval filters on the embedding model, so
 * changing it makes every stored vector invisible. Without a library-wide
 * rebuild the only cure is opening each book and pressing 重建 — thirty times.
 * Progress here counts books, so it uses its own event.
 */
export function useRebuildLibrary() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RagProgress | null>(null);

  useTauriEvent(onRagLibraryProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.ragIndexLibrary(),
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["rag", "status"] });
    },
  });

  return { build, progress };
}

/** Drops the whole library's index. Same reasoning as the rebuild: derived data. */
export function useClearLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ipc.ragClearLibrary(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rag", "status"] }),
  });
}

/**
 * Drops one book's index.
 *
 * Maintenance, not a destructive action: chunks are derived from chapters, so
 * the cost of a mistake is one rebuild. The next question that needs retrieval
 * simply finds nothing and the panel offers to index again.
 */
export function useClearIndex(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ipc.ragClearBook(bookId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rag", "status"] }),
  });
}
