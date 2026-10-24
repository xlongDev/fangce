import { describe, expect, it } from "vitest";

import {
  DEFAULT_READER_SETTINGS,
  foldScrollDelta,
  pageIsNight,
  updateReadingSpeed,
  useReaderSettings,
} from "@/stores/reader";

describe("foldScrollDelta", () => {
  it("keeps slow speeds moving by carrying sub-pixel steps across frames", () => {
    // 40 px/s on a 120 Hz display moves 0.33 px per frame; without the carry
    // every whole-pixel write rounds back to zero and the page never scrolls.
    let carry = 0;
    let moved = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      const fold = foldScrollDelta(40, 1 / 120, carry);
      carry = fold.carry;
      moved += fold.delta;
    }
    expect(moved).toBe(40);
  });

  it("emits whole pixels immediately at fast speeds", () => {
    const fold = foldScrollDelta(480, 1 / 60, 0);
    expect(fold.delta).toBe(8);
    expect(fold.carry).toBeLessThan(1e-9);
  });
});

describe("updateReadingSpeed", () => {
  it("averages a plausible session into the estimate", () => {
    // 600 chars in 120s = 300 cpm → 0.7*300 + 0.3*300 = 300.
    expect(updateReadingSpeed(300, 600, 120_000)).toBe(300);
    // 1000 chars in 50s = 1200 cpm → 0.7*300 + 0.3*1200 = 570.
    expect(updateReadingSpeed(300, 1000, 50_000)).toBe(570);
  });

  it("ignores sessions without progress or with implausible length", () => {
    expect(updateReadingSpeed(300, 0, 120_000)).toBe(300);
    expect(updateReadingSpeed(300, 50, 3_000)).toBe(300);
    expect(updateReadingSpeed(300, 50, 3600_000)).toBe(300);
  });

  it("clamps wild samples into a sane range", () => {
    // 10000 chars in 10s = far beyond the ceiling.
    expect(updateReadingSpeed(300, 10_000, 10_000)).toBe(300 * 0.7 + 1500 * 0.3);
  });
});

/**
 * The page indicator's boolean became a three-way scope in v7. A migration that
 * drops it is invisible until a reader who had page numbers on opens a book and
 * finds them gone, so it is pinned rather than trusted.
 *
 * `scopeOf` sits at module scope because it reads the store's live options at
 * call time and captures nothing; inside the `describe` it would be rebuilt per
 * call for no reason.
 */
function scopeOf(persisted: Record<string, unknown>): string {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return (options.migrate(persisted, 6) as { pageNumbers: string }).pageNumbers;
}

describe("v7 page-number scope migration", () => {
  it("carries a stored `true` over as the display it already had", () => {
    expect(scopeOf({ showPageNumbers: true })).toBe("chapter");
  });

  it("leaves an off indicator off", () => {
    expect(scopeOf({ showPageNumbers: false })).toBe("off");
    expect(scopeOf({})).toBe("off");
  });

  it("keeps a scope it already understands, and refuses one it does not", () => {
    expect(scopeOf({ pageNumbers: "book" })).toBe("book");
    // Not a value this version knows: the row would otherwise render with no
    // chip selected, which is worse than losing the preference.
    expect(scopeOf({ pageNumbers: "spread" })).toBe("off");
  });
});

describe("pageIsNight", () => {
  it("follows the app theme only when the reader asked it to", () => {
    // This is the whole point of the setting: `follow` is the only branch
    // that reads the app theme, so it is the only one that can change the
    // page under a foliate book — and changing the page there costs a
    // re-pagination of every loaded section.
    expect(pageIsNight("follow", false)).toBe(false);
    expect(pageIsNight("follow", true)).toBe(true);
  });

  it("holds the page where the reader pinned it, whatever the app does", () => {
    expect(pageIsNight("day", false)).toBe(false);
    expect(pageIsNight("day", true)).toBe(false);
    expect(pageIsNight("night", false)).toBe(true);
    expect(pageIsNight("night", true)).toBe(true);
  });

  it("reads the shipped default as following — `null` is 跟随主题", () => {
    // There is no snapshot resolving it any more: `null` *is* follow, so a
    // fresh install and a reader who picked 跟随主题 get the same answer, and
    // the page moves with the shell the moment the system theme does.
    expect(pageIsNight(null, false)).toBe(false);
    expect(pageIsNight(null, true)).toBe(true);
  });
});

/**
 * v8 has to tell "never chose" from "chose follow": the first launch used to
 * snapshot the page palette from the app theme, and a stored `follow` was the
 * old default rather than a decision to keep following. v13 removed the
 * snapshot, which took the reason to keep a stored pin in the shared slot with
 * it — see the v13 describe below for what that half became.
 */
function pageThemeOf(persisted: Record<string, unknown>): unknown {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return (options.migrate(persisted, 7) as { pageTheme: unknown }).pageTheme;
}

describe("v8 page-theme migration", () => {
  it("reads a stored `follow` as never having chosen", () => {
    expect(pageThemeOf({ pageTheme: "follow" })).toBeNull();
    expect(pageThemeOf({})).toBeNull();
  });

  it("leaves a stored pin where v8 is concerned — v13 is what drops it", () => {
    // v8's own rule was that a pin is a choice. What turned out to be true is
    // that the shared slot never held one: the snapshot was its only writer,
    // and a reader's own choice goes to `byBook[bookId]`. So by the time the
    // whole migrate body has run, both land on 跟随主题.
    expect(pageThemeOf({ pageTheme: "night" })).toBeNull();
    expect(pageThemeOf({ pageTheme: "day" })).toBeNull();
  });
});

/**
 * v11 retires the bundled webfont key. `lxgw` selected a face only `pnpm dev`
 * carried; no build ships one now, and an unmigrated key resolves to the system
 * *sans* rather than to the 楷体 that stack used to fall through to — the
 * reader's page changing font on upgrade, with nothing to explain it.
 */
function fontFamilyOf(persisted: Record<string, unknown>): unknown {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return (options.migrate(persisted, 10) as { fontFamily: unknown }).fontFamily;
}

describe("v11 bundled-font-key migration", () => {
  it("moves the retired bundled key to the family its stack fell through to", () => {
    expect(fontFamilyOf({ fontFamily: "lxgw" })).toBe("kai");
  });

  it("leaves every key the app still knows alone", () => {
    // Not `system`: v10 turns that into `book` on its own account (it was the
    // old default rather than a choice), and this migration must not interfere
    // with that.
    for (const key of ["book", "song", "kai", "hei", "catalog:lxgw"]) {
      expect(fontFamilyOf({ fontFamily: key }), key).toBe(key);
    }
  });
});

/**
 * v12 carries two default changes to installs that already have the app — see
 * the migrate body. Both are invisible without it, which is the whole reason
 * they are here: a fresh install reads `DEFAULT_READER_SETTINGS`, an installed
 * one reads its own persisted store, and the two are only the same on a machine
 * that has never run this build.
 */
function v12(persisted: Record<string, unknown>): Record<string, unknown> {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return options.migrate(persisted, 11) as unknown as Record<string, unknown>;
}

describe("v12 default-layout migration", () => {
  it("takes the old scrolled default to 单页 on an installed store", () => {
    // The change itself landed a day earlier (87558c4); without this line the
    // default only ever reached a fresh install, and every reader who already
    // had the app kept opening books in 滚动.
    expect(v12({ layoutMode: "scroll" }).layoutMode).toBe("single");
  });

  it("leaves a layout the reader picked alone", () => {
    for (const key of ["single", "double"]) {
      expect(v12({ layoutMode: key }).layoutMode, key).toBe(key);
    }
  });

  it("refuses a value it does not know, so the row is never chipless", () => {
    // Anything unrecognised lands on the default rather than surviving into a
    // `layoutMode === "scroll"` test that silently means nothing.
    expect(v12({ layoutMode: "columns" }).layoutMode).toBe("single");
  });
});

describe("v12 pdfNight axis migration", () => {
  it("reads the old `true` as never having chosen, so a PDF follows the theme", () => {
    // `true` was the old default: every PDF night-rendered, in daylight too.
    // Mapping it to the new `follow` is what finally gives a daylight PDF the
    // colours it was published with.
    expect(v12({ pdfNight: true }).pdfNight).toBe("follow");
    expect(v12({}).pdfNight).toBe("follow");
  });

  it("keeps a reader who turned it off on 原色", () => {
    // The asymmetry with the line above is the point: `false` was a choice,
    // and `follow` would have handed the night palette back at dusk.
    expect(v12({ pdfNight: false }).pdfNight).toBe("day");
  });

  it("keeps every state it already writes, and refuses the ones it does not", () => {
    for (const key of ["follow", "day", "night"]) {
      expect(v12({ pdfNight: key }).pdfNight, key).toBe(key);
    }
    // Same reasoning as the layout row: an unrecognised value must not survive
    // into the picker, where it would render with no chip lit.
    expect(v12({ pdfNight: "sepia" }).pdfNight).toBe("follow");
  });
});

/**
 * v13 retires the first-launch snapshot of the page palette: 跟随主题 is the
 * default again, and the pin the snapshot left in the shared slot has to go
 * with it. Same two-step as v12 — without the line in the migrate body the new
 * default only ever reaches a fresh install, and every reader who already had
 * the app keeps opening books on the palette their first launch happened to
 * land on.
 */
function v13(persisted: Record<string, unknown>): Record<string, unknown> {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return options.migrate(persisted, 12) as unknown as Record<string, unknown>;
}

describe("v13 page-theme un-pin migration", () => {
  it("drops the snapshot's pin back to 跟随主题", () => {
    expect(v13({ pageTheme: "day" }).pageTheme).toBeNull();
    expect(v13({ pageTheme: "night" }).pageTheme).toBeNull();
    // Already following — including a store that never had the app installed
    // long enough to be pinned.
    expect(v13({ pageTheme: "follow" }).pageTheme).toBeNull();
    expect(v13({}).pageTheme).toBeNull();
  });

  it("leaves a book's own pinned palette alone", () => {
    // Per-book values are real choices: the reader made them in the panel
    // while reading that book, which is the only place the panel can write.
    // Only the shared slot was ever machine-written.
    const byBook = { b1: { pageTheme: "night" }, b2: { pageTheme: "day" } };
    expect(v13({ byBook }).byBook).toEqual(byBook);
  });
});

/**
 * v14 carries two more default changes to installed stores — 段首缩进 on, and
 * the read-aloud wash on 词语. Same two-step as v12 and v13.
 */
function v14(persisted: Record<string, unknown>): Record<string, unknown> {
  const options = useReaderSettings.persist.getOptions();
  if (!options.migrate) throw new Error("the store lost its migrate function");
  return options.migrate(persisted, 13) as unknown as Record<string, unknown>;
}

describe("v14 indent and wash-granularity migration", () => {
  it("turns 段首缩进 on for an installed store", () => {
    // The shared slot is only ever the default: the panel writes `indent` to
    // `byBook[bookId]` (it is in `BOOK_SETTINGS`), so a `false` here is the
    // old default rather than a choice.
    expect(v14({ indent: false }).indent).toBe(true);
    expect(v14({}).indent).toBe(true);
  });

  it("leaves a book's own 段首缩进 alone", () => {
    // A `false` under `byBook` was written from the panel — the reader turned
    // it off while reading that book, and that is a choice.
    const byBook = { b1: { indent: false }, b2: { indent: true } };
    expect(v14({ byBook }).byBook).toEqual(byBook);
  });

  it("takes a stored 句子 to 词语", () => {
    // `speechGranularity` is app-wide and the panel is its only writer, so a
    // stored `sentence` is the old default: "never chose".
    expect(v14({ speechGranularity: "sentence" }).speechGranularity).toBe("word");
    // The two the reader could have picked deliberately stay put.
    expect(v14({ speechGranularity: "paragraph" }).speechGranularity).toBe("paragraph");
    expect(v14({ speechGranularity: "word" }).speechGranularity).toBe("word");
  });
});

describe("shipped defaults", () => {
  it("opens a book paged, and leaves a PDF in the colours it was published with", () => {
    // The two asks, as the *fresh install* sees them. The migration tests above
    // cover the installed case; this one is the pair they are migrating to, so
    // a default changed in one place and not the other shows up here.
    expect(DEFAULT_READER_SETTINGS.layoutMode).toBe("single");
    expect(DEFAULT_READER_SETTINGS.pdfNight).toBe("follow");
    // And `follow` on a day page is 原色 — the promise the setting makes is
    // only true if the predicate agrees with it.
    expect(pageIsNight(DEFAULT_READER_SETTINGS.pdfNight, false)).toBe(false);
    expect(pageIsNight(DEFAULT_READER_SETTINGS.pdfNight, true)).toBe(true);
  });

  it("lets the page follow the theme instead of pinning it on first launch", () => {
    // The reversal of the 2026-09-19 decision. The snapshot kept theme
    // switches cheap and quietly broke the promise instead: the pin never
    // re-ran, so a reader who switched themes later got a shell that changed
    // colour around a book that did not. Following is the default again and
    // the re-pagination is a cost the reader opts into by pinning.
    expect(DEFAULT_READER_SETTINGS.pageTheme).toBeNull();
    expect(pageIsNight(DEFAULT_READER_SETTINGS.pageTheme, false)).toBe(false);
    expect(pageIsNight(DEFAULT_READER_SETTINGS.pageTheme, true)).toBe(true);
  });

  it("gives a book an indented first line and washes the spoken word", () => {
    // What the reader sees the first time they take the layout back
    // (段首缩进 only exists under 自定义) and the first time the voice runs.
    expect(DEFAULT_READER_SETTINGS.indent).toBe(true);
    expect(DEFAULT_READER_SETTINGS.speechGranularity).toBe("word");
  });
});
