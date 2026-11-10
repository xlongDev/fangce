import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { demoEnabled, demoProposals } from "@/lib/demo";
import { showToast } from "@/stores/toasts";
import type { Candidate, MetadataFill, Proposal } from "@/types/ipc";

/**
 * Asks Open Library about one book.
 *
 * A mutation rather than a query: it runs when the reader presses 查找, not
 * when the sheet opens. A query would fire on every book the sheet is opened
 * for — a network round trip per edit, most of them for books whose metadata
 * the reader has no intention of touching.
 */
export function useMetadataSearch() {
  return useMutation<Candidate[], Error, string>({
    mutationFn: (id: string) => ipc.metadataSearch(id),
  });
}

/**
 * What a fill would add to these books, without writing anything.
 *
 * A query rather than a mutation: the dialog opens on a selection, and the
 * answer is keyed by that selection — reopening the same batch should show what
 * it showed a minute ago instead of asking the catalogue again.
 */
export function useMetadataPropose(ids: string[], enabled: boolean) {
  const demo = demoEnabled();
  return useQuery<Proposal[]>({
    queryKey: ["metadata", "propose", demo, ids],
    queryFn: () => (demo ? demoProposals(ids) : ipc.metadataPropose(ids)),
    enabled: enabled && ids.length > 0 && (isDesktopRuntime || demo),
    // A batch of thirty is thirty requests to somebody else's server. The
    // answer does not change while the dialog is open, and asking twice for a
    // reader who closed and reopened it is rude.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Writes the proposals the reader accepted. One transaction, one log entry. */
export function useMetadataApply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: MetadataFill[]) =>
      demoEnabled() ? Promise.resolve(items.length) : ipc.metadataApply(items),
    onSuccess: (written) => {
      showToast("success", `补全了 ${written} 本`);
      void queryClient.invalidateQueries({ queryKey: ["books"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
      // The proposals were computed against metadata that no longer exists.
      void queryClient.invalidateQueries({ queryKey: ["metadata", "propose"] });
    },
  });
}
