import type { ReactNode } from "react";
import { BookOpenText, MagnifyingGlass, TextAa, TreeStructure, User } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import type { RagHit, ToolCallView } from "@/types/ipc";

const ICONS: Record<string, Icon> = {
  search_book: MagnifyingGlass,
  read_chapter: BookOpenText,
  character: User,
  mindmap: TreeStructure,
  wordcloud: TextAa,
};

/**
 * One thing the assistant did while answering.
 *
 * The header and the way back into the book; the picture the tool produced comes
 * in as `children`, because the renderers that draw it are heavy and belong in a
 * chunk of their own (see `ToolArtifact`). Keeping them out of this module is
 * also what lets the row be unit-tested in seconds rather than minutes.
 *
 * The artefact is always shown, not folded: a mind map that has to be clicked
 * open is a mind map nobody sees, and it *is* the answer to "梳理一下人物关系".
 * The sources stay small, because they are a way back into the book rather than
 * the content of the answer.
 */
export function ToolRow({
  tool,
  onJump,
  children,
}: {
  tool: ToolCallView;
  onJump: (hit: RagHit) => void;
  children?: ReactNode;
}) {
  const Icon = ICONS[tool.name] ?? MagnifyingGlass;
  const sources = tool.sources ?? [];

  return (
    <div data-tool={tool.name} className="mb-2.5">
      <div
        className={cn(
          "flex items-center gap-1.5 text-[11px]",
          tool.ok ? "text-text-3" : "text-danger",
        )}
      >
        <Icon size={11} weight="bold" aria-hidden />
        <span className="truncate">{tool.label}</span>
        <span className="text-text-3/70 shrink-0">· {tool.detail}</span>
      </div>

      {children}

      {sources.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {sources.map((hit, index) => (
            <li key={`${hit.bookId}-${hit.chapterIdx}-${hit.startChar}`}>
              <button
                type="button"
                onClick={() => onJump(hit)}
                className="focus-visible:focus-ring text-text-3 hover:text-accent w-full truncate rounded text-left text-[11px] leading-relaxed transition-colors"
              >
                [{index + 1}] 第 {hit.chapterIdx + 1} 章
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
