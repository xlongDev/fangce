import { motion, useReducedMotion } from "motion/react";
import {
  ArrowDown,
  CaretDown,
  CheckSquare,
  MagnifyingGlass,
  Rows,
  SortAscending,
  SquaresFour,
  StackSimple,
  X,
} from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { sortOptions } from "@/features/library/format";
import { groupOptions, type ShelfGroup } from "@/features/library/group";
import { DURATION, SPRING } from "@/lib/motion";
import { cn } from "@/lib/cn";
import type { useLibraryStats } from "@/hooks/useLibrary";
import type { LibrarySort } from "@/types/ipc";

/**
 * Search, sort, layout and the batch-manage switch — the one row of controls
 * that acts on the whole shelf rather than on a book.
 */
export function ShelfToolbar({
  search,
  onSearch,
  sort,
  onSort,
  descending,
  onDescending,
  group,
  onGroup,
  layout,
  onLayout,
  managing,
  onToggleManaging,
  stats,
}: {
  search: string;
  onSearch: (value: string) => void;
  sort: LibrarySort;
  onSort: (value: LibrarySort) => void;
  /** True while the shelf is pointing the way `descending` says. */
  descending: boolean;
  onDescending: (value: boolean) => void;
  group: ShelfGroup;
  onGroup: (value: ShelfGroup) => void;
  layout: "grid" | "list";
  onLayout: (value: "grid" | "list") => void;
  managing: boolean;
  onToggleManaging: () => void;
  stats: ReturnType<typeof useLibraryStats>["data"];
}) {
  const reduce = useReducedMotion();

  /**
   * Where a word waits when it is not the one being shown: 降序 parks above the
   * slot, 升序 below it, so flipping the control slides *both* the same way in
   * one movement — the outgoing word leaving through the top as the incoming
   * one arrives from the bottom. One direction for the whole control, which is
   * the thing that makes it read as the shelf being re-pointed rather than as
   * a word that was replaced.
   *
   * Both words stay mounted rather than swapping under an `AnimatePresence`,
   * so a flip caught mid-flight carries its velocity into the next one instead
   * of restarting from wherever the interrupted one happened to be.
   */
  const parked = (above: boolean) => (reduce ? "0%" : above ? "-100%" : "100%");
  const flip = reduce ? { duration: DURATION.fast } : SPRING.tap;

  return (
    // `flex-wrap` is load-bearing: the search keeps a 160px floor, and on a
    // narrow pane (880px window) the five controls plus the count do not fit
    // beside it — without wrapping they overflowed the shelf by 127px, which
    // is what `e2e/shelf-reflow.spec.ts` measures. The search still takes the
    // slack on a wide one, so nothing about the roomy case changed.
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-64 min-w-40 flex-1">
        <MagnifyingGlass
          size={14}
          className="text-text-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
        />
        <GlassInput
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索书名或作者"
          className="pr-8 pl-8"
          aria-label="搜索书名或作者"
        />
        {search && (
          <button
            type="button"
            aria-label="清除搜索"
            onClick={() => onSearch("")}
            className="text-text-3 hover:text-text-1 absolute top-1/2 right-2 -translate-y-1/2"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* The two dropdowns read identically otherwise, so each leads with its
          own glyph — the same trick the grouping select already used, now on
          both sides of the direction button between them. */}
      <div className="glass focus-within:focus-ring relative inline-flex h-9 items-center rounded-md">
        <SortAscending
          size={13}
          className="text-text-3 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        />
        <select
          aria-label="排序方式"
          value={sort}
          onChange={(event) => onSort(event.target.value as LibrarySort)}
          className="text-text-1 appearance-none bg-transparent pr-7 pl-7 text-sm outline-none [&>option]:text-black"
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <CaretDown
          size={12}
          className="text-text-3 pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
        />
      </div>

      {/* Direction. Flipping the whole array rather than asking SQL for a
          second order per option: every order gains an ascending and a
          descending side from one button, and no variant has to know which
          way round it is.

          The label reads the *effective* direction, not the flip — 最近添加
          and 文件大小 already come back descending, so a toggle that called
          the untouched order "升序" would be lying about the shelf. */}
      <button
        type="button"
        aria-label={descending ? "当前降序，改为升序" : "当前升序，改为降序"}
        title={descending ? "当前降序，点击改为升序" : "当前升序，点击改为降序"}
        aria-pressed={descending}
        onClick={() => onDescending(!descending)}
        className={cn(
          "glass text-text-2 hover:text-text-1 focus-visible:focus-ring inline-flex h-9 items-center gap-1 rounded-md px-2.5 text-sm transition-colors",
          descending && "text-text-1",
        )}
      >
        {/* One arrow, turned, rather than two swapped: the flip is a rotation
            and an icon that turns in place says that, where two different
            glyphs say "this is a different control now". */}
        <motion.span
          className="inline-flex"
          animate={{ rotate: descending ? 0 : 180 }}
          transition={reduce ? { duration: 0 } : SPRING.tap}
        >
          <ArrowDown size={13} />
        </motion.span>
        {/* Fixed width: both words are two characters, so the control must not
            twitch as they trade places. */}
        <span className="relative inline-block h-5 w-8 overflow-hidden">
          <motion.span
            animate={{ y: descending ? "0%" : parked(true), opacity: descending ? 1 : 0 }}
            transition={flip}
            className="absolute inset-0 flex items-center justify-center"
          >
            降序
          </motion.span>
          <motion.span
            animate={{ y: descending ? parked(false) : "0%", opacity: descending ? 0 : 1 }}
            transition={flip}
            className="absolute inset-0 flex items-center justify-center"
          >
            升序
          </motion.span>
        </span>
      </button>

      {/* Grouping. Sections, not order: with a group chosen the shelf is cut
          into piles and each pile keeps the current order inside it, so the two
          controls answer different questions and combine.

          A plain `<select>` beside the sort one rather than a segmented
          control — four options, each two to four characters, which is more
          than a stadium holds. The icon is what tells the two dropdowns apart
          at a glance, since they read the same otherwise. */}
      <div className="glass focus-within:focus-ring relative inline-flex h-9 items-center rounded-md">
        <StackSimple
          size={13}
          className="text-text-3 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
        />
        <select
          aria-label="分组方式"
          value={group}
          onChange={(event) => onGroup(event.target.value as ShelfGroup)}
          className="text-text-1 appearance-none bg-transparent pr-7 pl-7 text-sm outline-none [&>option]:text-black"
        >
          {groupOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <CaretDown
          size={12}
          className="text-text-3 pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
        />
      </div>

      {/* Shelf layout: grid tiles (cover-on-top) or single-column rows.
          Same `layoutId` highlight as the sidebar's theme pill: one
          stadium springs between the two cells instead of each cell
          rendering its own background, so the choice reads as motion.

          The thumb's radius is derived from the track's rather than being
          a literal. The track is a stadium (36px tall, `--radius-md` 18px),
          so 1px of border and 4px of padding leave a 13px inner curve — and
          a thumb whose radius does not match it cuts across the curve the
          track has already turned away from. Measured with the old 7px
          literal, the thumb's corner sat 10.9px outside the track's outline
          and read as "the thumb is too big" even though it fitted inside
          with 2px to spare.

          The padding is 4px rather than the usual 2px for the same reason:
          at 2px the thumb is 32px in a 36px track, and a 13-16px radius on
          a near-square 36×32 cell renders as a circle — rounder than the
          track it sits in, which reads as *bigger*, not smaller. 26×36 is
          a stadium that is wider than it is tall, which is what a
          segmented thumb is supposed to look like. */}
      <div className="glass relative inline-flex h-9 items-stretch rounded-md p-1">
        {(
          [
            { value: "grid", icon: SquaresFour, label: "网格视图" },
            { value: "list", icon: Rows, label: "列表视图" },
          ] as const
        ).map((option) => {
          const active = layout === option.value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              title={option.label}
              aria-label={option.label}
              aria-pressed={active}
              onClick={() => onLayout(option.value)}
              className={cn(
                "focus-visible:focus-ring relative flex w-9 items-center justify-center rounded-[calc(var(--radius-md)-5px)] transition-colors",
                active ? "text-text-1" : "text-text-3 hover:text-text-2",
              )}
            >
              {active && (
                <motion.span
                  layoutId="shelf-layout-pill"
                  className="bg-surface-3 shadow-glass absolute inset-0 rounded-[calc(var(--radius-md)-5px)]"
                  transition={reduce ? { duration: 0 } : SPRING.layout}
                />
              )}
              <Icon size={14} weight={active ? "fill" : "regular"} className="relative" />
            </button>
          );
        })}
      </div>

      {/* 选择 / 完成, the words Finder, Photos and Files all use. It used to
          say 批量管理 → 退出管理: a backend term for one half and a sentence
          about "management" for the other, and the entry wore `primary` (the
          action colour) for what is really the way back out.

          The glyph stayed `CheckSquare` on purpose. `Selection` — a dashed
          marquee plus a pointer — says "go pick some" more precisely, but at
          15px the dashed frame and the arrow collapse into two brackets.
          Measured on screen, not guessed: it read as `[ ]`. A ticked box is
          the more common multi-select symbol anyway (Gmail, Notion), and the
          word beside it now carries the meaning. */}
      <GlassButton size="md" onClick={onToggleManaging}>
        <CheckSquare size={15} /> {managing ? "完成" : "选择"}
      </GlassButton>

      {/* Kept mounted and made invisible while selecting, rather than dropped:
          it is `ml-auto`, so removing it slid the button above 100px to the
          right at the exact moment the reader pressed it. */}
      {stats && stats.total > 0 && (
        <p className={cn("text-text-3 ml-auto text-xs", managing && "invisible")}>
          共 {stats.total} 本{stats.reading > 0 && ` · 在读 ${stats.reading}`}
          {stats.favorites > 0 && ` · 收藏 ${stats.favorites}`}
        </p>
      )}
    </div>
  );
}
