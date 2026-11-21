/**
 * Reading a clippings file back into highlights.
 *
 * Two shapes are understood, and they are the two this app writes (see
 * `notes.ts`): its Markdown page and its CSV table. A Kindle's own
 * `My Clippings.txt` is **not** — that reader is six hundred lines on the
 * desktop, tested against devices neither of us can fix, and carrying it over
 * for a file the browser build has no reason to meet is not worth the code. A
 * file that is not ours is refused with a sentence rather than read badly.
 *
 * The rules below are the desktop's, so a file written by either build reads in
 * both. Where they are subtle the reason is carried over too: the link closes an
 * entry and stamps itself on the line above it; a `> ` inside a note belongs to
 * the note; a bare `>` is a blank line within a quote; a CSV column is found by
 * name, which is why a column added to the writer cannot break this reader.
 */

/** The link this app writes, and the book id inside it. */
const LINK_PREFIX = "fangce://book/";

/** One highlight read out of a file. */
export interface Clipping {
  title: string;
  text: string;
  /** The id this app's own export links to, when the file carries the link.
   *  Worth more than the title: a renamed book still matches, and a shelf
   *  holding one title twice is no longer a coin toss. */
  bookId: string | null;
  note: string | null;
  color: string | null;
  /** Inked colour and paint style: blank means "never chose", which is not the
   *  same fact as yellow. */
  style: string | null;
  chapterIdx: number | null;
}

/** Everything a clippings file turned into. */
export interface Parsed {
  highlights: Clipping[];
  notes: number;
  bookmarks: number;
}

/** Which of the shapes we can read. `kindle` is refused, not guessed at. */
export type Shape = "markdown" | "csv" | null;

const empty = (): Parsed => ({ highlights: [], notes: 0, bookmarks: 0 });

/** Kindle writes a BOM, and line endings depend on the machine the file was
 *  copied through. */
const normalise = (source: string): string =>
  (source.startsWith("\uFEFF") ? source.slice(1) : source)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

/** The book id inside a link line, or `null` when there is none. */
const linkedBookId = (line: string): string | null => {
  const at = line.indexOf(LINK_PREFIX);
  if (at < 0) return null;
  const rest = line.slice(at + LINK_PREFIX.length);
  const id = rest.split(/[?\s)"']/)[0] ?? "";
  return id.length > 0 ? id : null;
};

/** Ink the exporter folded into a link line, as `<!-- ink:color=#ffd12e;style=underline -->`.
 *  No comment means "never chose", not yellow. */
const linkedInk = (line: string): { color: string | null; style: string | null } => {
  const at = line.indexOf("<!-- ink:");
  const end = line.indexOf("-->", at);
  if (at < 0 || end < 0) return { color: null, style: null };
  let color: string | null = null;
  let style: string | null = null;
  for (const pair of line.slice(at + "<!-- ink:".length, end).split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    const value = rest.join("=").trim();
    if (value.length === 0) continue;
    if (key === "color") color = value;
    if (key === "style") style = value;
  }
  return { color, style };
};

/** Whether a line carries one of this app's links. */
const carriesLink = (line: string): boolean => linkedBookId(line) !== null;

/** "第 3 章" → 2. One-based in the file, zero-based in the library. */
const chapterNumber = (heading: string): number | null => {
  const hit = /第\s*(\d+)\s*章/.exec(heading);
  if (!hit) return null;
  const at = Number(hit[1]) - 1;
  return at >= 0 ? at : null;
};

/** The book a heading names, without the quotes the export puts around it. */
const headingTitle = (heading: string): string => {
  const stripped = heading.replace(/^《/, "").replace(/》$/, "");
  // A single-book file's own title line ends with 标注与笔记, which is not part
  // of the name.
  return stripped.replace(/标注与笔记$/, "").trim();
};

const blank = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Reads this app's Markdown export back into highlights.
 *
 * Never throws: a malformed entry is skipped, because the file may have been
 * edited by hand on the way here.
 */
export function parseMarkdown(source: string): Parsed {
  const parsed = empty();
  let title = "";
  let chapter: number | null = null;
  let passage: string[] = [];
  let note: string[] = [];
  // Once the quote has ended, everything is the note — including lines that
  // happen to start with `> `.
  let inNote = false;

  const flush = () => {
    const text = passage.join("\n").trim();
    const written = note.join("\n").trim();
    // Cleared either way: a heading that ends an entry with nothing in it must
    // not leave its text lying around for the next entry to pick up.
    passage = [];
    note = [];
    inNote = false;
    if (text.length === 0) return;
    parsed.highlights.push({
      title,
      text,
      bookId: null,
      note: written.length > 0 ? written : null,
      color: null,
      style: null,
      chapterIdx: chapter,
    });
  };

  for (const line of normalise(source).split("\n")) {
    if (line.startsWith("#")) {
      const heading = line.replace(/^#+/, "").trim();
      const idx = chapterNumber(heading);
      // A new chapter — or a new book — ends whatever came before it.
      flush();
      if (idx !== null) chapter = idx;
      else {
        title = headingTitle(heading);
        chapter = null;
      }
      continue;
    }
    if (carriesLink(line)) {
      const before = parsed.highlights.length;
      flush();
      // The link closes the entry above it, so it and its ink are stamped onto
      // the highlight `flush` just pushed — and only when it pushed one. An
      // entry that ended at a heading would hand its id and colour to its
      // predecessor.
      if (parsed.highlights.length > before) {
        const last = parsed.highlights[parsed.highlights.length - 1]!;
        last.bookId = linkedBookId(line);
        const ink = linkedInk(line);
        last.color = ink.color;
        last.style = ink.style;
      }
      continue;
    }
    if (line.startsWith("> ")) {
      // Inside a note the marker is the reader's own prose and is kept verbatim;
      // outside it, it is the quote's prefix and comes off.
      if (inNote) note.push(line);
      else passage.push(line.slice(2));
      continue;
    }
    // A bare `>` is an empty line inside the quote, which the writer emits as
    // `> ` and a hand-edited file may write without the space.
    if (line.trim() === ">" && !inNote) {
      passage.push("");
      continue;
    }
    if (line.trim().length === 0) {
      // The blank between the quote and the note. Inside the note, a blank is
      // part of it.
      if (passage.length > 0) inNote = true;
      if (inNote) note.push("");
      continue;
    }
    inNote = true;
    note.push(line);
  }
  flush();
  return parsed;
}

/**
 * Splits one CSV table into rows of fields. Quoted fields keep their commas,
 * their quotes (doubled) and their line breaks — the three things that would
 * otherwise split one row into several.
 */
export function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]!;
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') {
          field += '"';
          at += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      pushField();
      continue;
    }
    if (char === "\n") {
      pushRow();
      continue;
    }
    if (char === "\r") continue;
    field += char;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Reads this app's CSV export back into highlights. */
export function parseCsv(source: string): Parsed {
  const parsed = empty();
  const rows = csvRows(normalise(source));
  const header = rows.shift();
  if (!header) return parsed;
  const column = (want: string): number | null => {
    const at = header.findIndex((field) => field.trim() === want);
    return at >= 0 ? at : null;
  };
  const textAt = column("原文");
  // Without a 原文 column there is nothing to import, and guessing which column
  // holds the passage is worse than refusing.
  if (textAt === null) return parsed;
  const titleAt = column("书名");
  const chapterAt = column("章节");
  const noteAt = column("笔记");
  const colorAt = column("颜色");
  const styleAt = column("样式");
  const linkAt = column("链接");

  for (const row of rows) {
    const at = (index: number | null): string => (index === null ? "" : (row[index] ?? ""));
    // Kept verbatim, not collapsed: this text came out of our own annotations
    // table, so its line breaks are the reader's own.
    const text = at(textAt).trim();
    if (text.length === 0) continue;
    const chapter = Number.parseInt(at(chapterAt).trim(), 10);
    parsed.highlights.push({
      title: at(titleAt).trim(),
      text,
      // The link is what makes an old single-book export importable: the id it
      // carries is the only thing in the file that names the book.
      bookId: linkedBookId(at(linkAt)),
      note: blank(at(noteAt)),
      color: blank(at(colorAt)),
      style: blank(at(styleAt)),
      // Written one-based; annotations count from zero.
      chapterIdx: Number.isFinite(chapter) && chapter > 0 ? chapter - 1 : null,
    });
  }
  return parsed;
}

/** Which of the two shapes this file is, or `null` when it is neither. */
export function detect(source: string): Shape {
  const text = normalise(source);
  if (/^\s*书名\s*,/.test(text)) return "csv";
  if (/^#\s/m.test(text)) return "markdown";
  return null;
}

/** Reads a file this app wrote. `null` means "not ours" — say so and stop. */
export function parseClippings(source: string): Parsed | null {
  switch (detect(source)) {
    case "csv":
      return parseCsv(source);
    case "markdown":
      return parseMarkdown(source);
    default:
      return null;
  }
}
