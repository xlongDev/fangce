import { useState } from "react";
import { CircleNotch, Sparkle, Tag, X } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useApplySuggestedTags, useSuggestTags } from "@/hooks/useTags";
import type { TagRun } from "@/types/ipc";

/**
 * AI 打标签：模型给建议，读者决定。
 *
 * 三件事写在这里，因为它们是这个功能能安全存在的前提：
 *
 * - **不自动跑。** 一次建议是一次计费的模型调用，打开一个对话框就花掉它是不对的
 *   —— 所以有一个「开始建议」按钮，和一句它会花什么的说明。
 * - **不写已打过标签的书。** 那是读者自己的判断，后端在挑书时就跳过了，这里说明。
 * - **不确认不写。** 每一行可以取消，每个标签可以点掉；按「应用」之前一个字节都
 *   没有进库。
 */

/** 每本书进提示词 + 模型回标签，实测约 200 tokens（60 本 ≈ 9k 进 / 3k 出）。
 *  一个上界而不是精确值：精确要先把「哪些书还没标签」查出来，为一行提示多一次
 *  往返不值；而实际只会更少（带标签的书在挑选时就被跳过了）。 */
const TOKENS_PER_BOOK = 200;
/** Backend's cap for one run (`tagging::RUN_LIMIT`). */
const RUN_LIMIT = 60;

interface Row {
  bookId: string;
  title: string;
  tags: string[];
  /** 这一行还要不要。关掉的行不写入，但留在列表里 —— 它解释了为什么少了一本。 */
  on: boolean;
}

/** `800 tokens` · `1.2k tokens` — past a thousand the zeros stop meaning anything. */
function tokenEstimate(books: number): string {
  const total = books * TOKENS_PER_BOOK;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tokens` : `${total} tokens`;
}

export function AiTagDialog({
  open,
  ids,
  onClose,
}: {
  open: boolean;
  ids: string[];
  onClose: () => void;
}) {
  const suggest = useSuggestTags();
  const apply = useApplySuggestedTags();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [run, setRun] = useState<TagRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The batch that was just written, or `null` before the first apply. */
  const [written, setWritten] = useState<number | null>(null);
  /** Everything written since this sheet opened — a run of 200 books is four
   *  batches, and the number the reader cares about is the total. */
  const [total, setTotal] = useState(0);
  /** Books left over from the last batch: no labels yet, past the 60 cap. */
  const [remaining, setRemaining] = useState(0);
  /** Whether the next batch is fetched on its own after an apply. On by
   *  default: a 300-book selection is a statement of intent, and the batches
   *  are an artefact of the request size, not of the reader's patience.
   *
   *  What it does **not** do is write: every batch still lands in the review
   *  list first. 停在这里 turns it off, so the reader who has seen enough can
   *  stop paying after the batch in hand. */
  const [auto, setAuto] = useState(true);

  /// 一批，不是一个选择批次：多出来的书留在这里，等读者按「继续」。
  const ask = () => {
    setError(null);
    setAuto(true);
    setRows(null);
    setRun(null);
    setWritten(null);
    suggest.mutate(ids, {
      onSuccess: (data) => {
        setRun(data);
        setRemaining(data.remaining);
        setRows(data.suggestions.map((item) => ({ ...item, on: true })));
      },
      onError: (err) => {
        // A failing batch must not retry itself: an endpoint that is down would
        // spend the reader's tokens in a loop.
        setAuto(false);
        setError(String(err));
      },
    });
  };

  const applyNow = () => {
    const picked = (rows ?? []).filter((row) => row.on && row.tags.length > 0);
    apply.mutate(
      picked.map((row) => ({ bookId: row.bookId, tags: row.tags })),
      {
        onSuccess: (count) => {
          setWritten(count);
          setTotal((done) => done + count);
          // Keep going only when something was actually written: a batch the
          // reader unticked entirely would otherwise loop forever on the same
          // books.
          if (auto && count > 0 && remaining > 0) {
            ask();
          } else {
            setAuto(false);
          }
        },
        onError: (err) => setError(String(err)),
      },
    );
  };

  const close = () => {
    // The next open starts from nothing: a suggestion belongs to the selection
    // it was made for.
    setRows(null);
    setRun(null);
    setError(null);
    setWritten(null);
    setTotal(0);
    setRemaining(0);
    setAuto(true);
    onClose();
  };

  const toggleRow = (index: number) =>
    setRows((all) => {
      const next = [...(all ?? [])];
      const row = next[index];
      if (row) next[index] = { ...row, on: !row.on };
      return next;
    });

  const dropTag = (index: number, tag: string) =>
    setRows((all) => {
      const next = [...(all ?? [])];
      const row = next[index];
      if (row) next[index] = { ...row, tags: row.tags.filter((name) => name !== tag) };
      return next;
    });

  const picked = (rows ?? []).filter((row) => row.on && row.tags.length > 0);
  const tagCount = picked.reduce((sum, row) => sum + row.tags.length, 0);

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="AI 打标签"
      description={
        written === null
          ? "只给还没有标签的书建议，建议不会自己写进库。"
          : "已写入。操作记录里能看到这一次改动。"
      }
      widthClass="w-[min(94vw,560px)]"
    >
      <div className="space-y-3">
        {written !== null && (
          <div className="glass rounded-xl border px-3 py-3">
            <p className="text-text-1 flex items-center gap-2 text-[13px] font-medium">
              <Tag size={14} className="text-accent" /> 已给 {written} 本加上标签
              {total > written && (
                <span className="text-text-3 text-[12px]">本轮累计 {total} 本</span>
              )}
            </p>
            <p className="text-text-3 mt-1 text-[12px] leading-relaxed">
              {remaining > 0
                ? `还有 ${remaining} 本没有标签、这一批没轮上。按「继续下一批」接着做 —— 每批仍要你看过再写入。`
                : "设置 › 操作记录 里可以按「AI」筛出这一次；标签改动不可撤销，需要时手工删。"}
            </p>
          </div>
        )}

        {error && (
          <div className="glass rounded-xl border px-3 py-2.5">
            <p className="text-text-2 text-[12.5px] break-all">{error}</p>
            <GlassButton size="sm" variant="subtle" className="mt-2" onClick={ask}>
              再试一次
            </GlassButton>
          </div>
        )}

        {rows === null && written === null && !error && (
          <div className="space-y-3 py-2">
            <p className="text-text-2 text-[12.5px] leading-relaxed">
              模型会读到选中书籍的书名、作者和简介（简介最多 200 字），然后给出每本 2–4 个标签。
              一次最多 60 本，每批 20 本一次调用。
            </p>
            {ids.length > RUN_LIMIT && (
              <p className="text-text-2 text-[12.5px] leading-relaxed">
                选中 {ids.length} 本，分 {Math.ceil(ids.length / RUN_LIMIT)} 批做完：
                每批应用后自动看下一批，但写得先经你确认。想停就按「停在这里」。
              </p>
            )}
            <p className="text-text-3 text-[11.5px] leading-relaxed">
              合计最多约 {tokenEstimate(ids.length)}
              （按每本约 {TOKENS_PER_BOOK} tokens 算）；已经有标签的书会自动跳过，实际只会更少。
            </p>
            {suggest.isPending && total > 0 && (
              <p className="text-text-2 flex items-center gap-2 text-[12.5px]">
                <CircleNotch size={13} className="text-accent animate-spin" />
                本轮已写入 {total} 本，正在看下一批…
              </p>
            )}
            <div className="flex items-center gap-2">
              <GlassButton
                variant="primary"
                size="md"
                disabled={suggest.isPending || ids.length === 0}
                onClick={ask}
              >
                {suggest.isPending ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" /> 正在看这 {ids.length} 本…
                  </>
                ) : (
                  <>
                    <Sparkle size={14} /> 开始建议
                  </>
                )}
              </GlassButton>
              {suggest.isPending && total > 0 && (
                <GlassButton size="md" variant="subtle" onClick={() => setAuto(false)}>
                  停在这里
                </GlassButton>
              )}
            </div>
          </div>
        )}

        {rows !== null && written === null && (
          <>
            {run && (run.remaining > 0 || run.failedBatches > 0) && (
              <p className="text-text-3 text-[12px] leading-relaxed">
                {run.remaining > 0 &&
                  (auto
                    ? `还有 ${run.remaining} 本没轮上，应用后自动看下一批。`
                    : `还有 ${run.remaining} 本没轮上，应用后点「继续下一批」接着做。`)}
                {run.failedBatches > 0 &&
                  `有 ${run.failedBatches} 批模型没答上来，那几本没有建议。`}
              </p>
            )}
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {rows.map((row, index) => (
                <li
                  key={row.bookId}
                  className={`glass rounded-xl border px-3 py-2.5 ${row.on ? "" : "opacity-50"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="press focus-visible:focus-ring text-text-1 min-w-0 flex-1 truncate text-left text-[13px] font-medium"
                      onClick={() => toggleRow(index)}
                    >
                      {row.title}
                    </button>
                    <span className="text-text-3 shrink-0 text-[11.5px]">
                      {row.on ? `${row.tags.length} 个` : "不写入"}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {row.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="glass-2 text-text-2 hover:text-text-1 focus-visible:focus-ring inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]"
                        onClick={() => dropTag(index, tag)}
                      >
                        {tag}
                        <X size={9} />
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-2">
              <GlassButton size="md" onClick={close} disabled={apply.isPending}>
                关闭
              </GlassButton>
              <GlassButton
                variant="primary"
                size="md"
                disabled={picked.length === 0 || apply.isPending}
                onClick={applyNow}
              >
                {apply.isPending ? "写入中…" : `应用：${picked.length} 本 · ${tagCount} 个标签`}
              </GlassButton>
            </div>
          </>
        )}

        {written !== null && (
          <div className="flex items-center justify-between gap-2">
            <GlassButton size="md" onClick={close} disabled={suggest.isPending}>
              完成
            </GlassButton>
            {remaining > 0 && !auto && (
              <GlassButton variant="primary" size="md" disabled={suggest.isPending} onClick={ask}>
                {suggest.isPending ? "正在看下一批…" : `继续下一批（还剩 ${remaining} 本）`}
              </GlassButton>
            )}
          </div>
        )}
      </div>
    </GlassDialog>
  );
}
