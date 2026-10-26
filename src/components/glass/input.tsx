import { forwardRef, type InputHTMLAttributes } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/cn";

interface GlassInputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** Glass input that reads as a single quiet band. */
export const GlassInput = forwardRef<HTMLInputElement, GlassInputProps>(function GlassInput(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        // The `glass` utility rather than a flat tint: on a page whose panels
        // and buttons are lit panes, a hairline-filled field reads as a hole
        // cut in them. `glass` brings its own 1px rim, so no `border` here.
        "glass h-9 w-full rounded-md px-3 text-sm",
        "text-text-1 placeholder:text-text-3 transition-colors",
        "focus-visible:border-accent focus-visible:bg-surface-2 focus-visible:outline-none",
        className,
      )}
      {...rest}
    />
  );
});

interface GlassSwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/** A quiet glass switch built on Radix for proper a11y semantics. */
export function GlassSwitch({
  checked,
  onCheckedChange,
  id,
  ariaLabel,
  disabled,
}: GlassSwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full",
        "border-hairline border transition-colors",
        "bg-surface-2 data-[state=checked]:bg-accent",
        "focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "bg-text-1 block h-5 w-5 translate-x-0.5 rounded-full",
          // Back-out bezier: the thumb overshoots slightly before settling,
          // reading as a physical toggle rather than a linear slide.
          "transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          "motion-reduce:transition-none",
          "data-[state=checked]:bg-on-accent data-[state=checked]:translate-x-[22px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
