import { useRef } from "react";
import { motion } from "motion/react";
import { BookOpen, CaretRight, Sun } from "@phosphor-icons/react";

import { useMotion } from "@/lib/motion";
import { displayTitle } from "@/lib/title";
import { boxOf, useBookHandoff } from "@/stores/book-handoff";
import type { BookSummary } from "@/types/ipc";

/**
 * The shelf's one always-on shortcut: the book you were last in, with the
 * cover you recognise it by.
 *
 * It used to be a sentence — "上次读到《…》的 18% 处" — with nothing to click.
 * Now it is the resume control: the reader already restores the saved fraction
 * when a book opens, so opening it is the whole feature.
 */
export function ContinueReadingCard({
  book,
  onOpen,
}: {
  book: BookSummary | undefined;
  onOpen: (book: BookSummary) => void;
}) {
  const m = useMotion();
  const beginHandoff = useBookHandoff((s) => s.begin);
  const coverRef = useRef<HTMLSpanElement>(null);

  if (!book) {
    return (
      <section className="glass mb-6 rounded-2xl p-5">
        <div className="text-text-2 flex items-center gap-2">
          <Sun size={16} weight="duotone" />
          <h2 className="text-text-1 text-sm font-medium">继续阅读</h2>
        </div>
        <p className="text-text-2 mt-2 text-[13px]">
          当你打开一本新书时，最近阅读的位置会出现在这里。
        </p>
      </section>
    );
  }

  const percent = Math.round(Math.min(book.progress ?? 0, 1) * 100);
  return (
    <motion.button
      type="button"
      onClick={() => {
        const cover = coverRef.current;
        if (cover) {
          beginHandoff({
            id: book.id,
            coverUrl: book.coverUrl ?? null,
            from: boxOf(cover),
            side: "shelf",
          });
        }
        onOpen(book);
      }}
      whileTap={m.reduce ? undefined : { scale: 0.995 }}
      transition={m.tap}
      className="glass focus-visible:focus-ring group relative mb-6 flex w-full items-center gap-4 rounded-2xl p-4 text-left transition-[box-shadow] duration-[260ms] ease-[var(--ease-land)] hover:shadow-[var(--shadow-card-lift)] motion-reduce:transition-none"
    >
      {/* The shelf's one-pass gloss, clipped to the card's own radius by a
          wrapper so the card can keep `overflow: visible` for the cover's
          lift shadow. It sits under the content (raised with `relative z-10`
          below), so no band of light ever washes the title. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
      >
        <span
          data-continue-sheen
          className="absolute inset-0 -translate-x-full bg-[linear-gradient(90deg,transparent,var(--card-sheen),transparent)] transition-[translate] duration-1000 ease-[cubic-bezier(0.33,1,0.68,1)] group-hover:translate-x-full group-hover:delay-200 motion-reduce:hidden"
        />
      </span>
      {/* Cornered to the tile's ratio (18px on a 138px cover), like the reader
          header's thumbnail: this cover is the other origin of a flight, so a
          rounder corner here is a cover that changes shape on the way in. */}
      <span
        ref={coverRef}
        className="relative z-10 block h-16 w-12 shrink-0 overflow-hidden rounded-[6px] transition-[translate,box-shadow] duration-350 ease-[cubic-bezier(0.33,1,0.68,1)] group-hover:-translate-y-1 group-hover:shadow-[var(--shadow-cover-lift)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
      >
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
            <BookOpen size={18} weight="duotone" />
          </span>
        )}
      </span>
      <span className="relative z-10 min-w-0 flex-1">
        <span className="text-text-3 flex items-center gap-1.5 text-[11.5px]">
          <Sun size={12} weight="duotone" /> 继续阅读
        </span>
        {/* The metadata's subtitle stays off the card and in the tooltip: an
            EPUB that carries 「认知觉醒: 开启自我改变的原动力 (当你…)」 was
            printing all of it here, at twice the length of the label above it. */}
        <span className="text-text-1 mt-0.5 block truncate text-sm font-medium" title={book.title}>
          {displayTitle(book.title)}
        </span>
        <span className="mt-2 flex items-center gap-2">
          <span className="bg-hairline h-1 flex-1 overflow-hidden rounded-full">
            <span
              className="bg-accent block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="text-text-3 shrink-0 text-[11.5px] tabular-nums">已读 {percent}%</span>
        </span>
      </span>
      <span
        data-continue-caret
        aria-hidden="true"
        className="text-text-3 group-hover:text-text-1 relative z-10 shrink-0 transition-[translate,color] duration-300 ease-[var(--ease-land)] group-hover:translate-x-1 motion-reduce:group-hover:translate-x-0"
      >
        <CaretRight size={14} />
      </span>
    </motion.button>
  );
}
