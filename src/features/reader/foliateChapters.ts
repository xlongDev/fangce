/**
 * Read-aloud navigation across a foliate book's table of contents.
 *
 * A chapter in the reader's TOC and a spine section in the EPUB are different
 * things. A body section is commonly followed by one or more plate-only
 * sections (a photo with a one-line caption) that have no TOC entry of their
 * own. Rolling the voice by `section + 1` therefore lands on a plate, plays
 * nothing, and looks exactly like the reader stopped mid-book. Rolling by the
 * next TOC entry's own section skips straight to the next real chapter.
 */

/**
 * The spine section the next TOC chapter starts at, strictly after `from`.
 *
 * `entryStarts` is the flattened TOC resolved to spine indices, in document
 * order. Returns `null` once `from` is at or past the last chapter — the one
 * place the voice genuinely stops. A book with no resolvable TOC falls back
 * to the next spine section, which is the old behaviour.
 */
export function nextChapterSection(
  entryStarts: readonly number[],
  from: number,
  sectionCount: number,
): number | null {
  const target =
    entryStarts.find((index) => index > from) ?? (entryStarts.length === 0 ? from + 1 : null);
  return target === null || target >= sectionCount ? null : target;
}
