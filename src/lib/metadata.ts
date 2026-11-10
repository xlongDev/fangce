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
