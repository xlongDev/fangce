import type { ReactNode } from "react";

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
  return (
    <Row label={label} hint={hint}>
      <div className="flex w-full items-center gap-2">
        <GlassInput
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
          className="text-right tabular-nums"
        />
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
