import { AnimatePresence, motion } from "motion/react";
import { CaretRight, Sparkle } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { OverlayPortal } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";
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
 * Folding is one capsule changing length. The sparkle and the counter never
 * leave; the title body and the action buttons each sit in a `1fr → 0fr` grid
 * column whose transition carries the whole capsule shut — pure CSS on width,
 * because the previous attempt moved the glass with a transform (`layout`
 * FLIP) and a resampled backdrop-filter reads as judder, not motion. The
 * badge is that same capsule at its shortest, and folded it *is* a button:
 * clicking it anywhere opens the length back up. Folding is presentation
 * only — the run, its toast, and 停止 are untouched by it.
 */
export function GuideBatchPill() {
  const m = useMotion();
  const run = useGuideBatch((s) => s.run);
  const stop = useGuideBatch((s) => s.stop);
  const collapsed = useGuideBatch((s) => s.collapsed);
  const setCollapsed = useGuideBatch((s) => s.setCollapsed);

  const ease = `cubic-bezier(${EASE_OUT.join(", ")})`;
  const transition = (properties: string[]) =>
    m.reduce
      ? "none"
      : properties.map((property) => `${property} ${DURATION.base}s ${ease}`).join(", ");
  const fold = transition([
    "grid-template-columns",
    "grid-template-rows",
    "margin-left",
    "opacity",
  ]);
  // Padding and gap shrink with the badge; without them in the same transition
  // the length would spring while the height and spacing snapped.
  const surface = transition(["padding", "gap"]);
  const hasNews = run !== null && (run.failed.length > 0 || run.status === "stopping");

  return (
    <OverlayPortal>
      <AnimatePresence>
        {run && run.status !== "done" && (
          <motion.div
            initial={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            transition={m.panel}
            // Above the batch bar's own bottom edge (`bottom-6` + ~48px), so
            // the two can never overlap however wide the selection grows.
            // Named for `useShelfSelection`'s empty-space exit: pressing the
            // pill or badge is not pressing empty shelf.
            data-guide-batch-pill
            className="fixed right-6 bottom-24 z-40"
          >
            {/* The role is only absent when the pill is unfolded, and then
                there is no onClick either — the static rule cannot see the
                conditional pairing. */}
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div
              role={collapsed ? "button" : undefined}
              tabIndex={collapsed ? 0 : undefined}
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
              title={collapsed ? "展开生成进度" : undefined}
              className={cn(
                "glass-2 shadow-panel text-text-1 flex max-w-[min(72vw,420px)] items-center overflow-hidden rounded-full",
                collapsed && "focus-visible:focus-ring cursor-default",
              )}
              style={{
                padding: collapsed ? "5px 10px" : "8px 12px 8px 16px",
                gap: collapsed ? "6px" : "10px",
                transition: surface,
              }}
            >
              <Sparkle size={collapsed ? 12 : 14} className="text-accent shrink-0" aria-hidden />

              {/* The body and the actions fold away inside `1fr → 0fr` grid
                  columns — the capsule shortens around the counter, which is
                  the one piece both shapes share. The negative margin eats the
                  dead flex gap a zero-width column leaves behind, so the
                  badge's spacing stays the pill's spacing. The cells carry
                  `overflow-hidden` because a 0fr track is only as small as its
                  items' minimum contribution: a visible-overflow cell would
                  hold the track open at full button width, which is exactly
                  the strip of dead space folded badges had. */}
              <div
                className="grid min-w-0"
                style={{
                  gridTemplateColumns: collapsed ? "0fr" : "1fr",
                  // Width alone does not fold the badge: a zero-width column
                  // still stands a 32px button tall. The row goes with it.
                  gridTemplateRows: collapsed ? "0fr" : "1fr",
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
                      {run.status === "stopping" && "，将在当前这本写完后停止"}
                    </p>
                  </div>
                </div>
              </div>

              <span
                className={cn(
                  "text-text-2 shrink-0 tabular-nums",
                  collapsed ? "text-[11px]" : "text-[12px]",
                )}
              >
                {run.index} / {run.total}
              </span>

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
                  marginLeft: collapsed ? "-6px" : "0px",
                  transition: fold,
                }}
              >
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-0.5 overflow-hidden",
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
