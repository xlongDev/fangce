import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTauriEvent } from "@/hooks/useTauriEvent";
import { desktopQuery, ipc, onSummaryProgress } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";
import type { ChapterSummary, SummaryProgress } from "@/types/ipc";

/**
 * The chapters up to the reader's position, with whatever summaries exist.
 *
 * `upto` is part of the key: moving forward in the book reveals chapters that
 * were not in the answer before, and a cached list that stopped at chapter 12
 * would keep the panel a chapter behind for the rest of the session.
 */
export function useChapterSummaries(bookId: string, upto: number) {
  return useQuery({
    queryKey: ["summary", "list", bookId, upto],
    queryFn: desktopQuery<ChapterSummary[]>([], () => ipc.chapterSummaries(bookId, upto)),
    staleTime: 10_000,
  });
}

/** Summarises the chapters up to `upto` that have none, tracking progress. */
export function useSummaryBuild(bookId: string, upto: number) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<SummaryProgress | null>(null);

  useTauriEvent(onSummaryProgress, setProgress);

  const build = useMutation({
    mutationFn: () => ipc.chapterSummaryBuild(bookId, upto),
    onSuccess: (report) => {
      // A chapter the model could not summarise is skipped rather than failing
      // the run, so the panel can be thinner than the book. Silence would leave
      // the reader wondering why one chapter stays blank.
      if (report.skipped > 0) {
        showToast(
          "error",
          `${report.total} 章里有 ${report.skipped} 章没能写出来，可以再点一次补齐。`,
        );
      }
    },
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["summary"] });
    },
  });

  return { build, progress };
}
