import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Check } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useMetadataApply, useMetadataPropose } from "@/hooks/useMetadata";
import { cn } from "@/lib/cn";
import { EASE_OUT, useMotion } from "@/lib/motion";
import type { Fill, MetadataFill, Proposal } from "@/types/ipc";

/**
 * 批量补全：what the catalogue would add to a selection, before anything is
 * written.
 *
 * Two rules make this safe to run on thirty books at once, and both are
 * visible in the dialog rather than buried:
 *
 * - **Only empty fields.** The backend refuses to touch a field the book
 *   already has, so a fill can never overwrite something the reader typed. The
 *   dialog says so in one line, because "why did it not fill this one" is the
 *   question the list would otherwise leave open.
 * - **Everything is previewed.** Rows are ticked by default and each can be
 *   unticked, and nothing is written until 补全 is pressed.
 *
 * The skipped rows stay on screen. A list that silently drops the twelve books
 * it could not help reads as a bug, and the reason — 没找到 / 匹配度太低 /
 * 字段都有 — is the only thing that tells the reader whether to try again.
 */
const FIELD_LABELS: Record<string, string> = {
  subtitle: "副标题",
  publisher: "出版社",
  language: "语言",
  isbn: "ISBN",
  publishedYear: "出版年",
  description: "简介",
};

/**
 * One run asks about this many books.
 *
 * NeoDB is a community instance rather than a commercial API, and a reader who
 * hits 全选 on a 985-book shelf would otherwise send 985 requests in one go.
 * Forty is a batch you can read the result of; the rest is another run.
 */
const MAX_BATCH = 40;

export function BatchFillDialog({
  open,
  ids,
  onClose,
}: {
  open: boolean;
  ids: string[];
  onClose: () => void;
}) {
  const count = Math.min(ids.length, MAX_BATCH);
  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`从 NeoDB 补全 ${count} 本`}
      description={
        ids.length > MAX_BATCH
          ? `只填空着的字段，不会覆盖你已经写过的内容。一次最多查 ${MAX_BATCH} 本，这次先查前 ${count} 本。`
          : "只填空着的字段，不会覆盖你已经写过的内容。"
      }
      widthClass="w-[min(92vw,560px)]"
    >
      {/* Keyed by the selection: opening a different batch must not show the
          previous one's proposals for a frame. */}
      <FillBody
        key={ids.slice(0, MAX_BATCH).join(",")}
        ids={ids.slice(0, MAX_BATCH)}
        onClose={onClose}
      />
    </GlassDialog>
  );
}

function FillBody({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const propose = useMetadataPropose(ids, true);
  const apply = useMetadataApply();
  /** Ticked book ids. `null` until the first answer, then "everything with a
   *  fill" — the reader can untick, and an unticked row stays unticked. */
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());

  const proposals = propose.data ?? [];
  const fillable = proposals.filter((proposal) => proposal.fills.length > 0);
  const chosen = fillable.filter((proposal) => !unticked.has(proposal.bookId));
  const skipped = proposals.length - fillable.length;

  const toggle = (bookId: string) =>
    setUnticked((current) => {
      const next = new Set(current);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });

  if (propose.isPending) {
    return (
      <p className="text-text-2 py-6 text-center text-[13px]">
        正在问 NeoDB…（{ids.length} 本，几秒钟）
      </p>
    );
  }

  if (propose.isError) {
    return (
      <div className="space-y-3">
        <p className="text-danger text-[13px] leading-relaxed">{propose.error.message}</p>
        <div className="flex justify-end">
          <GlassButton variant="subtle" onClick={onClose}>
            关闭
          </GlassButton>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {fillable.length === 0 ? (
        <p className="text-text-2 py-4 text-[13px] leading-relaxed">
          这 {ids.length} 本都没有可补的字段。可能是目录里没有，也可能是出版社和语言本来就有。
        </p>
      ) : (
        // The sheet is centred on the window and has no height cap of its own
        // (`GlassDialog` centres, it does not constrain). Twelve rows of six
        // fills ran off both edges of a 700px window — the title above the top
        // edge and the buttons below the bottom. The list scrolls itself, and
        // the buttons stay outside it so they are always reachable.
        <ul className="divide-hairline max-h-[50vh] divide-y overflow-y-auto">
          {proposals.map((proposal) => (
            <Row
              key={proposal.bookId}
              proposal={proposal}
              ticked={!unticked.has(proposal.bookId)}
              onToggle={() => toggle(proposal.bookId)}
            />
          ))}
        </ul>
      )}

      {skipped > 0 && fillable.length > 0 && (
        <p className="text-text-3 text-xs leading-relaxed">
          另有 {skipped} 本没有可补的字段，原因写在各自那一行。
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <GlassButton variant="subtle" onClick={onClose} disabled={apply.isPending}>
          取消
        </GlassButton>
        <GlassButton
          variant="primary"
          disabled={chosen.length === 0 || apply.isPending}
          onClick={() =>
            apply.mutate(chosen.map(toFill), {
              onSuccess: onClose,
            })
          }
        >
          补全 {chosen.length} 本
        </GlassButton>
      </div>
    </div>
  );
}

/** One proposal as a tickable row: what it would write, or why it would not. */
function Row({
  proposal,
  ticked,
  onToggle,
}: {
  proposal: Proposal;
  ticked: boolean;
  onToggle: () => void;
}) {
  const nothing = proposal.fills.length === 0;
  /** Per-row, not per-sheet: opening one book's 简介 must not open the other
   *  twenty-four. */
  const [open, setOpen] = useState(false);
  const m = useMotion();
  // Short and ease-out rather than a spring: a spring on `height: auto`
  // overshoots and makes the row bounce past its own content. Nothing here is
  // moving through space — it is one block becoming visible.
  const transition = m.reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT };

  return (
    <li
      className={cn(
        "rounded-lg transition-colors duration-150",
        // An open row owns its whole block, header and detail together — a
        // tinted header floating above a white panel read as two unrelated
        // things.
        open && !nothing ? "bg-surface-2/50" : "",
      )}
    >
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg px-1.5 py-1.5 transition-colors duration-150",
          // The hover only while closed: on an open row it paints a bar across
          // a block that is already highlighted, which reads as a selection
          // the reader did not make.
          !nothing && !open && "hover:bg-surface-2/60",
        )}
      >
        {/* Two targets, not one: the box picks the book, the rest of the row
            opens it. A single button that did both would make "let me read the
            blurb first" tick a book the reader was still deciding about. */}
        <button
          type="button"
          disabled={nothing}
          onClick={onToggle}
          aria-pressed={!nothing && ticked}
          aria-label={
            nothing
              ? undefined
              : ticked
                ? `取消选择《${proposal.bookTitle}》`
                : `选择《${proposal.bookTitle}》`
          }
          className={cn(
            "press focus-visible:focus-ring mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
            nothing
              ? "border-hairline cursor-default"
              : ticked
                ? "border-accent bg-accent text-on-accent"
                : "border-hairline hover:border-accent",
          )}
        >
          {/* An icon rather than a ✓ character: at 10px the glyph rendered as
              a tofu box in the bundled UI font. */}
          {!nothing && ticked && <Check size={10} weight="bold" />}
        </button>

        <button
          type="button"
          disabled={nothing}
          onClick={() => setOpen((current) => !current)}
          aria-expanded={nothing ? undefined : open}
          className={cn(
            "focus-visible:focus-ring min-w-0 flex-1 rounded text-left",
            nothing ? "cursor-default" : "press",
          )}
        >
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                nothing ? "text-text-3" : "text-text-1",
              )}
            >
              {proposal.bookTitle}
            </span>
            {!nothing && (
              <span className="text-text-3 shrink-0 text-[11px] tabular-nums">
                {Math.round((proposal.matchScore ?? 0) * 100)}%
              </span>
            )}
          </span>
          {nothing ? (
            <span className="text-text-3 mt-0.5 block text-[11px]">{proposal.skipped}</span>
          ) : (
            <span className="text-text-2 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
              {proposal.fills.map((fill) => (
                <span key={fill.field}>
                  {FIELD_LABELS[fill.field] ?? fill.field} → {preview(fill)}
                </span>
              ))}
            </span>
          )}
        </button>

        {!nothing && (
          <CaretDown
            size={11}
            aria-hidden
            className={cn(
              "text-text-3 mt-1.5 shrink-0 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && !nothing && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            // The clip is what makes the height animation read as an opening
            // rather than as content sliding under the next row.
            className="overflow-hidden"
          >
            <dl className="mx-1.5 mb-2 ml-8 space-y-1.5">
              {proposal.fills.map((fill) =>
                fill.field === "description" ? (
                  <div key={fill.field}>
                    <dt className="text-text-3 text-[11px]">简介</dt>
                    <dd className="text-text-1 bg-surface-1 border-hairline mt-1 max-h-28 overflow-y-auto rounded-md border p-2 text-[12px] leading-relaxed whitespace-pre-wrap">
                      {fill.to}
                    </dd>
                  </div>
                ) : (
                  <div key={fill.field} className="flex gap-3">
                    <dt className="text-text-3 w-12 shrink-0 text-[11px] leading-5">
                      {FIELD_LABELS[fill.field] ?? fill.field}
                    </dt>
                    <dd className="text-text-1 min-w-0 flex-1 text-[12px] leading-5 break-all">
                      {fill.to}
                    </dd>
                  </div>
                ),
              )}
            </dl>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/** One fill, as a line that fits.
 *
 * 简介 arrives as up to 4000 characters — printed whole, one row became a page
 * of marketing copy and pushed the dialog off both edges of the window. The
 * list says what will happen; the text itself is written on 补全, and the
 * reader can open the book afterwards to read it.
 */
export function preview(fill: Fill): string {
  if (fill.field === "description") return `将填入（${fill.to.length} 字）`;
  return fill.to.length > 32 ? `${fill.to.slice(0, 32)}…` : fill.to;
}

/** A proposal as the write it asks for: only the fields it named. */
function toFill(proposal: Proposal): MetadataFill {
  const fill: MetadataFill = {
    id: proposal.bookId,
    subtitle: null,
    publisher: null,
    language: null,
    isbn: null,
    publishedYear: null,
    description: null,
  };
  for (const item of proposal.fills) {
    if (item.field === "subtitle") fill.subtitle = item.to;
    if (item.field === "publisher") fill.publisher = item.to;
    if (item.field === "language") fill.language = item.to;
    if (item.field === "isbn") fill.isbn = item.to;
    if (item.field === "description") fill.description = item.to;
    if (item.field === "publishedYear") {
      const year = Number.parseInt(item.to, 10);
      if (Number.isFinite(year)) fill.publishedYear = year;
    }
  }
  return fill;
}
