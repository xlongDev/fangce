import { expect, test, type Page } from "@playwright/test";

/**
 * The resume card sits flush with the top of the shelf scroller, which has
 * `overflow: auto`. Lifting the whole card clipped its top edge, so the card
 * itself now only deepens its shadow: the cover lifts *inside* the card, the
 * caret eases out, and a one-pass gloss sweeps under the text like a shelf
 * tile. Reduced motion keeps the colour change and drops every travel.
 */
const card = (page: Page) => page.locator("[data-shelf-scroller] button").first();

const sheenX = (el: Element) =>
  Number.parseFloat(getComputedStyle(el).translate.split(" ")[0] ?? "0");

test("resume card lifts the cover, not its clipped top edge", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");

  const target = card(page);
  await expect(target).toBeVisible();
  const cover = target.locator("img").first().locator("xpath=..");
  const caret = target.locator("[data-continue-caret]");
  const sheen = target.locator("[data-continue-sheen]");

  const before = await target.evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    shadow: getComputedStyle(el).boxShadow,
  }));
  const coverBefore = await cover.evaluate((el) => el.getBoundingClientRect().top);
  const caretBefore = await caret.evaluate((el) => el.getBoundingClientRect().left);
  const sheenBefore = await sheen.evaluate(sheenX);
  const caretDuration = await caret.evaluate((el) => getComputedStyle(el).transitionDuration);

  await target.hover();
  // Wait for the actual cover lift rather than a fixed sleep: the actionability
  // wait inside `hover()` can absorb the card's entrance animation.
  await expect
    .poll(() => cover.evaluate((el) => el.getBoundingClientRect().top))
    .toBeLessThan(coverBefore - 1);

  const after = await target.evaluate((el) => ({
    top: el.getBoundingClientRect().top,
    shadow: getComputedStyle(el).boxShadow,
  }));
  const coverAfter = await cover.evaluate((el) => el.getBoundingClientRect().top);
  const caretAfter = await caret.evaluate((el) => el.getBoundingClientRect().left);

  expect(Math.abs(before.top - after.top)).toBeLessThan(0.5);
  expect(after.shadow).not.toBe(before.shadow);
  expect(coverBefore - coverAfter).toBeGreaterThan(1);
  expect(caretAfter - caretBefore).toBeGreaterThan(1);
  expect(caretDuration).toBe("0.3s");

  // One sweep, starting off the left edge and ending off the right. The gloss
  // is delayed behind the lift, so poll instead of sampling immediately.
  // Chrome reports `translate-x-full` as a percentage, so only the sign is
  // stable across engines: off the left edge before, off the right after.
  expect(sheenBefore).toBeLessThan(0);
  await expect.poll(() => sheen.evaluate(sheenX), { timeout: 3_000 }).toBeGreaterThan(0);
});

test("reduced motion keeps the colour change but drops the travel", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");

  const target = card(page);
  await expect(target).toBeVisible();
  const cover = target.locator("img").first().locator("xpath=..");
  const caret = target.locator("[data-continue-caret]");

  const before = await target.evaluate((el) => el.getBoundingClientRect().top);
  const coverBefore = await cover.evaluate((el) => el.getBoundingClientRect().top);
  const caretBefore = await caret.evaluate((el) => el.getBoundingClientRect().left);

  await target.hover();
  await page.waitForTimeout(200);

  const after = await target.evaluate((el) => el.getBoundingClientRect().top);
  const coverAfter = await cover.evaluate((el) => el.getBoundingClientRect().top);
  const caretAfter = await caret.evaluate((el) => el.getBoundingClientRect().left);

  expect(Math.abs(before - after)).toBeLessThan(0.5);
  expect(Math.abs(coverBefore - coverAfter)).toBeLessThan(0.5);
  expect(Math.abs(caretAfter - caretBefore)).toBeLessThan(0.5);
  await expect(target.locator("[data-continue-sheen]")).toBeHidden();
});
