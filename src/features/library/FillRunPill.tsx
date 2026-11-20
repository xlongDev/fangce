import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CaretRight, MagicWand } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { FillRunStatus } from "@/features/library/FillRunStatus";
import { cn } from "@/lib/cn";
import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";
import { useFillRun, type FillRun } from "@/stores/fillRun";
import { showToast } from "@/stores/toasts";

/**
 * 整架补全的常驻进度。
 *
 * 循环住在 `stores/fillRun`，弹窗关掉也照跑；这里让它在任何页面都看得见、
 * 停得下来。书架刷新和结束提示也放在这里而不是弹窗：弹窗常被关掉，
 * 而「跑完了书架没更新」正是关掉弹窗之后才会发生的问题。
 *
 * 🔴 只有**一个**玻璃面：头部胶囊与详情区同属一只容器，中间只隔一条 hairline。
 * 两个独立的玻璃块会在右下角叠成两条通知条（读者明确不要）。折叠时整面缩进
 * `rounded-full` 徽章，详情区随高度动画收走；计数常驻，状态文字与按钮各在
 * `1fr → 0fr` 的 grid 列里收起。纯 CSS 宽度过渡，不用 motion 的 layout FLIP
 * —— 重新采样 backdrop-filter 会读成抖动。折叠后的徽章本身是按钮，点它展开。
 */
function describe(state: FillRun): string {
  const head = state.stopped
    ? state.stopped.startsWith("平台限流")
      ? "整架补全已暂停"
      : "整架补全已停止"
    : "整架补全完成";
  const counts = `已补全 ${state.written} 本，跳过 ${state.skipped} 本`;
  const extra = [
    state.failed > 0 ? `失败 ${state.failed} 本` : null,
    state.pending.length > 0 ? `待补全 ${state.pending.length} 本` : null,
  ]
    .filter(Boolean)
    .join("，");
  return extra ? `${head}：${counts}，${extra}。` : `${head}：${counts}。`;
}

export function FillRunPill() {
  const m = useMotion();
  const queryClient = useQueryClient();
  const cancelled = useFillRun((s) => s.cancelled);
  const running = useFillRun((s) => s.running);
  const total = useFillRun((s) => s.total);
  const done = useFillRun((s) => s.done);
  const stopped = useFillRun((s) => s.stopped);
  const cancel = useFillRun((s) => s.cancel);
  const reset = useFillRun((s) => s.reset);
  const collapsed = useFillRun((s) => s.collapsed);
  const setCollapsed = useFillRun((s) => s.setCollapsed);
  const wasRunning = useRef(false);

  useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = running;
    if (running) {
      if (!was) setCollapsed(false);
      return;
    }
    if (!was) return;
    const state = useFillRun.getState();
    if (state.total === 0) return;
    // One refresh at the end, not one per batch: nobody is watching a grid
    // that is behind the page they are on, and the loop runs dozens of batches.
    void queryClient.invalidateQueries({ queryKey: ["books"] });
    void queryClient.invalidateQueries({ queryKey: ["operations"] });
    showToast(state.failed > 0 ? "error" : "success", describe(state));
  }, [running, queryClient, setCollapsed]);

  const status = running
    ? cancelled
      ? "正在停止…"
      : "补全中"
    : stopped?.startsWith("平台限流")
      ? "已暂停"
      : stopped
        ? "已停止"
        : "补全完成";

  const ease = `cubic-bezier(${EASE_OUT.join(", ")})`;
  const transition = (properties: string[]) =>
    m.reduce
      ? "none"
      : properties.map((property) => `${property} ${DURATION.base}s ${ease}`).join(", ");
  const fold = transition(["grid-template-columns", "margin-left", "opacity"]);
  const surface = transition(["padding", "gap", "border-radius"]);

  return (
    <OverlayPortal>
      <AnimatePresence>
        {total > 0 && (
          <motion.div
            data-fill-run-pill
            initial={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            transition={m.panel}
            // Above the guide pill (`bottom-24`) and the batch bar (`bottom-6`).
            className="fixed right-6 bottom-40 z-40 flex max-w-[min(80vw,380px)] flex-col items-end"
          >
            {/* 一只容器 = 一条通知条。头部与详情同面，只隔一条 hairline。 */}
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- role/tabIndex/onClick/onKeyDown 全部随 collapsed 一起出现 */}
            <div
              data-fill-run-surface
              role={collapsed ? "button" : undefined}
              tabIndex={collapsed ? 0 : undefined}
              aria-label={collapsed ? "展开补全进度" : undefined}
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
              title={collapsed ? "展开补全进度" : undefined}
              className={cn(
                "glass-2 shadow-panel text-text-1 overflow-hidden",
                collapsed ? "rounded-full" : "rounded-2xl",
                collapsed && "focus-visible:focus-ring cursor-default",
              )}
            >
              <div
                className="flex items-center"
                style={{
                  padding: collapsed ? "5px 10px" : "8px 12px 8px 14px",
                  gap: collapsed ? "6px" : "10px",
                  transition: surface,
                }}
              >
                <MagicWand
                  size={collapsed ? 12 : 14}
                  className="text-accent shrink-0"
                  aria-hidden
                />

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
                    <p className="text-text-3 text-[12.5px] leading-snug">{status}</p>
                  </div>
                </div>

                <span
                  className={cn(
                    "text-text-2 shrink-0 tabular-nums",
                    collapsed ? "text-[11px]" : "text-[12.5px]",
                  )}
                >
                  {done} / {total}
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
                    {running ? (
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
                      aria-label="折叠补全进度"
                      title="折叠通知条"
                      onClick={() => setCollapsed(true)}
                      className="focus-visible:focus-ring text-text-3 hover:text-text-1 hover:bg-surface-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors"
                    >
                      <CaretRight size={13} />
                    </button>
                  </div>
                </div>
              </div>

              {/* 详情与头部同一只玻璃面，不是第二条浮层。 */}
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={m.panel}
                    className="border-hairline overflow-hidden border-t"
                  >
                    <div className="w-[min(80vw,380px)] p-4">
                      <FillRunStatus />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
