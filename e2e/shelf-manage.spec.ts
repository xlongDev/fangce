import { expect, test } from "@playwright/test";

/**
 * Batch-manage mode.
 *
 * Three things are worth pinning down here:
 *
 * 1. The action bar sits centred on the shelf, not 150px off to the right of
 *    centre. A previous `motion.div` used `x: "-50%"` inside its own animate
 *    values; motion's transform overrode the inline `-50%` as soon as the
 *    spring settled, which left the bar visually off-centre. That fix used
 *    Tailwind v4's `-translate-x-1/2` (the `translate` property, not
 *    `transform`), which motion does not touch — but it centred the bar on
 *    the *window*, and the shelf is not the window: the sidebar pushes the
 *    reading pane ~130px right of centre, so the bar still read as off-centre
 *    to anyone looking at the shelf. It is now placed against the pane's
 *    measured centre.
 *
 *    Note what this test used to measure: the bar was reached through
 *    `getByRole("button", { name: "退出批量管理" })`, which was the *scrim* —
 *    a `fixed inset-0` button whose centre is the window's by construction.
 *    The assertion held regardless of where the bar sat.
 *
 * 2. A card click selects, and does not open the book. This is the whole
 *    mode, and it was broken: the scrim covered the shelf, so every click on
 *    a book landed on the dismiss layer and exited the mode instead. Both
 *    engines showed the same topmost element at a card's centre — the scrim,
 *    not the card. Playwright's own actionability check is the assertion:
 *    `click()` fails outright if the target does not receive the pointer.
 *
 * 3. Escape leaves the mode and drops the selection. With the scrim gone the
 *    keyboard needed its own way out; the bar's 完成 is the pointer one.
 */
test("batch-manage bar is centred on the shelf", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  await page.getByRole("button", { name: "选择", exact: true }).click();

  // The bar, not the scrim — see the note above.
  const bar = page.locator("[data-batch-bar]");
  await expect(bar).toBeVisible();

  // The pane the bar is centred in is the shelf scroller's own parent — the
  // exact element the placement effect measures (`scrollerRef`'s
  // `parentElement`), so the assertion and the implementation cannot drift
  // apart. It is not the window: that is the bug this replaced.
  const pane = (await page.locator("[data-shelf-scroller]").locator("xpath=..").boundingBox())!;
  const box = (await bar.boundingBox())!;
  const paneCentre = pane.x + pane.width / 2;
  const barCentre = box.x + box.width / 2;
  // ±2px slack — the spring lands within a couple of pixels at this size.
  expect(Math.abs(barCentre - paneCentre)).toBeLessThan(2);
  // And the pane's centre is not the window's, which is what the bar used to
  // be placed against — with the sidebar open they are ~130px apart. Without
  // this the assertion above would still pass if both had drifted together.
  expect(Math.abs(barCentre - 1280 / 2)).toBeGreaterThan(20);
});

test("cards select instead of opening, and Escape leaves the mode", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  await page.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.locator("[data-batch-bar]");
  await expect(bar).toContainText("已选 0 本");

  // `click()` rather than a coordinate: Playwright refuses to click an element
  // that does not receive the pointer at its own centre, which is exactly the
  // regression this covers.
  //
  // The two books are picked around the continue-reading card, which shows
  // demo-2 (the most recently read of the fixture) under its own button with
  // that title. demo-1 and demo-3 exist only on the shelf.
  const first = page.getByRole("button", { name: /我们为什么会生病/ }).first();
  await first.click();
  await expect(bar).toContainText("已选 1 本");

  await page
    .getByRole("button", { name: /长日将尽/ })
    .first()
    .click();
  await expect(bar).toContainText("已选 2 本");

  // Clicking a selected card again takes it back out.
  await first.click();
  await expect(bar).toContainText("已选 1 本");

  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  // Re-entering starts from nothing rather than from the last selection.
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await expect(page.locator("[data-batch-bar]")).toContainText("已选 0 本");
});

/**
 * Shelf layout switch.
 *
 * The shelf has two layouts: `grid` (cover-on-top tiles, two-to-six columns
 * by breakpoint) and `list` (single-column rows with a 64×88 cover).
 * Switching between them is a user-visible change, so a regression in
 * the segmented control or in `BookCard`'s `variant` prop breaks this.
 */
test("shelf layout switches between grid and list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  // Grid is the default: the first card uses an aspect-ratio cover, not a
  // fixed 64×88 list cover. The difference between the two is the whole
  // point of the switch, so a strict > 100 vs < 80 pair is enough — the
  // absolute width depends on the breakpoint (measured: 138 on a 6-column
  // 1280-wide shelf).
  const gridCover = page.locator("[data-book-cover]").first();
  const gridWidth = (await gridCover.boundingBox())!.width;
  expect(gridWidth).toBeGreaterThan(100);

  await page.getByRole("button", { name: "列表视图" }).click();
  const listCover = page.locator("[data-book-cover]").first();
  const listWidth = (await listCover.boundingBox())!.width;
  // The list cover is `w-16` (64px) — a narrower cover than the grid's.
  expect(listWidth).toBeLessThan(80);

  // Back to grid: the cover widens again.
  await page.getByRole("button", { name: "网格视图" }).click();
  const restoredWidth = (await page.locator("[data-book-cover]").first().boundingBox())!.width;
  expect(restoredWidth).toBeGreaterThan(100);
});
