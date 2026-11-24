import { useEffect, useRef, useState } from "react";
import { CircleNotch, PencilSimple, Sparkle, Tag, X } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput, GlassSwitch } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { useApplySuggestedTags, useSuggestTags } from "@/hooks/useTags";
import { useTagRun, type TagReview } from "@/stores/tagRun";
import type { TagAdd, TagRun as TagRunData } from "@/types/ipc";

/**
 * AI 打标签：模型给建议，读者决定。
 *
 * 三种节奏，共用同一条写入命令（tagSuggestApply → tags::assign + ops::record），
 * 没有第二个写入口：
 *
 * - **逐批预览**（默认）：一批一确认。
 * - **全部生成后统一审阅**（开关）：把选中书切成不重叠的块，一次跑完攒着，
 *   全部出齐再逐条改/删，确认后一次写入。循环住在 `tagRun` store，所以关窗
 *   照跑（右下角胶囊接管进度），中途停止也保留已收集的建议供审阅。
 * - **后台运行**：同一套循环在对话框外继续，逐批写库或统一审阅取决于开关。
 */
/** 每本书进提示词 + 模型回标签，实测约 200 tokens（60 本 ≈ 9k 进 / 3k 出）。
 *  一个上界而不是精确值：精确要先把「哪些书还没标签」查出来，为一行提示多一次
 *  往返不值；而实际只会更少（带标签的书在挑选时就被跳过了）。 */
const TOKENS_PER_BOOK = 200;
/** Backend's cap for one run (`tagging::RUN_LIMIT`). */
const RUN_LIMIT = 60;
/** 审阅列表一页的行数：每本 2–4 个 glass chip 带 backdrop-filter，一次渲染
 *  上千本会把列表拖死。50 本与逐批模式同量级。 */
const PAGE = 50;

interface Row {
  bookId: string;
  title: string;
  tags: string[];
  /** 这一行还要不要。关掉的行不写入，但留在列表里 —— 它解释了为什么少了一本。 */
  on: boolean;
}

interface Editing {
  row: number;
  tag: number;
  value: string;
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
  const review = useTagRun((s) => s.review);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [run, setRun] = useState<TagRunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The batch that was just written, or `null` before the first apply. */
  const [written, setWritten] = useState<number | null>(null);
  /** Everything written since this sheet opened. */
  const [total, setTotal] = useState(0);
  /** Books left over from the last batch (manual mode only). */
  const [remaining, setRemaining] = useState(0);
  /** Manual mode: fetch the next batch on its own after an apply. */
  const [auto, setAuto] = useState(true);
  /** 开关：全部生成后统一审阅，确认一次写入。默认关 = 逐批预览。 */
  const [autoApply, setAutoApply] = useState(false);
  /** UI feedback after 「停在这里」 in manual mode — the pipeline has been cut. */
  const [stopped, setStopped] = useState(false);
  /** 审阅列表当前页。chips 带 backdrop-filter，一次渲染上千本会卡死。 */
  const [page, setPage] = useState(0);
  /** 正在改的标签：整表只有一处编辑，行+列定位即可。 */
  const [editing, setEditing] = useState<Editing | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  // 只在切换到新的一格时全选，输入过程中不能反复 select 掉光标。
  useEffect(() => {
    if (editing) editRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.row, editing?.tag]);

  /** A ref, not state: the in-flight callback closed over the old `auto`, so
   *  `setAuto(false)` alone never reached it. Manual mode reads this ref. */
  const stopRef = useRef(false);
  /** 在飞结果回来后要移交的意图。ref 给回调读（state 闭包是旧值），state 给 UI。
   *  移交不是「停在这里」——在飞的 token 已花，结果要接住复用而不是丢弃。 */
  const handoffRef = useRef<"background" | "review" | null>(null);
  const [handoff, setHandoffState] = useState<"background" | "review" | null>(null);
  const setHandoff = (next: "background" | "review" | null) => {
    handoffRef.current = next;
    setHandoffState(next);
  };
  /** 已把哪一次 review 的建议灌进本地列表。换一轮（新对象）才重灌，避免
   *  覆盖读者在审阅时做的修改。 */
  const loadedReview = useRef<TagReview | null>(null);

  /**
   * 后台循环跑完（或中途停止）后，把 store 里的建议搬进可编辑的本地列表。
   * 没写库，所以书架不需要刷新；编辑只在本地，确认时才一次写入。
   */
  useEffect(() => {
    if (!review || review.running || loadedReview.current === review) return;
    loadedReview.current = review;
    setRows(review.rows.map((r) => ({ ...r, on: true })));
    setRun({
      suggestions: review.rows,
      considered: review.rows.length,
      remaining: 0,
      failedBatches: review.failed,
    });
    setRemaining(0);
    setError(review.error);
    if (review.cancelled && review.rows.length === 0) {
      // 一条都没攒下，也别让人对着空表发呆：说清楚为什么停了。
      setError(review.error ?? "已停止，这一轮还没有生成出建议");
    }
  }, [review]);

  const stop = () => {
    stopRef.current = true;
    setStopped(true);
    setAuto(false);
  };

  const startReview = () => {
    loadedReview.current = null;
    setRows(null);
    setRun(null);
    setError(null);
    setWritten(null);
    setPage(0);
    setStopped(false);
    useTagRun.getState().startReview(ids);
  };

  /// 一批，不是一个选择批次：多出来的书留在这里，等读者按「继续」。
  const ask = () => {
    setAuto(true);
    stopRef.current = false;
    setHandoff(null);
    setStopped(false);
    setError(null);
    setRows(null);
    setRun(null);
    setWritten(null);
    setPage(0);
    if (autoApply) {
      startReview();
      return;
    }
    suggest.mutate(ids, {
      onSuccess: (data) => {
        const target = handoffRef.current;
        if (target) {
          setHandoff(null);
          if (target === "background") {
            // 在飞的这批 token 已花：先写库，再让 store 循环接手。后端
            // untagged 会跳过刚写的，不会为同一批书再烧一次 token。
            const items: TagAdd[] = data.suggestions.map((s) => ({
              bookId: s.bookId,
              tags: s.tags,
            }));
            apply.mutate(items, {
              onSuccess: () => {
                // 在飞的只是最后一批：全部写完，没有下一批要接，也就没有后台任务。
                if (data.remaining > 0) {
                  useTagRun.getState().start(ids);
                  useTagRun.getState().setBackground(true);
                }
                close();
              },
              onError: (err) => {
                setHandoff(null);
                setError(String(err));
              },
            });
          } else if (target === "review") {
            // 在飞结果作为审阅的第一批攒进去，后续块按 bookId 跳过它们。
            loadedReview.current = null;
            setRows(null);
            setRun(null);
            setWritten(null);
            setPage(0);
            setStopped(false);
            useTagRun.getState().startReview(
              ids,
              data.suggestions.map((s) => ({ bookId: s.bookId, title: s.title, tags: s.tags })),
            );
          }
          return;
        }
        // 停在这里之后回来的答案要丢掉，否则流水线看着停了又弹出一批。
        if (stopRef.current) return;
        setRun(data);
        setRemaining(data.remaining);
        setRows(data.suggestions.map((item) => ({ ...item, on: true })));
      },
      onError: (err) => {
        // 移交中失败：没有结果可复用，留在窗口里说明原因（不启动 store 重拉，
        // 那正是要避免的二次烧钱）。正常失败也照旧报一次。
        if (handoffRef.current) setHandoff(null);
        setError(String(err));
      },
    });
  };

  const runInBackground = () => {
    if (autoApply) {
      startReview();
      useTagRun.getState().setBackground(true);
      close();
      return;
    }
    if (suggest.isPending) {
      // 逐批在飞：标记移交，等在飞结果回来先写库（复用已花的 token），
      // 再启动 store 循环从下一批接手。此时不能关窗 —— 卸载会丢掉回调。
      setHandoff("background");
      return;
    }
    // 没有在飞结果可复用（初始态或预览态），照旧让 store 重新发起。
    // start 会从 idle 重置，所以标记要在它之后打，才轮得到胶囊显示。
    stopRef.current = true;
    useTagRun.getState().start(ids);
    useTagRun.getState().setBackground(true);
    close();
  };

  const write = (items: TagAdd[], nextRemaining: number) => {
    apply.mutate(items, {
      onSuccess: (count) => {
        setWritten(count);
        setTotal((done) => done + count);
        // 审阅模式的建议已经落定（或读者主动放弃），胶囊上的入口该撤了。
        useTagRun.getState().clearReview();
        // 停在这里之后不再接力，但已经写成功的这一批要照常计数。
        if (stopRef.current) return;
        // 全量统一审阅模式一次写完就结束；只有逐批模式才继续下一批。空批次
        // 也不能接力，否则会对同一批书反复请求。
        if (count > 0 && nextRemaining > 0 && !autoApply && auto) {
          ask();
        }
      },
      onError: (err) => setError(String(err)),
    });
  };

  const applyNow = () => {
    const picked = (rows ?? []).filter((row) => row.on && row.tags.length > 0);
    write(
      picked.map((row) => ({ bookId: row.bookId, tags: row.tags })),
      remaining,
    );
  };

  const close = () => {
    // The next open starts from nothing: a suggestion belongs to the selection
    // it was made for. Cut any in-flight *manual* batch so it cannot repopulate
    // the sheet; a review loop lives in the store and is deliberately left alone.
    stopRef.current = true;
    setRows(null);
    setRun(null);
    setError(null);
    setWritten(null);
    setTotal(0);
    setRemaining(0);
    setAuto(true);
    setAutoApply(false);
    setStopped(false);
    setEditing(null);
    setPage(0);
    loadedReview.current = null;
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

  const commitEdit = () => {
    if (!editing) return;
    const value = editing.value.trim();
    setRows((all) => {
      const next = [...(all ?? [])];
      const row = next[editing.row];
      if (!row) return next;
      const tags = row.tags.map((name, i) => (i === editing.tag ? value : name));
      next[editing.row] = {
        ...row,
        tags: tags.filter((name, i) => name && tags.indexOf(name) === i),
      };
      return next;
    });
    setEditing(null);
  };

  const reviewing = review?.running ?? false;
  const chunkTotal = Math.max(1, Math.ceil(ids.length / RUN_LIMIT));
  const busy = reviewing || suggest.isPending || apply.isPending;
  const picked = (rows ?? []).filter((row) => row.on && row.tags.length > 0);
  const tagCount = picked.reduce((sum, row) => sum + row.tags.length, 0);

  /** 开关在任何阶段都能点：逐批在飞打开 → 标记移交，等在飞结果回来作为
   *  审阅第一批（token 不浪费）；预览中打开 → 直接重跑全量（此时没有在飞
   *  结果）；审阅生成中关掉 → 停止并保留已收集的。写库事务中才禁用。 */
  const toggleReview = (next: boolean) => {
    setAutoApply(next);
    if (next && suggest.isPending) {
      setHandoff("review");
    } else if (next && rows !== null && review === null) {
      stopRef.current = true;
      startReview();
    } else if (!next && reviewing) {
      useTagRun.getState().cancelReview();
    }
  };

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="AI 打标签"
      description={
        written !== null && stopped
          ? "这一轮停下了。操作记录里能看到写入的改动。"
          : review?.cancelled && rows !== null
            ? "已提前停止，下面是已生成的建议；确认之前不会写入。"
            : "只给还没有标签的书建议，确认之前不会写入。"
      }
      widthClass="w-[min(94vw,560px)]"
    >
      <div className="space-y-3">
        <div className="glass flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-text-1 text-[13px] font-medium">全部生成后统一审阅</p>
            <p className="text-text-3 mt-0.5 text-[11.5px] leading-relaxed">
              打开后一次跑完所有批次、先不写入；出齐后逐条修改或删除，确认后统一应用。
            </p>
          </div>
          <GlassSwitch
            checked={autoApply}
            onCheckedChange={toggleReview}
            ariaLabel="全部生成后统一审阅"
            disabled={!!handoff || apply.isPending || (review !== null && !reviewing)}
          />
        </div>

        {(written !== null || stopped) && (
          <div className="glass rounded-xl border px-3 py-3">
            <p className="text-text-1 flex items-center gap-2 text-[13px] font-medium">
              <Tag size={14} className="text-accent" />
              {stopped ? `已停在这里，本轮已写入 ${total} 本` : `已给 ${written} 本加上标签`}
              {written !== null && !stopped && total > written && (
                <span className="text-text-3 text-[12px]">本轮累计 {total} 本</span>
              )}
            </p>
            <p className="text-text-3 mt-1 text-[12px] leading-relaxed">
              设置 › 操作记录 里可以按「AI」筛出这一次；标签改动按需手工删除。
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

        {reviewing && (
          <div className="glass rounded-xl border px-3 py-3">
            <p className="text-text-2 flex items-center gap-2 text-[12.5px]">
              <CircleNotch size={14} className="text-accent animate-spin" />
              正在生成全部建议 · 第 {review!.done}/{review!.total} 批 · 已收集 {review!.rows.length}{" "}
              本
            </p>
            <p className="text-text-3 mt-1.5 text-[11.5px] leading-relaxed">
              全程不写入。中途停止会保留已生成的建议供审阅；关掉窗口也会继续在后台生成，进度见右下角。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <GlassButton
                size="sm"
                variant="subtle"
                onClick={() => useTagRun.getState().cancelReview()}
              >
                停在这里并审阅
              </GlassButton>
              <GlassButton size="sm" variant="subtle" onClick={close}>
                后台运行
              </GlassButton>
            </div>
          </div>
        )}

        {rows === null && written === null && !error && !stopped && !reviewing && (
          <div className="space-y-3 py-2">
            <dl className="border-hairline divide-hairline divide-y rounded-md border px-3">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-text-3 shrink-0 text-[12px]">处理范围</dt>
                <dd className="text-text-1 text-[13px] tabular-nums">
                  {ids.length} 本 · 仅无标签书籍
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-text-3 shrink-0 text-[12px]">分批策略</dt>
                <dd className="text-text-1 text-right text-[12px] tabular-nums">
                  {chunkTotal} 批 · 每批至多 {RUN_LIMIT} 本 · 每 20 本一次请求
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-text-3 shrink-0 text-[12px]">模型开销</dt>
                <dd className="text-text-1 text-[12px] tabular-nums">
                  最多约 {tokenEstimate(ids.length)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-text-3 shrink-0 text-[12px]">写入方式</dt>
                <dd className="text-text-1 text-right text-[12px]">
                  {autoApply ? "全部生成 → 统一审阅 → 一次写入" : "逐批预览确认后写入"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-text-3 shrink-0 text-[12px]">中断</dt>
                <dd className="text-text-1 text-right text-[12px]">可随时停止，已写入内容保留</dd>
              </div>
            </dl>
            <p className="text-text-3 text-[11.5px] leading-relaxed">
              模型依据书名、作者与简介（至多 200 字）生成每本 2–4
              个标签；已有标签的书籍自动跳过，实际开销低于上表估计。
            </p>
            <div className="flex items-center gap-2">
              <GlassButton
                variant="primary"
                size="md"
                disabled={busy || ids.length === 0}
                onClick={ask}
              >
                {suggest.isPending ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" /> 正在看这 {ids.length} 本…
                  </>
                ) : autoApply ? (
                  <>
                    <Sparkle size={14} /> 生成全部建议
                  </>
                ) : (
                  <>
                    <Sparkle size={14} /> 开始建议
                  </>
                )}
              </GlassButton>
              {suggest.isPending && total > 0 && (
                <GlassButton size="md" variant="subtle" onClick={stop}>
                  停在这里
                </GlassButton>
              )}
              {/* 逐批 suggest 在飞时也要能转后台：标记移交，等在飞结果回来
                  先写库（复用 token）再让 store 接手，不重复拉同一批。 */}
              {!reviewing && !apply.isPending && !handoff && (
                <GlassButton size="md" variant="subtle" onClick={runInBackground}>
                  后台运行
                </GlassButton>
              )}
              {handoff && (
                <span className="text-text-2 flex items-center gap-2 text-[12px]">
                  <CircleNotch size={13} className="text-accent animate-spin" />
                  {handoff === "background"
                    ? "正在移交后台，等这一批写完就接着跑…"
                    : "正在切到统一审阅，等这一批返回后接着生成…"}
                </span>
              )}
            </div>
            <p className="text-text-3 text-[11px] leading-relaxed">
              逐批预览便于边做边校对；全部生成适合一次看完整批质量；后台运行可关窗，进度与「审阅」入口在右下角。
            </p>
          </div>
        )}

        {rows !== null && written === null && !stopped && (
          <>
            {review?.cancelled && rows.length > 0 && (
              <p className="text-text-2 text-[12px] leading-relaxed">
                已提前停止，下面保留的是已生成的 {rows.length} 本建议，可照常修改、删除后写入。
              </p>
            )}
            <p className="text-text-2 text-[12px] leading-relaxed">
              已为 {rows.length} 本书生成建议。写入前可逐条修改、删除或跳过整本，确认后一次应用。
            </p>
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
            {rows.length > 0 ? (
              <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {rows.slice(page * PAGE, (page + 1) * PAGE).map((row, i) => {
                  const index = page * PAGE + i;
                  return (
                    <li
                      key={row.bookId}
                      className={`glass rounded-xl border px-3 py-2.5 ${row.on ? "" : "opacity-50"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          className="press focus-visible:focus-ring text-text-1 min-w-0 flex-1 truncate text-left text-[13px] font-medium"
                          onClick={() => toggleRow(index)}
                          title="点按切换是否写入这本书"
                        >
                          {row.title}
                        </button>
                        <span className="text-text-3 shrink-0 text-[11.5px]">
                          {row.on ? `${row.tags.length} 个` : "不写入"}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {row.tags.map((tag, tagIndex) => {
                          const isEditing = editing?.row === index && editing.tag === tagIndex;
                          return isEditing ? (
                            <GlassInput
                              key={tag}
                              ref={editRef}
                              value={editing?.value ?? ""}
                              aria-label="编辑标签"
                              className="h-6 w-24 px-2 text-[11.5px]"
                              onChange={(e) =>
                                setEditing((prev) =>
                                  prev ? { ...prev, value: e.target.value } : prev,
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitEdit();
                                } else if (e.key === "Escape") {
                                  setEditing(null);
                                }
                              }}
                              onBlur={commitEdit}
                            />
                          ) : (
                            <span
                              key={tag}
                              className="glass-2 text-text-2 inline-flex items-center rounded-full border text-[11.5px]"
                            >
                              <button
                                type="button"
                                className="focus-visible:focus-ring hover:text-text-1 py-0.5 pr-1 pl-2"
                                onClick={() => dropTag(index, tag)}
                                aria-label={tag}
                                title="点按删除这个标签"
                              >
                                {tag} <X size={9} className="inline" />
                              </button>
                              <button
                                type="button"
                                className="text-text-3 hover:text-text-1 focus-visible:focus-ring py-0.5 pr-1.5"
                                onClick={() =>
                                  setEditing({ row: index, tag: tagIndex, value: tag })
                                }
                                aria-label={`修改标签 ${tag}`}
                                title="点按修改标签文字"
                              >
                                <PencilSimple size={10} />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-text-3 rounded-xl border px-3 py-3 text-[12px]">
                这一轮没有生成出可审阅的建议。
              </p>
            )}
            {rows.length > PAGE && (
              <div className="text-text-3 flex items-center justify-between gap-2 text-[11.5px]">
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </GlassButton>
                <span className="tabular-nums">
                  第 {page + 1}/{Math.ceil(rows.length / PAGE)} 页 · 共 {rows.length} 本
                </span>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={page >= Math.ceil(rows.length / PAGE) - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </GlassButton>
              </div>
            )}
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

        {(written !== null || stopped) && (
          <div className="flex items-center justify-between gap-2">
            <GlassButton size="md" onClick={close} disabled={busy}>
              完成
            </GlassButton>
            {remaining > 0 && (
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
