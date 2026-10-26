import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Check } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";

export interface SourceOption {
  id: string;
  name: string;
}

/**
 * Whether a picker is open right now.
 *
 * Radix's dialog listens for Escape on the document in the **capture** phase,
 * so it runs before any React handler could: a reader arrowing through the
 * source list would lose the whole dialog they were searching in, not just the
 * list. The dialog asks this first and stands down — see `GlassDialog`'s
 * `onEscapeKeyDown`. A count rather than a flag, because a dialog can hold
 * more than one of these and the last one out must not clear it for the others.
 */
let openPickers = 0;
export function sourcePickerOpen(): boolean {
  return openPickers > 0;
}

/**
 * Which source to search, as a combobox rather than an OS `<select>`.
 *
 * The native element wore the window's own rectangle — sharp corners, system
 * colours and a dropdown the app had no say in — inside a dialog whose every
 * other surface is rounded glass. It read as a control from another program
 * dropped into the middle of the shelf.
 *
 * So the picker is the app's own now: a trigger with the same rounded corners
 * as the result rows it sits above, opening a rounded panel of the same
 * material as the dialog, with the current source marked. Keyboard and
 * pointer both work — arrows move, Enter picks, Escape closes and hands the
 * focus back to the trigger, a press outside closes — because a picker that
 * only answers the mouse is a picker the keyboard user cannot leave.
 */
export function SourcePicker({
  sources,
  value,
  onChange,
}: {
  sources: SourceOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const m = useMotion();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Ties the trigger to the list it opens; see the combobox ARIA pattern. */
  const listboxId = useId();

  const active = sources.find((entry) => entry.id === value);

  // A press anywhere else is an answer: the reader looked away. Listened on
  // the document rather than blurred on the list, because focus moves to the
  // body on a press in the dialog's own padding, which is not a dismissal.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Held for the dialog's escape guard, which reads it while the key is still
  // travelling. See `sourcePickerOpen`.
  useEffect(() => {
    if (!open) return;
    openPickers += 1;
    return () => {
      openPickers -= 1;
    };
  }, [open]);

  // Opening lands the focus on the current source, so the arrows have
  // somewhere to start and Tab walks on from the list rather than the page.
  // Once per opening, and only once: a re-render while the list is up — the
  // sources refetching, a message arriving — would otherwise pull the focus
  // back to the current source in the middle of an arrow walk.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedOnce.current = false;
      return;
    }
    if (focusedOnce.current) return;
    focusedOnce.current = true;
    const index = sources.findIndex((entry) => entry.id === value);
    optionRefs.current[index === -1 ? 0 : index]?.focus();
  }, [open, sources, value]);

  const step = (from: number, direction: 1 | -1) => {
    if (sources.length === 0) return;
    const next = (from + direction + sources.length) % sources.length;
    optionRefs.current[next]?.focus();
  };

  if (sources.length === 0) {
    // Nothing to pick yet. The empty state below carries the way out, so this
    // is a statement of fact rather than a disabled control to poke at — and it
    // carries no label of its own: the words are the statement.
    return (
      <div className="glass text-text-3 flex h-9 min-w-0 flex-1 items-center rounded-xl border px-3 text-sm">
        还没有书源
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        // A button-based combobox is the point of this widget: the native
        // `<select>` the rule would have us use is the control being replaced,
        // and it cannot be given the dialog's material or its rounded panel.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label="选择书源"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "glass hover:bg-surface-2 flex h-9 w-full items-center justify-between gap-2 rounded-xl border px-3 text-sm transition-colors",
          "text-text-1 focus-visible:focus-ring",
        )}
      >
        <span className="truncate">{active?.name ?? "选择书源"}</span>
        <motion.span
          aria-hidden
          animate={{ rotate: open ? 180 : 0 }}
          transition={m.tap}
          className="text-text-3 inline-flex shrink-0"
        >
          <CaretDown size={14} />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            id={listboxId}
            // The same replacement as the trigger above: a list of buttons in
            // a rounded panel, not a `<select>`'s system-drawn menu.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="listbox"
            aria-label="书源"
            initial={{ opacity: 0, y: m.reduce ? 0 : -4, scale: m.reduce ? 1 : 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : -4, scale: m.reduce ? 1 : 0.98 }}
            transition={m.panel}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const current = optionRefs.current.findIndex((el) => el === document.activeElement);
                step(current === -1 ? 0 : current, event.key === "ArrowDown" ? 1 : -1);
              }
            }}
            className="glass-2 shadow-panel border-hairline absolute top-full right-0 left-0 z-10 mt-1.5 max-h-52 overflow-y-auto rounded-2xl border p-1"
          >
            {sources.map((entry, index) => {
              const selected = entry.id === value;
              return (
                <li key={entry.id} role="presentation">
                  <button
                    type="button"
                    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                    role="option"
                    aria-selected={selected}
                    ref={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    onClick={() => {
                      onChange(entry.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "press focus-visible:focus-ring flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-[13px]",
                      selected
                        ? "bg-accent-soft text-text-1"
                        : "text-text-2 hover:text-text-1 hover:bg-surface-1",
                    )}
                  >
                    <span className="truncate">{entry.name}</span>
                    {selected && <Check size={14} className="text-accent shrink-0" />}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
