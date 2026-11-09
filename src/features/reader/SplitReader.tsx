import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, CaretLeft, CaretRight, X } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { GlassIconButton } from "@/components/glass/button";
import { ReaderHost } from "./ReaderHost";
import { CHROME_BTN } from "./ReaderChrome";
import { PairSlotsProvider, type PairIdentity } from "./pairLayout";

export interface SplitReaderProps {
  bookId: string;
  partnerId: string;
  /** The pane the book was opened from keeps the route's own arrival state
   *  (a deep-linked chapter, a search hit); the companion opens at its own
   *  saved position, which is what a reader resuming a translation wants. */
  initialChapter?: number | null;
  initialQuery?: string;
  initialSnippet?: string;
  initialOffset?: number | null;
  initialAnnotation?: string | null;
  /** Opens the companion-book picker (the pair bar's 更换对照书 button). */
  onOpenPair: () => void;
  /** Closes the pair, leaving the opened book reading alone. */
  onExitPair: () => void;
}

/**
 * 对照阅读: two books, one window, one set of bars.
 *
 * The window has a single bar above the books and a single bar below them.
 * The top bar is rendered here, symmetrically: one block per book with its
 * cover, title, chapter readout and its *own* page steppers, so neither book
 * has to be made active to be turned, and both are always named. The bottom
 * bar belongs to whichever book is active — that pane paints its controls
 * into the pair's slot through a portal (`pairLayout`), which moves DOM and
 * not state, so every control stays bound to the reader whose book it drives.
 *
 * Which pane is active follows the reader: clicking either half or either
 * block in the top bar hands it the keyboard, the voice and the bottom bar.
 * The window-level gates themselves stay inside each reader, keyed on
 * `active`, so two mounted readers never both answer one keypress.
 *
 * ponytail: 50/50 with a fixed divider — a draggable split is a ratio in
 * state plus pointer capture, worth adding when someone asks for an uneven
 * pair (a wide original beside a narrow translation). Vertical stacking and
 * three-or-more panes are the same story: the layout here would grow a
 * direction and the panes would grow a list.
 */
export function SplitReader({
  bookId,
  partnerId,
  initialChapter = null,
  initialQuery = "",
  initialSnippet = "",
  initialOffset = null,
  initialAnnotation = null,
  onOpenPair,
  onExitPair,
}: SplitReaderProps) {
  const [activeId, setActiveId] = useState(bookId);
  const [bottom, setBottom] = useState<HTMLElement | null>(null);
  // What each pane last said about itself — the top bar is built from these.
  const [identities, setIdentities] = useState<Record<string, PairIdentity>>({});
  const slots = useMemo(() => ({ bottom }), [bottom]);

  const publish = useCallback((id: string, identity: PairIdentity) => {
    setIdentities((prev) => {
      const was = prev[id];
      if (
        was !== undefined &&
        was.coverUrl === identity.coverUrl &&
        was.title === identity.title &&
        was.index === identity.index &&
        was.total === identity.total &&
        was.isPdf === identity.isPdf &&
        was.chapterLabel === identity.chapterLabel &&
        was.backLabel === identity.backLabel &&
        was.onBack === identity.onBack &&
        was.onStep === identity.onStep
      ) {
        return prev;
      }
      return { ...prev, [id]: identity };
    });
  }, []);

  const publishPrimary = useCallback(
    (identity: PairIdentity) => publish(bookId, identity),
    [publish, bookId],
  );
  const publishCompanion = useCallback(
    (identity: PairIdentity) => publish(partnerId, identity),
    [publish, partnerId],
  );
  const activateCompanion = useCallback(() => setActiveId(partnerId), [partnerId]);
  const activatePrimary = useCallback(() => setActiveId(bookId), [bookId]);

  return (
    <PairSlotsProvider value={slots}>
      <div className="flex h-full min-h-0 flex-col">
        {/* One bar, two books. Split down the middle so each block sits over
            the half it names, and the seam runs unbroken from here to the
            bottom of the window. */}
        <div
          data-pair-top
          className="border-hairline relative z-30 flex shrink-0 items-stretch border-b"
        >
          <PairBookBlock
            identity={identities[bookId] ?? null}
            active={activeId === bookId}
            onActivate={activatePrimary}
            withBack
          />
          <div aria-hidden className="bg-hairline w-px shrink-0" />
          <PairBookBlock
            identity={identities[partnerId] ?? null}
            active={activeId === partnerId}
            onActivate={activateCompanion}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-row">
          <PairPane bookId={bookId} active={activeId === bookId} onActivate={setActiveId}>
            <ReaderHost
              key={bookId}
              bookId={bookId}
              pair={{ active: activeId === bookId, onActivate: activatePrimary }}
              initialChapter={initialChapter}
              initialQuery={initialQuery}
              initialSnippet={initialSnippet}
              initialOffset={initialOffset}
              initialAnnotation={initialAnnotation}
              onOpenPair={onOpenPair}
              onIdentity={publishPrimary}
            />
          </PairPane>

          {/* One line, as it was before: the seam is the only thing between
              the books. The exit handle rides the middle of it and appears
              when the pointer comes near — it is not something to read past.
              `z-20`: the right pane paints after this element, and without a
              level of its own the seam's hover zone would be covered by that
              pane's paper — the handle would never appear. */}
          <div data-pair-divider className="group/seam relative z-20 w-px shrink-0">
            <div aria-hidden className="bg-hairline absolute inset-0" />
            <div className="absolute top-1/2 left-1/2 h-24 w-6 -translate-x-1/2 -translate-y-1/2">
              <GlassIconButton
                label="退出对照"
                size="sm"
                className="pointer-events-none absolute top-1/2 left-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/seam:pointer-events-auto group-hover/seam:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                onClick={onExitPair}
              >
                <X size={13} />
              </GlassIconButton>
            </div>
          </div>

          <PairPane bookId={partnerId} active={activeId === partnerId} onActivate={setActiveId}>
            <ReaderHost
              key={partnerId}
              bookId={partnerId}
              pair={{ active: activeId === partnerId, onActivate: activateCompanion }}
              onOpenPair={onOpenPair}
              onIdentity={publishCompanion}
            />
          </PairPane>
        </div>

        {/* The pair's one bottom bar: the active book's controls. */}
        <div ref={setBottom} data-pair-bottom className="relative z-30 shrink-0" />
      </div>
    </PairSlotsProvider>
  );
}

/**
 * One book's half of the top bar: cover, title, chapter — and its own
 * steppers, which turn *that* book without making it the active one.
 *
 * The identity area is a button so the whole block is a target for "read this
 * one", while the steppers stay separate buttons beside it: pressing ‹ must
 * not also move the keyboard, or the per-book steppers would be a mode switch
 * in disguise.
 */
function PairBookBlock({
  identity,
  active,
  onActivate,
  withBack = false,
}: {
  identity: PairIdentity | null;
  active: boolean;
  onActivate: () => void;
  /** The back button is window-level and lives in the left block only. */
  withBack?: boolean;
}) {
  if (identity === null) {
    return <div data-pair-block className="min-w-0 flex-1 px-3 py-2" />;
  }
  return (
    <div
      data-pair-block
      data-pair-active={active || undefined}
      className="flex min-w-0 flex-1 items-center gap-1 px-3 py-2"
    >
      {withBack && (
        <GlassIconButton
          label={identity.backLabel}
          size="sm"
          className={CHROME_BTN}
          onClick={identity.onBack}
        >
          <ArrowLeft size={16} />
        </GlassIconButton>
      )}
      <button
        type="button"
        onClick={onActivate}
        title={`切换到《${identity.title}》`}
        className="focus-visible:focus-ring hover:bg-surface-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors"
      >
        <span className="border-hairline block aspect-[3/4] h-9 shrink-0 overflow-hidden rounded-[3.5px] border">
          {identity.coverUrl ? (
            <img
              src={identity.coverUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
              <BookOpen size={13} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm",
              active ? "text-text-1 font-medium" : "text-text-2",
            )}
            data-reader-title
          >
            {identity.title}
          </span>
          <span className="text-text-3 block truncate text-xs" data-reader-chapter>
            第 {identity.index} / {identity.total} {identity.isPdf ? "页" : "章"}
            {!identity.isPdf && identity.chapterLabel && ` · ${identity.chapterLabel}`}
          </span>
        </span>
      </button>
      <GlassIconButton
        label="上一章"
        size="sm"
        className={CHROME_BTN}
        onClick={() => identity.onStep(-1)}
        disabled={identity.index <= 1}
      >
        <CaretLeft size={16} />
      </GlassIconButton>
      <GlassIconButton
        label="下一章"
        size="sm"
        className={CHROME_BTN}
        onClick={() => identity.onStep(1)}
        disabled={identity.index >= identity.total}
      >
        <CaretRight size={16} />
      </GlassIconButton>
    </div>
  );
}

/**
 * One half of the window. A plain wrapper except for the pointer handler:
 * activation has to happen on the way *down*, before the pane's own scroll
 * or text selection sees the event, so the pane the reader reached for is
 * the one that answers before they have finished clicking.
 *
 * Clicks inside a foliate book never reach this handler — the book lives in
 * an iframe inside a shadow root, and neither pointer events nor `focusin`
 * cross that boundary. That path is answered from the section document
 * itself (`FoliateBookView`'s per-section `pointerdown`), which is the only
 * place a click on a book's text is visible at all.
 */
function PairPane({
  bookId,
  active,
  onActivate,
  children,
}: {
  bookId: string;
  active: boolean;
  onActivate: (bookId: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      data-pair-pane
      data-pair-active={active || undefined}
      aria-label={active ? "当前阅读" : "对照书籍"}
      onPointerDown={() => onActivate(bookId)}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col")}
    >
      {/* Which half answers the keyboard, the voice and the chrome is
          invisible until a keypress lands in the wrong book. One accent line
          on the pane the reader last clicked says it without a mode switch —
          it moves when they click the other side.

          A `shadow-[inset_…]` on this section was the first try and does not
          work: the reader paints its own paper (`surface.background`) as an
          opaque child, and a parent's inset shadow sits below every child. */}
      {active && (
        <span
          aria-hidden
          className="bg-accent pointer-events-none absolute inset-x-0 top-0 z-10 h-px"
        />
      )}
      {children}
    </section>
  );
}
