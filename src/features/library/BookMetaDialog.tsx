import { useState, type ReactNode } from "react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import type { BookMetadataPatch, BookSummary } from "@/types/ipc";

/**
 * The metadata sheet: everything the shelf prints about a book that the file
 * itself got wrong — a scanned PDF with no title, a bad author split, a
 * description the reader wants to write themselves.
 *
 * Only these fields are editable. The reading position, the annotations and the
 * file on disk are not the sheet's business: editing metadata must never be a
 * way to lose a bookmark. Clearing a field is meaningful (it goes back to
 * "unknown"), so the save button follows the *content*, not the keystrokes.
 */

/** Field ceilings, mirroring what the backend stores without truncating. */
const LIMITS = { title: 300, subtitle: 300, publisher: 200, language: 40, description: 4000 };

interface BookMetaDialogProps {
  /** `null` keeps the sheet closed. */
  book: BookSummary | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: (patch: BookMetadataPatch) => void;
}

export function BookMetaDialog({ book, busy, onCancel, onSave }: BookMetaDialogProps) {
  return (
    <GlassDialog
      open={book !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="书籍信息"
      description={book ? `《${book.title}》` : undefined}
      widthClass="w-[min(92vw,480px)]"
    >
      {/* Keyed by the book: the form starts from that book's values, and a
          remount resets it without an effect — opening B right after A must not
          inherit A's half-typed title. */}
      {book && (
        <BookMetaForm key={book.id} book={book} busy={busy} onCancel={onCancel} onSave={onSave} />
      )}
    </GlassDialog>
  );
}

interface BookMetaFormProps {
  book: BookSummary;
  busy?: boolean;
  onCancel: () => void;
  onSave: (patch: BookMetadataPatch) => void;
}

/** One empty field is "unknown", not a deliberate blank, so the form sends
 * `null` for those and the shelf prints nothing there. */
const blank = (value: string) => {
  const text = value.trim();
  return text.length > 0 ? text : null;
};

/** Authors share one line separated by commas — the shape authors are printed
 * in everywhere else, and the only one that survives a copy-paste. Both the
 * ASCII and the full-width comma split, because a Chinese title block uses the
 * latter and typing it is easier than switching the IME. */
const splitAuthors = (value: string): string[] =>
  value
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

function BookMetaForm({ book, busy, onCancel, onSave }: BookMetaFormProps) {
  const [title, setTitle] = useState(book.title);
  const [authors, setAuthors] = useState(book.authors.join(", "));
  const [subtitle, setSubtitle] = useState(book.subtitle ?? "");
  const [publisher, setPublisher] = useState(book.publisher ?? "");
  const [language, setLanguage] = useState(book.language ?? "");
  const [description, setDescription] = useState(book.description ?? "");

  const patch: BookMetadataPatch = {
    title: title.trim(),
    subtitle: blank(subtitle),
    description: blank(description),
    language: blank(language),
    publisher: blank(publisher),
    authors: splitAuthors(authors),
  };

  // Compare against what the book holds, not against "has the user typed": a
  // field typed and then undone is not a change worth a round trip.
  const changed =
    patch.title !== book.title ||
    (patch.subtitle ?? "") !== (book.subtitle ?? "") ||
    (patch.description ?? "") !== (book.description ?? "") ||
    (patch.language ?? "") !== (book.language ?? "") ||
    (patch.publisher ?? "") !== (book.publisher ?? "") ||
    patch.authors.join("\u0000") !== book.authors.join("\u0000");

  const valid = patch.title.length > 0;

  return (
    <form
      // A real form so Enter in any field saves, which is what a small sheet
      // owes the keyboard.
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && valid && !busy) onSave(patch);
      }}
    >
      <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1">
        <Field label="书名">
          <GlassInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={LIMITS.title}
            aria-label="书名"
            autoComplete="off"
          />
        </Field>

        <Field label="作者" hint="多人用逗号分隔">
          <GlassInput
            value={authors}
            onChange={(event) => setAuthors(event.target.value)}
            placeholder="刘慈欣"
            aria-label="作者"
            autoComplete="off"
          />
        </Field>

        <Field label="副标题">
          <GlassInput
            value={subtitle}
            onChange={(event) => setSubtitle(event.target.value)}
            maxLength={LIMITS.subtitle}
            aria-label="副标题"
            autoComplete="off"
          />
        </Field>

        <div className="flex gap-3">
          <Field label="出版社" className="flex-1">
            <GlassInput
              value={publisher}
              onChange={(event) => setPublisher(event.target.value)}
              maxLength={LIMITS.publisher}
              aria-label="出版社"
              autoComplete="off"
            />
          </Field>
          <Field label="语言" className="w-24">
            <GlassInput
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder="zh"
              maxLength={LIMITS.language}
              aria-label="语言"
              autoComplete="off"
            />
          </Field>
        </div>

        <Field label="简介">
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={LIMITS.description}
            rows={3}
            aria-label="简介"
            className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 min-h-[72px] w-full resize-y rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none"
          />
        </Field>

        {/* The one rule the backend enforces, stated before the click rather
            than as a toast after it. */}
        {!valid && <p className="text-danger text-xs">书名不能为空。</p>}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <GlassButton type="button" variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton type="submit" variant="primary" disabled={busy || !changed || !valid}>
          保存
        </GlassButton>
      </div>
    </form>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}

function Field({ label, hint, className, children }: FieldProps) {
  return (
    <label className={className}>
      <span className="text-text-2 mb-1 flex items-baseline gap-1.5 text-xs font-medium">
        {label}
        {hint && <span className="text-text-3 font-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
