import { afterEach, describe, expect, it } from "vitest";

import { adoptCatalogFont, isCatalogAdopted } from "@/features/reader/catalogFont";
import { catalogKey } from "@/lib/fontCatalog";
import { resetAllSettings } from "@/stores/reset";
import { DEFAULT_SETTINGS, useSettings } from "@/stores/settings";
import { DEFAULT_READER_SETTINGS, useReaderSettings } from "@/stores/reader";

/** The `localStorage` key the catalogue sheets live under — see
 *  `catalogFont.test.ts` for why it is spelled out rather than imported. */
const SHEET_STORE = "fangce.catalogFontSheets";

describe("resetAllSettings", () => {
  afterEach(() => {
    useSettings.setState(DEFAULT_SETTINGS);
    useReaderSettings.setState(DEFAULT_READER_SETTINGS);
    for (const element of document.querySelectorAll('[id^="catalog-font-"]')) element.remove();
  });

  it("puts both persisted stores back to what the app shipped with", () => {
    useSettings.setState({
      theme: "dark",
      accent: { kind: "custom", hex: "#5566aa" },
      shelfLayout: "list",
      sidebarCollapsed: true,
    });
    useReaderSettings.setState({ fontSize: 26, marginX: 160, surface: "sepia" });

    resetAllSettings();

    expect(useSettings.getState().theme).toBe("system");
    expect(useSettings.getState().accent).toEqual(DEFAULT_SETTINGS.accent);
    expect(useSettings.getState().shelfLayout).toBe("grid");
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
    expect(useReaderSettings.getState().fontSize).toBe(18);
    expect(useReaderSettings.getState().marginX).toBe(DEFAULT_READER_SETTINGS.marginX);
    expect(useReaderSettings.getState().surface).toBe("standard");
  });

  it("leaves the page palette following the theme, pinned or not", () => {
    // The page palette is no longer snapshotted, so a restore drops it back to
    // 跟随主题 like everything else — the same thing a first launch gets. It
    // used to be re-resolved here, and that is where the "dark shell, day
    // book" a reader could not undo came from: the reset installed
    // `theme: "system"` while pinning the page from the theme the reader had
    // been on a moment before, and the pin never re-ran.
    useReaderSettings.setState({ pageTheme: "day" });

    resetAllSettings();

    expect(useReaderSettings.getState().pageTheme).toBeNull();
    expect(useSettings.getState().theme).toBe("system");
  });

  it("puts the rebound keys back with everything else", () => {
    // Rebound keys are preferences like any other, so 重置 is where a reader
    // who has made a mess of the keyboard goes. It is asserted here rather
    // than left to the panel because the panel has its own 全部恢复默认 — two
    // buttons that have to mean the same thing.
    useSettings.getState().setKeyOverride("reader.chapter.next", [{ key: "n" }]);
    resetAllSettings();
    expect(useSettings.getState().keyOverrides).toEqual({});
  });

  it("uninstalls the catalogue fonts along with the flag that lists them", () => {
    // 下载 is two writes — the id in `downloadedFonts` and the sheet in the
    // document — and only the first of them is a preference. Clearing one and
    // leaving the other is the bug this pins: 霞鹜文楷 stayed declared and
    // rendering, with no row anywhere saying it was installed and no way for
    // the reader to take it out short of a reinstall.
    adoptCatalogFont("lxgw", '@font-face { font-family: "LXGW WenKai" }');
    localStorage.setItem(SHEET_STORE, JSON.stringify({ lxgw: { fingerprint: "x", css: "y" } }));
    useSettings.setState({ downloadedFonts: ["lxgw"] });
    useReaderSettings.setState({ fontFamily: catalogKey("lxgw") });

    resetAllSettings();

    expect(useSettings.getState().downloadedFonts).toEqual([]);
    // …and the picker is back on 原书 rather than on a key whose sheet just
    // went away — which `useAdoptedFontKey` would read as "not installed yet"
    // and go and fetch again.
    expect(useReaderSettings.getState().fontFamily).toBe("book");
    expect(isCatalogAdopted("lxgw")).toBe(false);
    expect(localStorage.getItem(SHEET_STORE)).toBeNull();
  });
});
