/**
 * What to call a catalogue in front of its rating.
 *
 * Douban and NeoDB both have ratings and they are different numbers from
 * different sets of people — 《活着》 is 9.4 with a few hundred thousand readers
 * on Douban and 9.2 with 995 on NeoDB. Printing the number without the name is
 * the one thing that would make it a lie, so both the sheet and the fill list
 * go through here.
 *
 * `null` should not happen — every rating is stored with its source, and rows
 * that predate the column were backfilled as NeoDB's, which is what they were.
 * It falls back to a word that is not a catalogue name rather than guessing.
 */
export function sourceLabel(source: string | null | undefined): string {
  if (source === "douban") return "豆瓣";
  if (source === "neodb") return "NeoDB";
  return "评分";
}

import type { MetadataFill, Proposal } from "@/types/ipc";

/** The sheet's field names, in the order the form shows them. */
export const FIELD_LABELS: Record<string, string> = {
  subtitle: "副标题",
  publisher: "出版社",
  language: "语言",
  isbn: "ISBN",
  publishedYear: "出版年",
  description: "简介",
};

/**
 * 「已有 出版社、语言」 — what a fill is *not* going to touch.
 *
 * A row that offers two fields reads as a catalogue with thin data unless it
 * also says the other four were already there. Without it, a book filled last
 * week and a book nobody has ever filled look the same in the list.
 *
 * Long lists are summarised: 「已有 副标题、出版社 等 5 项」 keeps the row one
 * line, and the names are there for the two that matter most in practice.
 */
export function existingHint(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const names = fields.map((field) => FIELD_LABELS[field] ?? field);
  if (names.length <= 3) return `已有 ${names.join("、")}`;
  return `已有 ${names.slice(0, 2).join("、")} 等 ${names.length} 项`;
}

/** Whether a proposal would write anything at all.
 *
 * A book whose six fields are already there still gains a rating, a Douban
 * link, or a cover — judging by `fills` alone rendered those rows greyed out
 * and untickable, with no reason line. */
export function hasSomething(proposal: Proposal): boolean {
  return (
    proposal.fills.length > 0 ||
    typeof proposal.rating === "number" ||
    proposal.doubanUrl != null ||
    proposal.coverUrl != null
  );
}

/** A proposal as the write it asks for: only the fields it named. */
export function toFill(proposal: Proposal): MetadataFill {
  const fill: MetadataFill = {
    id: proposal.bookId,
    subtitle: null,
    publisher: null,
    language: null,
    isbn: null,
    publishedYear: null,
    description: null,
    // The catalogue's snapshot travels with the fills rather than as a fill.
    rating: proposal.rating,
    ratingCount: proposal.ratingCount,
    ratingSource: proposal.ratingSource,
    doubanUrl: proposal.doubanUrl,
    coverUrl: proposal.coverUrl,
  };
  for (const item of proposal.fills) {
    if (item.field === "subtitle") fill.subtitle = item.to;
    if (item.field === "publisher") fill.publisher = item.to;
    if (item.field === "language") fill.language = item.to;
    if (item.field === "isbn") fill.isbn = item.to;
    if (item.field === "description") fill.description = item.to;
    if (item.field === "publishedYear") {
      const year = Number.parseInt(item.to, 10);
      if (Number.isFinite(year)) fill.publishedYear = year;
    }
  }
  return fill;
}
