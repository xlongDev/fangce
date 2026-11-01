import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, onGraphProgress } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { GraphProgress } from "@/types/ipc";

/** Graph status for one book. Refreshed after every build. */
export function useGraphStatus(bookId: string) {
  return useQuery({
    queryKey: ["graph", "status", bookId],
    queryFn: () => {
      // The graph lives in the desktop's own store; the browser has no copy,
      // and this is what it reports rather than pretending to have asked.
      return desktopQuery({ entities: 0, relations: 0, model: "" }, () =>
        ipc.graphStatus(bookId),
      )();
    },
    staleTime: 5_000,
  });
}

/** All entities, or the relations of one selected entity. */
export function useGraphQuery(bookId: string, entity: string | null) {
  return useQuery({
    queryKey: ["graph", "view", bookId, entity],
    queryFn: () => {
      return desktopQuery({ entities: [], relations: [] }, () => ipc.graphQuery(bookId, entity))();
    },
    staleTime: 5_000,
  });
}

/** Where this character's portrait lives, if one was ever drawn.
 *
 *  A query rather than a mutation because the panel asks it on every open, and
 *  the answer is a file that either exists or does not.
 */
export function useCharacterPortrait(bookId: string, name: string | null) {
  return useQuery<string | null>({
    queryKey: ["graph", "portrait", bookId, name],
    queryFn: desktopQuery<string | null>(null, () =>
      name ? ipc.aiCharacterPortraitUrl(bookId, name) : Promise.resolve(null),
    ),
    enabled: name !== null,
    staleTime: 30_000,
  });
}

/** Draws a new portrait, then re-asks where it lives. */
export function useGeneratePortrait(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<string, unknown, { name: string; appearance: string }>({
    mutationFn: ({ name, appearance }) => ipc.aiCharacterPortrait(bookId, name, appearance),
    // Inline: the failure is shown under the button that caused it, and it names
    // a settings group the reader has to go and fix.
    meta: { silent: true },
    onSuccess: (_url, { name }) => {
      queryClient.invalidateQueries({ queryKey: ["graph", "portrait", bookId, name] });
    },
  });
}

/** Rebuilds one book's graph, tracking live chapter progress. */
export function useGraphBuild(bookId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<GraphProgress | null>(null);

  useTauriEvent(onGraphProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.graphBuild(bookId),
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  return { build, progress };
}
