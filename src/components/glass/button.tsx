import { forwardRef, type ReactNode } from "react";
import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";

type Variant = "primary" | "ghost" | "subtle";
type Size = "sm" | "md" | "lg";

// `motion` overrides a few DOM events (`onAnimationStart`, `onDrag*`), so the
// props come from `HTMLMotionProps` instead of `ButtonHTMLAttributes`.
interface GlassButtonProps extends Omit<HTMLMotionProps<"button">, "ref" | "children"> {
  variant?: Variant;
  size?: Size;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-on-accent border-transparent shadow-glass",
  // `glass` is the default now. Every surface in this app is a lit pane, so a
  // flat `bg-surface-1 + border-hairline` fill reads as a hole cut in one —
  // the sidebar footer, the shelf toolbar and the header buttons each had to
  // be converted by hand before this was the default, and there were always
  // more of them.
  ghost: "glass text-text-1 hover:bg-surface-2",
  // `subtle` was transparent on purpose: a button inside a row should not
  // become a second object on it. The reader overruled that — the settings
  // panel and both TTS surfaces are rows of controls that read as text
  // without a material under them. It keeps the lighter ink so a row of them
  // still has a hierarchy against the primary action beside it.
  subtle: "glass text-text-2 hover:bg-surface-2 hover:text-text-1",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] rounded-md",
  md: "h-9 px-4 text-sm rounded-md",
  lg: "h-11 px-5 text-[15px] rounded-lg",
};

/** Pill-shaped glass button. Use `motion` for tap feedback, gated by reduced motion. */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  {
    variant = "ghost",
    size = "md",
    leading,
    trailing,
    className,
    children,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const m = useMotion();
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      whileTap={disabled || m.reduce ? undefined : { scale: 0.94 }}
      transition={m.tap}
      className={cn(
        // `whitespace-nowrap` is load-bearing, not cosmetic: a button sits in a
        // flex line next to a `GlassInput` (or a `w-full` sibling), and without
        // it a squeezed button breaks its CJK label onto stacked lines — `h-*`
        // pins the height, so it reads as deformed rather than merely small.
        // `nowrap` also makes min-content == full label width, so `min-width:
        // auto` stops the flex squeeze from ever getting that far.
        "inline-flex items-center justify-center gap-2 border font-medium whitespace-nowrap",
        "focus-visible:focus-ring transition-colors disabled:pointer-events-none disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </motion.button>
  );
});

interface GlassIconButtonProps extends Omit<HTMLMotionProps<"button">, "ref" | "children"> {
  /** Required for a11y; the visible content is decorative. */
  label: string;
  size?: Size;
  /** Defaults to `ghost`, which is now the glass material. Only worth passing
   *  for `primary` (a solid accent action) or `subtle` (a button inside a row
   *  that should stay flat). */
  variant?: Variant;
  children?: ReactNode;
}

const ICON_SIZE: Record<Size, string> = {
  sm: "h-8 w-8 rounded-md",
  md: "h-9 w-9 rounded-md",
  lg: "h-11 w-11 rounded-lg",
};

/** Square glass button for icon glyphs. Always provides an `aria-label`. */
export const GlassIconButton = forwardRef<HTMLButtonElement, GlassIconButtonProps>(
  function GlassIconButton(
    { label, size = "md", variant = "ghost", className, children, type = "button", ...rest },
    ref,
  ) {
    return (
      <GlassButton
        ref={ref}
        type={type}
        variant={variant}
        aria-label={label}
        className={cn(ICON_SIZE[size], "px-0", className)}
        {...rest}
      >
        {children}
      </GlassButton>
    );
  },
);
