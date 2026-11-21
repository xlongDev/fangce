/**
 * Highlights to a file the reader can take away: Markdown or CSV, one book or
 * a selection across several.
 *
 * The shapes here are **the desktop's**, which are in turn half of a contract
 * with *importing*: `clippings::parse_csv` finds its columns by name, so a file
 * without `书名` cannot be read back at all. That is why this is a second
 * implementation rather than a port — moving `export.rs` over here would leave
 * the importer on the other side of a shape only one of them still knows.
 *
 * The two implementations are pinned together by their tests: the expectations
 * below are the strings `library/export.rs` asserts, copied over deliberately.
 * Change one side and the other goes red, which is the point.
 */

/** The scheme the app registers, so a row can be reopened where it came from. */
const SCHEME = "fangce";

/** A byte-order mark, so Excel opens the file as UTF-8 instead of guessing the
 *  system code page — the difference between 三体 and mojibake. */
const CSV_BOM = "\uFEFF";

/** The one column layout both CSV exporters write, and the one the importer
 *  reads. Adding a column here is invisible there until something asks. */
const CSV_HEADER = "书名,章节,原文,笔记,颜色,样式,链接\n";

/** One highlight, as much of it as an export needs. */
export interface NoteEntry {
  id: string;
  chapterIdx: number;
  text: string;
  note: string | null;
  color: string | null;
  style: string | null;
}

/** One book's highlights. */
export interface Notes {
  id: string;
  title: string;
  authors: string[];
  /** 0–1, as the shelf stores it. */
  progress: number;
  entries: NoteEntry[];
}

/** The link a highlight carries back into the app. Pinned to the string
 *  `parseDeepLink` reads (`src/lib/deeplink.ts`). */
export const link = (bookId: string, annotationId: string): string =>
  `${SCHEME}://book/${bookId}?annotation=${annotationId}`;

/** The link home, with the highlight's ink folded into an HTML comment on the
 *  same line — invisible to a page reader, read back by `clippings.ts`. */
const markdownLink = (entry: NoteEntry, bookId: string): string => {
  const ink: string[] = [];
  if (entry.color !== null) ink.push(`color=${entry.color}`);
  if (entry.style !== null) ink.push(`style=${entry.style}`);
  const comment = ink.length > 0 ? ` <!-- ink:${ink.join(";")} -->` : "";
  return `[在 方册 中打开](${link(bookId, entry.id)})${comment}`;
};

/** One blockquote. Every line gets its own `>`, so a highlight spanning
 *  paragraphs stays a single quote instead of nesting its second half. */
const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** The line under the title: who wrote it, how much there is, how far in. */
function summary(notes: Notes): string {
  const noted = notes.entries.filter((entry) => entry.note !== null).length;
  const parts = [`${notes.entries.length} 条标注`];
  if (noted > 0) parts.push(`${noted} 条有笔记`);
  if (notes.progress > 0) parts.push(`阅读进度 ${Math.round(notes.progress * 100)}%`);
  const line = parts.join(" · ");
  return notes.authors.length === 0 ? line : `${notes.authors.join("、")} · ${line}`;
}

/** The line under the title of a cross-book export. Progress is per book and
 *  means nothing across several, so each section keeps its own. */
function summaryMany(books: Notes[]): string {
  const highlights = books.reduce((total, book) => total + book.entries.length, 0);
  const noted = books.flatMap((book) => book.entries).filter((entry) => entry.note !== null).length;
  const parts = [`${books.length} 本书`, `${highlights} 条标注`];
  if (noted > 0) parts.push(`${noted} 条有笔记`);
  return parts.join(" · ");
}

/** Which flavour of Markdown a file is written in. The desktop's `Dialect`,
 *  spelled the same way because the two are pinned to each other by these
 *  tests — see the note at the top of this file. */
export type Dialect = "plain" | "obsidian";

/** Obsidian's properties block. This is the whole of that dialect's value:
 *  without it a vault holds the highlights as prose, and no query can ask which
 *  book a note came from, who wrote it, or how far in the reader was. */
function frontmatter(books: Notes[]): string {
  const fields = [
    books.length === 1
      ? `title: ${yaml(`《${books[0]!.title}》标注与笔记`)}`
      : `title: ${yaml(`笔记导出（${books.length} 本书）`)}`,
  ];
  // Author and progress belong to one book and mean nothing across several.
  if (books.length === 1) {
    const [only] = books;
    if (only!.authors.length > 0) {
      fields.push(`authors: [${only!.authors.map(yaml).join(", ")}]`);
    }
    fields.push(`progress: ${only!.progress.toFixed(2)}`);
  }
  fields.push("tags:", "  - 方册");
  return `---\n${fields.join("\n")}\n---`;
}

/** A YAML scalar, quoted — a title carrying a colon or a quote would otherwise
 *  end the mapping somewhere it was not meant to. */
const yaml = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** One book's highlights, chapter by chapter, pushed onto `blocks`.
 *
 *  A heading is emitted when the chapter actually changes: the list is already
 *  in reading order, so a group never needs buffering. */
function body(notes: Notes, heading: string, dialect: Dialect, blocks: string[]): void {
  if (notes.entries.length === 0) blocks.push("这本书还没有标注。");
  let chapter: number | null = null;
  for (const entry of notes.entries) {
    if (chapter !== entry.chapterIdx) {
      chapter = entry.chapterIdx;
      blocks.push(`${heading} 第 ${entry.chapterIdx + 1} 章`);
    }
    blocks.push(dialect === "obsidian" ? `> [!quote]\n${quote(entry.text)}` : quote(entry.text));
    if (entry.note !== null) blocks.push(entry.note);
    // The way back in. A link rather than a bare URL: note apps render the one
    // and leave the other as text that has to be copied out by hand. The ink
    // rides in a comment on this line, where the importer reads it back.
    blocks.push(markdownLink(entry, notes.id));
  }
}

export function renderMarkdown(notes: Notes, dialect: Dialect = "plain"): string {
  // The properties block is a property of the file rather than one of its
  // blocks, so it rides on the first one instead of standing in the list where
  // it would be joined by a blank line like everything else.
  const title =
    dialect === "obsidian"
      ? `${frontmatter([notes])}\n\n# [[${notes.title}]] 标注与笔记`
      : `# 《${notes.title}》标注与笔记`;
  const blocks = [title, summary(notes)];
  body(notes, "##", dialect, blocks);
  // Trailing newline: the file is meant to be opened by other tools, and a text
  // file that ends without one makes every one of them complain.
  return `${blocks.join("\n\n")}\n`;
}

/** Several books as one page, a section each. The book heading and the chapter
 *  headings differ by a level: two `##`s in a row would read as two of the same
 *  thing, and one of them is a book. */
export function renderMarkdownMany(books: Notes[], dialect: Dialect = "plain"): string {
  // One properties block for the file, at the top. A second one part-way down
  // would be a YAML mapping in the middle of a Markdown document, which is not
  // a thing any reader of either one wants.
  const blocks = [
    dialect === "obsidian" ? `${frontmatter(books)}\n\n# 笔记导出` : "# 笔记导出",
    summaryMany(books),
  ];
  for (const notes of books) {
    blocks.push(dialect === "obsidian" ? `## [[${notes.title}]]` : `## 《${notes.title}》`);
    if (notes.authors.length > 0) blocks.push(notes.authors.join("、"));
    body(notes, "###", dialect, blocks);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Quotes a field when it holds a delimiter, a quote or a line break — the
 *  three things that would otherwise split one row into several. */
const field = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** One CSV row: the book it came from, then the highlight. */
function row(notes: Notes, entry: NoteEntry): string {
  return [
    field(notes.title),
    entry.chapterIdx + 1,
    field(entry.text),
    field(entry.note ?? ""),
    // Left empty rather than filled with the defaults the UI applies: "never
    // chosen" and "chose yellow" are different facts, and the file should not
    // invent one of them.
    field(entry.color ?? ""),
    field(entry.style ?? ""),
    // Raw rather than as a `[text](url)` pair: a spreadsheet column is a value,
    // and the URL is what the app answers to.
    field(link(notes.id, entry.id)),
  ].join(",");
}

export function renderCsv(notes: Notes): string {
  return CSV_BOM + CSV_HEADER + notes.entries.map((entry) => `${row(notes, entry)}\n`).join("");
}

/** Several books as one CSV table. One header, one shape: a single-book file
 *  leads with `书名` exactly as a cross-book one does, even though the title
 *  repeats down every row — the importer matches a clipping to a book by title,
 *  so a file that never names its book cannot be read back. */
export function renderCsvMany(books: Notes[]): string {
  return (
    CSV_BOM +
    CSV_HEADER +
    books.flatMap((notes) => notes.entries.map((entry) => `${row(notes, entry)}\n`)).join("")
  );
}
