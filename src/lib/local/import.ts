/**
 * Turning a picked file into a shelf row, in the browser.
 *
 * Two paths, because the shelf already has two: the formats foliate-js can open
 * (epub / mobi / azw3 / fb2 / cbz / pdf) are read by the same engine the reader
 * uses, so metadata, cover, table of contents and chapter text all come from it
 * and agree with what the reader will show; plain text and markdown are split
 * here, the way the Rust importer splits them on the desktop.
 *
 * Both paths end with the same thing: every chapter's text, in reading order.
 * That table is what search, read-aloud and the progress bar address, so having
 * it in the browser is what makes the two builds the same product rather than
 * one of them a viewer.
 */
import { makeBook } from "foliate-js/view.js";

import { chapterFromBlocks, countChars, textBlocks } from "@/lib/local/blocks";
import { authorNames } from "@/lib/local/rows";
import type { BookFormat, ChapterContent, ChapterMeta } from "@/lib/bindings";
import type { BookImage } from "@/types/ipc";

/** Formats the shelf accepts, and the extension that names each one. */
const BY_EXTENSION: Record<string, BookFormat> = {
  epub: "epub",
  pdf: "pdf",
  mobi: "mobi",
  azw: "azw",
  azw3: "azw3",
  prc: "prc",
  fb2: "fb2",
  cbz: "cbz",
  md: "markdown",
  markdown: "markdown",
  txt: "txt",
};

export function detectFormat(name: string): BookFormat | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[extension] ?? null;
}

/** A heading that starts a chapter in a plain-text book.
 *
 * No `\b` after the marker: the characters around it are CJK, which has no word
 * boundaries in a regex, so the anchor would never match. The line-length check
 * at the call site is what keeps a sentence that merely starts with 第一章 from
 * being taken for a heading.
 */
const HEADING =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷篇部集]|chapter\s+\d+|(?:序章|序言|前言|后记|尾声|番外)\s*$)/i;

/**
 * Splits a text into chapters and paragraphs.
 *
 * A book with headings is split at them; one without is split every
 * `PLAIN_CHUNK` characters so the reader's progress bar and TOC still have
 * something to move between — the desktop importer does the same thing for the
 * same reason.
 */
export function splitChapters(text: string, fallbackTitle: string): ChapterContent[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chapters: ChapterContent[] = [];
  let title = fallbackTitle;
  let body: string[] = [];

  const flush = () => {
    const paragraphs = body.map((line) => line.trim()).filter((line) => line.length > 0);
    if (paragraphs.length === 0) return;
    chapters.push({ idx: chapters.length, title, paragraphs });
    body = [];
  };

  let chunk = 0;
  for (const line of lines) {
    if (HEADING.test(line) && line.trim().length <= 40) {
      flush();
      title = line.trim();
      chunk = 0;
      continue;
    }
    // No headings in sight: cut on a paragraph boundary so a chunk never starts
    // mid-sentence, and only once the run is long enough to be worth a chapter.
    const size = body.reduce((total, entry) => total + entry.length, 0);
    if (chapters.length === 0 && chunk === 0 && size > 8000) {
      flush();
      title = `${fallbackTitle}（续 ${chapters.length + 1}）`;
      chunk = chapters.length;
    }
    body.push(line);
  }
  flush();
  if (chapters.length === 0) {
    chapters.push({ idx: 0, title: fallbackTitle, paragraphs: ["（这本书没有可显示的正文）"] });
  }
  // Ids are positional: the reader addresses chapters by index, and the split
  // order is the reading order.
  chapters.forEach((chapter, idx) => {
    chapter.idx = idx;
  });
  return chapters;
}

/** What importing one file produced. */
export type ParsedBook = {
  format: BookFormat;
  title: string;
  subtitle: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  authors: string[];
  cover: Blob | null;
  toc: ChapterMeta[];
  /** `null` for a book with no prose to extract — a PDF, a comic archive. */
  chapters: ChapterContent[] | null;
  /** Every picture the book shows, in reading order, keyed by container path. */
  images: BookImage[];
};

/**
 * Decodes a text file, guessing the encoding when UTF-8 does not fit.
 *
 * Chinese `.txt` books are as often GB18030 as UTF-8, and a wrong guess is not
 * a subtle failure — it is a page of replacement characters. The guess is the
 * cheap one: decode as UTF-8 (fatal off), and if the result is littered with
 * U+FFFD, decode again as GB18030, which every browser supports and which is a
 * superset of GBK.
 */
export function decodeText(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const broken = (utf8.match(/\uFFFD/g) ?? []).length;
  if (broken < Math.max(2, utf8.length / 2000)) return utf8;
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {
    return utf8;
  }
}

/** Reads one picked file into everything the shelf and the reader need. */
/** One spine entry: foliate's own section shape, as far as this file reads it. */
type FoliateSection = {
  id?: string;
  /** Missing on formats that have no text of their own — a comic archive. */
  createDocument?: () => Promise<Document>;
  /** Turns a reference inside this document into a container path. EPUB only —
   *  MOBI addresses its pictures by record index instead. */
  resolveHref?: (href: string) => string;
};

/** The bit of a foliate book this module reads: everything else belongs to the
 *  reader view. */
type FoliateBookDoc = {
  metadata?: Record<string, unknown> | null;
  toc?: { label?: string; subitems?: unknown[] }[];
  sections?: FoliateSection[];
  getCover?: () => Promise<Blob | null> | Blob | null;
  destroy?: () => void;
};

/**
 * Every chapter's text, in the order the reader pages through them.
 *
 * foliate's sections are the spine, and the desktop extracts from the spine in
 * the same order (`document::epub::read_chapters`) — so chapter n here is
 * chapter n there, which is what makes a search hit found in the browser the
 * same place the desktop would send the reader.
 *
 * A section with no prose is dropped rather than numbered, exactly as the
 * desktop drops it: a pure-SVG cover is a spine entry that would otherwise
 * become a chapter reading as a blank page.
 *
 * `null` when nothing could be extracted (a comic archive, a damaged
 * container), which is also the shape a PDF keeps.
 */
async function extractChapters(
  book: FoliateBookDoc,
): Promise<{ chapters: ChapterContent[]; images: BookImage[] } | null> {
  const chapters: ChapterContent[] = [];
  // Every picture the book shows, in reading order, keyed the way the lightbox
  // looks them up. The documents are already being parsed for the prose, so the
  // walk costs nothing extra — and it is the only place the whole book's
  // pictures are ever in hand at once.
  const images: BookImage[] = [];
  for (const section of book.sections ?? []) {
    if (typeof section.createDocument !== "function") continue;
    try {
      const doc = await section.createDocument();
      const chapterIdx = chapters.length;
      for (const path of imagesInDocument(doc, section)) {
        if (images.some((image) => image.path === path)) continue;
        images.push({ chapterIdx, path });
      }
      const blocks = textBlocks(doc.body);
      if (blocks.length === 0) continue;
      const { title, paragraphs } = chapterFromBlocks(blocks, `第 ${chapters.length + 1} 章`);
      chapters.push({ idx: chapters.length, title, paragraphs });
    } catch {
      // A section that will not open is skipped, not fatal: the rest of the
      // book still reads, and a chapter index that shifted by one is a smaller
      // loss than refusing the file.
    }
  }
  return chapters.length > 0 ? { chapters, images } : null;
}

/**
 * The pictures one section document shows, keyed the way the lightbox looks
 * them up.
 *
 * Shared by the import walk and the on-demand one (`readBookImages`) so the two
 * lists cannot drift: a book imported today and a book whose list is built
 * later have to answer the same paths, or a click names a picture the list does
 * not have and the viewer opens something else.
 */
function imagesInDocument(doc: Document, section: FoliateSection): string[] {
  const paths: string[] = [];
  for (const node of doc.querySelectorAll("img[src], image[href], img[recindex]")) {
    // MOBI carries its pictures by record index, and foliate stamps the
    // rendered copy with the same `kindle:recindex:N` path the lightbox keys
    // on; EPUB refers to them by relative path, which the section's own
    // resolver turns into a container path.
    const recindex = node.getAttribute("recindex");
    const raw = recindex
      ? `kindle:recindex:${recindex}`
      : metadataText(node.getAttribute("src") ?? node.getAttribute("href"));
    if (raw === null) continue;
    let path = raw;
    if (!recindex) {
      try {
        path = section.resolveHref ? String(section.resolveHref(raw)) : raw;
      } catch {
        // An unresolvable reference keeps the raw path: a wrong key is a
        // picture that will not open, while dropping it loses the row.
      }
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * A whole book's pictures, in reading order — for a row that has none.
 *
 * The import collects this while it is already parsing every section for the
 * prose (see `extractChapters`); this is that walk on its own, for the rows
 * written before the list was collected. It is the expensive half of an import
 * — every spine document is opened and parsed — so a caller runs it once and
 * keeps the answer rather than asking twice.
 */
export async function readBookImages(file: File): Promise<BookImage[]> {
  const format = detectFormat(file.name);
  // The formats with no container to walk: exactly the three `readBook` answers
  // without opening the book.
  if (!format || format === "pdf" || format === "txt" || format === "markdown") return [];

  const book = (await makeBook(file)) as FoliateBookDoc;
  const images: BookImage[] = [];
  // The chapter a picture is filed under is the index of the chapters the
  // reader pages through, which skips a section with no prose — the same count
  // `extractChapters` keeps.
  let chapterIdx = 0;
  try {
    for (const section of book.sections ?? []) {
      if (typeof section.createDocument !== "function") continue;
      try {
        const doc = await section.createDocument();
        for (const path of imagesInDocument(doc, section)) {
          if (images.some((image) => image.path === path)) continue;
          images.push({ chapterIdx, path });
        }
        if (textBlocks(doc.body).length > 0) chapterIdx++;
      } catch {
        // A section that will not open is skipped, not fatal: the rest of the
        // book still lists, and one missing picture is a smaller loss than
        // refusing the book.
      }
    }
  } finally {
    book.destroy?.();
  }
  return images;
}

/**
 * One text field of a container's metadata, as a string.
 *
 * foliate's readers do not agree on the shape: EPUB answers with strings, MOBI
 * hands over lists (`language: ["zh"]`), and a field that is missing can be
 * anything at all. The reader's own types say `string`, so the shape is settled
 * here, once, instead of being defended against everywhere it is read — a MOBI
 * whose language was a list took the whole reading page down on
 * `language.toLowerCase()`.
 */
export function metadataText(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

export async function readBook(file: File): Promise<ParsedBook> {
  const format = detectFormat(file.name);
  if (!format) throw new Error(`不支持的格式：${file.name}`);
  const stem = file.name.replace(/\.[^.]+$/, "");

  if (format === "txt" || format === "markdown") {
    const chapters = splitChapters(decodeText(await file.arrayBuffer()), stem);
    return {
      format,
      title: stem,
      subtitle: null,
      description: chapters[0]?.paragraphs[0]?.slice(0, 200) ?? null,
      language: null,
      publisher: null,
      authors: [],
      cover: null,
      toc: chapters.map((chapter) => ({
        idx: chapter.idx,
        title: chapter.title,
        chars: countChars(chapter.paragraphs),
      })),
      chapters,
      // Plain text has no container and so no pictures to enumerate.
      images: [],
    };
  }

  // foliate's own type is the reader's; the metadata surface is wider than it
  // declares, so it is spelled out here rather than reaching through `any`.
  if (format === "pdf") {
    // foliate's PDF path is stubbed out in this repo — the reader renders PDFs
    // through its own pdf.js pipeline (`lib/pdf.ts`) — so a PDF arrives with
    // nothing but its name here, and `describePdf` fills in the page count and
    // the cover from that pipeline once the bytes are in place to be read.
    return {
      format,
      title: stem,
      subtitle: null,
      description: null,
      language: null,
      publisher: null,
      authors: [],
      cover: null,
      toc: [],
      chapters: null,
      // The page images come from `describePdf`'s own pipeline, not from a
      // container listing.
      images: [],
    };
  }

  const book = (await makeBook(file)) as FoliateBookDoc;
  const meta = (book.metadata ?? {}) as {
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
    language?: string | null;
    publisher?: string | null;
    // Wider than it looks: an EPUB creator carrying a role or a file-as stays
    // a contributor object, so the list is settled by `authorNames` below.
    author?: unknown;
  };
  const authors = authorNames(meta.author);
  const labels = flattenToc(book.toc ?? []);
  let cover: Blob | null = null;
  try {
    cover = (await book.getCover?.()) ?? null;
  } catch {
    // A malformed cover is not a reason to refuse the book.
  }
  // Navigation labels and section ids, read before the book is closed: what
  // the chapter list falls back to when nothing could be extracted.
  const labelsOrSections: ChapterMeta[] =
    labels.length > 0
      ? labels.map((title, idx) => ({ idx, title, chars: 0 }))
      : (book.sections ?? []).map((section, idx) => ({
          idx,
          title: section.id ?? `第 ${idx + 1} 节`,
          chars: 0,
        }));
  // Last, because it is the expensive part: every spine document is unzipped
  // and parsed. It is done once, here, rather than on the first search — the
  // reader is already waiting for the import, and a search that has to open the
  // whole book before it can answer is a search that looks broken.
  const extracted = await extractChapters(book);
  const chapters = extracted?.chapters ?? null;
  book.destroy?.();
  return {
    format,
    title: metadataText(meta.title) ?? stem,
    subtitle: metadataText(meta.subtitle),
    description: metadataText(meta.description),
    language: metadataText(meta.language),
    publisher: metadataText(meta.publisher),
    authors,
    cover,
    // The extracted chapters are the table, not the container's navigation:
    // this is the list the reader pages through, so its indices and its
    // character counts have to be the ones a search hit and the progress bar
    // address. Navigation is the fallback for a book with no text to extract.
    toc: chapters
      ? chapters.map((chapter) => ({
          idx: chapter.idx,
          title: chapter.title,
          chars: countChars(chapter.paragraphs),
        }))
      : labelsOrSections,
    chapters,
    images: extracted?.images ?? [],
  };
}

/** foliate's nested TOC as a flat list of labels, in reading order. */
function flattenToc(toc: { label?: string; href?: string; subitems?: unknown[] }[]): string[] {
  const out: string[] = [];
  const walk = (items: { label?: string; subitems?: unknown[] }[]) => {
    for (const item of items) {
      if (item.label) out.push(item.label.trim());
      if (Array.isArray(item.subitems)) walk(item.subitems as { label?: string }[]);
    }
  };
  walk(toc);
  return out.filter((label) => label.length > 0);
}
