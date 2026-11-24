import { AnimatePresence, motion } from "motion/react";
import { CaretRight, Sparkle } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import {
  runPillBottom,
  useRunPillMotion,
  useRunPillPeek,
  useRunPillSlot,
} from "@/features/library/runPillSlots";
import { useGuideBatch } from "@/stores/guideBatch";

/**
 * The batch-guide run, floating over whatever page the reader has moved to.
 *
 * The loop lives in `stores/guideBatch` precisely so this can be dismissable
 * by navigation: the pill is mounted in the shell, so the run stays visible on
 * the shelf, in the reader, on the settings page. Same shape as the import
 * pill in `LibraryPage`, for the same reason.
 *
 * Deliberately small. Book titles run long — a boxed set's title can carry its
 * whole author list and tagline — so the name is truncated rather than given
 * room, and the counter stays visible while the title folds. The second line
 * only appears when there is actual news (a failure, a stop in progress);
 * "已完成 0" next to "1 / 4" is a number the reader can already see, and a
 * permanent second row doubles the pill's footprint for it.
 *
 * Folding follows `FillRunPill`: the title body and actions sit in `1fr → 0fr`
 * grid columns, and the folded badge keeps only the sparkle. Hover or keyboard
 * focus peeks the counter out; a click anywhere on the badge opens the full
 * strip. All of it is CSS width, never a motion `layout` FLIP — resampling the
 * glass blur reads as judder. Folding is presentation only: the run, its toast
 * and 停止 are untouched by it.
 */
export function GuideBatchPill() {
  const { fold, surface, entrance } = useRunPillMotion();
  const run = useGuideBatch((s) => s.run);
  const stop = useGuideBatch((s) => s.stop);
  const collapsed = useGuideBatch((s) => s.collapsed);
  const setCollapsed = useGuideBatch((s) => s.setCollapsed);
  const { countHidden, peekHandlers, keepPeek } = useRunPillPeek(collapsed);

  const hasNews = run !== null && (run.failed.length > 0 || run.status === "stopping");
  const visible = run !== null && run.status !== "done";
  const slot = useRunPillSlot("guide", visible);

  return (
    <OverlayPortal>
      <AnimatePresence>
        {visible && (
          <motion.div
            {...entrance}
            // Shared stack with the other run pills: the visible ones sit just
            // above the batch bar, never over it or over each other.
            // Named for `useShelfSelection`'s empty-space exit: pressing the
            // pill or badge is not pressing empty shelf.
            data-guide-batch-pill
            className="fixed right-6 z-40 flex max-w-[min(72vw,420px)] flex-col items-end"
            style={{ bottom: runPillBottom(slot) }}
          >
            {/* The role is only absent when the pill is unfolded, and then
                there is no onClick either — the static rule cannot see the
                conditional pairing. */}
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div
              data-guide-batch-surface
              role={collapsed ? "button" : undefined}
              tabIndex={collapsed ? 0 : undefined}
              aria-label={collapsed ? "展开生成进度" : undefined}
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
              title={collapsed ? "展开生成进度" : undefined}
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
                <Sparkle size={collapsed ? 11 : 14} className="text-accent shrink-0" aria-hidden />

                {/* The body and the actions fold away inside `1fr → 0fr` grid
                  columns; only the counter peeks out on hover. The negative
                  margin eats the dead flex gap a zero-width column leaves
                  behind. `overflow-hidden` matters because a 0fr track is only
                  as small as its items' minimum contribution. */}
                <div
                  className="grid min-w-0"
                  style={{
                    gridTemplateColumns: collapsed ? "0fr" : "1fr",
                    // Width alone does not fold the badge: a zero-width column
                    // still stands a 32px button tall. The row goes with it.
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
                    <p className="flex items-baseline gap-1.5 text-[12.5px] leading-snug">
                      <span className="text-text-3 shrink-0">正在生成</span>
                      <span className="truncate">《{run.title}》</span>
                    </p>
                    <div
                      className="grid overflow-hidden"
                      style={{
                        gridTemplateRows: !collapsed && hasNews ? "1fr" : "0fr",
                        transition: fold,
                      }}
                    >
                      <p className="text-text-3 min-h-0 overflow-hidden text-[11px] leading-snug">
                        已完成 {run.generated}
                        {run.failed.length > 0 && `，失败 ${run.failed.length}`}
                        {run.status === "stopping" && "，正在停止"}
                      </p>
                    </div>
                  </div>
                </div>

                <div
                  data-guide-batch-count
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
                        collapsed ? "text-[10px] leading-[14px]" : "text-[12px]",
                      )}
                    >
                      {run.index} / {run.total}
                    </span>
                  </div>
                </div>

                {/* shrink-0 is load-bearing: at the capsule's 420px ceiling the
                  title column is the only one allowed to give way, otherwise
                  flex squeezes this column and the 停止 button is sliced by
                  the capsule's right cap. */}
                <div
                  className="grid shrink-0"
                  style={{
                    gridTemplateColumns: collapsed ? "0fr" : "1fr",
                    // Width alone does not fold the badge: a zero-width column
                    // still stands a 32px button tall. The row goes with it.
                    gridTemplateRows: collapsed ? "0fr" : "1fr",
                    marginLeft: collapsed ? "-5px" : "0px",
                    transition: fold,
                  }}
                >
                  <div
                    className={cn(
                      "flex min-h-0 min-w-0 items-center gap-0.5 overflow-hidden",
                      collapsed && "pointer-events-none opacity-0",
                    )}
                    style={{ transition: fold }}
                  >
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      className="shrink-0"
                      style={{ boxShadow: "none" }}
                      disabled={run.status === "stopping"}
                      onClick={stop}
                    >
                      停止
                    </GlassButton>
                    {/* A bare glyph, not a second glass button: the capsule is
                      the only surface here. No material, no rim, no shadow —
                      just a hover tint and a focus ring. */}
                    <button
                      type="button"
                      aria-label="折叠生成进度"
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
