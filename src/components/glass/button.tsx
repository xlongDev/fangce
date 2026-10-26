import { forwardRef, type ReactNode } from "react";
import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";

type Variant = "primary" | "ghost" | "glass" | "subtle";
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
  ghost: "bg-surface-1 text-text-1 border-hairline hover:bg-surface-2",
  // The `glass` utility, not a fill: specular sweep, lit rim, inset top/bottom
  // edges and the panel shadow. `ghost` is a flat tint with a hairline, which
  // reads as a chip when it sits next to a real pane — the sidebar footer had
  // a `glass` pill above a row of `ghost` buttons and the row looked cut out
  // of the paper rather than resting on it.
  glass: "glass text-text-1 hover:bg-surface-2",
  subtle: "bg-transparent text-text-2 border-transparent hover:bg-surface-1 hover:text-text-1",
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
  /** Defaults to `ghost`. Pass `glass` where the button sits beside a real
   *  pane and a flat tint would read as a hole in it. */
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
