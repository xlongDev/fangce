import { expect, test } from "@playwright/test";

const SHELF = "/?demo=1&books=24";

/**
 * The Calibre scan is desktop-only (it opens a real directory), so the web
 * build can only be checked for an honest refusal.
 *
 * The entry lives in `ShelfHeader` with the other "where a book comes from"
 * buttons, so the toolbar keeps the seven controls whose reflow is pinned by
 * `shelf-reflow.spec.ts`.
 *
 * Grouping toolbar children by `getBoundingClientRect().top` does **not** count
 * rows: with `items-center`, children of different heights have different tops
 * inside one row. An early version of the second test used tops and reported a
 * third row even with the extra button removed. Vertical centres are the row
 * identity.
 */
test("the web build says the scan needs the desktop app", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  const button = page.getByRole("button", { name: "扫描 Calibre 书库" });
  await expect(button).toBeVisible();
  await button.click();

  await expect(page.getByText(/只在桌面版可用/)).toBeVisible();
  // Not an empty picker that pretends there is nothing to scan, and no import
  // action that could never work without a filesystem.
  await expect(page.getByRole("button", { name: /选择书库目录/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /导入选中的/ })).toHaveCount(0);
});

test("the shelf toolbar still fits on two rows", async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  // `items-center` means children of different heights have different `top`
  // within the *same* row. Their vertical centres are the row identity.
  const layout = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "查找疑似重复",
    );
    const toolbar = button?.parentElement;
    if (!toolbar) return { rows: -1, centers: [] as number[] };
    const centers = [...toolbar.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return Math.round(rect.top + rect.height / 2);
    });
    return { rows: new Set(centers).size, centers };
  });

  expect(layout.rows, `toolbar row centres: ${layout.centers.join(", ")}`).toBeLessThanOrEqual(2);
});
