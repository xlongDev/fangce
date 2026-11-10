import { describe, expect, it } from "vitest";

import {
  NO_FILTERS,
  activeFilterCount,
  buildBookQuery,
  resolveTagFilter,
  toggleValue,
  type ShelfFilters,
} from "@/features/library/shelfQuery";

describe("buildBookQuery", () => {
  it("forwards the sort unchanged on the `recent` filter", () => {
    // The whole point of the fix: the shelf's sort dropdown stops being a
    // fake control. Readers who open it and pick 文件大小 get the order they
    // asked for; readers who never touch it keep the store default.
    const picks = ["recentlyAdded", "titleAsc", "authorAsc", "formatAsc", "sizeDesc"] as const;
    for (const sort of picks) {
      expect(buildBookQuery("recent", sort, "", null).sort).toBe(sort);
    }
  });

  it("maps `all` to the all shelf and forwards sort", () => {
    expect(buildBookQuery("all", "titleAsc", "", null)).toEqual({
      filter: "all",
      sort: "titleAsc",
      search: undefined,
      tag: undefined,
    });
  });

  it("passes `recent` and `favorites` through as filter values", () => {
    expect(buildBookQuery("favorites", "recentlyRead", "", null).filter).toBe("favorites");
    expect(buildBookQuery("recent", "recentlyRead", "", null).filter).toBe("recent");
  });

  it("carries the active tag only on the tag shelf", () => {
    expect(buildBookQuery("tags", "recentlyRead", "", "历史").tag).toBe("历史");
    expect(buildBookQuery("all", "recentlyRead", "", "历史").tag).toBeUndefined();
  });

  it("trims the search and drops an empty one", () => {
    expect(buildBookQuery("all", "recentlyRead", "  马尔克斯  ", null).search).toBe("马尔克斯");
    expect(buildBookQuery("all", "recentlyRead", "   ", null).search).toBeUndefined();
  });
});

describe("resolveTagFilter", () => {
  const known = [{ name: "小说" }, { name: "悬疑" }];

  it("keeps a label that still exists", () => {
    expect(resolveTagFilter("小说", known)).toBe("小说");
  });

  it("falls back to the whole shelf when the remembered label is gone", () => {
    // The case `TagBar` cannot see: deleting from the bar clears the choice,
    // but a label removed from its last book elsewhere does not — and the
    // filter would then point at nothing.
    expect(resolveTagFilter("历史", known)).toBeNull();
    expect(resolveTagFilter("小说", [])).toBeNull();
  });

  it("keeps the choice while the labels are still loading", () => {
    // `undefined` is "not known yet", not "there are none". Treating them the
    // same would forget the choice on every mount.
    expect(resolveTagFilter("小说", undefined)).toBe("小说");
  });

  it("stays on the whole shelf when nothing was remembered", () => {
    expect(resolveTagFilter(null, known)).toBeNull();
    expect(resolveTagFilter(null, undefined)).toBeNull();
  });
});

describe("shelf filters", () => {
  it("sends nothing the panel did not narrow", () => {
    // An untouched panel must produce the request the shelf sent before it
    // existed, or every reader pays for a filter they never opened.
    const query = buildBookQuery("all", "recentlyAdded", "", null, NO_FILTERS);
    expect(query.formats).toBeUndefined();
    expect(query.languages).toBeUndefined();
    expect(query.publishers).toBeUndefined();
    expect(query.status).toBeUndefined();
    expect(query.hasCover).toBeUndefined();
  });

  it("forwards a narrowed panel", () => {
    const filters: ShelfFilters = {
      formats: ["epub"],
      languages: ["zh"],
      publishers: [],
      status: "reading",
      hasCover: false,
    };
    expect(buildBookQuery("all", "recentlyAdded", "", null, filters)).toMatchObject({
      formats: ["epub"],
      languages: ["zh"],
      publishers: undefined,
      status: "reading",
      hasCover: false,
    });
  });

  it("counts dimensions, not values", () => {
    // Two formats and one status is two things the reader switched on, and
    // the badge has to agree with what 清空筛选 will undo.
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, formats: ["epub", "pdf"], status: "finished" })).toBe(
      2,
    );
    expect(activeFilterCount({ ...NO_FILTERS, hasCover: false })).toBe(1);
  });

  it("toggles a value without mutating the list it was given", () => {
    const list = ["epub"];
    expect(toggleValue(list, "pdf")).toEqual(["epub", "pdf"]);
    expect(toggleValue(list, "epub")).toEqual([]);
    expect(list).toEqual(["epub"]);
  });

  it("reads the bin instead of narrowing the shelf", () => {
    // `trash` swaps the set of rows; `filter` stays `all` because 「最近」 and
    // 「收藏」 are facts about the shelf, not about the bin.
    const bin = buildBookQuery("trash", "recentlyAdded", "", null, NO_FILTERS);
    expect(bin.trash).toBe(true);
    expect(bin.filter).toBe("all");

    // Every other shelf must not send it — an absent flag is what keeps an
    // older caller's request byte-identical.
    expect(buildBookQuery("all", "recentlyAdded", "", null).trash).toBeUndefined();
    expect(buildBookQuery("favorites", "recentlyAdded", "", null).trash).toBeUndefined();
  });
});
