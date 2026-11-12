import { useState, type ReactNode } from "react";
import { ArrowSquareOut, MagnifyingGlass } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { CoverThumb } from "@/features/library/CoverThumb";
import { type Source, useMetadataSearch } from "@/hooks/useMetadata";
import { sourceLabel } from "@/lib/metadata";
import { openUrl } from "@tauri-apps/plugin-opener";
import { showToast } from "@/stores/toasts";
import { isDesktopRuntime } from "@/lib/ipc";
import type { BookMetadataPatch, BookSummary, Candidate } from "@/types/ipc";

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
/** The two catalogues, in the order the sheet offers them. Douban first
 *  because it is the one that answers without a proxy. */
const SOURCES: { key: Source; label: string; hint: string }[] = [
  { key: "douban", label: "豆瓣", hint: "豆瓣图书：中文版次最全，国内可直连" },
  { key: "neodb", label: "NeoDB", hint: "NeoDB：有 ISBN 和外文书，国内需要代理" },
];

const LIMITS = {
  title: 300,
  subtitle: 300,
  publisher: 200,
  language: 40,
  description: 4000,
  isbn: 20,
};

/** 添加日期 is read, never written — it is when the file arrived, not a fact
 *  about the book, and the reader has no way to know a better one. */
const ADDED = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface BookMetaDialogProps {
  /** `null` keeps the sheet closed. */
  book: BookSummary | null;
  busy?: boolean;
  onCancel: () => void;
  /** `coverUrl` is the picture to fetch with this save, or `null` to leave the
   *  one the book has alone. */
  onSave: (patch: BookMetadataPatch, coverUrl: string | null) => void;
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
  /** `coverUrl` is the picture to fetch with this save, or `null` to leave the
   *  one the book has alone. */
  onSave: (patch: BookMetadataPatch, coverUrl: string | null) => void;
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
  const [isbn, setIsbn] = useState(book.isbn ?? "");
  /** A string, not a number: a half-typed year is a state the input has to be
   *  able to hold. Parsed on save, and only when it is all digits. */
  const [year, setYear] = useState(book.publishedYear ? String(book.publishedYear) : "");
  /** The catalogue's snapshot: not editable, only carried. `null` when the
   *  book has none, which is also when a lookup would write it. */
  const [rating, setRating] = useState<{
    value: number | null;
    count: number | null;
    source: string | null;
  }>({ value: book.rating, count: book.ratingCount, source: book.ratingSource });
  const [douban, setDouban] = useState<string | null>(book.doubanUrl);
  /** The cover the last candidate offered. Held separately from the one the
   *  reader has accepted, because a book that already has a picture must not
   *  lose it to a click that was about the title. */
  const [offeredCover, setOfferedCover] = useState<string | null>(null);
  /** A cover to fetch on 保存. A cover is a file, not a column, so it cannot be
   *  part of the form's patch — and it must not be written the moment the
   *  reader clicks a candidate, because nothing is written before 保存. */
  const [pendingCover, setPendingCover] = useState<string | null>(null);
  /** Candidates from the last 查找, or `null` when the reader has not asked. */
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const search = useMetadataSearch();

  const yearText = year.trim();
  const yearValue = /^\d{1,4}$/.test(yearText) ? Number(yearText) : null;
  const patch: BookMetadataPatch = {
    title: title.trim(),
    subtitle: blank(subtitle),
    description: blank(description),
    language: blank(language),
    publisher: blank(publisher),
    isbn: blank(isbn),
    publishedYear: yearValue,
    // Carried through untouched: a save that dropped them would wipe the
    // catalogue's rating every time the reader fixed a typo in the title.
    rating: rating.value,
    ratingCount: rating.count,
    // The label travels with the number: it is stored, not derived, because
    // 「豆瓣 9.2」 and 「NeoDB 9.2」 are different claims.
    ratingSource: rating.source,
    doubanUrl: douban,
    authors: splitAuthors(authors),
  };

  // Compare against what the book holds, not against "has the user typed": a
  // field typed and then undone is not a change worth a round trip.
  const changed =
    // A cover is a change on its own: replacing the picture and leaving every
    // word alone is the whole point of 查找书目 for a badly-covered book, and a
    // save button that stayed disabled would make it impossible.
    pendingCover !== null ||
    patch.title !== book.title ||
    (patch.subtitle ?? "") !== (book.subtitle ?? "") ||
    (patch.description ?? "") !== (book.description ?? "") ||
    (patch.language ?? "") !== (book.language ?? "") ||
    (patch.publisher ?? "") !== (book.publisher ?? "") ||
    (patch.isbn ?? "") !== (book.isbn ?? "") ||
    (patch.publishedYear ?? null) !== (book.publishedYear ?? null) ||
    (patch.rating ?? null) !== (book.rating ?? null) ||
    (patch.doubanUrl ?? null) !== (book.doubanUrl ?? null) ||
    patch.authors.join("\u0000") !== book.authors.join("\u0000");

  const valid = patch.title.length > 0;

  return (
    <form
      // A real form so Enter in any field saves, which is what a small sheet
      // owes the keyboard.
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || !valid || busy) return;
        // One save, one record. The cover is a file and the fields are columns,
        // but they are the same decision — sending them as two commands is what
        // produced two log lines and two undo buttons for one click.
        onSave(patch, pendingCover);
      }}
    >
      <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1">
        {/* A catalogue lookup, not an autofill: it fills the form and stops
            there. The reader still presses 保存, so nothing is written behind
            their back — and a candidate that is wrong costs one edit, not a
            silent overwrite.

            Two buttons, one per catalogue, because they are not interchangeable:
            Douban is reachable from here and has the Chinese editions; NeoDB
            needs a proxy and is the only one with an ISBN and with books Douban
            has never heard of. One button that quietly picked one of them hid
            that choice from the reader. */}
        {isDesktopRuntime && (
          <div className="flex flex-wrap items-center gap-2">
            <MagnifyingGlass size={13} className="text-text-3 shrink-0" />
            {SOURCES.map((source) => (
              <GlassButton
                key={source.key}
                type="button"
                size="sm"
                variant="subtle"
                title={source.hint}
                disabled={search.isPending}
                onClick={() =>
                  search.mutate({ id: book.id, source: source.key }, { onSuccess: setCandidates })
                }
              >
                {search.isPending && search.variables?.source === source.key
                  ? "查找中…"
                  : source.label}
              </GlassButton>
            ))}
            {candidates !== null && (
              <span className="text-text-3 text-xs">
                {sourceLabel(search.variables?.source)} {candidates.length} 条
                {/* The catalogue lists every name attached to any edition,
                    translators included. Saying so is cheaper and more honest
                    than guessing which names are authors. */}
                {candidates.length > 0 && " · 作者表可能含译者，按需删减"}
              </span>
            )}
          </div>
        )}

        {search.isError && (
          <p className="text-danger text-xs leading-relaxed">{search.error.message}</p>
        )}

        {candidates !== null && candidates.length === 0 && (
          <p className="text-text-3 text-xs leading-relaxed">
            {sourceLabel(search.variables?.source)}{" "}
            没有找到相近的书。可以换个书名再试、换个来源再查，或者自己填。
          </p>
        )}

        {candidates !== null && candidates.length > 0 && (
          <ul
            // `shrink-0` is load-bearing. The sheet's body is a column flexbox
            // with a height cap, and flex items shrink before the container
            // scrolls — thirteen results collapsed the list to a few pixels of
            // rounded border, which reads as a rendering bug rather than as a
            // list. The list scrolls itself; the sheet scrolls around it.
            className="glass max-h-48 shrink-0 overflow-y-auto rounded-md p-1"
          >
            {candidates.map((candidate) => (
              // No index in the key: the list is replaced wholesale on every
              // 查找, and a title+year+isbn is enough to tell two candidates
              // apart (Open Library does return the same book twice, and that
              // is a duplicate worth showing rather than silently dropping).
              <li
                key={`${candidate.title}|${candidate.publishedYear ?? ""}|${candidate.isbn ?? ""}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setTitle(candidate.title);
                    setAuthors(candidate.authors.join(", "));
                    // Only overwrite what the provider actually has: a missing
                    // publisher is not evidence that the book has none.
                    if (candidate.publisher) setPublisher(candidate.publisher);
                    if (candidate.language) setLanguage(candidate.language);
                    // The catalogue knows more than the four fields this
                    // button used to write — a subtitle, a blurb, an ISBN and
                    // a year were sitting in the same response, unused.
                    if (candidate.subtitle) setSubtitle(candidate.subtitle);
                    if (candidate.description) setDescription(candidate.description);
                    if (candidate.isbn) setIsbn(candidate.isbn);
                    if (candidate.publishedYear) setYear(String(candidate.publishedYear));
                    // The catalogue's own rating and the Douban page it was
                    // linked from — shown read-only, saved with the form.
                    if (candidate.rating !== null) {
                      setRating({
                        value: candidate.rating,
                        count: candidate.ratingCount,
                        source: candidate.source,
                      });
                    }
                    if (candidate.doubanUrl) setDouban(candidate.doubanUrl);
                    // 🔴 A book with no picture takes the catalogue's one as a
                    // *fill* — there is nothing to lose, so it needs no second
                    // click. A book that already has one is a *replacement*,
                    // and the picture on its shelf is what the reader has been
                    // looking at: that takes a deliberate 「换成这张」 below,
                    // never a side effect of picking a better title.
                    const offered = candidate.coverUrl ?? null;
                    setOfferedCover(offered);
                    setPendingCover(book.coverUrl ? null : offered);
                    setCandidates(null);
                  }}
                  className="press focus-visible:focus-ring hover:bg-surface-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
                >
                  {/* The picture is what tells two editions apart. Nothing is
                      downloaded for it — see `CoverThumb`. */}
                  <CoverThumb url={candidate.coverUrl} className="h-11 w-8" />
                  <span className="min-w-0 flex-1">
                    <span className="text-text-1 block truncate text-[13px]">
                      {candidate.title}
                    </span>
                    <span className="text-text-2 block truncate text-[11px]">
                      {[candidate.authors[0], candidate.publishedYear, candidate.publisher]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="text-text-3 shrink-0 text-[11px] tabular-nums">
                    {/* `f64` crosses the IPC boundary as `number | null`, so a
                        score that somehow arrived empty reads as 0 rather than
                        crashing the sheet. */}
                    {Math.round((candidate.matchScore ?? 0) * 100)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

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

        <div className="flex gap-3">
          <Field label="出版年" className="w-24">
            <GlassInput
              value={year}
              onChange={(event) => setYear(event.target.value)}
              placeholder="如 2008"
              inputMode="numeric"
              maxLength={4}
              aria-label="出版年"
              autoComplete="off"
            />
          </Field>
          <Field label="ISBN" className="flex-1">
            <GlassInput
              value={isbn}
              onChange={(event) => setIsbn(event.target.value)}
              placeholder="13 位或 10 位"
              maxLength={LIMITS.isbn}
              aria-label="ISBN"
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

        {/* Read-only facts, and last. The rating carries the name of the
            catalogue it came from — the two have different numbers from
            different people, and a bare number would be read as the other
            one's. The link is how a reader gets to the page. */}
        <div className="text-text-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span>添加于 {ADDED.format(new Date(book.addedAt * 1000))}</span>
          {/* `typeof` rather than `!== null`: a row written before the column
              existed has no `rating` at all, and `undefined !== null` is true —
              which crashed the whole sheet on `.toFixed` of undefined. */}
          {typeof rating.value === "number" && (
            <span className="text-text-2">
              {sourceLabel(rating.source)} {rating.value.toFixed(1)}
              {rating.count !== null && `（${rating.count} 人）`}
            </span>
          )}
          {/* A book that already has a picture is offered the catalogue's one
              rather than given it: the picture on its shelf is what the reader
              has been looking at, and picking a better title is not a request
              to change it. Two thumbnails, because 「是不是这一版」 is a question
              only the reader can answer. */}
          {book.coverUrl && offeredCover && !pendingCover && (
            <span className="inline-flex items-center gap-1.5">
              <img
                src={book.coverUrl}
                alt="现在的封面"
                className="h-7 w-[21px] rounded object-cover"
                draggable={false}
              />
              <span aria-hidden>→</span>
              <button
                type="button"
                onClick={() => setPendingCover(offeredCover)}
                className="text-accent focus-visible:focus-ring inline-flex items-center gap-1.5 rounded hover:underline"
              >
                <CoverThumb url={offeredCover} className="h-7 w-[21px]" />
                换成这张
              </button>
            </span>
          )}

          {pendingCover && (
            <span className="inline-flex items-center gap-1.5">
              {book.coverUrl && (
                <>
                  <img
                    src={book.coverUrl}
                    alt="现在的封面"
                    className="h-7 w-[21px] rounded object-cover"
                    draggable={false}
                  />
                  <span aria-hidden>→</span>
                </>
              )}
              <CoverThumb url={pendingCover} className="h-7 w-[21px]" />
              <span>{book.coverUrl ? "保存时替换" : "保存时下载"}</span>
              {book.coverUrl && (
                <button
                  type="button"
                  onClick={() => setPendingCover(null)}
                  className="text-text-3 hover:text-text-1 focus-visible:focus-ring rounded underline"
                >
                  不换
                </button>
              )}
            </span>
          )}
          {douban && (
            <button
              type="button"
              onClick={() =>
                void openUrl(douban).catch((err: unknown) => {
                  // Never silently: `opener` refuses any URL outside its
                  // capability scope, and a swallowed rejection is exactly how
                  // "the link does nothing" became a bug report.
                  showToast(
                    "error",
                    `打不开这个链接：${err instanceof Error ? err.message : String(err)}`,
                  );
                })
              }
              className="text-accent focus-visible:focus-ring inline-flex items-center gap-1 rounded hover:underline"
            >
              豆瓣 <ArrowSquareOut size={10} weight="bold" />
            </button>
          )}
        </div>

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
