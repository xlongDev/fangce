/**
 * What the browser's stores hold, and the handful of row helpers more than one
 * command domain reads.
 *
 * `StoredBook` is the shelf row: a `BookSummary` minus its cover URL, plus the
 * table of contents and the picture list. Everything above this layer — the
 * shelf, the reader, search — answers in `BookSummary` shapes, so the strip and
 * the re-attach both live here, next to the row they are about.
 *
 * Split out of `backend.ts` when that grew too big to read (O7): these were the
 * only declarations more than one command domain called.
 */
import type { BookImage, BookSummary, ChapterMeta } from "@/lib/bindings";
import * as db from "@/lib/local/db";

/** A shelf row as it is stored: `BookSummary` minus the cover, plus the TOC. */
export type StoredBook = Omit<BookSummary, "coverUrl"> & {
  toc: ChapterMeta[];
  /** Every picture the book shows, collected at import. The lightbox walks it;
   *  the desktop keeps the same list in its own database. */
  images: BookImage[];
};

/**
 * An image in the store: the bytes plus the type to read them back as.
 *
 * A `Blob` would carry both at once, and Chromium is happy to keep one — but
 * WebKit refuses to store a `File` at all and aborts the transaction, so the
 * bytes go in as an `ArrayBuffer`, which every engine clones.
 */
export type StoredImage = { type: string; bytes: ArrayBuffer };

/** Row fields that never belong to a `BookSummary`: the table of contents and
 *  the picture list both stay in the row. */
export const SUMMARY_KEYS = ["toc", "images"] as const;

export const now = () => Math.floor(Date.now() / 1000);
export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Two digits, the way a date key wants them. */
export const two = (value: number) => String(value).padStart(2, "0");

/** Cover object URLs, one per book, made once and kept for the session. */
export const coverUrls = new Map<string, string>();

/** A book's cover as a Blob, from either shape the store has held: the image
 *  itself (older rows) or its bytes with their type. */
export async function coverOf(id: string): Promise<Blob | null> {
  const stored = await db.get<StoredImage | Blob>("files", `${id}:cover`);
  if (!stored) return null;
  return stored instanceof Blob ? stored : new Blob([stored.bytes], { type: stored.type });
}

export async function coverUrlOf(id: string, cover: Blob | null): Promise<string | null> {
  if (!cover) return null;
  const existing = coverUrls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(cover);
  coverUrls.set(id, url);
  return url;
}

/**
 * An author list as plain strings, whatever shape a row holds.
 *
 * The one metadata field the importer cannot settle on its own: foliate's EPUB
 * reader keeps a contributor an **object** whenever it carries a role or a
 * file-as — EPUB 2's `opf:role="aut"`, a MARC `role` refinement — and only
 * collapses a contributor with nothing but a name down to that name. A book
 * with two such creators hands over a list of objects, and stored as it
 * arrived it takes the shelf down on `authorLine`'s `name.trim()`
 * (`TypeError: e.trim is not a function`, measured on the deployed web build).
 * The desktop never meets the shape: its Rust importer answers plain strings.
 *
 * It settles reads as well as writes because a row written before it existed —
 * the web build imported through the same unnormalised path — still holds the
 * objects, and every consumer above this layer assumes strings (`authorLine`,
 * the author sort, edition matching). A contributor's `name` is taken when it
 * is a string; a language-mapped name (`alternate-script`, or an `xml:lang`
 * off the base) is itself an object with no single string in it, so that
 * author is dropped rather than guessed at.
 */
export function authorNames(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    const inner =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { name?: unknown }).name
        : entry;
    if (typeof inner === "string" && inner.trim()) out.push(inner.trim());
  }
  return out;
}

export async function summaryOf(book: StoredBook): Promise<BookSummary> {
  const cover = await coverOf(book.id);
  const { toc: _toc, images: _images, ...rest } = book;
  return {
    ...rest,
    authors: authorNames(book.authors),
    coverUrl: await coverUrlOf(book.id, cover),
  };
}

/** One book's row, or `null`. */
export async function bookRow(id: string): Promise<StoredBook | null> {
  return db.get<StoredBook>("books", id);
}

/** Writes a row back, bumping `updatedAt` unless the caller says otherwise. */
export async function patchBook(
  id: string,
  patch: Partial<StoredBook>,
): Promise<StoredBook | null> {
  const row = await bookRow(id);
  if (!row) return null;
  const next: StoredBook = { ...row, ...patch, updatedAt: now() };
  await db.put("books", id, next);
  return next;
}
