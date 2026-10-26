import { useState } from "react";
import { Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useDeleteTag } from "@/hooks/useTags";
import { cn } from "@/lib/cn";
import type { TagSummary } from "@/types/ipc";

/**
 * The tag shelf's filter bar.
 *
 * Chips filter the grid. Only the selected chip can also be deleted, so a
 * destructive control never sits under the cursor of a chip the reader is
 * about to click — and a stray click on a chip does the harmless thing.
 */

const CHIP =
  "press focus-visible:focus-ring flex h-8 items-center gap-1 rounded-full border px-3 text-xs";
const IDLE = "glass text-text-2 hover:bg-surface-2 hover:text-text-1 cursor-pointer";
const ON = "border-accent bg-accent-soft text-text-1";

interface TagBarProps {
  tags: TagSummary[];
  /** The tag being shown, or `null` for the whole shelf. */
  selected: string | null;
  onSelect: (name: string | null) => void;
}

export function TagBar({ tags, selected, onSelect }: TagBarProps) {
  const [pending, setPending] = useState<TagSummary | null>(null);
  const remove = useDeleteTag();

  if (tags.length === 0) {
    return (
      <p className="text-text-3 mb-4 text-xs">
        还没有标签。在书的右上角点标签按钮，给它写个名字，这里就能按标签筛选。
      </p>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={selected === null}
          onClick={() => onSelect(null)}
          className={cn(CHIP, selected === null ? ON : IDLE)}
        >
          全部
        </button>

        {tags.map((tag) =>
          tag.name === selected ? (
            <span key={tag.id} className={cn(CHIP, ON, "pr-1.5")}>
              <span className="text-text-3">#</span>
              {tag.name}
              <span className="text-text-3 tabular-nums">{tag.count}</span>
              <button
                type="button"
                aria-label={`删除标签 ${tag.name}`}
                onClick={() => setPending(tag)}
                className="press focus-visible:focus-ring text-text-3 hover:text-danger ml-0.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full"
              >
                <Trash size={11} />
              </button>
            </span>
          ) : (
            <button
              key={tag.id}
              type="button"
              aria-pressed={false}
              onClick={() => onSelect(tag.name)}
              className={cn(CHIP, IDLE)}
            >
              <span className="text-text-3">#</span>
              {tag.name}
              <span className="text-text-3 tabular-nums">{tag.count}</span>
            </button>
          ),
        )}
      </div>

      <GlassDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={`删除标签「${pending?.name ?? ""}」？`}
        description={`${pending?.count ?? 0} 本书会失去这个标签，书籍本身不受影响。`}
        widthClass="w-[min(92vw,400px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setPending(null)}
            disabled={remove.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            disabled={remove.isPending}
            onClick={() => {
              if (!pending) return;
              remove.mutate(pending.id, {
                onSuccess: () => {
                  setPending(null);
                  // The filter would otherwise point at a tag that is gone.
                  onSelect(null);
                },
              });
            }}
          >
            删除
          </GlassButton>
        </div>
      </GlassDialog>
    </>
  );
}
