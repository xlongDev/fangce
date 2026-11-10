import { beforeEach, describe, expect, it } from "vitest";

import { useCommandStore } from "@/stores/commands";
import { DEFAULT_SETTINGS, useSettings, withDefaults } from "@/stores/settings";
import type { Command } from "@/lib/commands";

const alpha: Command = { id: "a", title: "A", group: "g", run: () => {} };
const beta: Command = { id: "b", title: "B", group: "g", run: () => {} };

describe("useCommandStore", () => {
  beforeEach(() => {
    useCommandStore.setState({ commands: [] });
  });

  it("registers commands", () => {
    useCommandStore.getState().register([alpha]);
    expect(useCommandStore.getState().commands.map((c) => c.id)).toEqual(["a"]);
  });

  it("replaces an existing command with the same id instead of duplicating", () => {
    useCommandStore.getState().register([alpha]);
    useCommandStore.getState().register([{ ...alpha, title: "A2" }]);
    const commands = useCommandStore.getState().commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]?.title).toBe("A2");
  });

  it("unregisters by id", () => {
    useCommandStore.getState().register([alpha, beta]);
    useCommandStore.getState().unregister(["a"]);
    expect(useCommandStore.getState().commands.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("useSettings", () => {
  beforeEach(() => {
    useSettings.setState({
      theme: "system",
      transparency: "full",
      sidebarCollapsed: false,
    });
  });

  it("defaults to following the system theme", () => {
    expect(useSettings.getState().theme).toBe("system");
  });

  it("updates the theme", () => {
    useSettings.getState().setTheme("dark");
    expect(useSettings.getState().theme).toBe("dark");
  });

  it("toggles the sidebar", () => {
    useSettings.getState().toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(true);
    useSettings.getState().toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
  });

  it("opens 最近 in the order that answers why it was opened", () => {
    expect(DEFAULT_SETTINGS.shelfViews.recent.sort).toBe("recentlyRead");
    expect(DEFAULT_SETTINGS.shelfViews.all.sort).toBe("recentlyAdded");
  });

  it("keeps one shelf's arrangement off the others", () => {
    useSettings.setState(DEFAULT_SETTINGS);
    useSettings.getState().setShelfView("recent", { group: "author" });
    expect(useSettings.getState().shelfViews.recent.group).toBe("author");
    expect(useSettings.getState().shelfViews.all.group).toBe("none");
  });
});

/**
 * The rebind panel's whole storage.
 *
 * `null` is the delete: there is no "reset to default" value to store, because
 * an absent id already means "whatever the command declares". Getting that
 * wrong is how a panel ends up with two ways to say the same thing and a
 * restore that cannot be distinguished from a rebind to the same key.
 */
describe("useSettings key overrides", () => {
  beforeEach(() => {
    useSettings.setState({ keyOverrides: {} });
  });

  it("starts with nothing rebound", () => {
    expect(DEFAULT_SETTINGS.keyOverrides).toEqual({});
    expect(useSettings.getState().keyOverrides).toEqual({});
  });

  it("records an override against its id", () => {
    useSettings.getState().setKeyOverride("app.palette", [{ mod: true, key: "j" }]);
    expect(useSettings.getState().keyOverrides).toEqual({
      "app.palette": [{ mod: true, key: "j" }],
    });
  });

  it("keeps the other ids where they were", () => {
    useSettings.getState().setKeyOverride("app.palette", [{ mod: true, key: "j" }]);
    useSettings.getState().setKeyOverride("reader.chapter.next", [{ key: "n" }]);
    expect(Object.keys(useSettings.getState().keyOverrides).toSorted()).toEqual([
      "app.palette",
      "reader.chapter.next",
    ]);
  });

  it("replaces an id's keys rather than adding to them", () => {
    useSettings.getState().setKeyOverride("reader.chapter.next", [{ key: "n" }]);
    useSettings.getState().setKeyOverride("reader.chapter.next", [{ key: "j" }]);
    expect(useSettings.getState().keyOverrides["reader.chapter.next"]).toEqual([{ key: "j" }]);
  });

  it("drops the id when handed null, which is what puts the default back", () => {
    useSettings.getState().setKeyOverride("reader.chapter.next", [{ key: "n" }]);
    useSettings.getState().setKeyOverride("reader.chapter.next", null);
    expect(useSettings.getState().keyOverrides).toEqual({});
  });

  it("puts them all back at once", () => {
    useSettings.getState().setKeyOverride("app.palette", [{ mod: true, key: "j" }]);
    useSettings.getState().setKeyOverride("reader.chapter.next", [{ key: "n" }]);
    useSettings.getState().resetKeyOverrides();
    expect(useSettings.getState().keyOverrides).toEqual({});
  });
});

describe("withDefaults", () => {
  /** A payload written before 回收站 existed: four shelves, no `trash`. */
  const stored = {
    all: DEFAULT_SETTINGS.shelfViews.all,
    recent: DEFAULT_SETTINGS.shelfViews.recent,
    favorites: DEFAULT_SETTINGS.shelfViews.favorites,
    tags: DEFAULT_SETTINGS.shelfViews.tags,
  };

  it("gives a record the key it was stored without", () => {
    // The reported crash: `shelfViews.trash` was `undefined` on an existing
    // install, and the shelf destructured it. `persist` merges shallowly, so
    // the stored four-key record replaced the five-key default.
    const merged = withDefaults(stored, DEFAULT_SETTINGS.shelfViews);
    expect(merged.trash).toEqual(DEFAULT_SETTINGS.shelfViews.trash);
    expect(merged.all).toEqual(DEFAULT_SETTINGS.shelfViews.all);
  });

  it("keeps what the reader had actually changed", () => {
    const changed = { ...stored, all: { ...stored.all, sort: "titleAsc" as const } };
    expect(withDefaults(changed, DEFAULT_SETTINGS.shelfViews).all.sort).toBe("titleAsc");
  });

  it("falls back to the defaults for a missing or broken record", () => {
    expect(withDefaults(undefined, DEFAULT_SETTINGS.shelfViews)).toEqual(
      DEFAULT_SETTINGS.shelfViews,
    );
    expect(withDefaults(null, DEFAULT_SETTINGS.shelfViews)).toEqual(DEFAULT_SETTINGS.shelfViews);
  });
});
