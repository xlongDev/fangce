import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { MagicWand } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { FillRunStatus } from "@/features/library/FillRunStatus";
import { useMotion } from "@/lib/motion";
import { useFillRun, type FillRun } from "@/stores/fillRun";
import { showToast } from "@/stores/toasts";

/**
 * 整架补全的常驻进度。
 *
 * 循环住在 `stores/fillRun`，弹窗关掉也照跑；这里让它在任何页面都看得见、
 * 停得下来。书架刷新和结束提示也放在这里而不是弹窗：弹窗常被关掉，
 * 而「跑完了书架没更新」正是关掉弹窗之后才会发生的问题。
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
  const [expanded, setExpanded] = useState(false);
  const wasRunning = useRef(false);

  useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = running;
    if (running) {
      if (!was) setExpanded(false);
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
  }, [running, queryClient]);

  const status = running
    ? cancelled
      ? "正在停止…"
      : "补全中"
    : stopped?.startsWith("平台限流")
      ? "已暂停"
      : stopped
        ? "已停止"
        : "补全完成";

  const dismiss = () => {
    reset();
    setExpanded(false);
  };

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
            className="fixed right-6 bottom-40 z-40 flex max-w-[min(80vw,380px)] flex-col items-end gap-2"
          >
            <div className="glass-2 shadow-panel text-text-1 flex max-w-full items-center gap-2 rounded-full px-3 py-2">
              <MagicWand size={14} className="text-accent shrink-0" aria-hidden />
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? "收起补全进度" : "展开补全进度"}
                onClick={() => setExpanded((value) => !value)}
                className="focus-visible:focus-ring flex min-w-0 items-baseline gap-1.5 rounded text-left text-[12.5px]"
              >
                <span className="text-text-3 shrink-0">{status}</span>
                <span className="tabular-nums">
                  {done} / {total}
                </span>
              </button>
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
                  onClick={dismiss}
                >
                  关闭
                </GlassButton>
              )}
            </div>

            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  initial={{ opacity: 0, y: m.reduce ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: m.reduce ? 0 : 8 }}
                  transition={m.panel}
                  className="glass-2 shadow-panel w-[min(80vw,380px)] rounded-2xl p-4"
                >
                  <FillRunStatus />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
