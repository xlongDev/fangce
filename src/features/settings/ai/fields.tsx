import { useRef, type ReactNode } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";

import { GlassInput, GlassSwitch } from "@/components/glass/input";
import { Row } from "@/features/settings/section";
import type { AiConfigFull } from "@/lib/aiConfig";

/** Writes one field of the draft. */
export type Setter = <K extends keyof AiConfigFull>(key: K, value: AiConfigFull[K]) => void;

/**
 * A whole-number row.
 *
 * Typing is not validated as it happens — a field that refuses "4" on the way to
 * "4096" is a field that fights the reader. The value is parsed when it is a
 * number and the backend clamps it on save, so the only thing this can produce
 * is a number that is too big, which the clamp turns into the maximum.
 */
export function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // stepUp/stepDown keep the browser's step arithmetic: money rows use
  // step=0.01, where `value + step` drifts (0.01 → 0.020000000000000004).
  const nudge = (direction: 1 | -1) => {
    const input = inputRef.current;
    if (!input) return;
    if (direction === 1) input.stepUp();
    else input.stepDown();
    const next = input.valueAsNumber;
    if (Number.isFinite(next)) onChange(next);
  };

  return (
    <Row label={label} hint={hint}>
      <div className="flex w-full items-center gap-2">
        <div className="relative w-full">
          <GlassInput
            ref={inputRef}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(value) ? value : ""}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange(next);
            }}
            aria-label={label}
            className="no-spinner pr-9 text-right tabular-nums"
          />
          {/* Native spinner is theme-painted and sits inside the padding, so it
              can neither match `data-theme` nor be spaced from the value. A
              glass stepper in the same band fixes both. */}
          <div className="absolute inset-y-1 right-1 flex w-6 flex-col items-center justify-center gap-0.5">
            <button
              type="button"
              aria-label={`增加${label}`}
              onClick={() => nudge(1)}
              className="glass text-text-3 hover:text-text-1 focus-visible:focus-ring flex h-3.5 w-5 shrink-0 items-center justify-center rounded-[5px] transition-colors"
            >
              <CaretUp size={9} weight="bold" />
            </button>
            <button
              type="button"
              aria-label={`减少${label}`}
              onClick={() => nudge(-1)}
              className="glass text-text-3 hover:text-text-1 focus-visible:focus-ring flex h-3.5 w-5 shrink-0 items-center justify-center rounded-[5px] transition-colors"
            >
              <CaretDown size={9} weight="bold" />
            </button>
          </div>
        </div>
        {suffix ? <span className="text-text-3 shrink-0 text-xs">{suffix}</span> : null}
      </div>
    </Row>
  );
}

/** A boolean row, switch on the right. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <GlassSwitch checked={checked} onCheckedChange={onChange} ariaLabel={label} />
    </Row>
  );
}

/** A labelled block that is not a two-column row — a textarea or a list. */
export function Block({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text-1 text-[13.5px] font-medium">{title}</p>
          {hint && <p className="text-text-3 mt-1 text-[12px] leading-relaxed">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
