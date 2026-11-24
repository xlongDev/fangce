import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CaretRight, MagicWand } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { navigateTo } from "@/features/command/registerCoreCommands";
import {
  runPillBottom,
  useRunPillMotion,
  useRunPillPeek,
  useRunPillSlot,
} from "@/features/library/runPillSlots";
import { cn } from "@/lib/cn";
import { useFillRun, type FillRun } from "@/stores/fillRun";
import { showToast } from "@/stores/toasts";

/**
 * 整架补全的常驻进度。
 *
 * 循环住在 `stores/fillRun`，弹窗关掉也照跑；这里让它在任何页面都看得见、
 * 停得下来。书架刷新和结束提示也放在这里而不是弹窗：弹窗常被关掉，
 * 而「跑完了书架没更新」正是关掉弹窗之后才会发生的问题。
 *
 * 🔴 胶囊只在横向展开/折叠：状态文字与按钮各在 `1fr → 0fr` 的 grid 列里收起。
 * 折叠态默认只剩图标；hover/键盘聚焦时计数在 `0fr → 1fr` 的列里弹出，指针
 * 未移入时不占宽度。纯 CSS 宽度过渡，不用 motion 的 layout FLIP —— 重新
 * 采样 backdrop-filter 会读成抖动。底部不再放详情：完整界面由「返回界面」
 * 打开（要先回书架，因为弹窗挂在 `ShelfBatchBar`）。
 */
function describe(state: FillRun): string {
  const head = state.stopped
    ? state.stopped.startsWith("平台限流")
      ? "整架补全已暂停"
      : "整架补全已停止"
    : "整架补全完成";
  const counts = `已补全 ${state.written} 本${state.renamed > 0 ? `，改名 ${state.renamed} 本` : ""}，跳过 ${state.skipped} 本`;
  const extra = [
    state.failed > 0 ? `失败 ${state.failed} 本` : null,
    state.pending.length > 0 ? `待补全 ${state.pending.length} 本` : null,
  ]
    .filter(Boolean)
    .join("，");
  return extra ? `${head}：${counts}，${extra}。` : `${head}：${counts}。`;
}

// 同 TagRunPill：对话框挂在书架页，后台跑时读者可能在任何页面。
function openSheet() {
  navigateTo("/");
  useFillRun.getState().openSheet();
}

export function FillRunPill() {
  const { fold, surface, entrance } = useRunPillMotion();
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
  const background = useFillRun((s) => s.background);
  const { countHidden, peekHandlers, keepPeek } = useRunPillPeek(collapsed);
  const wasRunning = useRef(false);
  // 没点「后台运行」时进度就在补全弹窗里，右下角不再多出一条通知条。
  const visible = background && total > 0;
  const slot = useRunPillSlot("fill", visible);

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

  return (
    <OverlayPortal>
      <AnimatePresence>
        {visible && (
          <motion.div
            data-fill-run-pill
            {...entrance}
            // 与其他后台通知条共用一列，贴在批量管理栏上方（见 runPillSlots）。
            className="fixed right-6 z-40 flex max-w-[min(80vw,380px)] flex-col items-end"
            style={{ bottom: runPillBottom(slot) }}
          >
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- role/tabIndex/交互事件全部随 collapsed 一起出现 */}
            <div
              data-fill-run-surface
              role={collapsed ? "button" : undefined}
              tabIndex={collapsed ? 0 : undefined}
              aria-label={collapsed ? "展开补全进度" : undefined}
              onClick={collapsed ? () => setCollapsed(false) : undefined}
              {...peekHandlers}
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
                  padding: collapsed ? "4px 8px" : "8px 12px 8px 14px",
                  gap: collapsed ? "5px" : "10px",
                  transition: surface,
                }}
              >
                <MagicWand
                  size={collapsed ? 11 : 14}
                  className="text-accent shrink-0"
                  aria-hidden
                />

                {/* 状态文字：折叠时收起。计数在它外面，两个形态都在。 */}
                <div
                  className="grid min-w-0"
                  style={{
                    gridTemplateColumns: collapsed ? "0fr" : "1fr",
                    // 也要收行：否则隐藏的按钮仍把徽章撑到 ~44px 高。
                    gridTemplateRows: collapsed ? "0fr" : "1fr",
                    marginLeft: collapsed ? "-5px" : "0px",
                    transition: fold,
                  }}
                >
                  <div
                    className={cn(
                      "min-h-0 min-w-0 overflow-hidden whitespace-nowrap",
                      collapsed && "pointer-events-none opacity-0",
                    )}
                    style={{ transition: fold }}
                  >
                    <p className="text-text-3 text-[12.5px] leading-snug">{status}</p>
                  </div>
                </div>

                <div
                  data-fill-run-count
                  className="grid shrink-0"
                  style={{
                    gridTemplateColumns: countHidden ? "0fr" : "1fr",
                    marginLeft: countHidden ? "-5px" : "0px",
                    transition: fold,
                  }}
                >
                  <div
                    className={cn(
                      "min-h-0 min-w-0 overflow-hidden",
                      countHidden && "pointer-events-none opacity-0",
                    )}
                    style={{ transition: fold }}
                  >
                    <span
                      className={cn(
                        "text-text-2 block whitespace-nowrap tabular-nums",
                        collapsed ? "text-[10px] leading-[14px]" : "text-[12.5px]",
                      )}
                    >
                      {done} / {total}
                    </span>
                  </div>
                </div>

                {/* 按钮区：折叠时收起。 */}
                <div
                  className="grid shrink-0"
                  style={{
                    gridTemplateColumns: collapsed ? "0fr" : "1fr",
                    gridTemplateRows: collapsed ? "0fr" : "1fr",
                    marginLeft: collapsed ? "-5px" : "0px",
                    transition: fold,
                  }}
                >
                  <div
                    className={cn(
                      "flex min-h-0 min-w-0 items-center gap-1 overflow-hidden",
                      collapsed && "pointer-events-none opacity-0",
                    )}
                    style={{ transition: fold }}
                  >
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      style={{ boxShadow: "none" }}
                      onClick={openSheet}
                    >
                      返回界面
                    </GlassButton>
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
                      onClick={() => {
                        keepPeek();
                        setCollapsed(true);
                      }}
                      className="focus-visible:focus-ring text-text-3 hover:text-text-1 hover:bg-surface-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors"
                    >
                      <CaretRight size={13} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
