import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Check } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { CoverThumb } from "@/features/library/CoverThumb";
import { useMetadataApply, useMetadataPropose } from "@/hooks/useMetadata";
import { CHUNK, useFillRun } from "@/stores/fillRun";
import { cn } from "@/lib/cn";
import { FIELD_LABELS, existingHint, hasSomething, sourceLabel, toFill } from "@/lib/metadata";
import { EASE_OUT, useMotion } from "@/lib/motion";
import type { Fill, Proposal } from "@/types/ipc";

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
/**
 * The preview cap, and the batch size the whole-shelf run uses.
 *
 * These are other people's servers, not a commercial API. Forty rows is a list
 * you can read; forty books is also one transaction, which is what
 * [`useFillRun`] feeds the backend at a time. One number so the two cannot
 * drift apart.
 */
const MAX_BATCH = CHUNK;

export function BatchFillDialog({
  open,
  ids,
  onClose,
}: {
  open: boolean;
  ids: string[];
  onClose: () => void;
}) {
  const run = useFillRun();
  // A run outlives this dialog — the reader can close it and watch the shelf —
  // so an open dialog shows the run it would otherwise be starting a second of.
  const showingRun = run.running || run.total > 0;
  const whole = ids.length > MAX_BATCH;

  const close = () => {
    // A finished run is dismissed here; a running one keeps going.
    if (!run.running) run.reset();
    onClose();
  };

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={
        showingRun
          ? "整架补全"
          : whole
            ? `整架补全 ${ids.length} 本`
            : `从目录补全 ${Math.min(ids.length, MAX_BATCH)} 本`
      }
      description={
        showingRun
          ? undefined
          : whole
            ? "只填空着的字段，不会覆盖你已经写过的内容。按批自动跑，中途可以停。"
            : "只填空着的字段，不会覆盖你已经写过的内容。"
      }
      widthClass="w-[min(92vw,560px)]"
    >
      {showingRun ? (
        <RunBody onClose={close} />
      ) : whole ? (
        <WholeBody ids={ids} onClose={close} />
      ) : (
        /* Keyed by the selection: opening a different batch must not show the
           previous one's proposals for a frame. */
        <FillBody key={ids.join(",")} ids={ids} onClose={close} />
      )}
    </GlassDialog>
  );
}

/** The start of a run over more books than a preview can hold. */
function WholeBody({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const run = useFillRun();
  const batches = Math.ceil(ids.length / MAX_BATCH);
  // Measured at roughly a third of a second a book, four at a time. Rounded up
  // and never below a minute, because 「1 分钟」 for a five-minute job is worse
  // than no estimate at all.
  const minutes = Math.max(1, Math.ceil((ids.length * 0.35) / 60));

  return (
    <div className="space-y-4">
      <p className="text-text-2 text-[13px] leading-relaxed">
        这次选了 {ids.length} 本，分 {batches} 批自动跑，大约 {minutes}{" "}
        分钟。跑的时候可以随时停，已经写进去的会留着。
      </p>
      <p className="text-text-3 text-xs leading-relaxed">
        整架跑没有预览——几百行的清单没人看，而且每本都要先查一遍才有预览，等于查两遍。想先看看效果，选{" "}
        {MAX_BATCH} 本以内。
      </p>
      <div className="flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onClose}>
          取消
        </GlassButton>
        <GlassButton variant="primary" onClick={() => run.start(ids)}>
          开始补全 {ids.length} 本
        </GlassButton>
      </div>
    </div>
  );
}

/** Progress, and the summary it leaves behind. */
function RunBody({ onClose }: { onClose: () => void }) {
  const run = useFillRun();
  const queryClient = useQueryClient();
  const finished = !run.running;

  // One refresh at the end rather than one per batch: the shelf is not what the
  // reader is looking at, and twenty-four refetches of 985 rows to update a
  // grid nobody is watching is work for its own sake.
  useEffect(() => {
    if (finished && run.total > 0) {
      void queryClient.invalidateQueries({ queryKey: ["books"] });
    }
  }, [finished, run.total, queryClient]);

  const percent = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-text-1">
            {finished ? (run.stopped ? "已停止" : "补完了") : "正在查目录并写入…"}
          </span>
          <span className="text-text-3 tabular-nums">
            {run.done} / {run.total}
          </span>
        </div>
        {/* Decorative: the count above it is the accessible version, and a
            div with a `progressbar` role is exactly what `prefer-tag-over-role`
            exists to replace. */}
        <div aria-hidden className="bg-surface-2 mt-2 h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <p className="text-text-2 text-[13px]">
        已补 {run.written} 本 · 跳过 {run.skipped} 本{run.failed > 0 && ` · 失败 ${run.failed} 本`}
      </p>
      {run.stopped && <p className="text-text-3 text-xs leading-relaxed">{run.stopped}</p>}
      {finished && !run.stopped && run.written > 0 && (
        <p className="text-text-3 text-xs leading-relaxed">书架上已经能看到改过的信息。</p>
      )}

      <div className="flex justify-end gap-2">
        {run.running ? (
          <GlassButton variant="subtle" onClick={run.cancel}>
            停止
          </GlassButton>
        ) : (
          <GlassButton variant="primary" onClick={onClose}>
            关闭
          </GlassButton>
        )}
      </div>
    </div>
  );
}

function FillBody({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const propose = useMetadataPropose(ids, true);
  const apply = useMetadataApply();
  /** Ticked book ids. `null` until the first answer, then "everything with a
   *  fill" — the reader can untick, and an unticked row stays unticked. */
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());

  const proposals = propose.data ?? [];
  // A row can carry nothing but a rating and a Douban link — a book whose
  // fields are all filled still gains something from the lookup.
  const fillable = proposals.filter(hasSomething);
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
      <p className="text-text-2 py-6 text-center text-[13px]">正在查目录…（{ids.length} 本）</p>
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
  // `hasSomething`, not `fills.length`: a book whose six fields are all there
  // still gains a rating and a Douban link, and judging by `fills` alone made
  // those rows render greyed out, untickable and — because the backend only
  // sets `skipped` when there is genuinely nothing — with no reason line at
  // all. That is the 「为什么这几行是灰的」 in the report.
  const nothing = !hasSomething(proposal);
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
              {typeof proposal.rating === "number" && (
                // Named, always: a bare number here would be read as Douban's.
                <span className="text-text-3">
                  {sourceLabel(proposal.ratingSource)} {proposal.rating.toFixed(1)}
                  {proposal.ratingCount !== null && `（${proposal.ratingCount} 人）`}
                </span>
              )}
              {proposal.fills.map((fill) => (
                <span key={fill.field}>
                  {FIELD_LABELS[fill.field] ?? fill.field} → {preview(fill)}
                </span>
              ))}
              {/* A cover is written too, and it has no value to show — without
                  this line a book whose only gain is a picture rendered as an
                  empty row that looked like nothing would happen. */}
              {proposal.coverUrl && <span>封面</span>}
              {/* What this book already has, so 「只补两项」 reads as 「另外四项
                  本来就有」 rather than as a catalogue with thin data. */}
              {existingHint(proposal.existing) && (
                <span className="text-text-3">{existingHint(proposal.existing)}</span>
              )}
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
              {/* The rating is written too, so it belongs in the list of things
                  that will happen. Without it, a book whose only gain is a
                  rating expanded into an empty panel. */}
              {typeof proposal.rating === "number" && (
                <div className="flex gap-3">
                  <dt className="text-text-3 w-12 shrink-0 text-[11px] leading-5">评分</dt>
                  <dd className="text-text-1 min-w-0 flex-1 text-[12px] leading-5">
                    {sourceLabel(proposal.ratingSource)} {proposal.rating.toFixed(1)}
                    {typeof proposal.ratingCount === "number" && `（${proposal.ratingCount} 人）`}
                  </dd>
                </div>
              )}
              {proposal.coverUrl && (
                <div className="flex gap-3">
                  <dt className="text-text-3 w-12 shrink-0 text-[11px] leading-5">封面</dt>
                  {/* The picture itself, not its address: a URL is not
                      evidence that the cover is the right edition, and this
                      panel exists to be read. Fetched when the row opens, not
                      for all forty. */}
                  <dd className="min-w-0 flex-1">
                    <CoverThumb url={proposal.coverUrl} className="h-20 w-[60px]" />
                  </dd>
                </div>
              )}
              {proposal.doubanUrl && (
                <div className="flex gap-3">
                  <dt className="text-text-3 w-12 shrink-0 text-[11px] leading-5">豆瓣</dt>
                  <dd className="text-text-2 min-w-0 flex-1 truncate text-[12px] leading-5">
                    {proposal.doubanUrl}
                  </dd>
                </div>
              )}
              {proposal.fills.map((fill) =>
                fill.field === "description" ? (
                  <div key={fill.field}>
                    <dt className="text-text-3 text-[11px]">简介</dt>
                    {/* `surface-3`, not `surface-1`: this is a paragraph the
                        reader is meant to read, and surface-1 is 58% opaque —
                        saturated book covers showed straight through the
                        words. The opaque step is what a reading surface gets. */}
                    <dd className="text-text-1 bg-surface-3 border-hairline mt-1 max-h-28 overflow-y-auto rounded-md border p-2 text-[12px] leading-relaxed whitespace-pre-wrap">
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
