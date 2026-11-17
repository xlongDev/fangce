import type { ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";

import { cn } from "@/lib/cn";
import { EASE_OUT } from "@/lib/motion";

const DEFAULT_TRANSITION: Transition = { duration: 0.15, ease: EASE_OUT };

/**
 * Crossfades between states of one small glyph — a speaker becoming a pause,
 * an arrow becoming a pause — instead of snapping. `state` is only an identity:
 * change it and the old glyph pops out while the new one pops in.
 *
 * For dense rows whose press is the CSS `press` utility this is the animated
 * half the utility cannot express (it owns `transition-property` outright).
 *
 * `transition` lets one caller borrow a different curve — e.g. the landing
 * bezier used by the shelf toolbar — without retuning every other icon here.
 */
export function IconSwap({
  state,
  className,
  transition = DEFAULT_TRANSITION,
  children,
}: {
  state: string;
  className?: string;
  transition?: Transition;
  children: ReactNode;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        className={cn("grid place-items-center", className)}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.6 }}
        transition={transition}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}
