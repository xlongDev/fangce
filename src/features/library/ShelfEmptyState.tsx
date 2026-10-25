import { motion } from "motion/react";
import { Sparkle } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { cn } from "@/lib/cn";
import { staggerDelay, useMotion } from "@/lib/motion";

/**
 * The empty shelf, drawn as a shelf of books.
 *
 * The row of spines is the app icon's own motif — five reading lines in a muted
 * spectrum — stood upright: a full library in miniature, in the app's palette,
 * before there is a book to point at. The colours are semi-transparent so the
 * whole block stays quiet on either theme.
 *
 * It used to list every format the importer accepts as a row of chips under
 * the copy. That row answered a question nobody asks on an empty shelf — it is
 * the importer's spec, not an action, and eleven chips outweighed the one
 * button it was sitting above. The list still lives in `BOOK_FORMAT_CHIPS`,
 * where it earns its keep: `DropImportOverlay` shows it while a file is
 * actually being dragged over the window and the answer matters.
 */
const SPINES = [
  { color: "#f0a93b", w: 16, h: 60 },
  { color: "#e0735c", w: 21, h: 76 },
  { color: "#b0679b", w: 14, h: 54 },
  { color: "#5c7fbf", w: 18, h: 84 },
  { color: "#4fa89b", w: 16, h: 68 },
  { color: "#f0a93b", w: 13, h: 58 },
  { color: "#e0735c", w: 20, h: 72 },
  { color: "#5c7fbf", w: 15, h: 62 },
];

export function ShelfEmptyState({
  onImport,
  className,
}: {
  onImport: () => void;
  className?: string;
}) {
  const m = useMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={m.enter}
      className={cn("flex h-full flex-col items-center justify-center px-6 text-center", className)}
    >
      <div className="relative mb-7">
        <span aria-hidden className="bg-accent-soft absolute -inset-7 rounded-full blur-2xl" />
        <div className="relative flex items-end gap-[5px]">
          {SPINES.map((spine, index) => (
            <motion.span
              key={`${spine.color}-${spine.w}-${spine.h}`}
              aria-hidden
              initial={{ opacity: 0, y: m.rise }}
              animate={{ opacity: 0.92, y: 0 }}
              transition={{ ...m.enter, delay: staggerDelay(index, 0.045) }}
              style={{ backgroundColor: spine.color, width: spine.w, height: spine.h }}
              className="rounded-t-[3px]"
            />
          ))}
        </div>
        {/* The shelf the spines stand on: a hairline a touch wider than the row. */}
        <span
          aria-hidden
          className="bg-hairline-strong absolute -bottom-2.5 left-1/2 h-px w-[calc(100%+2rem)] -translate-x-1/2 rounded-full"
        />
      </div>

      <h2 className="text-text-1 text-base font-semibold">书库还是空的</h2>
      <p className="text-text-2 mt-1.5 max-w-[42ch] text-[13.5px] leading-relaxed">
        书架在等它的第一本书。拖进窗口，或者从这里导入。
      </p>

      <div className="mt-6">
        <GlassButton variant="primary" size="md" onClick={onImport}>
          <Sparkle size={14} /> 导入书籍
        </GlassButton>
      </div>
    </motion.div>
  );
}
