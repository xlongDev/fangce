import { motion } from "motion/react";
import { DURATION } from "@/lib/motion";

import { BrandMark } from "@/components/brand/Mark";

interface WordmarkProps {
  /** When the sidebar is collapsed, only the spectrum is shown. */
  compact?: boolean;
}

/** The 方册 mark: a five-bar muted spectrum over the wordmark. */
export function Wordmark({ compact = false }: WordmarkProps) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <BrandMark height={22} />
      {/* Stays in layout and fades instead of unmounting: collapsing fades it
          out before the shell clips it, expanding fades it back in after the
          pane has mostly opened. */}
      <motion.span
        initial={false}
        animate={{ opacity: compact ? 0 : 1 }}
        transition={{
          duration: compact ? DURATION.fast : DURATION.base,
          delay: compact ? 0 : 0.15,
        }}
        className="text-text-1 text-[15px] font-semibold tracking-tight whitespace-nowrap"
      >
        方册
      </motion.span>
    </div>
  );
}
