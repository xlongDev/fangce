import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CaretRight, Tag } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { navigateTo } from "@/features/command/registerCoreCommands";
import { runPillBottom, useRunPillSlot } from "@/features/library/runPillSlots";
import { cn } from "@/lib/cn";
import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";
import { describeTagReview, describeTagRun, useTagRun } from "@/stores/tagRun";
import { showToast } from "@/stores/toasts";

/**
 * 批量打标签的常驻进度。循环住在 `stores/tagRun`，对话框关掉也照跑；
 * 书架刷新、结束提示和「审阅」入口也放这里 —— 对话框常被关掉，而「跑完了
 * 书架没更新 / 建议没地方看」正是关掉之后才会发生的问题。与 `FillRunPill` 同一套约定。
 *
 * 折叠照 `GuideBatchPill`：一个胶囊改长度，计数常驻、状态文字与按钮各在
 * `1fr → 0fr` 的 grid 列里收起。纯 CSS 宽度过渡，不用 motion 的 layout FLIP
 * —— 重新采样 backdrop-filter 会读成抖动。折叠后的徽章本身是按钮，点它展开。
 */
export function TagRunPill() {
  const m = useMotion();
  const queryClient = useQueryClient();
  const running = useTagRun((s) => s.running);
  const cancelled = useTagRun((s) => s.cancelled);
  const total = useTagRun((s) => s.total);
  const done = useTagRun((s) => s.done);
  const written = useTagRun((s) => s.written);
  const remaining = useTagRun((s) => s.remaining);
  const stopped = useTagRun((s) => s.stopped);
  const cancel = useTagRun((s) => s.cancel);
  const reset = useTagRun((s) => s.reset);
  const review = useTagRun((s) => s.review);
  const cancelReview = useTagRun((s) => s.cancelReview);
  const requestReview = useTagRun((s) => s.requestReview);
  const clearReview = useTagRun((s) => s.dismissReview);
  const collapsed = useTagRun((s) => s.collapsed);
  const setCollapsed = useTagRun((s) => s.setCollapsed);
  const wasRunning = useRef(false);
  const wasReviewRunning = useRef(false);

  // 逐批写入模式：结束时刷新一次 + toast。
  useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = running;
    if (running || !was || total === 0) return;
    void queryClient.invalidateQueries({ queryKey: ["books"] });
    void queryClient.invalidateQueries({ queryKey: ["tags"] });
    void queryClient.invalidateQueries({ queryKey: ["operations"] });
    const state = useTagRun.getState();
    showToast(
      state.failedBatches > 0 || state.stopped ? "error" : "success",
      describeTagRun(state),
    );
  }, [running, total, queryClient]);

  // 统一审阅模式：还没写库，不需要刷新 queries；跑完给一个「去审阅」的提示。
  useEffect(() => {
    const was = wasReviewRunning.current;
    wasReviewRunning.current = review?.running ?? false;
    const current = useTagRun.getState().review;
    if (!was || current?.running || !current || current.rows.length === 0) return;
    showToast(
      current.cancelled || current.failed > 0 ? "error" : "success",
      describeTagReview(current),
    );
  }, [review?.running]);

  const reviewRunning = review?.running ?? false;
  const showWrite = total > 0 && !review;
  const showReview = review !== null;
  const slot = useRunPillSlot("tag", showWrite || showReview);

  // 「返回界面」要先回书架：对话框挂在 ShelfBatchBar（书架页），后台跑时
  // 读者可能已在阅读器或设置页。只置 reviewSheetOpen 不导航，对话框没挂载。
  const openReviewSheet = () => {
    navigateTo("/");
    requestReview();
  };

  const ease = `cubic-bezier(${EASE_OUT.join(", ")})`;
  const transition = (properties: string[]) =>
    m.reduce
      ? "none"
      : properties.map((property) => `${property} ${DURATION.base}s ${ease}`).join(", ");
  const fold = transition(["grid-template-columns", "margin-left", "opacity"]);
  const surface = transition(["padding", "gap"]);

  // 展开态的状态文字与补充；计数常驻，折叠后仍看得见进度。
  const label = review
    ? reviewRunning
      ? review.cancelled
        ? "正在停止…"
        : "生成建议中"
      : review.cancelled
        ? "已停止"
        : "建议已生成"
    : running
      ? cancelled
        ? "正在停止…"
        : stopped
          ? "已停止"
          : "打标签中"
      : stopped
        ? "已停止"
        : "打标签完成";
  const counter = review
    ? reviewRunning
      ? `${review.done}/${review.total} 批`
      : `${review.rows.length} 本`
    : `${done} / ${total}`;
  const detail = review
    ? reviewRunning
      ? `已收集 ${review.rows.length} 本`
      : "待审阅"
    : [written > 0 ? `写入 ${written} 本` : "", remaining > 0 && running ? `剩余 ${remaining}` : ""]
        .filter(Boolean)
        .join(" · ");

  return (
    <OverlayPortal>
      <AnimatePresence>
        {(showWrite || showReview) && (
          <motion.div
            data-tag-run-pill
            initial={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            transition={m.panel}
            // 与其他后台通知条共用一列，贴在批量管理栏上方（见 runPillSlots）。
            className="fixed right-6 z-40"
            style={{ bottom: runPillBottom(slot) }}
          >
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- role/tabIndex/onClick/collected keys are all conditional on `collapsed` */}
            <div
              role={collapsed ? "button" : undefined}
              tabIndex={collapsed ? 0 : undefined}
              aria-label={collapsed ? "展开打标签进度" : undefined}
              onClick={collapsed ? () => setCollapsed(false) : undefined}
              onKeyDown={
                collapsed
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setCollapsed(false);
                      }
                    }
                  : undefined
              }
              title={collapsed ? "展开打标签进度" : undefined}
              className={cn(
                "glass-2 shadow-panel text-text-1 flex max-w-[min(80vw,420px)] items-center overflow-hidden rounded-full",
                collapsed && "focus-visible:focus-ring cursor-default",
              )}
              style={{
                padding: collapsed ? "5px 10px" : "8px 12px 8px 14px",
                gap: collapsed ? "6px" : "10px",
                transition: surface,
              }}
            >
              <Tag size={collapsed ? 12 : 14} className="text-accent shrink-0" aria-hidden />

              {/* 状态文字：折叠时收起。计数在它外面，两个形态都在。 */}
              <div
                className="grid min-w-0"
                style={{
                  gridTemplateColumns: collapsed ? "0fr" : "1fr",
                  marginLeft: collapsed ? "-6px" : "0px",
                  transition: fold,
                }}
              >
                <div
                  className={cn(
                    "min-w-0 overflow-hidden whitespace-nowrap",
                    collapsed && "pointer-events-none opacity-0",
                  )}
                  style={{ transition: fold }}
                >
                  <p className="text-text-3 text-[12.5px] leading-snug">{label}</p>
                </div>
              </div>

              <span
                className={cn(
                  "text-text-2 shrink-0 tabular-nums",
                  collapsed ? "text-[11px]" : "text-[12.5px]",
                )}
              >
                {counter}
                {!collapsed && detail && <span className="text-text-3"> · {detail}</span>}
              </span>

              {/* 按钮区：折叠时收起。 */}
              <div
                className="grid shrink-0"
                style={{
                  gridTemplateColumns: collapsed ? "0fr" : "1fr",
                  marginLeft: collapsed ? "-6px" : "0px",
                  transition: fold,
                }}
              >
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-1 overflow-hidden",
                    collapsed && "pointer-events-none opacity-0",
                  )}
                  style={{ transition: fold }}
                >
                  {review ? (
                    reviewRunning ? (
                      <>
                        <GlassButton
                          size="sm"
                          variant="subtle"
                          style={{ boxShadow: "none" }}
                          onClick={openReviewSheet}
                        >
                          返回界面
                        </GlassButton>
                        <GlassButton
                          size="sm"
                          variant="subtle"
                          style={{ boxShadow: "none" }}
                          disabled={review.cancelled}
                          onClick={cancelReview}
                        >
                          {review.cancelled ? "停止中" : "停止"}
                        </GlassButton>
                      </>
                    ) : (
                      <>
                        <GlassButton
                          size="sm"
                          variant="subtle"
                          style={{ boxShadow: "none" }}
                          disabled={review.rows.length === 0}
                          onClick={openReviewSheet}
                        >
                          审阅
                        </GlassButton>
                        <GlassButton
                          size="sm"
                          variant="subtle"
                          style={{ boxShadow: "none" }}
                          onClick={clearReview}
                        >
                          关闭
                        </GlassButton>
                      </>
                    )
                  ) : running ? (
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      style={{ boxShadow: "none" }}
                      disabled={cancelled}
                      onClick={cancel}
                    >
                      {cancelled ? "停止中" : "停止"}
                    </GlassButton>
                  ) : (
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      style={{ boxShadow: "none" }}
                      onClick={reset}
                    >
                      关闭
                    </GlassButton>
                  )}
                  <button
                    type="button"
                    aria-label="折叠打标签进度"
                    title="折叠通知条"
                    onClick={() => setCollapsed(true)}
                    className="focus-visible:focus-ring text-text-3 hover:text-text-1 hover:bg-surface-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors"
                  >
                    <CaretRight size={13} />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
