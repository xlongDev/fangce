import { useLayoutEffect, useRef, useState } from "react";
import { CaretDown, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { useDeleteTag } from "@/hooks/useTags";
import { searchTags } from "@/features/library/labelSearch";
import { cn } from "@/lib/cn";
import type { TagSummary } from "@/types/ipc";

/**
 * The tag shelf's index.
 *
 * It used to be a bar of chips above the books, which on a 281-label library
 * meant the reader scrolled past their own vocabulary to reach the tail before
 * they could see a single book — and the page is called 「按标签浏览」, so the
 * books are the content and the labels are its table of contents. A rail is
 * what a table of contents looks like: always there, always the same width,
 * with the books beside it instead of below it.
 *
 * Three things make it readable at this size, and none of them is a colour:
 *
 * - **Bands** by how many books a label gathers (≥ 8 / 2–7 / 1), each with its
 *   own header and count, so the top is the vocabulary the reader actually has.
 * - **A bar** under the labels that carry weight, drawn from the same number —
 *   长篇小说 (50) and 伦理学 (1) stop being the same size.
 * - **Search**, because the tail is 152 labels and nobody browses it.
 *
 * Rows are flat: a hairline and a fill, no `glass`. A chip is five box-shadow
 * layers, and 281 of them unfolded in one frame is ~1400 shadows painted for a
 * list that is text.
 */

/** Books a label needs to sit in the top band. */
const COMMON = 8;
/** Below this, a label has been used once and belongs in the tail. */
const OCCASIONAL = 2;

/**
 * How many rows a band shows before it folds.
 *
 * A rail is ~14 rows tall, so a band that fits in one screen is a band that
 * needs no fold. Fixed band rules were the first attempt — 「≥8 / 2–7 / 1」 —
 * and they produced 15 / **114** / 152 on the library this was built for: the
 * middle band was still two screens. Folding by size keeps the rail one screen
 * whatever shape the reader's vocabulary has.
 */
const PER_BAND = 10;

/**
 * The count, and — when the row is the current filter — the only place the
 * accent appears in this rail.
 *
 * Filled rather than tinted: `accent-soft` is 12% over white in the light
 * theme, which is a beige pill on a white row — no pill at all. A solid fill
 * with `on-accent` text clears contrast in both themes, so the same class
 * works without a second rule per theme.
 */
const countPill = (count: number | undefined, active: boolean, heavy: boolean) =>
  count === undefined ? null : (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[11.5px] tabular-nums transition-colors duration-150",
        active ? "bg-accent text-on-accent font-medium" : heavy ? "text-text-1" : "text-text-3",
      )}
    >
      {count}
    </span>
  );

interface TagIndexProps {
  tags: TagSummary[];
  /** The label being shown, or `null` for the whole shelf. */
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** Books in the shelf, for the 「全部」 row's count. Without it that row would
   *  be the only selected row with nothing highlighted, which reads as broken. */
  total?: number;
}

export function TagIndex({ tags, selected, onSelect, total }: TagIndexProps) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<TagSummary | null>(null);
  /** Which bands the reader has opened or closed, by band key. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const remove = useDeleteTag();

  const trimmed = query.trim().toLowerCase();
  /** Already in relevance order; empty query hands back the shelf order. */
  const matched = searchTags(tags, query);

  // The backend hands these over most-used first, so filtering is enough to
  // band them — no second sort that could disagree with the query.
  //
  // The bands are named after **how many books a label gathers**, not after a
  // judgement of it. 「常用 / 普通 / 只用过一次」 read as a verdict on the reader's
  // own vocabulary — a label that happens to hold one book is not a lesser
  // label, it is a narrow one — and 「普通」 says nothing at all. A range is what
  // the reader is actually comparing: 8 本以上 / 2–7 本 / 1 本.
  const bands = [
    {
      key: "many",
      label: `${COMMON} 本以上`,
      tags: matched.filter((tag) => tag.count >= COMMON),
    },
    {
      key: "some",
      label: `${OCCASIONAL}–${COMMON - 1} 本`,
      tags: matched.filter((tag) => tag.count >= OCCASIONAL && tag.count < COMMON),
    },
    {
      key: "one",
      label: `${OCCASIONAL - 1} 本`,
      tags: matched.filter((tag) => tag.count < OCCASIONAL),
    },
  ];

  /**
   * Whether a band is showing its rows.
   *
   * `overrides` comes first, and that order is the whole fix for 「点了收起没
   * 反应」: the previous version let 「the selected tag lives in this band」 win,
   * so a band holding the current filter could never be closed — the one band
   * the reader is most likely to want out of the way. A band still opens on its
   * own when the filter lands in it, because a selection you cannot see reads as
   * no selection; that default is just a default.
   *
   * Searching always opens everything: the reader is looking for a word, not
   * browsing a structure.
   */
  const bandOpen = (key: string, band: TagSummary[]) =>
    overrides[key] ?? (band.some((tag) => tag.name === selected) || band.length <= PER_BAND);

  /** The list, and each row's element, so the highlight can be measured. */
  const listRef = useRef<HTMLUListElement>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  /** Where the glass highlight is, in the list's own coordinates. */
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null);
  /** False for the first measurement: the highlight appears where the selection
   *  already is, instead of sliding in from the top of the list. */
  const [settled, setSettled] = useState(false);

  /**
   * One glass pane that travels between rows, rather than a fill on each row.
   *
   * This is the whole reason the highlight is a separate element: a background
   * colour can be swapped but not carried, and 「selected moves」 is easier to
   * read as one object moving than as two objects cross-fading.
   *
   * Measured in the list's own coordinates (`getBoundingClientRect` minus the
   * list's top, plus its scroll offset) so the pane scrolls with the rows it
   * belongs to. Recomputed whenever the layout can have shifted — a band folded,
   * a search typed, a tag deleted — not just when the selection changes.
   */
  /** Rows on screen right now. The pane must be re-measured whenever this
   *  changes — a band folded, a search typed, a tag deleted — and this is the
   *  number that actually moves when those happen. */
  const visibleRows =
    1 +
    (trimmed !== ""
      ? matched.length
      : bands.reduce((n, band) => n + (bandOpen(band.key, band.tags) ? band.tags.length : 0), 0));

  const rowKey = selected ?? "";
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = rowsRef.current.get(rowKey);
    if (!list || !row || visibleRows === 0) {
      setBar(null);
      return;
    }
    const rect = row.getBoundingClientRect();
    const top = rect.top - list.getBoundingClientRect().top + list.scrollTop;
    // Same place and same size keeps the old object: a fresh one every render
    // would schedule another render, forever.
    setBar((prev) =>
      prev && prev.top === top && prev.height === rect.height ? prev : { top, height: rect.height },
    );
    if (!settled) {
      // One frame with transitions off, so the first paint is where it ends up.
      const frame = requestAnimationFrame(() => setSettled(true));
      return () => cancelAnimationFrame(frame);
    }
  }, [rowKey, settled, visibleRows]);

  if (tags.length === 0) {
    return (
      <p className="text-text-3 text-xs leading-relaxed">
        还没有标签。在书的右上角点标签按钮，给它写个名字，这里就能按标签筛选。
      </p>
    );
  }

  const row = (tag: TagSummary) => {
    const active = tag.name === selected;
    return (
      <li key={tag.id} className="group relative">
        <div
          ref={(el) => {
            if (el) rowsRef.current.set(tag.name, el);
            else rowsRef.current.delete(tag.name);
          }}
          className={cn(
            "relative flex h-8 items-center rounded-lg transition-colors duration-150 ease-out",
            // The selected row carries no fill of its own: the glass pane behind
            // the list draws it, and a fill here would cover that pane up.
            active ? "" : "hover:bg-text-1/6",
          )}
        >
          <button
            type="button"
            aria-current={active ? "true" : undefined}
            aria-label={`${tag.name}，${tag.count} 本`}
            onClick={() => onSelect(tag.name)}
            className="focus-visible:focus-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 pl-2.5 text-left"
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] transition-colors duration-150",
                active ? "text-text-1 font-medium" : "text-text-2",
              )}
            >
              {tag.name}
            </span>
            {/* The mark of "this is the one" sits on the number, not in a bar
                down the left edge: a 2px accent bar is the tree-view gesture,
                and these rows are pills with a 24px radius — a straight line
                against a curve reads as a notch. */}
            {countPill(tag.count, active, tag.count >= COMMON)}
          </button>
          {/* Beside the name rather than inside it (a button in a button is not
              a button), and quiet until the row is pointed at: a destructive
              control should not sit in the path of a label the reader is about
              to click. */}
          <button
            type="button"
            aria-label={`删除标签 ${tag.name}`}
            onClick={() => setPending(tag)}
            className="press focus-visible:focus-ring text-text-3 hover:text-danger mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Trash size={12} />
          </button>
        </div>
      </li>
    );
  };

  return (
    <nav
      aria-label="标签索引"
      // 摞在书上时给它一个上限自己滚（否则 40 行目录把书挤到屏外）；
      // 摆到书旁边时贴着滚动区顶部，翻书的时候目录一直在。
      //
      // 🔴 **头钉住，只有列表滚。** 让整列滚的第一个版本有两个毛病：搜索框跟着
      // 滚走（展开 114 行之后想换个词得先滚回顶部），而那些行被 `flex-shrink`
      // 按比例压扁（32px 变 24px，越展开越瘪）—— 行是 flex 子项，容器一有上限
      // 它们就分着挨压。分开之后列表是滚动容器，行在它里面保持自己的高度。
      // 宽窗给**固定高度**而不是 max-height：高度一确定，下面的列表就必然分到
      // 「剩余空间」，滚动不再取决于内容是否恰好溢出（内容差几像素时 max-height
      // 会让整列刚好放下，视觉上就是「列表滚不动」）。窄窗仍用 max-h，因为那时
      // 它摞在书上，不能占满整屏。
      className="flex max-h-[42vh] flex-col @min-[720px]:sticky @min-[720px]:top-0 @min-[720px]:h-[calc(100vh-8.5rem)] @min-[720px]:max-h-none"
    >
      {/* One row, exactly as tall as the shelf's toolbar beside it (`GlassInput`
          is h-9) — the two columns read as a single line of controls, and a
          second line here pushes the whole index down by 15px, which is what
          made the rail look taller than the bar next to it.

          The count lives inside the field instead, and only while searching: a
          total is already implied by the bands (常用 15 / 普通 114 / 一次 152),
          while 「匹配 12」 is the thing the reader cannot get anywhere else. */}
      <div className="relative shrink-0">
        <GlassInput
          className="pr-16"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标签或拼音"
          title="拼音首字母或全拼都能找，空格隔开多个词，比如 zg / zhongguo"
          aria-label="搜索标签或拼音首字母"
        />
        {trimmed && (
          <span className="text-text-3 pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] tabular-nums">
            匹配 {matched.length}
          </span>
        )}
      </div>

      {/* `mb-4` matches the toolbar's own margin, so the first tag row and the
          first book row start on the same line — the two columns are one grid,
          and their content should read as one. `min-h-0` so the list gives way
          instead of pushing the header out, and a plain block (not a flex
          column) so its rows are never the ones that shrink. */}
      <ul ref={listRef} className="relative mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
        {/* The highlight itself. `glass` because it is the one lifted surface in
            here — every other row is a flat fill, so the selected one reads as a
            pane laid on the list rather than a row that changed colour.

            `right-1` stops short of the scrollbar's gutter; `pointer-events-none`
            so clicks pass through to the row underneath. */}
        {bar && (
          <div
            aria-hidden
            data-tag-indicator
            style={{ transform: `translateY(${bar.top}px)`, height: bar.height }}
            className={cn(
              "glass pointer-events-none absolute top-0 right-1 left-0 rounded-lg",
              settled && "transition-transform duration-[420ms] ease-[var(--ease-spring)]",
            )}
          />
        )}
        <li>
          <button
            type="button"
            aria-current={selected === null ? "true" : undefined}
            onClick={() => onSelect(null)}
            // `pr-8` matches where a tag row's count lands: the tag rows hold
            // space for the delete button even when it is invisible, so without
            // it 「全部」 would print its number 24px to the right of every row
            // under it.
            ref={(el) => {
              if (el) rowsRef.current.set("", el);
              else rowsRef.current.delete("");
            }}
            className={cn(
              "focus-visible:focus-ring relative flex h-8 w-full items-center gap-2 rounded-lg pr-8 pl-2.5 text-left text-[13px] transition-colors duration-150 ease-out",
              selected === null ? "text-text-1 font-medium" : "text-text-2 hover:bg-text-1/6",
            )}
          >
            <span className="min-w-0 flex-1 truncate">全部</span>
            {countPill(total, selected === null, true)}
          </button>
        </li>

        {/* A search shows matches, not bands. Relevance order is the only order
            that means anything while looking for one word, and grouping by how
            many books a label gathers would shuffle that order into three
            piles the reader did not ask for. */}
        {trimmed !== ""
          ? matched.map(row)
          : bands.map((band) => {
              if (band.tags.length === 0) return null;
              const open = bandOpen(band.key, band.tags);
              const shown = open ? band.tags : [];
              return (
                <li key={band.key} className="mt-3">
                  {/* The header is a heading, and a heading does not need a verb in
                  it: the count on its left is the state, the arrow on its right
                  is the control. 「展开 15 个」 next to 「常用 15」 was the count
                  twice, in two different kinds of text. */}
                  <p className="text-text-3 mb-1 flex items-center gap-1.5 pl-2.5 text-[11px]">
                    {band.label}
                    <span className="tabular-nums opacity-60">· {band.tags.length}</span>
                    {band.tags.length > PER_BAND && (
                      <button
                        type="button"
                        onClick={() => setOverrides((all) => ({ ...all, [band.key]: !open }))}
                        aria-expanded={open}
                        aria-label={open ? "收起" : `展开 ${band.tags.length} 个`}
                        className="press focus-visible:focus-ring text-text-3 hover:bg-surface-2 hover:text-text-1 ml-auto flex h-5 w-5 items-center justify-center rounded-md"
                      >
                        <CaretDown
                          size={11}
                          aria-hidden
                          className={cn(
                            "transition-transform duration-200 ease-out",
                            open && "rotate-180",
                          )}
                        />
                      </button>
                    )}
                  </p>
                  {shown.length > 0 && <ul className="flex flex-col">{shown.map(row)}</ul>}
                </li>
              );
            })}
      </ul>

      <GlassDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
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
    </nav>
  );
}
