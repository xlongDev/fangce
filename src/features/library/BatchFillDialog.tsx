import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Check } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { CoverThumb } from "@/features/library/CoverThumb";
import { FillRunStatus } from "@/features/library/FillRunStatus";
import {
  useMetadataApply,
  useMetadataPropose,
  useMetadataSources,
  useTitleApply,
  useTitleProposals,
} from "@/hooks/useMetadata";
import { CHUNK, useFillRun } from "@/stores/fillRun";
import { cn } from "@/lib/cn";
import { isDesktopRuntime } from "@/lib/ipc";
import { FIELD_LABELS, existingHint, hasSomething, sourceLabel, toFill } from "@/lib/metadata";
import { EASE_OUT, useMotion } from "@/lib/motion";
import {
  acceptedTitles,
  TitleCandidates,
  type TitleChoices,
  type TitleTicks,
} from "@/features/library/TitleCandidates";
import type { Fill, Proposal, TitleProposal, TitleRename } from "@/types/ipc";

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
  /** 替换已有封面. Shared by the preview and the whole-shelf run: one
   *  decision, two paths, and turning it on must re-ask the catalogue. */
  const [replaceCovers, setReplaceCovers] = useState(false);
  /** 改书名 is opt-in, like replacing a cover: it is a decision, not a fill.
   *  Turning it on asks the catalogue a second question and shows the titles
   *  before anything is written. */
  const [renameTitles, setRenameTitles] = useState(false);
  /** Opening the sheet must not spend a batch of catalogue requests before the
   *  reader has chosen the options. The lookup starts only at 开始查询, and a
   *  change of options sends us back here rather than quietly re-querying. */
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const batchKey = ids.join(",");
  const confirmed = confirmedFor === batchKey;
  // A run outlives this dialog — the reader can close it and watch the shelf —
  // so an open dialog shows the run it would otherwise be starting a second of.
  const showingRun = run.running || run.total > 0;
  const whole = ids.length > MAX_BATCH;

  const close = () => {
    setConfirmedFor(null);
    // A finished run is dismissed here; a running one keeps going.
    if (!run.running) run.reset();
    onClose();
  };

  /** Switch a previewed batch to a background run. It re-asks the sources,
   *  but keeps the book selection and the exact titles ticked in the preview.
   *  Read the store fresh: the dialog closes and must not reset the new run. */
  const background = (books: string[], titles: TitleRename[]) => {
    const state = useFillRun.getState();
    state.start(books, replaceCovers, renameTitles, titles);
    state.setBackground(true);
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
            : `补全书籍信息 ${Math.min(ids.length, MAX_BATCH)} 本`
      }
      description={
        showingRun
          ? undefined
          : renameTitles
            ? "字段仅填空；书名只改写勾选的行。"
            : "仅填充空白字段，不覆盖已有内容。"
      }
      widthClass="w-[min(92vw,560px)]"
      // Two preview lists plus their rows can outgrow the window. Keep the
      // whole surface inside it and scroll the content rather than letting a
      // centred pane lose its title above and its buttons below the screen.
      contentClassName="max-h-[80vh] overflow-y-auto"
    >
      <div className="space-y-3">
        {/* Outside the two bodies so the switch stays visible while a new
            answer is being fetched — a control that vanishes exactly when it
            was just used reads as a broken click. */}
        {!showingRun && (
          <div className="space-y-2">
            <ReplaceCoversToggle
              checked={replaceCovers}
              onChange={setReplaceCovers}
              disabled={confirmed}
            />
            {isDesktopRuntime && (
              <RenameTitlesToggle
                checked={renameTitles}
                onChange={setRenameTitles}
                disabled={confirmed}
              />
            )}
            {confirmed && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmedFor(null)}
                  className="text-accent focus-visible:focus-ring rounded text-[11px] hover:underline"
                >
                  重新选择
                </button>
              </div>
            )}
          </div>
        )}
        {showingRun ? (
          <RunBody onClose={close} />
        ) : whole ? (
          <WholeBody
            ids={ids}
            onClose={close}
            replaceCovers={replaceCovers}
            renameTitles={renameTitles}
          />
        ) : !confirmed ? (
          <StartBody ids={ids} onClose={close} onConfirm={() => setConfirmedFor(batchKey)} />
        ) : (
          /* Keyed by the selection: opening a different batch must not show the
             previous one's proposals for a frame. */
          <FillBody
            key={batchKey}
            ids={ids}
            onClose={close}
            onBackground={background}
            replaceCovers={replaceCovers}
            renameTitles={renameTitles}
          />
        )}
      </div>
    </GlassDialog>
  );
}

/**
 * The switch that lets a batch replace a picture the book already has.
 *
 * Off by default: forty covers is a lot to lose to a bad match in one click.
 * A native checkbox in a label: the whole line is the hit target, and the
 * browser supplies the semantics and keyboard behaviour for free.
 */
function ReplaceCoversToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex w-full items-start gap-2 rounded text-left",
        disabled ? "cursor-default opacity-70" : "cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="border-hairline accent-accent focus-visible:focus-ring mt-0.5 h-4 w-4 shrink-0 rounded"
      />
      <span className="text-text-2 text-xs leading-relaxed">
        替换已有封面
        <span className="text-text-3 block">
          默认仅补全缺失封面。开启后，来源封面将覆盖书架封面；每次替换均可在操作记录中撤销。
        </span>
      </span>
    </label>
  );
}

/** The switch that lets a fill also rewrite titles from the catalogue.
 *
 * Off by default: a book always has a title, so replacing one is never a
 * "fill the blank" decision. On, each book gets its old title beside the
 * catalogue's answers, and only the rows the reader accepts are written.
 */
function RenameTitlesToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex w-full items-start gap-2 rounded text-left",
        disabled ? "cursor-default opacity-70" : "cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="border-hairline accent-accent focus-visible:focus-ring mt-0.5 h-4 w-4 shrink-0 rounded"
      />
      <span className="text-text-2 text-xs leading-relaxed">
        按来源改书名
        <span className="text-text-3 block">
          同时预览来源里的书名，只改写勾选的行；默认只取匹配度高的，每次改名均可在操作记录中撤销。
        </span>
      </span>
    </label>
  );
}

/**
 * The gate before a previewed fill. Opening the sheet is not a request to
 * query a catalogue: the reader may want to turn on a cover replacement or a
 * rename first, and those options change what gets asked. Nothing is fetched
 * until this button is pressed.
 */
function StartBody({
  ids,
  onClose,
  onConfirm,
}: {
  ids: string[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-text-2 text-[13px] leading-relaxed">
        将从豆瓣、NeoDB 及已配置的自定义来源查询。结果逐本列出，仅写入勾选项；下列选项可保持默认。
      </p>
      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="subtle" onClick={onClose}>
          取消
        </GlassButton>
        <GlassButton variant="primary" onClick={onConfirm}>
          开始查询 {ids.length} 本
        </GlassButton>
      </div>
    </div>
  );
}

/** The start of a run over more books than a preview can hold. */
function WholeBody({
  ids,
  onClose,
  replaceCovers,
  renameTitles,
}: {
  ids: string[];
  onClose: () => void;
  replaceCovers: boolean;
  renameTitles: boolean;
}) {
  const run = useFillRun();
  const batches = Math.ceil(ids.length / MAX_BATCH);
  // Measured at roughly a third of a second a book, four at a time. Rounded up
  // and never below a minute, because 「1 分钟」 for a five-minute job is worse
  // than no estimate at all.
  const minutes = Math.max(1, Math.ceil((ids.length * 0.35) / 60));

  return (
    <div className="space-y-4">
      <dl className="border-hairline divide-hairline divide-y rounded-md border px-3">
        <div className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-text-3 shrink-0 text-[12px]">处理范围</dt>
          <dd className="text-text-1 text-[13px] tabular-nums">{ids.length} 本</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-text-3 shrink-0 text-[12px]">批处理</dt>
          <dd className="text-text-1 text-[13px] tabular-nums">
            分 {batches} 批 · 预计 {minutes} 分钟
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-text-3 shrink-0 text-[12px]">中断</dt>
          <dd className="text-text-1 text-right text-[12px]">可随时停止，已写入内容保留</dd>
        </div>
      </dl>
      <p className="text-text-3 text-xs leading-relaxed">
        整架补全不提供逐本预览：生成预览需先查询全部书目，会重复请求书目来源。如需先确认结果，请单次选择不超过{" "}
        {MAX_BATCH} 本。开始后可以点「后台运行」关掉窗口，补全会继续跑，进度显示在右下角。
        {renameTitles && " 书名一并改写时，只取匹配度高的候选。"}
      </p>
      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="subtle" onClick={onClose}>
          取消
        </GlassButton>
        <GlassButton variant="primary" onClick={() => run.start(ids, replaceCovers, renameTitles)}>
          开始补全 {ids.length} 本
        </GlassButton>
      </div>
    </div>
  );
}

/** The run's status plus the controls that belong to this dialog. The same
 *  status is drawn by the shell's pill; completion refresh and the toast live
 *  there, because this dialog is routinely closed while the run is alive. */
function RunBody({ onClose }: { onClose: () => void }) {
  const run = useFillRun();

  return (
    <div className="space-y-4">
      <FillRunStatus />

      <div className="flex items-center justify-end gap-2">
        {run.running ? (
          <>
            <GlassButton
              variant="subtle"
              onClick={() => {
                // Only this button asks for a background pill. Closing the
                // dialog any other way leaves the progress in the dialog.
                run.setBackground(true);
                onClose();
              }}
            >
              后台运行
            </GlassButton>
            <GlassButton variant="subtle" disabled={run.cancelled} onClick={run.cancel}>
              {run.cancelled ? "停止中" : "停止"}
            </GlassButton>
          </>
        ) : (
          <>
            {run.pending.length > 0 && (
              <GlassButton variant="subtle" onClick={run.retryPending}>
                重试待补全 {run.pending.length} 本
              </GlassButton>
            )}
            <GlassButton variant="primary" onClick={onClose}>
              关闭
            </GlassButton>
          </>
        )}
      </div>
    </div>
  );
}

function FillBody({
  ids,
  onClose,
  onBackground,
  replaceCovers,
  renameTitles,
}: {
  ids: string[];
  onClose: () => void;
  onBackground: (books: string[], titles: TitleRename[]) => void;
  replaceCovers: boolean;
  renameTitles: boolean;
}) {
  const propose = useMetadataPropose(ids, true, replaceCovers);
  const titles = useTitleProposals(ids, renameTitles);
  const customSources = useMetadataSources();
  const customNames = Object.fromEntries(
    (customSources.data ?? []).map((entry) => [entry.id, entry.name]),
  );
  const apply = useMetadataApply();
  const titleApply = useTitleApply();
  /** Ticked book ids. `null` until the first answer, then "everything with a
   *  fill" — the reader can untick, and an unticked row stays unticked. */
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  /** Renames have their own ticks: a book can gain a publisher but keep its
   *  title, or the other way round. `TitleCandidates` supplies the defaults. */
  const [titleTicks, setTitleTicks] = useState<TitleTicks>({});
  const [titleChoices, setTitleChoices] = useState<TitleChoices>({});

  const proposals = propose.data ?? [];
  // A row can carry nothing but a rating and a Douban link — a book whose
  // fields are all filled still gains something from the lookup.
  const fillable = proposals.filter(hasSomething);
  const chosen = fillable.filter((proposal) => !unticked.has(proposal.bookId));
  const skipped = proposals.length - fillable.length;
  const titleRows = renameTitles ? (titles.data ?? []) : [];
  const renames = acceptedTitles(titleRows, titleTicks, titleChoices);
  const affected = new Set([...chosen.map((row) => row.bookId), ...renames.map((row) => row.id)]);
  const busy = apply.isPending || titleApply.isPending;

  const toggleTitle = (proposal: TitleProposal) =>
    setTitleTicks((current) => ({
      ...current,
      [proposal.bookId]: !(current[proposal.bookId] ?? proposal.confident),
    }));

  const chooseTitle = (bookId: string, index: number) => {
    setTitleChoices((current) => ({ ...current, [bookId]: index }));
    // Picking a specific title is itself the decision to use it.
    setTitleTicks((current) => ({ ...current, [bookId]: true }));
  };

  const toggle = (bookId: string) =>
    setUnticked((current) => {
      const next = new Set(current);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });

  if (propose.isPending || (renameTitles && titles.isPending)) {
    return (
      <div className="space-y-3">
        <p className="text-text-2 py-4 text-center text-[13px]">
          正在查询书目来源…（{ids.length} 本）
        </p>
        <div className="flex items-center justify-end gap-2">
          <GlassButton variant="subtle" onClick={onClose}>
            取消
          </GlassButton>
          <GlassButton variant="subtle" onClick={() => onBackground(ids, [])}>
            后台运行
          </GlassButton>
        </div>
      </div>
    );
  }

  const error = propose.error ?? (renameTitles ? titles.error : null);
  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-danger text-[13px] leading-relaxed">{error.message}</p>
        <div className="flex justify-end">
          <GlassButton variant="subtle" onClick={onClose}>
            关闭
          </GlassButton>
        </div>
      </div>
    );
  }

  const titleCandidates = titleRows.filter((row) => row.candidates.length > 0);
  const nothingToDo = fillable.length === 0 && (!renameTitles || titleCandidates.length === 0);
  /** Two transactions, not one: a fill's undo must not carry a rename's
   *  before-image, or undoing a publisher would also put the old title back. */
  const save = () => {
    void (async () => {
      try {
        if (chosen.length > 0) await apply.mutateAsync(chosen.map(toFill));
        if (renames.length > 0) await titleApply.mutateAsync(renames);
        onClose();
      } catch {
        // The mutation cache reports the failure. Keep the preview so the
        // reader can retry, or untick the book the catalogue refused.
      }
    })();
  };

  return (
    <div className="space-y-3">
      {nothingToDo ? (
        <p className="text-text-2 py-4 text-[13px] leading-relaxed">
          {renameTitles
            ? `这 ${ids.length} 本都没有可补的字段或可替换的书名。可能是来源里没有，也可能是信息本来就是全的。`
            : `这 ${ids.length} 本都没有可补的字段。可能是来源里没有，也可能是出版社和语言本来就有。`}
        </p>
      ) : (
        <div className="space-y-3">
          {fillable.length > 0 && (
            // The sheet is centred on the window and has no height cap of its
            // own (`GlassDialog` centres, it does not constrain). Twelve rows
            // of six fills ran off both edges of a 700px window — the title
            // above the top edge and the buttons below the bottom. Each list
            // scrolls itself, and the buttons stay outside so they are always
            // reachable; with renames on, both lists share the height.
            <ul
              className={cn(
                "divide-hairline divide-y overflow-y-auto",
                renameTitles ? "max-h-[20vh]" : "max-h-[50vh]",
              )}
            >
              {proposals.map((proposal) => (
                <Row
                  key={proposal.bookId}
                  proposal={proposal}
                  ticked={!unticked.has(proposal.bookId)}
                  onToggle={() => toggle(proposal.bookId)}
                  customNames={customNames}
                />
              ))}
            </ul>
          )}

          {renameTitles && titleCandidates.length > 0 && (
            <div className="border-hairline border-t pt-3">
              <p className="text-text-3 mb-1 text-[11px]">书名（只改写勾选的行）</p>
              <TitleCandidates
                rows={titleRows}
                ticks={titleTicks}
                choices={titleChoices}
                onToggle={toggleTitle}
                onChoose={chooseTitle}
                maxHeightClass="max-h-[20vh]"
              />
            </div>
          )}
        </div>
      )}

      {skipped > 0 && fillable.length > 0 && (
        <p className="text-text-3 text-xs leading-relaxed">
          另有 {skipped} 本没有可补的字段，原因写在各自那一行。
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <GlassButton variant="subtle" onClick={onClose} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="subtle"
          disabled={affected.size === 0 || busy}
          onClick={() => onBackground([...affected], renames)}
        >
          后台运行
        </GlassButton>
        <GlassButton variant="primary" disabled={affected.size === 0 || busy} onClick={save}>
          {renames.length > 0 ? `补全并改名 ${affected.size} 本` : `补全 ${chosen.length} 本`}
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
  customNames,
}: {
  proposal: Proposal;
  ticked: boolean;
  onToggle: () => void;
  customNames: Record<string, string>;
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
                  {sourceLabel(proposal.ratingSource, customNames)} {proposal.rating.toFixed(1)}
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
              {proposal.coverUrl && (
                <span className={proposal.coverReplaces ? "text-accent" : undefined}>
                  {proposal.coverReplaces ? "封面 → 替换" : "封面"}
                </span>
              )}
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
                    {sourceLabel(proposal.ratingSource, customNames)} {proposal.rating.toFixed(1)}
                    {typeof proposal.ratingCount === "number" && `（${proposal.ratingCount} 人）`}
                  </dd>
                </div>
              )}
              {proposal.coverUrl && (
                <div className="flex gap-3">
                  <dt className="text-text-3 w-12 shrink-0 text-[11px] leading-5">
                    {proposal.coverReplaces ? "封面（替换）" : "封面"}
                  </dt>
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
