import { expect, test } from "@playwright/test";

/**
 * An install whose saved settings predate the bin still opens it.
 *
 * `persist` merges the stored payload over the shipping defaults **shallowly**,
 * so a record that gained a key keeps its old shape and the new key reads as
 * `undefined`. When 回收站 became a fifth shelf, `shelfViews` went from four
 * keys to five, every existing install kept its four, and the page crashed on
 * `const { search } = view` — the unit suite cannot see it, because it never
 * rehydrates from storage.
 *
 * So the payload is written straight into `localStorage` before the app boots,
 * in the shape a reader who has been using this app for weeks would have.
 */
const OLD_PAYLOAD = {
  state: {
    shelfViews: {
      all: { search: "", sort: "recentlyAdded", descending: true, group: "none", tag: null },
      recent: { search: "", sort: "recentlyRead", descending: true, group: "none", tag: null },
      favorites: { search: "", sort: "recentlyAdded", descending: true, group: "none", tag: null },
      tags: { search: "", sort: "recentlyAdded", descending: true, group: "none", tag: null },
    },
  },
  version: 1,
};

test("a stored shelf view without 回收站 still opens it", async ({ page }) => {
  await page.addInitScript((payload) => {
    localStorage.setItem("fangce.settings", JSON.stringify(payload));
  }, OLD_PAYLOAD);

  await page.goto("/");
  await page.getByRole("link", { name: "回收站" }).click();

  // The heading is what the crash took with it: the boundary replaced the whole
  // page with 这个界面出错了, so its absence is the assertion.
  await expect(page.getByRole("heading", { level: 1, name: "回收站" })).toBeVisible();
  await expect(page.getByText("这个界面出错了")).toHaveCount(0);
  // And the merged view is a working one, not just a present one: the grid
  // rendered its own empty state, which reads `shelfViews` for its order.
  await expect(page.getByText("回收站是空的")).toBeVisible();
});
