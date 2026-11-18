import { useLayoutEffect, useRef, useState } from "react";
import { CaretDown, Check, PencilSimple, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { useDeleteTag, useDeleteTags, useRenameTag } from "@/hooks/useTags";
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
  const removeMany = useDeleteTags();
  const rename = useRenameTag();

  // Tag management lives in the index itself: a rail that already lists every
  // label is the natural place to rename and clear them. Managing is a mode so
  // the browse-and-filter gestures stay one click and the destructive controls
  // stay out of the way until asked for.
  const [managing, setManaging] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<"selected" | "all" | null>(null);
  const [renaming, setRenaming] = useState<TagSummary | null>(null);
  const [renameText, setRenameText] = useState("");

  const enterManaging = () => {
    setManaging(true);
    setChecked(new Set());
    setQuery("");
    // Managing means acting on the whole vocabulary: a band folded shut for
    // browsing would hide labels the reader needs to see (and might tick).
    setOverrides(
      Object.fromEntries(
        bands.filter((band) => band.tags.length > 0).map((band) => [band.key, true]),
      ),
    );
  };
  const exitManaging = () => {
    setManaging(false);
    setChecked(new Set());
  };
  const toggleChecked = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChecked = tags.length > 0 && checked.size === tags.length;
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(tags.map((tag) => tag.id)));

  const openRename = (tag: TagSummary) => {
    setRenaming(tag);
    setRenameText(tag.name);
  };

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

  /**
   * Arrow keys walk the rows; Enter and Space pick one.
   *
   * The rows are buttons, so Enter and Space already do the right thing — the
   * only thing missing was a way to *reach* them without 281 Tab presses, which
   * is what the roving `tabIndex` below is for: the list is one tab stop.
   *
   * Focus moves, selection does not follow it. Every pick fires a filtered
   * query against the library, so holding ↓ would otherwise ask the database
   * for twenty shelves in a second. The cost of the other choice is one extra
   * keystroke, paid once, by a reader who was going to press Enter anyway.
   *
   * Attached to the rows rather than to the list: a `<ul>` is not interactive,
   * and focus can only ever be on a row button or that row's trash — both of
   * which carry this handler, so nothing has to bubble.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-tag-row]") ?? []),
    ];
    if (rows.length === 0) return;
    event.preventDefault();

    // `indexOf` on the element itself rather than on its label: two rows can
    // share a name after a rename, and -1 (focus was somewhere else) starts
    // from the selection instead.
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const from = at >= 0 ? at : rows.findIndex((row) => row.dataset.tagRow === rowKey);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? Math.min(rows.length - 1, from + 1)
            : Math.max(0, from - 1);

    rows[next]?.focus();
  };

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
            tabIndex={active || managing ? 0 : -1}
            data-tag-row={tag.name}
            aria-current={active ? "true" : undefined}
            aria-label={
              managing
                ? `${checked.has(tag.id) ? "取消选择" : "选择"}标签 ${tag.name}`
                : `${tag.name}，${tag.count} 本`
            }
            onKeyDown={onKeyDown}
            onClick={() => (managing ? toggleChecked(tag.id) : onSelect(tag.name))}
            className="focus-visible:focus-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-1 pl-2.5 text-left"
          >
            {managing && (
              <span
                aria-hidden
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                  checked.has(tag.id)
                    ? "border-accent bg-accent text-on-accent"
                    : "border-text-3/50",
                )}
              >
                {checked.has(tag.id) && <Check size={10} weight="bold" />}
              </span>
            )}
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
              to click. In manage mode both controls stay visible. */}
          <button
            type="button"
            tabIndex={managing || active ? 0 : -1}
            aria-label={`重命名标签 ${tag.name}`}
            onKeyDown={onKeyDown}
            onClick={() => openRename(tag)}
            className={cn(
              "press focus-visible:focus-ring text-text-3 hover:text-accent mr-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
              managing
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <PencilSimple size={12} />
          </button>
          <button
            type="button"
            // Tab reaches these only from the selected row outside manage mode.
            // Otherwise the rail would be 281 invisible stops, since the trash
            // is `opacity-0` until the row is pointed at.
            tabIndex={managing || active ? 0 : -1}
            aria-label={`删除标签 ${tag.name}`}
            onKeyDown={onKeyDown}
            onClick={() => setPending(tag)}
            className={cn(
              "press focus-visible:focus-ring text-text-3 hover:text-danger mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
              managing
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
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
      {/* The browse view's field is ONE h-9 row so it lands on the shelf
          toolbar's line. Manage mode is a temporary state — it may take two
          rows — and enters through the pencil inside that field. */}
      {managing ? (
        <div className="glass flex shrink-0 flex-col gap-1.5 rounded-md p-1.5">
          <div className="flex items-center gap-1">
            <GlassButton size="sm" variant="subtle" className="h-7 flex-1 px-2" onClick={toggleAll}>
              {allChecked ? "取消全选" : "全选"}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="subtle"
              className="h-7 flex-1 px-2"
              disabled={checked.size === 0}
              onClick={() => setPendingBulk("selected")}
            >
              删除所选{checked.size > 0 ? ` (${checked.size})` : ""}
            </GlassButton>
            <button
              type="button"
              onClick={exitManaging}
              aria-label="退出标签管理"
              title="完成整理"
              className="press focus-visible:focus-ring text-text-3 hover:text-text-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
            >
              <Check size={14} weight="bold" />
            </button>
          </div>
          <GlassButton
            size="sm"
            variant="subtle"
            className="text-danger h-7 w-full"
            onClick={() => setPendingBulk("all")}
          >
            全部删除
          </GlassButton>
        </div>
      ) : (
        <div className="relative flex h-9 shrink-0 items-center">
          <GlassInput
            className="pr-16"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标签或拼音"
            title="拼音首字母或全拼都能找，空格隔开多个词，比如 zg / zhongguo"
            aria-label="搜索标签或拼音首字母"
            // ↓ out of the field and into the results: the reader has typed two
            // letters, and reaching for the mouse to pick one of four matches is
            // the part that costs.
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              const first = listRef.current?.querySelector<HTMLButtonElement>("[data-tag-row]");
              if (!first) return;
              event.preventDefault();
              first.focus();
            }}
          />
          {trimmed && (
            <span className="text-text-3 pointer-events-none absolute top-1/2 right-9 -translate-y-1/2 text-[11px] tabular-nums">
              匹配 {matched.length}
            </span>
          )}
          <button
            type="button"
            onClick={enterManaging}
            aria-label="整理标签"
            title="整理标签"
            className="press focus-visible:focus-ring text-text-3 hover:text-accent absolute top-1/2 right-2.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md"
          >
            <PencilSimple size={13} />
          </button>
        </div>
      )}

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
            // One tab stop for the whole rail: the selected row (or 全部) is the
            // way in, and the arrows take over from there.
            tabIndex={selected === null ? 0 : -1}
            data-tag-row=""
            aria-current={selected === null ? "true" : undefined}
            onKeyDown={onKeyDown}
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

      {/* Bulk delete: a single confirmation for the checked set, or for every
          tag. The description counts tags, not books — a book can carry several,
          and a sum of counts would overstate what the reader loses. */}
      <GlassDialog
        open={pendingBulk !== null}
        onOpenChange={(next) => {
          if (!next) setPendingBulk(null);
        }}
        title={pendingBulk === "all" ? "删除全部标签？" : `删除选中的 ${checked.size} 个标签？`}
        description={`这些标签会从所有书上移除，书籍本身不受影响。此操作无法撤销。`}
        widthClass="w-[min(92vw,400px)]"
      >
        {removeMany.isError && (
          <p className="text-danger text-[13px] leading-relaxed">{removeMany.error.message}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setPendingBulk(null)}
            disabled={removeMany.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            disabled={removeMany.isPending}
            onClick={() => {
              const ids = pendingBulk === "all" ? tags.map((tag) => tag.id) : [...checked];
              if (ids.length === 0) return;
              const dropsCurrent =
                pendingBulk === "all" ||
                tags.some((tag) => ids.includes(tag.id) && tag.name === selected);
              removeMany.mutate(ids, {
                onSuccess: () => {
                  setPendingBulk(null);
                  exitManaging();
                  if (dropsCurrent) onSelect(null);
                },
              });
            }}
          >
            删除
          </GlassButton>
        </div>
      </GlassDialog>

      <GlassDialog
        open={renaming !== null}
        onOpenChange={(next) => {
          if (!next) setRenaming(null);
        }}
        title="重命名标签"
        description="所有带这个标签的书会一起更新，标签本身不变。"
        widthClass="w-[min(92vw,400px)]"
      >
        <GlassInput
          className="mt-3"
          value={renameText}
          onChange={(event) => setRenameText(event.target.value)}
          maxLength={40}
          aria-label="新标签名"
          autoComplete="off"
        />
        {rename.isError && (
          <p className="text-danger mt-2 text-[13px] leading-relaxed">{rename.error.message}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setRenaming(null)}
            disabled={rename.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="primary"
            disabled={
              rename.isPending || renameText.trim() === "" || renameText.trim() === renaming?.name
            }
            onClick={() => {
              if (!renaming) return;
              const from = renaming.name;
              rename.mutate(
                { id: renaming.id, name: renameText },
                {
                  onSuccess: () => {
                    setRenaming(null);
                    if (from === selected) onSelect(renameText.trim());
                  },
                },
              );
            }}
          >
            保存
          </GlassButton>
        </div>
      </GlassDialog>
    </nav>
  );
}
