import type { BookFormat, BookSummary } from "@/types/ipc";

/**
 * How the shelf is cut into sections.
 *
 * Every dimension here is **exclusive** — a book lands in exactly one section —
 * and that is a constraint, not a preference: the grid keys its tiles by book
 * id, so a book shown under two headings would be two tiles with one key. Which
 * is why labels are *not* a dimension: a book with two tags belongs under both,
 * and the shelf cannot draw that. Browsing one label is what the 标签 shelf and
 * its `TagIndex` are for.
 */
export type ShelfGroup = "none" | "progress" | "author" | "format";

export const groupOptions: { value: ShelfGroup; label: string }[] = [
  { value: "none", label: "不分组" },
  { value: "progress", label: "阅读状态" },
  { value: "author", label: "作者" },
  { value: "format", label: "文件格式" },
];

/** One section of the shelf: what it is called and where it starts. */
export interface BookSection {
  key: string;
  label: string;
  /** Index of the section's first card in `ShelfSections.cards`. */
  start: number;
  count: number;
}

/**
 * The shelf read as sections.
 *
 * Flat, not nested: `cards` is what the windowed grid slices, exactly as it
 * sliced the plain book list before — sections are a reading aid laid over one
 * array, not a second structure for the grid to walk.
 */
export interface ShelfSections {
  cards: BookSummary[];
  sections: BookSection[];
}

/** Where a book sits in its own reading history. */
const PROGRESS_SECTIONS = [
  { key: "reading", label: "在读" },
  { key: "unread", label: "未开始" },
  { key: "finished", label: "已读完" },
];

/** The formats in the order the shelf lists them; anything else lands after. */
const FORMAT_ORDER: BookFormat[] = [
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "prc",
  "fb2",
  "cbz",
  "markdown",
  "txt",
];

const NO_AUTHOR = "未知作者";

function progressOf(book: BookSummary): string {
  const progress = book.progress;
  if (progress !== null && progress >= 1) return "finished";
  if (progress !== null && progress > 0) return "reading";
  return "unread";
}

function progressLabel(key: string): string {
  return PROGRESS_SECTIONS.find((section) => section.key === key)?.label ?? key;
}

function formatLabel(format: BookFormat): string {
  // `markdown` is the one format whose extension is not how it is spelled.
  return format === "markdown" ? "Markdown" : format.toUpperCase();
}

interface Dimension {
  /** Which section a book belongs to. */
  keyOf: (book: BookSummary) => string;
  /** What that section is called; read off the first book that landed in it. */
  labelOf: (book: BookSummary) => string;
  /**
   * Fixed section order. Sections this leaves out rank as 0 — that is, they
   * are ordered by size instead, which is what a dimension with no natural
   * order (作者) wants without having to say so.
   */
  rank?: (key: string) => number;
}

const DIMENSIONS: Record<Exclude<ShelfGroup, "none">, Dimension> = {
  progress: {
    keyOf: progressOf,
    labelOf: (book) => progressLabel(progressOf(book)),
    rank: (key) => {
      const at = PROGRESS_SECTIONS.findIndex((section) => section.key === key);
      return at === -1 ? PROGRESS_SECTIONS.length : at;
    },
  },
  author: {
    // Books with several authors go under the first one. Picking a *primary*
    // author is the only way to keep the sections exclusive; the whole credit
    // list is still on the card, and 作者 remains a sortable order.
    keyOf: (book) => book.authors[0] ?? NO_AUTHOR,
    labelOf: (book) => book.authors[0] ?? NO_AUTHOR,
  },
  format: {
    keyOf: (book) => book.format,
    labelOf: (book) => formatLabel(book.format),
    rank: (key) => {
      const at = FORMAT_ORDER.indexOf(key as BookFormat);
      return at === -1 ? FORMAT_ORDER.length : at;
    },
  },
};

/**
 * Cut the shelf into sections.
 *
 * A book keeps its place *within* its section — grouping says which pile a book
 * is in, the order says where it sits in that pile, and the two are chosen
 * independently. Sections with a natural order (阅读状态, 文件格式) come back in
 * it; the rest come back largest first, so the section a reader most likely
 * wants is the one the shelf opens on.
 *
 * `none` returns no sections rather than one section holding everything: the
 * caller shows a heading when there is more than one pile to tell apart.
 */
export function shelfSections(list: BookSummary[], by: ShelfGroup): ShelfSections {
  if (by === "none") return { cards: list, sections: [] };

  const dimension = DIMENSIONS[by];
  const buckets = new Map<string, { label: string; books: BookSummary[] }>();
  for (const book of list) {
    const key = dimension.keyOf(book);
    const bucket = buckets.get(key);
    if (bucket) bucket.books.push(book);
    else buckets.set(key, { label: dimension.labelOf(book), books: [book] });
  }

  const rank = dimension.rank ?? (() => 0);
  const ordered = [...buckets].toSorted(
    ([aKey, a], [bKey, b]) =>
      rank(aKey) - rank(bKey) ||
      b.books.length - a.books.length ||
      a.label.localeCompare(b.label, "zh"),
  );

  const cards: BookSummary[] = [];
  const sections: BookSection[] = [];
  for (const [key, bucket] of ordered) {
    sections.push({ key, label: bucket.label, start: cards.length, count: bucket.books.length });
    cards.push(...bucket.books);
  }
  return { cards, sections };
}

/**
 * One line of the shelf as it is laid out: a heading, or a run of cards.
 *
 * The window counts *these*, not books. With a heading between the rows the
 * list is no longer `ceil(total / columns)` rows of one height, so there is no
 * pitch to derive a position from any more — every position comes from walking
 * the items instead.
 */
export type ShelfItem =
  { kind: "header"; section: BookSection } | { kind: "row"; from: number; to: number };

/**
 * How tall a heading is, and the only place that number is written down.
 *
 * `ShelfGrid` renders the heading at exactly this height, and the window walks
 * the list at exactly this height. They have to be the same number or every
 * card below a heading sits off by the difference — and compounds down the
 * list, section after section.
 *
 * The row gap between items is *not* included: the grid's own `row-gap` puts
 * that between a heading and whatever follows it, exactly as it does between
 * two rows of cards.
 */
export const SECTION_HEADER_H = 44;

/**
 * The shelf as lines: a heading per pile, then that pile's rows.
 *
 * Rows are cut *within* a pile, never across one, so every pile starts on a
 * fresh line and a heading never lands in the middle of a row. What that costs
 * is the tail of the previous pile's last line, which stays empty — visibly so,
 * since the heading below it is the only thing that line was ever going to be
 * interrupted by.
 *
 * A collapsed pile contributes its heading and nothing else: the cards are not
 * hidden by CSS, they are never in the list, so the window never renders them
 * and a folded shelf of 500 books costs one line per pile.
 */
export function shelfItems(
  sections: BookSection[],
  total: number,
  columns: number,
  collapsed: ReadonlySet<string>,
): ShelfItem[] {
  const piles =
    sections.length > 0
      ? sections.map((section) => ({
          section,
          from: section.start,
          to: section.start + section.count,
        }))
      : [{ section: null, from: 0, to: total }];
  const columnsPerRow = Math.max(1, columns);
  const items: ShelfItem[] = [];
  for (const pile of piles) {
    if (pile.section) items.push({ kind: "header", section: pile.section });
    if (pile.section && collapsed.has(pile.section.key)) continue;
    for (let from = pile.from; from < pile.to; from += columnsPerRow) {
      items.push({ kind: "row", from, to: Math.min(from + columnsPerRow, pile.to) });
    }
  }
  return items;
}
