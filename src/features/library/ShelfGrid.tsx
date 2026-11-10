import type { ReactNode, RefObject } from "react";
import { BookOpen, CaretDown, X } from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { QueryError } from "@/components/common/QueryError";
import { GlassButton } from "@/components/glass/button";
import { BookCard } from "@/features/library/BookCard";
import { SECTION_HEADER_H, type BookSection } from "@/features/library/group";
import { ShelfEmptyState } from "@/features/library/ShelfEmptyState";
import type { useShelfWindow } from "@/hooks/useShelfWindow";
import { cn } from "@/lib/cn";
import { staggerDelay, useMotion } from "@/lib/motion";
import type { BookSummary } from "@/types/ipc";

/**
 * The windowed card grid.
 *
 * Only the cards the viewport can reach are rendered (see `useShelfWindow`);
 * the rest of the list is held open by the two spacers.
 */
export function ShelfGrid({
  pending,
  error,
  search,
  list,
  shelf,
  gridRef,
  layout,
  tagRow,
  collapsed,
  onToggleSection,
  managing,
  selected,
  busy,
  onToggleSelect,
  onOpen,
  onToggleFavorite,
  onAskDelete,
  onAskExport,
  onExportFile,
  onEditTags,
  onEditMeta,
  onImport,
  onClearSearch,
  onRetry,
  empty,
}: {
  pending: boolean;
  error: unknown;
  search: string;
  list: BookSummary[];
  shelf: ReturnType<typeof useShelfWindow>;
  gridRef: RefObject<HTMLDivElement | null>;
  layout: "grid" | "list";
  tagRow: boolean;
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  managing: boolean;
  selected: ReadonlySet<string>;
  busy: boolean;
  onToggleSelect: (book: BookSummary) => void;
  onOpen: (book: BookSummary) => void;
  onToggleFavorite: (book: BookSummary) => void;
  onAskDelete: (book: BookSummary) => void;
  onAskExport: (book: BookSummary) => void;
  onExportFile: (book: BookSummary) => void;
  onEditTags: (book: BookSummary) => void;
  onEditMeta: (book: BookSummary) => void;
  onImport: () => void;
  /** Clear the shelf's search, from the empty state that search produced. */
  onClearSearch: () => void;
  /** Ask the shelf's own query again, from the error state. */
  onRetry: () => void;
  /** What an empty shelf says. Defaults to the import prompt, which is right
   *  for every shelf that a book can arrive on and wrong for the bin. */
  empty?: ReactNode;
}) {
  const m = useMotion();

  if (pending) return <ShelfSkeleton />;
  if (error) {
    // The raw rejection used to *be* the description: a database lock or a
    // missing file, in English, under a heading that says 书架暂时打不开. What
    // a reader needs first is the one action that can help, so the sentence is
    // written here and the exception is folded away — it is still what makes a
    // report actionable, and it is the only thing on this screen that can be
    // copied into one. The block itself now lives in <QueryError>.
    return (
      <QueryError
        className="min-h-[30vh]"
        error={error}
        onRetry={onRetry}
        icon={<BookOpen size={26} weight="duotone" />}
        title="书架暂时打不开"
        description="书库这次没有读出来。先重试一次；如果还是不行，多半是本地的数据库或书籍文件出了问题。"
      />
    );
  }
  if (list.length === 0 && search) {
    return (
      <EmptyState
        className="min-h-[40vh]"
        icon={<BookOpen size={26} weight="duotone" />}
        title="没有找到匹配的书"
        description="换个关键词试试，搜索会同时匹配书名和作者。"
        action={
          // A search that matched nothing used to offer nothing at all: the
          // action was suppressed when `search` was set, which left the 13px ✕
          // inside the search field as the only way back to the whole shelf.
          // The empty state now carries the way out itself.
          //
          // The label is 「清空搜索条件」 rather than 「清除搜索」 on purpose —
          // the search field's own ✕ is already named 清除搜索, and a second
          // button whose name contains it would make every unscoped
          // `getByRole("button", { name: "清除搜索" })` ambiguous. That is the
          // failure mode the notes page's 批量管理 locator already hit once.
          //
          // It clears the *search*, not the label filter, so it cannot say
          // 「显示全部书籍」: on the 标签 shelf the tag narrowing stays put.
          <GlassButton size="md" onClick={onClearSearch}>
            <X size={14} /> 清空搜索条件
          </GlassButton>
        }
      />
    );
  }
  // A shelf with nothing in it gets its own state: the shelf of books, the
  // formats the importer actually takes, and the import button — what a reader
  // who just installed this needs, which a generic empty state cannot say.
  if (list.length === 0) {
    return empty ?? <ShelfEmptyState className="min-h-[40vh]" onImport={onImport} />;
  }

  return (
    <>
      {/* The rows above the window, held open at exactly the height they
          would have taken: the two spacers and the grid add up to the full
          list's height, gap for gap. Empty boxes rather than padding on
          the scroller, so the scrollbar length never depends on which
          rows happen to be rendered. */}
      {shelf.top > 0 && <div style={{ height: shelf.top }} aria-hidden />}
      <div
        ref={gridRef}
        data-shelf-grid
        // The track list is pinned from the window's count as soon as
        // there is one, and pinning it is what makes a column change
        // animate (see `ShelfWindow.columns`). Left to `auto-fill` alone,
        // the tracks follow the pane the instant the sidebar moves — a
        // reflow with no DOM mutation for motion to snapshot around, so
        // the cards teleported into their new slots. Hence an inline
        // `style` and not only a class: this has to be a *render*.
        // `--shelf-track` keeps the pinned `repeat()` and the `auto-fill`
        // fallback (the class, used until the first measurement lands) on
        // one number.
        style={
          layout === "grid" && shelf.columns > 0
            ? {
                gridTemplateColumns: `repeat(${shelf.columns}, minmax(0, var(--shelf-track)))`,
              }
            : undefined
        }
        className={cn(
          layout === "grid"
            ? // A fixed cover width, not `1fr` columns. `1fr` ties the
              // cover to the pane, and the pane is 248px narrower with
              // the sidebar open — so toggling the rail resized every
              // cover on the shelf (measured at 1440: 165px open,
              // 194px closed, a 17% swing on a gesture that is not
              // about the books). With a fixed track the rail buys
              // another *column* instead, and a cover is the same
              // object in both states. The track is sized to the width
              // the six-column shelf has at the default window, so the
              // common case is untouched; the leftover at other widths
              // is a right margin, which is what a shelf of fixed
              // objects does.
              "grid grid-cols-[repeat(auto-fill,minmax(0,var(--shelf-track)))] gap-x-5 gap-y-6"
            : // List: a single column, tight row gap (the row itself pads
              // itself). The list row already sizes its own cover + meta
              // inside; only the gap between rows is the grid's job.
              "grid grid-cols-1 gap-y-2",
        )}
      >
        {/* No `AnimatePresence` around the window. Its children set changes
            on every scroll, and an exit animation is not something that can
            be told apart from a filter change — so the removed tiles were
            kept in the DOM for it (measured: one whole window's worth, back
            in flow, which made the grid twice the height of the list it
            stands for and pushed the scroll position around under the
            reader). Tiles leaving the window therefore stop being rendered,
            and what is left of the filter-change motion is the survivors'
            FLIP below plus the arriving cards' stagger.

            Flattened rather than wrapped: a row is a *group* of cards for the
            window's arithmetic, but it is nothing at all to the DOM. Wrapping
            one in an element would put a box between the grid and its tracks;
            wrapping one in a keyed fragment would re-key every card in the row
            the moment the column count changed — and it is the *unchanged* key
            that lets motion see a card cross the grid and glide to its new
            slot instead of mounting somewhere else (see `ShelfWindow.columns`).
            So each card still answers to its own book id, and a heading is the
            one line that is an element of its own. */}
        {shelf.items.slice(shelf.start, shelf.end).flatMap((item) =>
          item.kind === "header" ? (
            <SectionHeading
              key={`heading:${item.section.key}`}
              section={item.section}
              collapsed={collapsed.has(item.section.key)}
              onToggle={onToggleSection}
            />
          ) : (
            list.slice(item.from, item.to).map((book, offset) => (
              <BookCard
                key={book.id}
                book={book}
                // The stagger is a position in the *list* — the window's own
                // order would restart it at every scroll.
                delay={staggerDelay(item.from + offset, m.stagger)}
                entering={!shelf.sliding}
                reserveTags={tagRow && layout === "grid"}
                busy={busy}
                selecting={managing}
                selected={selected.has(book.id)}
                onToggleSelect={onToggleSelect}
                onOpen={onOpen}
                variant={layout}
                onToggleFavorite={onToggleFavorite}
                onAskDelete={onAskDelete}
                onAskExport={onAskExport}
                onExportFile={onExportFile}
                onEditTags={onEditTags}
                onEditMeta={onEditMeta}
              />
            ))
          ),
        )}
      </div>
      {shelf.bottom > 0 && <div style={{ height: shelf.bottom }} aria-hidden />}
    </>
  );
}

/**
 * A pile's heading, in the flow between the rows.
 *
 * A line of the list rather than a label floating over it: it takes room, and
 * the window has to be told exactly how much — `SECTION_HEADER_H` is the number
 * the arithmetic walks *and* the height this renders at, so the two cannot
 * drift apart. A heading a few pixels taller than the arithmetic believes would
 * put every card below it out by that much, and the error would compound down
 * the list, pile after pile.
 *
 * The whole line is the toggle: one target rather than a label with a chevron
 * beside it, which is also what lets the chevron be a *state* instead of a
 * control.
 */
function SectionHeading({
  section,
  collapsed,
  onToggle,
}: {
  section: BookSection;
  collapsed: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <button
      type="button"
      data-shelf-header={section.key}
      aria-expanded={!collapsed}
      onClick={() => onToggle(section.key)}
      // Height and span are inline because both are read back: the window walks
      // the list at `SECTION_HEADER_H`, and the heading has to take a line of
      // its own whatever the column count happens to be.
      style={{ height: SECTION_HEADER_H, gridColumn: "1 / -1" }}
      className="focus-visible:focus-ring flex cursor-pointer items-end gap-1.5 pb-1 text-left"
    >
      <CaretDown
        size={10}
        weight="bold"
        className={cn(
          "text-text-3 mb-0.5 shrink-0 transition-transform duration-200",
          collapsed && "-rotate-90",
        )}
      />
      <span className="text-text-1 text-xs font-medium">{section.label}</span>
      <span className="text-text-3 text-xs">{section.count} 本</span>
    </button>
  );
}

function ShelfSkeleton() {
  return (
    // Mirrors the real tile's box (cover + two text lines) so the grid does not
    // jump when the books land, and announces itself once for screen readers.
    // The track must match the real grid's (see the shelf above) or the covers
    // shift sideways the moment the books arrive.
    <output
      aria-label="正在加载书架"
      className="grid grid-cols-[repeat(auto-fill,minmax(0,var(--shelf-track)))] gap-x-5 gap-y-6"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index}>
          <div className="skeleton aspect-[3/4] rounded-md" />
          <div className="skeleton mt-2 h-3.5 w-3/4 rounded-full" />
          <div className="skeleton mt-1.5 h-3 w-1/2 rounded-full" />
        </div>
      ))}
    </output>
  );
}
