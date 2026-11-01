import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { CaretDown } from "@phosphor-icons/react";

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

/** A glass `<select>` that matches [`GlassInput`] on the same row.
 *
 *  Native, not a listbox of our own: the OS draws the popup, which is what
 *  keyboard users and screen readers already know how to drive, and a fourteen
 *  entry provider list is exactly where a custom menu starts costing more than
 *  it returns. The caret is ours because the native one does not sit still
 *  across platforms.
 */
export const GlassSelect = forwardRef<HTMLSelectElement, GlassSelectProps>(function GlassSelect(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className="glass focus-within:focus-ring relative flex h-9 w-full min-w-0 items-center rounded-md">
      <select
        ref={ref}
        className={cn(
          "text-text-1 h-full w-full appearance-none truncate bg-transparent pr-8 pl-3 text-sm outline-none",
          // The popup is painted by the OS, so the glass theme's light-on-dark
          // ink would be unreadable on it.
          "[&>option]:text-black",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <CaretDown
        size={12}
        className="text-text-3 pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
      />
    </div>
  );
});

interface GlassSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

/** A native range input, tinted with the accent. */
export function GlassRange({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="range"
      className={cn(
        "accent-accent h-9 w-full cursor-pointer bg-transparent",
        "focus-visible:focus-ring rounded",
        className,
      )}
      {...rest}
    />
  );
}

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
