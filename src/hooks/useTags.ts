import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";
import type { TagAdd, TagRun, TagSummary } from "@/types/ipc";

/**
 * The shelf's labels: the tag bar reads them, the label editor writes them.
 *
 * Labels are ordinary rows, not a second shelf — a book keeps its place in the
 * grid and gains a name that can be filtered on. Both actions refresh the tag
 * list and the book list together, because one edit can add or retire a tag.
 */

/** Every tag in use, with its book count. */
export function useTags() {
  return useQuery<TagSummary[]>({
    queryKey: ["tags"],
    queryFn: () => ipc.tagList(),
    staleTime: 30_000,
  });
}

function useInvalidateLabels() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["books"] }),
    ]);
}

/**
 * Attaches and detaches labels on a set of books.
 *
 * `remove` is always explicit: the per-book sheet sends the difference between
 * what it showed and what the reader kept, while the batch bar leaves it empty
 * so selecting books can never clear a label it never saw.
 */
export function useAssignTags() {
  const invalidate = useInvalidateLabels();
  return useMutation({
    mutationFn: ({ ids, add, remove }: { ids: string[]; add: string[]; remove: string[] }) =>
      ipc.bookSetTags(ids, add, remove),
    onSettled: invalidate,
  });
}

/** Drops a tag from every book that carries it. */
export function useDeleteTag() {
  const invalidate = useInvalidateLabels();
  return useMutation({
    mutationFn: (id: string) => ipc.tagDelete(id),
    onSettled: invalidate,
  });
}

/**
 * Asks the model what to call these books.
 *
 * A read: nothing is written, and the answer is a proposal the reader edits
 * before it becomes anything. That is why this is not a mutation on the tag
 * cache — the cache is not stale until 应用 is pressed.
 */
export function useSuggestTags() {
  return useMutation<TagRun, Error, string[]>({
    mutationFn: (ids) => ipc.tagSuggest(ids),
  });
}

/** Writes the labels the reader kept. One transaction on the Rust side. */
export function useApplySuggestedTags() {
  const invalidate = useInvalidateLabels();
  return useMutation<number, Error, TagAdd[]>({
    mutationFn: (items) => ipc.tagSuggestApply(items),
    onSuccess: invalidate,
  });
}
