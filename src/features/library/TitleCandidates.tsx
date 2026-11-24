import { Check } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { sourceLabel } from "@/lib/metadata";
import type { TitleProposal, TitleRename } from "@/types/ipc";

/**
 * The per-book part of a title rename: old title against the catalogue's
 * answers. Shared by the fill sheet's 改书名 switch and nowhere else — a
 * rename is always a decision the reader makes after seeing both names.
 *
 * Low-scoring answers stay visible but start unticked, and picking a different
 * answer is itself a decision to use it. Both rules live here so the two call
 * sites cannot disagree about what a tick means.
 */
export type TitleTicks = Record<string, boolean>;
export type TitleChoices = Record<string, number>;

export function pickedTitle(proposal: TitleProposal, ticks: TitleTicks, choices: TitleChoices) {
  const candidate = proposal.candidates[choices[proposal.bookId] ?? 0];
  const on = candidate != null && (ticks[proposal.bookId] ?? proposal.confident);
  return { candidate, on };
}

/** The renames a preview would actually write, in shelf order. */
export function acceptedTitles(
  rows: TitleProposal[],
  ticks: TitleTicks,
  choices: TitleChoices,
): TitleRename[] {
  return rows.flatMap((row) => {
    const { candidate, on } = pickedTitle(row, ticks, choices);
    return on && candidate ? [{ id: row.bookId, title: candidate.title }] : [];
  });
}

export function TitleCandidates({
  rows,
  ticks,
  choices,
  onToggle,
  onChoose,
  maxHeightClass = "max-h-[50vh]",
}: {
  rows: TitleProposal[];
  ticks: TitleTicks;
  choices: TitleChoices;
  onToggle: (proposal: TitleProposal) => void;
  onChoose: (bookId: string, index: number) => void;
  maxHeightClass?: string;
}) {
  return (
    <ul className={cn("divide-hairline divide-y overflow-y-auto", maxHeightClass)}>
      {rows.map((proposal) => {
        const selected = choices[proposal.bookId] ?? 0;
        const { candidate, on } = pickedTitle(proposal, ticks, choices);
        return (
          <li key={proposal.bookId} className="py-2">
            <div className="flex items-start gap-2">
              <button
                type="button"
                disabled={!candidate}
                onClick={() => onToggle(proposal)}
                aria-pressed={on}
                aria-label={`${on ? "取消改名" : "改名"}《${proposal.bookTitle}》`}
                className={cn(
                  "press focus-visible:focus-ring mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  !candidate
                    ? "border-hairline cursor-default"
                    : on
                      ? "border-accent bg-accent text-on-accent"
                      : "border-hairline hover:border-accent",
                )}
              >
                {on && <Check size={10} weight="bold" />}
              </button>
              <div className="min-w-0 flex-1">
                {candidate ? (
                  <>
                    <p className="text-text-3 text-[11px] leading-relaxed break-words">
                      {proposal.bookTitle}
                    </p>
                    <p className="text-text-1 mt-0.5 text-[13px] leading-relaxed break-words">
                      → {candidate.title}
                    </p>
                    <p className="text-text-3 mt-0.5 text-[11px]">
                      {`${sourceLabel(candidate.source)} · 匹配度 ${Math.round((candidate.matchScore ?? 0) * 100)}%${proposal.confident ? "" : " · 请自己确认"}`}
                    </p>
                    {proposal.candidates.length > 1 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {proposal.candidates.map((item, index) => (
                          <button
                            key={`${item.source}-${item.title}-${item.matchScore ?? 0}`}
                            type="button"
                            aria-pressed={selected === index}
                            onClick={() => onChoose(proposal.bookId, index)}
                            title={item.title}
                            className={cn(
                              "border-hairline text-text-2 hover:text-text-1 max-w-full rounded-md border px-2 py-0.5 text-left text-[11px] leading-snug break-words transition-colors",
                              selected === index && "border-accent text-accent",
                            )}
                          >
                            {index + 1} · {item.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-text-3 text-[12px] leading-relaxed break-words">
                      {proposal.bookTitle}
                    </p>
                    <p className="text-text-3 mt-0.5 text-[11px]">
                      {proposal.skipped ?? "来源没有给出别的书名"}
                    </p>
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
