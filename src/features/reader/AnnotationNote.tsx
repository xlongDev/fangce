import { useEffect, useRef, useState } from "react";
import { Check, Eraser, NotePencil } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";

/**
 * The reader's own note hanging off a highlight.
 *
 * Display only. The field is `NoteEditor`, mounted by whoever decided that a
 * note is being written — which is what lets a row carry its own 编辑 button.
 * While the open/closed state lived in here, nothing outside could open it and
 * the only way in was clicking the note text itself, which is not something a
 * reader can be expected to discover.
 */
export function AnnotationNote({
  note,
  disabled,
  onEdit,
}: {
  /** The saved note, or `null` when there is none. */
  note: string | null;
  /** True while an edit is already in flight for this list. */
  disabled?: boolean;
  /** Opens the editor. */
  onEdit: () => void;
}) {
  if (note === null) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onEdit}
        className="focus-visible:focus-ring text-text-3 hover:text-text-1 inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:opacity-50"
      >
        <NotePencil size={12} />
        添加笔记
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onEdit}
      title="点击编辑笔记"
      className="focus-visible:focus-ring border-hairline text-text-2 hover:text-text-1 block w-full border-l pl-2.5 text-left text-[12.5px] leading-relaxed whitespace-pre-wrap transition-colors disabled:opacity-50"
    >
      {note}
    </button>
  );
}

/**
 * The note field, mounted only while a note is being written.
 *
 * The draft is owned here and starts from `value`, which is why the parent
 * mounts this instead of flipping a prop on something already on screen: a
 * mount is the one moment a component may read a prop into state, and a fresh
 * mount is exactly what "start writing" means. Nothing has to be kept in sync
 * afterwards, because nothing else can change the draft.
 *
 * Committing compares against the saved note, so opening one and closing it
 * again costs no round trip, and emptying the field clears the note instead of
 * storing an empty string (the backend folds blanks to `NULL`, so "has a note"
 * stays a single test).
 */
export function NoteEditor({
  value,
  disabled,
  onSave,
  onCancel,
}: {
  /** The saved note, or `null` when there is none. */
  value: string | null;
  disabled?: boolean;
  /** Receives the trimmed note — `null` to clear — and only when it changed. */
  onSave: (note: string | null) => void;
  /** Closes without writing: Escape, or a draft that still says what is saved. */
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  // Escape rewinds and closes; this keeps the blur that closing triggers from
  // committing the draft it just threw away.
  const rewound = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);

  // Focus the field as it appears. The reader asked for it by clicking, so the
  // caret should already be in it — but not through `autoFocus`, which the a11y
  // rule bans for the page-load case it cannot tell this apart from.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    // ...and *at the end* of what is already there, not at index 0. A focused
    // textarea keeps the selection React gave it, which on a fresh mount is
    // the start — so editing an existing note typed backwards through it, and
    // the reader had to arrow to the end before writing a word.
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const commit = () => {
    const next = draft.trim();
    if (next === (value ?? "").trim()) onCancel();
    else onSave(next === "" ? null : next);
  };

  const changed = draft.trim() !== (value ?? "").trim();

  return (
    // The same mousedown guard the selection toolbar's panel carries, for the
    // same reason: WebKit does not focus a button on press, so pressing one of
    // these blurred the field, the blur committed and unmounted the editor,
    // and the click landed on nothing — 保存 and 清空 both read as dead.
    // Holding focus where it is makes WebKit and Chromium agree, and the blur
    // still commits when the reader leaves for somewhere else entirely.
    <div className="flex flex-col gap-1">
      <textarea
        ref={field}
        aria-label="标注笔记"
        rows={2}
        value={draft}
        disabled={disabled}
        placeholder="写下你的想法"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (rewound.current) {
            rewound.current = false;
            onCancel();
            return;
          }
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            rewound.current = true;
            event.currentTarget.blur();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.currentTarget.blur();
          }
        }}
        className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 w-full resize-none rounded-md border px-2.5 py-2 text-[12.5px] leading-relaxed transition-colors focus-visible:outline-none"
      />
      {/* The strip is what makes the field manageable without leaving it:
          blur commits, but a reader who came here to add one line should be
          able to say so, and emptying the field is the way to drop a note
          that is already saved. */}
      <div className="flex items-center gap-0.5">
        <NoteAction
          label="保存笔记"
          text="保存"
          // Nothing to write while the field still says what is saved.
          disabled={disabled || !changed}
          onClick={commit}
        >
          <Check size={14} />
        </NoteAction>
        <NoteAction
          label="清空输入"
          text="清空"
          disabled={disabled || draft === ""}
          onClick={() => setDraft("")}
        >
          <Eraser size={14} />
        </NoteAction>
        <span className="text-text-3 ml-auto pr-1 text-[11px]">⌘↵ 保存 · Esc 取消</span>
      </div>
    </div>
  );
}

/**
 * One button on a note field's action strip.
 *
 * `label` names the action for assistive tech and the tooltip; `text` is the
 * short form on the button. They are separate because the names have to
 * disambiguate — 删除笔记 against the toolbar's 取消标注 — while the strip only
 * has room for the verb.
 *
 * Shared by the reader's own note and the selection toolbar's, so a note is
 * finished the same way wherever it is written.
 *
 * Module scope rather than declared in the render: a component defined inside
 * another gets a fresh identity every render, which both oxlint and the React
 * Compiler reject.
 */
export function NoteAction({
  label,
  text,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  text: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      // Hold focus where it is, rather than letting the press move it off the
      // field and blur it: WebKit does not focus a button on mousedown, while
      // Chromium does, so without this the blur commits and unmounts the
      // editor before the click lands — 保存 and 清空 read as dead buttons on
      // the platform this ships on. `focus-visible` is for the keyboard,
      // which arrives by Tab and never through here.
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "press focus-visible:focus-ring flex h-7 items-center gap-1 rounded-lg px-2 text-[11.5px] transition-colors",
        "text-text-2 hover:text-text-1 hover:bg-(--glass-btn)",
        danger && "hover:text-red-400",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
      <span>{text}</span>
    </button>
  );
}

/**
 * The two halves, wired together: one row's note, in whichever state it is in.
 *
 * Controlled rather than holding the flag itself, because a row's 编辑 button
 * is the second way into the editor and a component's own state has no second
 * entrance — pushing it in from outside would mean syncing a prop into state,
 * which this codebase does not do. The caller keeps one boolean; the draft
 * still lives in `NoteEditor`, which unmounts when the flag goes false.
 */
export function NoteCell({
  note,
  disabled,
  editing,
  onEditingChange,
  onSave,
}: {
  note: string | null;
  disabled?: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (note: string | null) => void;
}) {
  if (!editing) {
    return <AnnotationNote note={note} disabled={disabled} onEdit={() => onEditingChange(true)} />;
  }
  return (
    <NoteEditor
      value={note}
      disabled={disabled}
      onSave={(next) => {
        onEditingChange(false);
        onSave(next);
      }}
      onCancel={() => onEditingChange(false)}
    />
  );
}
