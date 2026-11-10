import type { BookFormat, BookQuery, LibrarySort, ReadingStatus } from "@/types/ipc";

/**
 * The five shelves, which are one page with a filter rather than five routes:
 * the chrome is identical, so a route change would remount the whole grid for
 * a heading.
 *
 * `tags` is a shelf of its own because it carries a second selection (which
 * tag), which no other filter has. `trash` is one because it reads a different
 * set of rows — the bin — rather than narrowing the same set.
 */
export type LibraryFilter = "all" | "recent" | "favorites" | "tags" | "trash";

/**
 * What the 筛选 panel narrows, on top of whichever shelf is open.
 *
 * A separate object from the shelf rather than more fields on the page state:
 * 「清空筛选」 has to reset exactly this and nothing else, and the panel's
 * count badge has to mean one thing.
 */
export interface ShelfFilters {
  formats: BookFormat[];
  languages: string[];
  publishers: string[];
  status: ReadingStatus;
  /** `null` = don't care; `true` / `false` = has / has not. */
  hasCover: boolean | null;
}

export const NO_FILTERS: ShelfFilters = {
  formats: [],
  languages: [],
  publishers: [],
  status: "any",
  hasCover: null,
};

/** How many dimensions are in use — the number on the button. */
export function activeFilterCount(filters: ShelfFilters): number {
  return (
    (filters.formats.length > 0 ? 1 : 0) +
    (filters.languages.length > 0 ? 1 : 0) +
    (filters.publishers.length > 0 ? 1 : 0) +
    (filters.status !== "any" ? 1 : 0) +
    (filters.hasCover !== null ? 1 : 0)
  );
}

/** Adds `value` to the list, or takes it out when it is already there. */
export function toggleValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/**
 * Build the `BookQuery` the shelf reads.
 *
 * The `recent` filter used to force `sort: recentlyRead` here, which made the
 * sort dropdown a fake control on the shelf — readers who opened the menu
 * and picked, say, "文件大小" would see no change. The store's default is
 * still `recentlyRead`, so the shelf is unchanged for readers who never open
 * the dropdown; everyone else gets the sort they asked for.
 *
 * The narrowing fields are only sent when they are set, so an untouched panel
 * produces the same request the shelf sent before it existed.
 *
 * `trash` is not a narrowing: it swaps the set of rows the query reads, and the
 * `filter` enum is forced to `all` there because 「最近」 and 「收藏」 are facts
 * about the shelf, not about the bin.
 */
export function buildBookQuery(
  filter: LibraryFilter,
  sort: LibrarySort,
  search: string,
  tag: string | null,
  filters: ShelfFilters = NO_FILTERS,
): BookQuery {
  const trash = filter === "trash";
  return {
    filter: filter === "recent" || filter === "favorites" ? filter : "all",
    sort,
    search: search.trim() || undefined,
    tag: filter === "tags" ? (tag ?? undefined) : undefined,
    formats: filters.formats.length > 0 ? filters.formats : undefined,
    languages: filters.languages.length > 0 ? filters.languages : undefined,
    publishers: filters.publishers.length > 0 ? filters.publishers : undefined,
    status: filters.status === "any" ? undefined : filters.status,
    hasCover: filters.hasCover ?? undefined,
    trash: trash ? true : undefined,
  };
}

/**
 * The label the 标签 shelf should actually filter by.
 *
 * A remembered label can be deleted while the shelf is away. Deleting it from
 * the bar clears the choice itself (`TagBar` calls `onSelect(null)`), but a
 * label removed from its last book somewhere else does not — and a filter
 * pointing at a label that no longer exists is an empty grid with no chip lit
 * to explain it, which reads as a broken shelf rather than as a filter. So an
 * unknown label falls back to the whole shelf.
 *
 * `undefined` means "the labels are not loaded yet", not "there are none":
 * dropping the choice then would forget it on every mount.
 */
export function resolveTagFilter(
  remembered: string | null,
  known: readonly { name: string }[] | undefined,
): string | null {
  if (remembered === null || known === undefined) return remembered;
  return known.some((entry) => entry.name === remembered) ? remembered : null;
}

/** Time-of-day lead on the shelf heading. */
export function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}
