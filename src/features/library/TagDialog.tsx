import { useState } from "react";
import { Check } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import type { BookSummary, TagSummary } from "@/types/ipc";

/**
 * The label sheet.
 *
 * One book opens it as an editor: the chips start on what the book carries and
 * saving applies the difference. Several books open it as an adder — there is
 * no single "current" set to show, and clearing a label the reader never saw
 * would be a surprise, so a multi-selection can only attach.
 *
 * Typing creates a tag; the chip appears in the same list, dashed, so "will be
 * created" and "already exists" are distinguishable before saving.
 */

type Change = { add: string[]; remove: string[] };

/** Longest tag the backend accepts; mirrored so the field stops before it. */
const MAX_TAG_CHARS = 40;

interface TagDialogProps {
  /** Books being labelled; `null` or empty keeps the dialog closed. */
  books: BookSummary[] | null;
  /** Every tag in use, for the suggestion list. */
  allTags: TagSummary[];
  busy?: boolean;
  onCancel: () => void;
  onSave: (change: Change) => void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const includes = (names: string[], name: string) => names.some((other) => same(other, name));

export function TagDialog({ books, allTags, busy, onCancel, onSave }: TagDialogProps) {
  const single: BookSummary | null = books?.length === 1 ? (books[0] ?? null) : null;

  return (
    <GlassDialog
      open={books !== null && books.length > 0}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={single ? "标签" : "添加标签"}
      description={
        single
          ? `《${single.title}》的标签，可以随时改。`
          : `为选中的 ${books?.length ?? 0} 本书添加标签，它们原有的标签不受影响。`
      }
      widthClass="w-[min(92vw,460px)]"
    >
      {/* Keyed by the book: each one carries its own starting set, and a
          remount resets the selection to it without an effect — the same trick
          the command palette uses with `key={session}`. Without this, opening
          book B right after book A opened with A's tags still ticked. */}
      <TagDialogBody
        key={single?.id ?? "multi"}
        single={single}
        allTags={allTags}
        busy={busy}
        onCancel={onCancel}
        onSave={onSave}
      />
    </GlassDialog>
  );
}

interface TagDialogBodyProps {
  single: BookSummary | null;
  allTags: TagSummary[];
  busy?: boolean;
  onCancel: () => void;
  onSave: (change: Change) => void;
}

function TagDialogBody({ single, allTags, busy, onCancel, onSave }: TagDialogBodyProps) {
  const known = allTags.map((tag) => tag.name);
  const [selected, setSelected] = useState<string[]>(() => (single ? [...single.tags] : []));
  const [draft, setDraft] = useState("");

  const current = single?.tags ?? [];
  const add = selected.filter((name) => !includes(current, name));
  const remove = single ? current.filter((name) => !includes(selected, name)) : [];
  const changed = add.length > 0 || remove.length > 0;

  const toggle = (name: string) =>
    setSelected((prev) =>
      includes(prev, name) ? prev.filter((n) => !same(n, name)) : [...prev, name],
    );

  // Enter commits the draft and keeps focus, so several tags can be typed in a
  // row without reaching for the mouse.
  const commitDraft = () => {
    const name = draft.trim().replace(/^#+/, "").trim();
    if (!name) return;
    if (!includes(selected, name)) setSelected((prev) => [...prev, name]);
    setDraft("");
  };

  // Existing tags in the backend's order, then whatever was just invented.
  const candidates = [
    ...known,
    ...selected.filter((name) => !known.some((existing) => same(existing, name))),
  ];

  return (
    <>
      <GlassInput
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Enter would otherwise submit a surrounding form or blur the field.
          event.preventDefault();
          commitDraft();
        }}
        placeholder="输入标签后回车创建"
        aria-label="新建标签"
        maxLength={MAX_TAG_CHARS}
        autoComplete="off"
      />

      <div className="mt-3 min-h-[42px]">
        {candidates.length === 0 ? (
          <p className="text-text-3 text-xs">书架还没有标签。输入一个词，回车就能创建第一个。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {candidates.map((name) => {
              const on = includes(selected, name);
              const fresh = !includes(known, name);
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(name)}
                  className={cn(
                    "press focus-visible:focus-ring flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
                    on
                      ? "border-accent bg-accent-soft text-text-1"
                      : "glass text-text-2 hover:bg-surface-2 hover:text-text-1",
                    fresh && !on && "border-dashed",
                  )}
                >
                  {/* A tick, not only a tint: the selected state must not rely
                      on colour alone. */}
                  {on ? (
                    <Check size={11} weight="bold" className="text-accent" />
                  ) : (
                    <span className="text-text-3">#</span>
                  )}
                  {name}
                  {fresh && on && <span className="text-text-3">· 新</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="primary"
          onClick={() => onSave({ add, remove })}
          disabled={busy || !changed}
        >
          {single ? "保存" : "添加"}
        </GlassButton>
      </div>
    </>
  );
}
