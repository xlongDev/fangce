import { useState } from "react";
import { CaretDown, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
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

/**
 * The chip, shared with the shelf's 筛选 panel.
 *
 * Exported rather than copied: two filter surfaces sit one above the other on
 * the same page, and a hover or pressed state that differs between them reads
 * as one of the two being broken.
 */
export const CHIP =
  "press focus-visible:focus-ring flex h-8 items-center gap-1 rounded-full border px-3 text-xs";
export const CHIP_IDLE = "glass text-text-2 hover:bg-surface-2 hover:text-text-1 cursor-pointer";
export const CHIP_ON = "border-accent bg-accent-soft text-text-1";

/**
 * How many chips a folded bar shows.
 *
 * A wall of 273 chips is not a way to browse — the reader scrolls past their
 * own vocabulary to reach tags used once. Forty is about one screenful; the
 * rest is one click or two keystrokes away, and the long tail is what the
 * search field exists for.
 *
 * 🔴 **Expanding snaps; it is not animated.** Three attempts went into animating
 * this, and the third one measured why it cannot work: each chip is the `glass`
 * utility — five `box-shadow` layers, a specular gradient and a border — so 281
 * chips are ~1400 shadows, all inside one box. Every frame of a `max-height`
 * transition repaints that box, and the expand visibly hitched on a real
 * machine. The material is the product, so the animation is what goes.
 * A height transition here only becomes affordable if the chips are virtualised
 * down to the rows on screen; that is a real project, not a CSS tweak.
 */
const TOP = 40;

interface TagBarProps {
  tags: TagSummary[];
  /** The tag being shown, or `null` for the whole shelf. */
  selected: string | null;
  onSelect: (name: string | null) => void;
}

export function TagBar({ tags, selected, onSelect }: TagBarProps) {
  const [pending, setPending] = useState<TagSummary | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const remove = useDeleteTag();

  // Typing filters; a search always shows every match, so the fold never hides
  // what was just asked for.
  const trimmed = query.trim().toLowerCase();
  const matched = trimmed ? tags.filter((tag) => tag.name.toLowerCase().includes(trimmed)) : tags;
  const folded = !expanded && !trimmed && matched.length > TOP;
  let shown = folded ? matched.slice(0, TOP) : matched;
  // The tag being filtered on must stay visible even when it lives past the
  // fold — otherwise the bar shows no selection and reads as broken.
  const current = selected ? tags.find((tag) => tag.name === selected) : undefined;
  if (current && !shown.some((tag) => tag.id === current.id)) {
    shown = [current, ...shown];
  }
  const hidden = matched.length - (folded ? Math.min(TOP, matched.length) : matched.length);

  if (tags.length === 0) {
    return (
      <p className="text-text-3 mb-4 text-xs">
        还没有标签。在书的右上角点标签按钮，给它写个名字，这里就能按标签筛选。
      </p>
    );
  }

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <GlassInput
          className="w-52"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标签"
          aria-label="搜索标签"
        />
        <span className="text-text-3 text-xs tabular-nums">共 {tags.length} 个</span>
        {trimmed && (
          <span className="text-text-3 text-xs">
            {matched.length === 0 ? "没有匹配的标签" : `匹配 ${matched.length} 个`}
          </span>
        )}
        {/* At the top as well as at the fold: after scrolling through 273 chips
            the way back is up here, not at the end of the list. */}
        {!trimmed && tags.length > TOP && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            className="text-text-3 hover:text-text-1 focus-visible:focus-ring ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px]"
          >
            {expanded ? "收起" : `展开全部 ${tags.length} 个`}
            <CaretDown
              size={10}
              aria-hidden
              className={cn("transition-transform duration-200", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>

      {/* No height animation here, on purpose — see the note on `TOP`. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={selected === null}
          onClick={() => onSelect(null)}
          className={cn(CHIP, selected === null ? CHIP_ON : CHIP_IDLE)}
        >
          全部
        </button>

        {shown.map((tag) =>
          tag.name === selected ? (
            <span key={tag.id} className={cn(CHIP, CHIP_ON, "pr-1.5")}>
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
              // Spoken as one phrase: the chip renders "#", the name and a
              // count in three nodes, which reads as "# 科幻 3" aloud.
              aria-label={`${tag.name}，${tag.count} 本`}
              onClick={() => onSelect(tag.name)}
              className={cn(CHIP, CHIP_IDLE)}
            >
              <span className="text-text-3">#</span>
              {tag.name}
              <span className="text-text-3 tabular-nums">{tag.count}</span>
            </button>
          ),
        )}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={cn(CHIP, CHIP_IDLE, "border-dashed")}
          >
            还有 {hidden} 个…
          </button>
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
