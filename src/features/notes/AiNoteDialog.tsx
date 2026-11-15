import { useState } from "react";
import { CircleNotch, NotePencil, Sparkle } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useApplyNoteDrafts, useSuggestNoteDrafts } from "@/hooks/useAiNotes";
import type { AiNoteRun } from "@/types/ipc";

/**
 * AI 补笔记：模型给建议，读者决定。
 *
 * 三条前提，和 AI 打标签那条链一样：不自动跑（一次建议一次计费）、
 * 不覆盖读者写过的笔记、不确认不写。后端在挑划线和落库前各查一次
 * `note IS NULL`，这里把「只补空的」说在前面。
 */
interface Row {
  annotationId: string;
  bookId: string;
  quote: string;
  note: string;
  /** 关掉的行不写入，但留在列表里 —— 它解释了为什么少了一条。 */
  on: boolean;
}

export function AiNoteDialog({
  open,
  ids,
  onClose,
}: {
  open: boolean;
  ids: string[];
  onClose: () => void;
}) {
  const suggest = useSuggestNoteDrafts();
  const apply = useApplyNoteDrafts();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [run, setRun] = useState<AiNoteRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<number | null>(null);

  const ask = () => {
    setError(null);
    setRows(null);
    setWritten(null);
    suggest.mutate(ids, {
      onSuccess: (data) => {
        setRun(data);
        setRows(data.suggestions.map((item) => ({ ...item, on: true })));
      },
      onError: (err) => setError(String(err)),
    });
  };

  const applyNow = () => {
    const picked = (rows ?? []).filter((row) => row.on && row.note.trim() !== "");
    apply.mutate(
      picked.map(({ annotationId, bookId, note }) => ({ annotationId, bookId, note })),
      {
        onSuccess: (count) => setWritten(count),
        onError: (err) => setError(String(err)),
      },
    );
  };

  const close = () => {
    setRows(null);
    setRun(null);
    setError(null);
    setWritten(null);
    onClose();
  };

  const toggle = (index: number) =>
    setRows((all) => {
      const next = [...(all ?? [])];
      const row = next[index];
      if (row) next[index] = { ...row, on: !row.on };
      return next;
    });

  const picked = (rows ?? []).filter((row) => row.on && row.note.trim() !== "");

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="AI 补笔记"
      description={
        written === null
          ? "只给还没写笔记的划线补一句草稿，不会覆盖你自己写过的话。"
          : "已写入。设置 › 操作记录 里可以撤销这一次。"
      }
      widthClass="w-[min(94vw,560px)]"
    >
      <div className="space-y-3">
        {written !== null && (
          <div className="glass rounded-xl border px-3 py-3">
            <p className="text-text-1 flex items-center gap-2 text-[13px] font-medium">
              <NotePencil size={14} className="text-accent" /> 已给 {written} 条补上笔记
            </p>
            <p className="text-text-3 mt-1 text-[12px] leading-relaxed">
              补的都是原本空着的笔记；撤销会把它们清空，你自己写的一条都不动。
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
              模型会读到选中划线的原文（每条最多 400 字），为还没写笔记的那些补一句草稿。 一次最多
              60 条，每批 20 条一次调用。已经写过笔记的会自动跳过。
            </p>
            {run && run.failedBatches > 0 && (
              <p className="text-text-3 text-[12px]">
                有 {run.failedBatches} 批模型没答上来，那几条没有建议。
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
                    <CircleNotch size={14} className="animate-spin" /> 正在看这 {ids.length} 条…
                  </>
                ) : (
                  <>
                    <Sparkle size={14} /> 开始建议
                  </>
                )}
              </GlassButton>
            </div>
          </div>
        )}

        {rows !== null && written === null && (
          <>
            {run && (run.remaining > 0 || run.failedBatches > 0) && (
              <p className="text-text-3 text-[12px] leading-relaxed">
                {run.remaining > 0 && `还有 ${run.remaining} 条没轮上，关掉再开一次可以继续。`}
                {run.failedBatches > 0 &&
                  `有 ${run.failedBatches} 批模型没答上来，那几条没有建议。`}
              </p>
            )}
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {rows.map((row, index) => (
                <li
                  key={row.annotationId}
                  className={`glass rounded-xl border px-3 py-2.5 ${row.on ? "" : "opacity-50"}`}
                >
                  <button
                    type="button"
                    className="press focus-visible:focus-ring text-text-2 w-full text-left text-[12.5px] leading-relaxed"
                    onClick={() => toggle(index)}
                  >
                    {row.quote}
                  </button>
                  <div className="mt-1.5 flex items-start justify-between gap-2">
                    <p className="text-text-1 text-[13px] leading-relaxed">{row.note}</p>
                    <span className="text-text-3 shrink-0 text-[11.5px]">
                      {row.on ? "写入" : "跳过"}
                    </span>
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
                {apply.isPending ? "写入中…" : `应用：${picked.length} 条`}
              </GlassButton>
            </div>
          </>
        )}

        {written !== null && (
          <div className="flex justify-end">
            <GlassButton size="md" onClick={close}>
              完成
            </GlassButton>
          </div>
        )}
      </div>
    </GlassDialog>
  );
}
