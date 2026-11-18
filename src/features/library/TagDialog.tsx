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
 * One book opens it as an editor and several as a manager, but both start from
 * the labels the reader can see and save only the difference against them. For
 * a multi-selection the starting set is the *union* of the books' tags — every
 * label on any selected book shows up ticked, so unticking one is an explicit
 * "remove this from the selection". A book that never carried it is a no-op on
 * the backend. Nothing is cleared that the sheet did not show.
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

  // Several books: open with the union of their tags, so every label present
  // on any selected book is ticked and can be unticked to remove it from the
  // whole selection. Books that never carried it are a no-op on the backend —
  // removing a tag from all is safe even when only one book had it. One book
  // keeps its whole set.
  const startTags = single
    ? single.tags
    : (books ?? []).reduce<string[]>((all, book) => {
        for (const name of book.tags) if (!includes(all, name)) all.push(name);
        return all;
      }, []);

  return (
    <GlassDialog
      open={books !== null && books.length > 0}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={single ? "标签" : "批量标签"}
      description={
        single
          ? `《${single.title}》的标签，可以随时改。`
          : `选中的 ${books?.length ?? 0} 本书已带标签默认勾选：取消勾选即从这些书中移除，新增勾选则加给全部。`
      }
      widthClass="w-[min(92vw,460px)]"
    >
      {/* Keyed by the book(s): each carries its own starting set, and a remount
          resets the selection to it without an effect — the same trick the
          command palette uses with `key={session}`. Without this, opening book
          B right after book A opened with A's tags still ticked. */}
      <TagDialogBody
        key={single?.id ?? (books ?? []).map((book) => book.id).join(",")}
        single={single}
        startTags={startTags}
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
  /** Tags the dialog opens ticked, and the only ones it may remove. */
  startTags: string[];
  allTags: TagSummary[];
  busy?: boolean;
  onCancel: () => void;
  onSave: (change: Change) => void;
}

function TagDialogBody({ single, startTags, allTags, busy, onCancel, onSave }: TagDialogBodyProps) {
  const known = allTags.map((tag) => tag.name);
  const [selected, setSelected] = useState<string[]>(() => [...startTags]);
  const [draft, setDraft] = useState("");

  const current = startTags;
  const add = selected.filter((name) => !includes(current, name));
  const remove = current.filter((name) => !includes(selected, name));
  const changed = add.length > 0 || remove.length > 0;

  const toggle = (name: string) =>
    setSelected((prev) =>
      includes(prev, name) ? prev.filter((n) => !same(n, name)) : [...prev, name],
    );

  // Enter picks the tag that is already there, or creates the one that is not.
  // Both keep focus and clear the field, so several tags can be entered in a
  // row without reaching for the mouse.
  const commitDraft = () => {
    const name = draft.trim().replace(/^#+/, "").trim();
    if (!name) return;
    const existing = known.find((candidate) => same(candidate, name));
    // Typing a name that exists selects it rather than adding a duplicate
    // spelling — the point of the field being a filter as well as a creator.
    const picking = existing ?? name;
    if (!includes(selected, picking)) setSelected((prev) => [...prev, picking]);
    setDraft("");
  };

  // Existing tags in the backend's order, then whatever was just invented.
  const candidates = [
    ...known,
    ...selected.filter((name) => !known.some((existing) => same(existing, name))),
  ];

  // What the field doubles as: a filter. With 273 tags in a library, scrolling
  // to find 心理学 is not a way to work — typing two characters is.
  const query = draft.trim().toLowerCase();
  const exact = candidates.some((name) => name.toLowerCase() === query);
  const visible = query
    ? candidates.filter((name) => name.toLowerCase().includes(query) || includes(selected, name))
    : candidates;
  // Selected first, so a long list never hides what is already ticked. Two
  // filters rather than a sort: `sort` mutates the array it was derived from,
  // and the next render reads `candidates` again.
  const shown = [
    ...visible.filter((name) => includes(selected, name)),
    ...visible.filter((name) => !includes(selected, name)),
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
        placeholder="搜索已有标签，或输入新词后回车创建"
        aria-label="新建标签"
        maxLength={MAX_TAG_CHARS}
        autoComplete="off"
      />

      {/* The chips scroll, the field and the buttons do not.
          
          A large library has hundreds of tags — 273 in the one this was
          reported on — and a `flex-wrap` block of them is taller than the
          window. The dialog is centred, so the overflow went off both ends and
          the labels past the fold were unreachable. Capping this box is the
          whole fix: everything below it stays where it is. */}
      <div className="mt-3 max-h-[46vh] min-h-[42px] overflow-y-auto pr-1">
        {candidates.length === 0 ? (
          <p className="text-text-3 text-xs">书架还没有标签。输入一个词，回车就能创建第一个。</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {shown.map((name) => {
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
            {/* Nothing matched: the way to make the word the reader typed. */}
            {query && !exact && (
              <button
                type="button"
                onClick={commitDraft}
                className="press focus-visible:focus-ring text-text-2 hover:text-text-1 flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs"
              >
                <span className="text-text-3">＋</span> 创建「{draft.trim()}」
              </button>
            )}
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
          {single ? "保存" : "应用"}
        </GlassButton>
      </div>
    </>
  );
}
