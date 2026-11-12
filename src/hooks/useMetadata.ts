import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { demoEnabled, demoProposals } from "@/lib/demo";
import { showToast } from "@/stores/toasts";
import type { Candidate, MetadataFill, Proposal } from "@/types/ipc";

/** The two catalogues the sheet offers, by the name the backend knows them by. */
export type Source = "douban" | "neodb";

/**
 * Asks one catalogue about one book.
 *
 * A mutation rather than a query: it runs when the reader presses a source's
 * button, not when the sheet opens. A query would fire on every book the sheet
 * is opened for — a network round trip per edit, most of them for books whose
 * metadata the reader has no intention of touching.
 *
 * The source is a parameter and not a chain: the two answer differently —
 * Douban has Chinese coverage and no ISBN, NeoDB has both and needs a proxy —
 * and comparing them is the reason there are two buttons.
 */
export function useMetadataSearch() {
  return useMutation<Candidate[], Error, { id: string; source: Source }>({
    mutationFn: ({ id, source }) => ipc.metadataSearch(id, source),
  });
}

/**
 * What a fill would add to these books, without writing anything.
 *
 * A query rather than a mutation: the dialog opens on a selection, and the
 * answer is keyed by that selection — reopening the same batch should show what
 * it showed a minute ago instead of asking the catalogue again.
 */
export function useMetadataPropose(ids: string[], enabled: boolean, replaceCovers = false) {
  const demo = demoEnabled();
  return useQuery<Proposal[]>({
    // The switch is part of the question, so it is part of the key: turning it
    // on has to ask the catalogue again, not show the previous answer with a
    // different label.
    queryKey: ["metadata", "propose", demo, replaceCovers, ids],
    queryFn: () => (demo ? demoProposals(ids) : ipc.metadataPropose(ids, replaceCovers)),
    enabled: enabled && ids.length > 0 && (isDesktopRuntime || demo),
    // A batch of thirty is thirty requests to somebody else's server. The
    // answer does not change while the dialog is open, and asking twice for a
    // reader who closed and reopened it is rude.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * A catalogue's cover, as a data URL, for showing it before anything is saved.
 *
 * Its own key rather than the proposal's: the same picture is asked for by a
 * candidate row and by an expanded batch row, and it must be fetched once. A
 * cover URL names one picture and that picture does not change, so the cache
 * never goes stale — a reopened dialog shows what it showed a minute ago
 * without asking anybody's server again.
 *
 * `enabled` is the caller's throttle. The single-book list shows three
 * candidates and fetches all three; the batch list can hold forty rows, and a
 * closed row has no reason to cost a request.
 */
export function useCoverPreview(url: string | null | undefined, enabled: boolean) {
  return useQuery<string>({
    queryKey: ["metadata", "cover", url],
    queryFn: () => ipc.metadataCoverPreview(url!),
    enabled: enabled && !!url && isDesktopRuntime,
    staleTime: Infinity,
    // A thumbnail that will not load is not a reason to ask again — the URL
    // names one file, and the answer will be the same. The row keeps its
    // placeholder, and the reader can still apply.
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
