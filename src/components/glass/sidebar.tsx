import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/cn";
import { SPRING } from "@/lib/motion";

interface GlassSidebarProps {
  children: ReactNode;
  className?: string;
  /** Fully collapse to zero width (animated); content is made inert. */
  hidden?: boolean;
  /** Elevation-3 opaque material for floating over page content: the blurred
   *  glass picks up whatever is behind it (a white PDF page reads as a light
   *  sidebar even on a night surface), the solid fill always follows the
   *  surface tokens instead. */
  overlay?: boolean;
}

const COLLAPSED = 76;
const EXPANDED = 248;
/** The parent flex row reserves a 12px gap; swallow it while collapsed away. */
const ROW_GAP = 12;
/** The material's rim, drawn *inside* the animated width (`box-sizing` is
 *  border-box). The inner column has to give up both pixels or it overflows
 *  the pane and gets clipped on one side only — which is what made the
 *  collapsed rail's selection read 17px from the left and 15px from the right
 *  (measured): every row, and the highlight under it, sat one pixel right of
 *  centre. */
const RIM = 1;

/** Floating glass sidebar that smoothly animates between collapsed and expanded.
 *
 * The inner column always keeps its final width while the pane springs: the
 * shell clips it (overflow-hidden) instead of re-wrapping the labels at every
 * intermediate width, which read as the content squashing before shrinking. */
export function GlassSidebar({
  children,
  className,
  hidden = false,
  overlay = false,
}: GlassSidebarProps) {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const reduce = useReducedMotion();
  const width = collapsed ? COLLAPSED : EXPANDED;
  return (
    <motion.aside
      initial={false}
      inert={hidden}
      animate={{
        width: hidden ? 0 : width,
        opacity: hidden ? 0 : 1,
        marginLeft: hidden ? -ROW_GAP : 0,
      }}
      transition={reduce ? { duration: 0 } : SPRING.panel}
      className={cn(
        overlay ? "glass-solid shadow-panel" : "glass-2 shadow-glass",
        "shrink-0 self-stretch overflow-hidden rounded-2xl",
        // Eases the token hand-off between app theme and reading surface.
        "transition-colors duration-300",
        className,
      )}
    >
      <div style={{ width: width - RIM * 2 }} className="flex h-full flex-col gap-3 p-3">
        {children}
      </div>
    </motion.aside>
  );
}
