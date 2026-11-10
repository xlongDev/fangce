import { useRef, useState } from "react";
import { motion } from "motion/react";
import {
  BookOpen,
  Check,
  DownloadSimple,
  Export,
  PencilSimple,
  Star,
  Tag,
  Trash,
} from "@phosphor-icons/react";

import { GlassDialog } from "@/components/glass/overlay";
import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { MarqueeText } from "@/components/common/MarqueeText";
import { authorLine, formatFileSize } from "@/features/library/format";
import { cn } from "@/lib/cn";
import { isDesktopRuntime } from "@/lib/ipc";
import { SPRING, useMotion } from "@/lib/motion";
import { displayTitle } from "@/lib/title";
import { useLandingBox } from "@/hooks/useLandingBox";
import { boxOf, useBookHandoff, type CoverBox } from "@/stores/book-handoff";
import type { BookSummary } from "@/types/ipc";

interface BookCardProps {
  book: BookSummary;
  busy?: boolean;
  /** Entrance offset inside a staggered shelf; see `staggerDelay`. */
  delay?: number;
  /**
   * Whether this tile arrived with the content (a filter, a sort, a first paint
   * of the shelf: it should animate in) or because the window slid under it,
   * which is scrolling and should show no motion at all. Read once, on mount.
   */
  entering?: boolean;
  /**
   * Keep the label line's space when the book has no labels. Rows have to be one
   * height for the window to compute them; only worth doing on a shelf whose
   * books carry labels at all (see `LibraryPage`).
   */
  reserveTags?: boolean;
  onOpen: (book: BookSummary) => void;
  onToggleFavorite: (book: BookSummary) => void;
  onAskDelete: (book: BookSummary) => void;
  onAskExport: (book: BookSummary) => void;
  /** The browser's export: a download of the book's own file. The desktop has
   *  somewhere to write and a panel to ask, so it offers `onAskExport`
   *  (a `.ctz`) instead — only one of the two is ever rendered. */
  onExportFile: (book: BookSummary) => void;
  onEditTags: (book: BookSummary) => void;
  onEditMeta: (book: BookSummary) => void;
  /** Batch-manage mode: clicks toggle selection instead of opening. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (book: BookSummary) => void;
  /** `grid` is the cover-on-top tile; `list` is a shallow row with the cover
   *  beside the text. Same gesture either way. */
  variant?: "grid" | "list";
}

/** One hover action on the cover: black glass, white icon — keyed to the cover
 *  art rather than the theme, so it holds on any cover in either palette. */
const coverAction =
  "h-6 w-6 rounded-full border-white/15 bg-black/45 text-white/90 backdrop-blur-[2px] " +
  "hover:bg-black/65 hover:text-white";

/** One shelf tile: cover, title, authors and quiet hover actions. */
/**
 * Whether a tile is on screen at all.
 *
 * A cover flying home needs somewhere to land, and a tile scrolled out of sight
 * is not it — the flight dissolves rather than aiming at something nobody can
 * see. Module scope so the identity is stable: the tracker keeps this in its
 * effect deps, and an inline arrow would restart the loop on every render.
 */
const onShelf = (box: Omit<CoverBox, "radius">) => box.y + box.h > 0 && box.y < window.innerHeight;

export function BookCard({
  book,
  busy,
  delay = 0,
  entering = true,
  reserveTags = false,
  onOpen,
  onToggleFavorite,
  onAskDelete,
  onAskExport,
  onExportFile,
  onEditTags,
  onEditMeta,
  selecting = false,
  selected = false,
  onToggleSelect,
  variant = "grid",
}: BookCardProps) {
  const authors = authorLine(book);
  const m = useMotion();
  const beginHandoff = useBookHandoff((s) => s.begin);
  const coverRef = useRef<HTMLSpanElement>(null);
  /**
   * `entering` as it was when this tile appeared. A scroll after the fact must
   * not turn a tile's own exit animation off: the flag is about how the card
   * arrived, not about what the shelf is doing now.
   */
  const [animated] = useState(entering);

  /** Hands the cover off to the reader's header before the route changes. */
  const open = () => {
    const cover = coverRef.current;
    if (cover) {
      beginHandoff({ id: book.id, coverUrl: book.coverUrl, from: boxOf(cover), side: "shelf" });
    }
    onOpen(book);
  };

  // The other end of the same gesture. When this book's cover is in the air —
  // on its way back from the reader — this tile is the landing pad, and it
  // keeps its own cover hidden until the flight arrives so the two are never
  // both on screen (the same trick the reader's header thumbnail uses on the
  // way in). A shelf that comes back scrolled somewhere else leaves the flight
  // to dissolve rather than sending the cover to a tile nobody can see.
  const flying = useBookHandoff((s) => s.id === book.id);
  // Tracked rather than taken once: the shelf is still rising out of its own
  // entrance when the flight arrives, and a box captured then is ten pixels
  // below where the tile settles — the cover would hop into place at the end.
  useLandingBox(book.id, coverRef, "shelf", onShelf);

  return (
    // layout: shared-layout FLIP, so resorting or filtering the shelf glides
    // cards to their new slots instead of snapping the grid into place.
    <motion.div
      layout
      // A tile a cover is flying home to skips its own entrance. It is invisible
      // either way — its cover stays hidden until the flight arrives — while a
      // wrapper still scaling up from 0.96 would move the box the flight is
      // aiming at (about 5px on a 138px cover), and a flight whose target moves
      // restarts its transition on every frame the target moves.
      initial={animated && !flying ? { opacity: 0, scale: m.reduce ? 1 : 0.96 } : false}
      animate={{ opacity: 1, scale: 1 }}
      // No `exit`: the grid does not keep a removed tile alive for one (see
      // `LibraryPage` — with a window, tiles leave on every scroll, and the ones
      // held back for an exit put the grid out of step with the list it stands
      // for). A tile that scrolls out simply stops being rendered; a filter or a
      // sort still reads as motion, because the survivors glide into their new
      // slots and the arriving cards enter on the stagger.
      transition={{ ...m.layout, delay: animated ? delay : 0 }}
      whileTap={busy || m.reduce ? undefined : { scale: 0.985 }}
      className={cn(
        "group relative",
        variant === "list" && "flex items-center gap-4 rounded-lg px-2 py-2",
      )}
    >
      <button
        type="button"
        onClick={() => (selecting ? onToggleSelect?.(book) : open())}
        aria-pressed={selecting ? selected : undefined}
        className={cn(
          "focus-visible:focus-ring text-left disabled:opacity-50",
          variant === "grid" ? "w-full rounded-md" : "flex w-full items-center gap-4 rounded-lg",
        )}
        disabled={busy}
      >
        {/* The cover carries the whole hover gesture — it rises, deepens its
            shadow and catches a band of light — while the title below stays
            put. The book lifts off the shelf; the label does not. */}
        <span
          ref={coverRef}
          data-book-cover
          className={cn(
            "glass relative block aspect-[3/4] overflow-hidden rounded-md",
            variant === "list" && "w-16 shrink-0",
            // Tailwind v4 moves `translate-y-*` with the `translate` property,
            // not `transform` — listing `transform` here would leave the lift
            // un-animated and snapping into place.
            //
            // `opacity` is deliberately not in this list. It only ever changes
            // for the handoff, and that has to be instant at both ends: while
            // the flight is in the air it is exactly on top of this cover, so
            // hiding and revealing it are invisible — but taking 300 ms over
            // the reveal is what made the cover look redrawn once the flight
            // landed (measured: the flight at 0.04 opacity, this cover at 0,
            // then a 0.53/0.86/0.93 ramp back up).
            //
            // The lift is slower and softer than the 300 ms twitch it replaced:
            // the previous `cubic-bezier(0.16,1,0.3,1)` had already done 95% of
            // the travel by 200 ms, so the eye saw a snap. The `--ease-land`
            // curve (90% at 60% of the time) reads as the book being *picked
            // up* — it should still be settling when the eye arrives. 350 ms is
            // the shortest this curve can be and still read as a lift rather
            // than a hop; a pointer crossing the shelf is not left waiting.
            "transition-[translate,box-shadow] duration-350 ease-[cubic-bezier(0.33,1,0.68,1)]",
            "group-hover:-translate-y-1.5 group-hover:shadow-[var(--shadow-cover-lift)]",
            "motion-reduce:transition-none motion-reduce:group-hover:translate-y-0",
            // Hidden only while this card's cover is in the air; the flight
            // ends the handoff and this cover is the one that lands.
            flying && "opacity-0",
          )}
        >
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
              <BookOpen size={28} weight="duotone" />
            </span>
          )}
          {/* Light sweeping the gloss: one pass per hover, no pointer tracking,
              so a 200-book shelf stays cheap. The sweep waits for the cover
              to finish its lift so the two motions feel layered rather than
              racing. */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 -translate-x-full",
              "bg-gradient-to-r from-transparent via-white/12 to-transparent",
              "transition-[translate] duration-1000 ease-[cubic-bezier(0.33,1,0.68,1)] group-hover:translate-x-full",
              "group-hover:delay-200 motion-reduce:hidden",
            )}
          />
          {(book.progress ?? 0) > 0 && (
            <span className="absolute right-0 bottom-0 left-0 block h-1 bg-black/30">
              <span
                className="bg-accent block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${Math.round(Math.min(book.progress ?? 0, 1) * 100)}%` }}
              />
            </span>
          )}
        </span>
        <span className={cn("block min-w-0", variant === "list" && "flex-1")}>
          <p className="text-text-1 mt-2 truncate text-sm font-medium" title={book.title}>
            {displayTitle(book.title)}
          </p>
          {/* Author truncates; format and size never do — a long author name
              used to push the size out of the line entirely, and the format was
              only ever shown for a book with no author at all. The author now
              marquees on hover when the name is longer than the slot. */}
          <p className="text-text-3 mt-0.5 flex items-center gap-1.5 text-xs">
            {/* The author slot stays in the line even for a book with no author
                at all. It is `flex-1`, so it is the thing holding the
                format/size block against the tile's right edge: leaving it out
                put `PDF · 17.1 MB` at the *left* edge of a book with no author
                while its neighbour in the same row had `PDF · 11.0 MB` at the
                right one (measured on the 6-column shelf). An empty slot keeps
                every row's second line lined up with the tiles beside it — the
                same reason `reserveTags` keeps an empty label line. */}
            {authors ? (
              // `flex-1` claims the rest of the line; `min-w-0` lets the flex
              // actually shrink the slot — without it the inner span would
              // measure wider than its parent and the marquee would never
              // see overflow.
              <MarqueeText className="min-w-0 flex-1">{authors}</MarqueeText>
            ) : (
              <span className="min-w-0 flex-1" aria-hidden="true" />
            )}
            <span className="shrink-0 text-[11px] tracking-wide">
              {book.format.toUpperCase()}
              {book.fileSize > 0 && ` · ${formatFileSize(book.fileSize)}`}
            </span>
          </p>
          {/* Labels get one extra line that truncates rather than reflowing the
              grid. On a shelf where any book at all has labels, every tile keeps
              that line — an empty one still holds its height — because the window
              counts rows and cannot know that this tile is a line shorter than the
              ones beside it. A shelf with no labels keeps the two-line rhythm it
              had. */}
          {(book.tags.length > 0 || reserveTags) && (
            <p className="text-accent mt-1 truncate text-[11px]">
              {book.tags.length > 0 ? book.tags.map((tag) => `#${tag}`).join("  ") : "\u00a0"}
            </p>
          )}
        </span>
      </button>

      {selecting ? (
        <span
          className={cn(
            "absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full border transition-colors",
            selected ? "border-accent bg-accent text-on-accent" : "border-hairline glass-solid",
          )}
        >
          <motion.span
            initial={false}
            animate={{ scale: selected ? 1 : 0.4, opacity: selected ? 1 : 0 }}
            transition={SPRING.tap}
            className="flex"
          >
            <Check size={13} weight="bold" />
          </motion.span>
        </span>
      ) : (
        <div
          className={cn(
            // grid-cols-5 across the cover's own width: the cells shrink with
            // the cover, so five actions fit a tile at any breakpoint instead
            // of riding out past the cover's edge (what a fixed-width pill
            // did on the 6-column shelf).
            //
            // The grid tiles slide the row in under the lift; a list row is too
            // shallow for that — its own centering uses `translate-y`, which
            // would fight the slide — so it fades in place instead.
            variant === "grid"
              ? "absolute inset-x-1.5 top-1.5 grid grid-cols-5 place-items-center gap-0.5"
              : "absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1",
            variant === "grid" ? "translate-y-2 group-hover:translate-y-0" : "",
            // The row follows the lift rather than racing it: it waits well
            // past the cover (180 ms vs the cover's 60 ms) and travels the
            // `ease-land` curve so the chips settle in last, like they were
            // laid down on top of the lifted book. Longer than the 300 ms
            // cubic-bezier it replaced — the old curve had done 95% of the
            // travel in 100 ms, which read as the buttons snapping into place.
            "opacity-0 transition-all duration-[450ms] ease-[cubic-bezier(0.33,1,0.68,1)]",
            // Hidden state also drops pointer events — an invisible button that
            // still clicks is a mis-tap waiting to happen.
            "pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-hover:delay-[180ms]",
            "focus-within:pointer-events-auto focus-within:opacity-100",
            "motion-reduce:transition-none",
          )}
        >
          {/* The chips are inked against the cover (black glass, white icons)
              rather than against the theme: a shelf tile is always read
              against its cover art, never against the page behind it, so the
              same chip must hold on a white cover in day mode and a black one
              at night. Filled icons carry the "on" state — an accent colour
              would flip contrast between the themes. */}
          <GlassIconButton
            label={book.favorite ? "取消收藏" : "收藏"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(book);
            }}
            className={coverAction}
          >
            <Star size={13} weight={book.favorite ? "fill" : "regular"} />
          </GlassIconButton>
          <GlassIconButton
            label="标签"
            onClick={(event) => {
              event.stopPropagation();
              onEditTags(book);
            }}
            className={coverAction}
          >
            <Tag size={13} weight={book.tags.length > 0 ? "fill" : "regular"} />
          </GlassIconButton>
          <GlassIconButton
            label="编辑信息"
            onClick={(event) => {
              event.stopPropagation();
              onEditMeta(book);
            }}
            className={coverAction}
          >
            <PencilSimple size={13} />
          </GlassIconButton>
          {/* One slot, two exports. The `grid` bar is a five-column grid, so a
              sixth button would either wrap or shrink every chip; and the two
              are the same gesture anyway — "let me have this book" — answered
              by whichever build can answer it. The desktop's dialog then asks
              *which* file (the book itself, or a pack that also carries the
              progress and the highlights), so its label stays open. */}
          {isDesktopRuntime ? (
            <GlassIconButton
              label="导出"
              onClick={(event) => {
                event.stopPropagation();
                onAskExport(book);
              }}
              className={coverAction}
            >
              <Export size={13} />
            </GlassIconButton>
          ) : (
            <GlassIconButton
              label="导出文件"
              onClick={(event) => {
                event.stopPropagation();
                onExportFile(book);
              }}
              className={coverAction}
            >
              <DownloadSimple size={13} />
            </GlassIconButton>
          )}
          <GlassIconButton
            label="删除"
            onClick={(event) => {
              event.stopPropagation();
              onAskDelete(book);
            }}
            className={cn(coverAction, "hover:bg-danger/70")}
          >
            <Trash size={13} />
          </GlassIconButton>
        </div>
      )}
    </motion.div>
  );
}

interface DeleteDialogProps {
  book: BookSummary | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (book: BookSummary) => void;
}

/** Confirmation for taking a book off the shelf.
 *
 *  Says 「移到回收站」 and means it: the file, the highlights and the position all
 *  survive, so the dialog no longer has to threaten the reader to be honest.
 *  The irreversible copy lives on the bin's own confirm, where it is true.
 */
export function DeleteBookDialog({ book, busy, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <GlassDialog
      open={book !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="删除这本书？"
      description={`《${book?.title ?? ""}》会移到回收站，笔记和阅读进度都还在，可以随时恢复。`}
      widthClass="w-[min(92vw,420px)]"
    >
      <div className="flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="ghost"
          className="text-danger"
          onClick={() => book && onConfirm(book)}
          disabled={busy || !book}
        >
          删除
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
