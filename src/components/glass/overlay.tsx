import { useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/lib/cn";
import { DURATION, useMotion } from "@/lib/motion";

/**
 * The shell's overlay host (see `AppShell`). Resolved lazily and re-resolved
 * while it is missing — a page mounts before the shell's own commit has landed
 * the host, but long before anything needs to portal into it.
 */
let overlayHostEl: HTMLElement | null = null;
export function overlayHost(): HTMLElement | null {
  if (!overlayHostEl?.isConnected) {
    overlayHostEl = document.querySelector<HTMLElement>("[data-overlay-host]");
  }
  return overlayHostEl;
}

/**
 * Renders floating UI into the shell rather than where it is declared.
 *
 * A `backdrop-filter` — the one the glass pane wears for its material — makes
 * its element the containing block for `position: fixed` descendants, and the
 * pane is `overflow: hidden` on top of that. A `fixed` overlay left inside a
 * page is therefore positioned from the pane's own origin instead of the
 * window's (off by the sidebar and the title bar) and then sliced at the
 * pane's edge. The host sits in the shell, where `fixed` means the window
 * again, and it inherits the same `data-theme` and reading-surface tokens the
 * pages do.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const host = overlayHost();
  return host ? createPortal(children, host) : children;
}

interface GlassDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Tailwind width class, defaults to a comfortable palette width. */
  widthClass?: string;
  /**
   * Runs before the dialog acts on Escape, and can stand it down with
   * `preventDefault`.
   *
   * Radix listens for the key on the document in the capture phase, so
   * anything inside the content that wants Escape for itself — a list closing,
   * a picker folding away — cannot catch it in React: by the time a handler
   * runs, the dialog has already decided to close. This is the one hook that
   * runs early enough to say otherwise.
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

/** Modal surface with Radix focus management and a motion-aware entry. */
export function GlassDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  widthClass = "w-[min(92vw,640px)]",
  onEscapeKeyDown,
}: GlassDialogProps) {
  const m = useMotion();

  /**
   * Centre on the content pane, not on the window.
   *
   * The sidebar pushes the pane right of the window's centre — measured on a
   * 1280px window: pane centre 770 against the window's 640, so a
   * window-centred dialog sat 130px left of the thing it was covering and read
   * as off-centre to anyone looking at the shelf. The batch-manage bar was
   * re-anchored for the same reason; this is that fix generalised, so every
   * dialog agrees with the bar instead of only the import one.
   *
   * Only the horizontal is written. Vertical centring is already the pane's,
   * because the pane is the full height of the window.
   *
   * **A custom property on the root rather than an inline style on the
   * element.** The obvious version held a `ref` to the dialog and wrote
   * `style.left` — but `Dialog.Content asChild` composes the child's ref, and
   * with React 19's `ref`-as-a-prop that composition comes back null: the
   * effect ran, the pane was found, and the element was `null`, so nothing was
   * ever written. A property on `documentElement` needs no ref at all.
   *
   * **The property is deliberately not cleared on close.** This cleanup runs
   * when `open` flips false, which is when the exit animation *starts* — and
   * `left` falling back to `50%` mid-exit would slide the dialog across the
   * window as it faded. It is cleared only when a dialog finds no pane, which
   * is what makes it self-correcting rather than sticky.
   *
   * The listener is for a window resize, a real gesture while a dialog is open.
   * The sidebar needs no watching: the scrim is modal, so it cannot be toggled
   * out from under an open dialog.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const place = () => {
      const pane = document.querySelector<HTMLElement>("[data-content-pane]");
      if (!pane) {
        root.style.removeProperty("--dialog-centre");
        return;
      }
      const box = pane.getBoundingClientRect();
      root.style.setProperty("--dialog-centre", `${box.left + box.width / 2}px`);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                // Named for `useShelfSelection`'s empty-space exit: a press on
                // a scrim is a dismissal of the dialog above, not of the mode
                // underneath it.
                data-dialog-overlay
                className="backdrop-glass fixed inset-0 z-50 bg-black/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: m.reduce ? 0 : DURATION.base }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount onEscapeKeyDown={onEscapeKeyDown}>
              <motion.div
                className={cn(
                  // `left` reads the pane's centre, falling back to the
                  // window's for a dialog opened where there is no pane.
                  "fixed top-1/2 left-[var(--dialog-centre,50%)] z-50 -translate-x-1/2 -translate-y-1/2",
                  widthClass,
                  "glass-2 shadow-panel rounded-2xl p-5 outline-none",
                )}
                initial={{ opacity: 0, scale: m.reduce ? 1 : 0.96, y: m.reduce ? 0 : 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: m.reduce ? 1 : 0.98 }}
                transition={m.panel}
              >
                {title && (
                  <Dialog.Title className="text-text-1 mb-1 text-base font-semibold">
                    {title}
                  </Dialog.Title>
                )}
                {description && (
                  <Dialog.Description className="text-text-2 mb-4 text-sm">
                    {description}
                  </Dialog.Description>
                )}
                {children}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
