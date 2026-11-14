/**
 * The pill the shelf's filter surfaces are made of.
 *
 * Shared rather than copied: the tag rail and the 筛选 panel sit on the same
 * page, and a hover or pressed state that differs between them reads as one of
 * the two being broken.
 */
export const CHIP =
  "press focus-visible:focus-ring flex h-8 items-center gap-1 rounded-full border px-3 text-xs";
export const CHIP_IDLE = "glass text-text-2 hover:bg-surface-2 hover:text-text-1 cursor-pointer";
export const CHIP_ON = "border-accent bg-accent-soft text-text-1";
