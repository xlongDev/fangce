import type { ReactNode } from "react";
import {
  Archive,
  ArrowsClockwise,
  BookOpenText,
  CloudArrowUp,
  type Icon,
  Info,
  Keyboard,
  Palette,
  Sparkle,
  TextAa,
} from "@phosphor-icons/react";
import { motion } from "motion/react";

import { GlassCard } from "@/components/glass/panel";
import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";

/**
 * The settings page's own furniture, in a file of its own.
 *
 * These are what every group is made of — the rail's table of contents, the
 * card, the labelled row — and the page had grown past the point where adding
 * another group to it was reasonable. Nothing here knows about any particular
 * setting; a group that wants a new one imports the rows.
 */
export const SECTIONS = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "keys", label: "快捷键", icon: Keyboard },
  { id: "ai", label: "AI 助手", icon: Sparkle },
  { id: "dictionary", label: "词典", icon: BookOpenText },
  { id: "fonts", label: "字体", icon: TextAa },
  { id: "sync", label: "同步", icon: CloudArrowUp },
  { id: "backup", label: "备份", icon: Archive },
  { id: "reset", label: "重置", icon: ArrowsClockwise },
  { id: "about", label: "关于", icon: Info },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * One group of settings. The material is a nested card rather than a second
 * top-level panel: a panel inside the shell's own panel would double the blur
 * for no extra hierarchy, while elevation 1 (tint + rim, no blur) reads as a
 * group sitting on the pane.
 */
export function SettingsGroup({
  id,
  anchor,
  icon: Icon,
  title,
  description,
  badge,
  children,
}: {
  /** The rail entry this group belongs to. Several groups may share one — the
   *  AI section is three, and the rail still has a single "AI 助手" row. */
  id: SectionId;
  /** DOM id and `data-section` value. Defaults to `id`; a second group under the
   *  same rail entry needs its own so the ids stay unique. The rail always finds
   *  the *first* element carrying the section id, which is the group a jump
   *  should land on. */
  anchor?: string;
  icon: Icon;
  title: string;
  description?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const m = useMotion();
  const key = anchor ?? id;
  return (
    // The groups rise together rather than in sequence: the route cross-fade
    // already owns the page's arrival, and a staggered form is decoration —
    // the stagger earns its keep on the shelf grid, where it follows content.
    <motion.section
      id={`settings-${key}`}
      data-section={key}
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={m.enter}
    >
      <GlassCard className="overflow-hidden p-0">
        <div className="flex items-center gap-3 px-5 py-4">
          {/* Hairline-bordered rather than a plain tint: in the light theme a
              surface-only chip on a white card is invisible. */}
          <span className="bg-surface-2 text-text-2 border-hairline flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
            <Icon size={16} weight="duotone" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-text-1 text-sm font-semibold">{title}</h2>
            {description && (
              <p className="text-text-3 mt-0.5 text-[12.5px] leading-relaxed">{description}</p>
            )}
          </div>
          {badge}
        </div>
        <div className="divide-hairline border-hairline divide-y border-t">{children}</div>
      </GlassCard>
    </motion.section>
  );
}

/**
 * One settings row: what it is on the left, the control on the right. The two
 * columns keep every control on one vertical line down the page, which a stack
 * of label-above-input blocks never manages.
 */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-3 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] sm:items-start sm:gap-6">
      <div className="min-w-0">
        <p className="text-text-1 text-[13.5px] font-medium">{label}</p>
        {hint && <p className="text-text-3 mt-1 text-[12px] leading-relaxed">{hint}</p>}
      </div>
      <div className="flex min-w-0 items-center sm:justify-end">{children}</div>
    </div>
  );
}

/** The row a group's actions live on, so buttons never float free of the rows. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 px-5 py-3.5">{children}</div>;
}

/** The line beside an action button, and whether it is bad news. */
export function Feedback({ status }: { status: { tone: "ok" | "bad"; text: string } | null }) {
  if (!status) return null;
  return (
    <output
      className={cn(
        "text-[12.5px] leading-relaxed",
        status.tone === "ok" ? "text-text-3" : "text-danger",
      )}
    >
      {status.text}
    </output>
  );
}

/** The "there are changes the backend has not seen" chip. */
export function Unsaved({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return (
    <span className="bg-accent-soft text-accent shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
      未保存
    </span>
  );
}
