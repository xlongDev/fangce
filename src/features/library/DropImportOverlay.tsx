import { motion } from "motion/react";
import { Upload } from "@phosphor-icons/react";

import { BOOK_FORMAT_CHIPS } from "@/features/library/importFiles";
import { cn } from "@/lib/cn";
import { DURATION, staggerDelay, useMotion } from "@/lib/motion";

/**
 * The shelf's invitation to drop files in.
 *
 * The old overlay was a dim scrim and a small pill. It said *something was
 * happening* without saying *where*: a reader hovering over the shelf had no
 * way to tell the whole window was the target, and the accepted formats were
 * nowhere on screen — the one question a first-time drag raises.
 *
 * So the whole shelf reads as the drop zone now: a dashed, accent-outlined
 * panel that scales in over a scrim, with the formats spelled out inside it.
 * The icon drifts a few pixels up and down while the drag lasts — the target
 * is *alive* and waiting, which is the whole message of this state. Under
 * reduced motion the drift is dropped and the panel simply appears.
 *
 * **Anchored to the content pane, not the window.** The drop zone *is* the
 * shelf — the browser build's own handlers sit on it, and the books land in the
 * list behind it — so dimming and centring over the sidebar as well invited a
 * drop where nothing would be imported. Rendered inside the page and
 * `absolute`, it takes the pane's `relative` box as its origin: the scrim is
 * clipped to the pane's rounded corners and the panel lands on the pane's
 * centre, with no measuring, no resize listener, and nothing to drift when the
 * sidebar is toggled. `z-50` clears the read-aloud pill's own layer (`z-40`),
 * which also lives inside the pane.
 */
export function DropImportOverlay() {
  const m = useMotion();

  return (
    <motion.div
      data-drop-overlay
      className="pointer-events-none absolute inset-0 z-50"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: m.reduce ? 0 : DURATION.base }}
    >
      <div aria-hidden className="absolute inset-0 bg-black/30" />

      <motion.div
        className="absolute inset-0 flex items-center justify-center p-8"
        initial={{ opacity: 0, scale: m.reduce ? 1 : 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: m.reduce ? 1 : 0.98 }}
        transition={m.panel}
      >
        <div
          className={cn(
            "glass-2 shadow-panel border-accent/40 text-text-1 relative",
            "flex w-full max-w-lg flex-col items-center rounded-3xl",
            "border-2 border-dashed px-10 py-11 text-center",
          )}
        >
          <span aria-hidden className="bg-accent-soft absolute -inset-8 rounded-full blur-2xl" />

          <motion.span
            aria-hidden
            className="glass text-accent relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
            animate={m.reduce ? { y: 0 } : { y: [0, -4, 0] }}
            transition={
              m.reduce ? { duration: 0 } : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
            }
          >
            <Upload size={22} weight="duotone" />
          </motion.span>

          <p className="relative text-base font-semibold">松开即可导入</p>
          <p className="text-text-2 relative mt-1.5 text-[13.5px]">
            文件或文件夹都可以拖进来，支持这些格式：
          </p>

          <div className="relative mt-4 flex max-w-[36ch] flex-wrap justify-center gap-1.5">
            {BOOK_FORMAT_CHIPS.map((label, index) => (
              <motion.span
                key={label}
                initial={{ opacity: 0, y: m.reduce ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...m.enter, delay: staggerDelay(index, m.stagger) }}
                className="text-text-3 rounded-full border border-white/10 bg-black/10 px-2.5 py-1 text-[11px] font-medium tracking-wide"
              >
                {label}
              </motion.span>
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
