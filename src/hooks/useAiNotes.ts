import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { demoEnabled, demoNoteDraftApply, demoNoteDrafts } from "@/lib/demo";
import { ipc, isDesktopRuntime } from "@/lib/ipc";
import type { AiNoteDraft, AiNoteRun } from "@/types/ipc";

/** `?demo=1` answers from the sample store; the shipped desktop app never does. */
const demo = !isDesktopRuntime && demoEnabled();

/** Asks the model for drafts. A read: nothing is written until 应用 is pressed. */
export function useSuggestNoteDrafts() {
  return useMutation<AiNoteRun, Error, string[]>({
    mutationFn: (ids) => (demo ? Promise.resolve(demoNoteDrafts(ids)) : ipc.notesDraftSuggest(ids)),
  });
}

/** Writes what the reader kept, then refetches every book's annotation list. */
export function useApplyNoteDrafts() {
  const query = useQueryClient();
  return useMutation<number, Error, AiNoteDraft[]>({
    mutationFn: (items) =>
      demo ? Promise.resolve(demoNoteDraftApply(items)) : ipc.notesDraftApply(items),
    onSuccess: () => {
      void query.invalidateQueries({ queryKey: ["annotations"] });
    },
  });
}

/** The review this reader saved for one book, if any. Desktop only: the
 *  browser build has no settings table and never calls into Tauri. */
export function useSavedRecap(bookId: string) {
  return useQuery<string | null>({
    queryKey: ["ai", "recap", bookId],
    queryFn: () => (isDesktopRuntime ? ipc.notesRecapGet(bookId) : Promise.resolve(null)),
    enabled: isDesktopRuntime && bookId !== "",
  });
}

/** Saves the preview only when the reader presses 保存 — the model itself
 *  never writes. Invalidates the saved copy so the label switches to 已保存. */
export function useSaveRecap() {
  const query = useQueryClient();
  return useMutation<null, Error, { bookId: string; text: string }>({
    mutationFn: ({ bookId, text }) =>
      isDesktopRuntime ? ipc.notesRecapSave(bookId, text) : Promise.resolve(null),
    onSuccess: (_saved, { bookId }) => {
      void query.invalidateQueries({ queryKey: ["ai", "recap", bookId] });
      void query.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}
