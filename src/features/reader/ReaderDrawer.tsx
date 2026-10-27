import type { ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";

import { DURATION, SPRING } from "@/lib/motion";

/** Right-hand drawer over a dimmed backdrop shared by every reader panel.
 * The backdrop click and the ✕ both dismiss; motion slides the sheet in from
 * the right edge and back out on close, gated by reduced motion.
 *
 * It is bounded by the reading viewport rather than by the window — the box
 * between the header and the footer. Sized to the window it ran the full
 * height of the app and sat over both bars. Anchoring it here also means the
 * page keeps its own width: opening a panel never reflows the book.
 *
 * It is rendered *inside* that viewport, not portalled into one. A 对照阅读
 * pair has two viewports, and every portal-based answer to "which one" was a
 * bug waiting to happen: a lookup found the left book's, a host passed down
 * from the wrong pane found the other's. A drawer that is a child of its own
 * pane's viewport cannot land anywhere else — `absolute inset-0` resolves
 * against the box it was written in.
 */
export function ReaderDrawer({
  title,
  onClose,
  paired = false,
  children,
}: {
  title: string;
  onClose: () => void;
  /** True inside a 对照阅读 pane: the sheet then stays put instead of
   *  sliding, because a slide out of one pane lands on the other book. */
  paired?: boolean;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();

  // The ordinary reader slides its drawer in from the right edge — the pane's
  // right edge is the window's, so the travel is over its own paper. A pair
  // cannot do that: the same travel carries the sheet across the seam and over
  // the other book for the length of the animation, which reads as "the panel
  // jumped to the other book". There it shrinks and fades in place instead.
  const sheetMotion = paired
    ? {
        initial: reduce ? { opacity: 1 } : { opacity: 0, scale: 0.98 },
        animate: { opacity: 1, scale: 1 },
        exit: reduce ? { opacity: 1 } : { opacity: 0, scale: 0.98 },
      }
    : {
        initial: reduce ? { opacity: 1 } : { x: "110%" },
        animate: { x: 0, opacity: 1 },
        exit: reduce ? { opacity: 1 } : { x: "110%", opacity: 1 },
      };

  const sheet = (
    // Deliberately *not* `overflow: hidden`. Clipping here would turn the
    // aside into a scroll container, and a scroll container is exactly what
    // `scrollIntoView` reaches for: a panel centring its current row used to
    // drag the whole sheet sideways inside this box. It would also shear off
    // the card's own shadow (`0 30px 80px`), which needs more room than the
    // 12px of padding this box leaves it.
    <aside className="absolute inset-0 z-40">
      <motion.button
        type="button"
        aria-label="关闭面板"
        className="absolute inset-0 cursor-default bg-black/25"
        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduce ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: reduce ? 0 : DURATION.base }}
        onClick={onClose}
      />
      <motion.div
        // Two ceilings, and both bind on the same pane. `85vw` is the wide-pane
        // one: a sheet that stops short of the window's left edge leaves a
        // sliver of the book showing, so the reader keeps their place. `100%`
        // is the narrow one — a 520px window leaves this reader ~230px, and a
        // sheet wider than its own pane is clipped by the pane's
        // `overflow-hidden`, which cuts the sheet's left column (the layout
        // switcher among it) clean off and no scroll can bring it back. The
        // aside spans the reading viewport, so `100%` is exactly that pane —
        // including either half of a 对照阅读 pair.
        className="absolute inset-y-0 right-0 w-80 max-w-[min(85vw,100%)] p-3"
        initial={sheetMotion.initial}
        animate={sheetMotion.animate}
        exit={sheetMotion.exit}
        transition={SPRING.panel}
      >
        {/* `glass-liquid`, not `glass-solid`: this panel floats over the page the
            reader is looking at, and an opaque sheet was the one thing in the
            reader that ignored it. `shadow-panel` used to be listed here too —
            it was never a real utility (`--shadow-panel` lives on `:root`, not
            in `@theme`), and `glass-liquid` carries it.

            `--liquid-density` is raised because this is the one glass surface in
            the app that carries paragraphs: at the material's default 84% the
            book's own lines read *through* the panel and compete with its text
            (clearest on an error card, where the advice under the verdict is
            12px). Denser fill, same rim, sheen and blur — still a pane, no
            longer a transparency test. */}
        <div className="glass-liquid flex h-full flex-col rounded-2xl [--liquid-density:96%]">
          <div className="border-hairline flex items-center justify-between border-b px-4 py-3">
            <p className="text-text-1 text-sm font-medium">{title}</p>
            <button
              type="button"
              aria-label={`关闭${title}`}
              onClick={onClose}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors"
            >
              <X size={15} />
            </button>
          </div>
          {children}
        </div>
      </motion.div>
    </aside>
  );

  // Inline: the sheet is a child of the reading viewport it was written in, so
  // `absolute inset-0` covers exactly that pane. No portal, no host to get
  // wrong, and in a pair no way for one book's panel to paint over the other.
  return sheet;
}
