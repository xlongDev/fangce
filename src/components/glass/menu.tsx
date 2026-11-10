import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

/**
 * A trigger and the glass panel it opens.
 *
 * The shape is the header's 简繁转换 menu (ReaderChrome): a relative wrapper, a
 * capture-phase `pointerdown` that closes on an outside click, Escape to close.
 * Written once here the second time it was needed — two copies of that listener
 * bookkeeping drift, and a menu that stays open over the drawer behind it is the
 * first thing to drift.
 *
 * The panel closes itself when a row is picked, through {@link MenuClose}: a row
 * that leaves the panel floating over the thing it just acted on reads as a
 * click that did nothing.
 */
export function GlassMenu({
  label,
  trigger,
  align = "right",
  placement = "down",
  widthClass = "w-56",
  panelClassName = "glass backdrop-blur-xl",
  children,
}: {
  /** Names the panel for assistive tech. */
  label: string;
  /** The button itself — it keeps its own icon, label and pressed styling. */
  trigger: ReactElement;
  /** Which edge the panel hangs from. */
  align?: "left" | "right";
  placement?: "down" | "up";
  /** The panel's width. A row of labels fits `w-56`; a panel of chips does
   *  not, and stretching it from inside would fight this element's own. */
  widthClass?: string;
  /** Overrides the panel's material. Defaults to `glass`, which is the right
   *  elevation when the panel opens over another pane (the reader's header,
   *  the AI drawer). A panel that floats over *content* — a grid of covers —
   *  needs a material that does not let that content read through the text,
   *  and that is a decision only the caller can make. */
  panelClassName?: string;
  /** Rows, normally a list of {@link GlassMenuItem}. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // The trigger's own click stays where it is: a trigger that does something
  // besides open (the reader's 简繁转换 button toggles a mode) must not lose it.
  const element = trigger as ReactElement<TriggerProps>;
  const button = cloneElement(element, {
    onClick: (event: MouseEvent<HTMLElement>) => {
      element.props.onClick?.(event);
      setOpen((value) => !value);
    },
    "aria-expanded": open,
  });

  return (
    <span ref={rootRef} className="relative inline-flex">
      {button}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            "shadow-glass absolute z-50 rounded-[14px] border p-1.5",
            panelClassName,
            widthClass,
            align === "right" ? "right-0" : "left-0",
            placement === "up" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]",
          )}
        >
          <MenuClose.Provider value={close}>{children}</MenuClose.Provider>
        </div>
      )}
    </span>
  );
}

/** How a row closes the panel it lives in. */
const MenuClose = createContext<() => void>(() => {});

/** The two props this component has to write into a trigger it did not build. */
type TriggerProps = {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  "aria-expanded"?: boolean;
};

/**
 * One row in a {@link GlassMenu}.
 *
 * `tone="danger"` is for the rows that delete something — the same colour the
 * rest of the app uses for that.
 */
export function GlassMenuItem({
  icon,
  label,
  tone = "normal",
  disabled = false,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  tone?: "normal" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClick();
        close();
      }}
      className={cn(
        "focus-visible:focus-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40",
        tone === "danger"
          ? "text-danger hover:bg-surface-2"
          : "text-text-2 hover:text-text-1 hover:bg-surface-2",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
