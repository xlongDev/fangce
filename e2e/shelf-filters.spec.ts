import { expect, test } from "@playwright/test";

/**
 * The 筛选 panel: it opens, it counts, and a chip it cannot honour is not
 * offered.
 *
 * The counts themselves are covered in Rust (`repository::facets`, nine cases)
 * and in the pure-function tests; what only a browser can say is that the panel
 * renders from `demoFacets`, that a chip is a checkbox rather than a button
 * that lies about its state, and that the panel stays open while you pick —
 * a filter sheet that closes on the first choice is a sheet you open six times.
 *
 * `?demo=1` is all-txt, all-covered and has no publisher, which is enough to
 * exercise a value that exists, a value that does not, and a whole section that
 * has nothing to say.
 */
const SHELF = "/?demo=1&books=24";

test("the filter panel counts, toggles and clears", async ({ page }) => {
  await page.goto(SHELF);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  await page.getByRole("button", { name: "筛选" }).click();
  const panel = page.getByRole("menu", { name: "筛选书库" });
  await expect(panel).toBeVisible();

  // Every sample book is a txt with a cover, so this is the one format the
  // panel should offer, and 无封面 is a value with nothing behind it.
  const txt = panel.getByRole("menuitemcheckbox", { name: /TXT/ });
  await expect(txt).toBeVisible();
  await expect(txt).toHaveAttribute("aria-checked", "false");

  const none = panel.getByRole("menuitemcheckbox", { name: /无封面/ });
  await expect(none).toBeDisabled();

  // No publisher anywhere in the fixture means no publisher section at all —
  // an empty heading would read as a broken panel.
  await expect(panel.getByText("出版社")).toHaveCount(0);

  await txt.click();
  await expect(txt).toHaveAttribute("aria-checked", "true");
  // The panel survives the pick: narrowing is a sequence, not a single choice.
  await expect(panel).toBeVisible();
  // The badge counts dimensions, not values.
  await expect(page.getByRole("button", { name: /筛选/ })).toContainText("1");

  await panel.getByRole("menuitem", { name: "清空筛选" }).click();
  await expect(txt).toHaveAttribute("aria-checked", "false");

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

/**
 * The panel floats over the cover grid, so its material is a balance: dense
 * enough that labels stay readable over bright artwork, but still liquid —
 * blur and a lit rim, not an opaque slab. It used to be `glass-2` with a padded
 * inner edge, which showed as a second rectangle around the chips.
 */
test("the filter panel is one liquid pane, legible over covers", async ({ page }) => {
  await page.goto(SHELF);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.getByRole("button", { name: "筛选" }).click();
  const panel = page.getByRole("menu", { name: "筛选书库" });
  await expect(panel).toBeVisible();

  const style = await panel.evaluate((el) => {
    const s = getComputedStyle(el);
    // The panel's own padding was the second rectangle: a 6px bare ring
    // between its rim and the chips. Padding now lives inside the scroll area.
    return {
      padding: parseFloat(s.paddingLeft),
      bg: s.backgroundColor,
      rim: s.borderTopColor,
    };
  });

  expect(style.padding).toBe(0);
  // The fill is surface-3 mixed at 84%: translucent enough for the covers to
  // colour the glass, dense enough to keep the labels clear of them. WebKit
  // serialises the colour as `color(srgb … / 0.76)`, Chromium as `rgba(…, 0.76)`,
  // so compare the alpha rather than the string.
  const alpha = parseFloat(style.bg.match(/([\d.]+)\)$/)?.[1] ?? "0");
  expect(alpha).toBeGreaterThan(0.7);
  expect(alpha).toBeLessThan(0.85);
  expect(style.rim).not.toBe("rgba(0, 0, 0, 0)");
});
