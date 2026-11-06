import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, onGraphProgress } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { CharacterCard, GraphProgress } from "@/types/ipc";

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
      // The card wall caches the picture's URL with the card, so a redraw has
      // to reach that list too or the wall keeps showing the old bytes.
      queryClient.invalidateQueries({ queryKey: ["graph", "characters", bookId] });
    },
  });
}

/* ------------------------------------------------------------- characters */

/**
 * The card wall: every character of one book, with its portrait URL.
 *
 * One query rather than the graph's entity list plus a portrait lookup per
 * name — the backend answers both in one pass, and a wall that paints in two
 * waves reads as a loading bug.
 */
export function useCharacters(bookId: string) {
  return useQuery<CharacterCard[]>({
    queryKey: ["graph", "characters", bookId],
    queryFn: desktopQuery<CharacterCard[]>([], () => ipc.graphCharacters(bookId)),
    staleTime: 5_000,
  });
}

/** A name the extractor never found. */
export function useAddCharacter(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<CharacterCard, unknown, string>({
    mutationFn: (name) => ipc.graphAddCharacter(bookId, name),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["graph"] }),
  });
}

/** Empties the wall; the backend removes the portraits with the rows. */
export function useClearCharacters(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<number, unknown, void>({
    mutationFn: () => ipc.graphClearCharacters(bookId),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["graph"] }),
  });
}

/** Writes the wall to a pack; the path comes from the native save panel. */
export function useExportCharacters(bookId: string) {
  return useMutation<number, unknown, string>({
    mutationFn: (path) => ipc.graphExportCharacters(bookId, path),
    meta: { silent: true },
  });
}

/** Merges a pack into this book. */
export function useImportCharacters(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation<number, unknown, string>({
    mutationFn: (path) => ipc.graphImportCharacters(bookId, path),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["graph"] }),
  });
}

/** Rebuilds one book's graph, tracking live chapter progress. */
export function useGraphBuild(bookId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<GraphProgress | null>(null);

  useTauriEvent(onGraphProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.graphBuild(bookId),
    onSuccess: (report) => {
      // A chapter whose reply could not be parsed is skipped rather than
      // aborting the build, so the graph can be thinner than the book. Saying
      // so is the difference between a partial answer and a wrong one.
      if (report.skipped > 0) {
        showToast(
          "error",
          `${report.chapters} 章里有 ${report.skipped} 章没能抽出来，图谱会偏薄。换一个更擅长按格式输出的模型可以补上。`,
        );
      }
    },
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  return { build, progress };
}
