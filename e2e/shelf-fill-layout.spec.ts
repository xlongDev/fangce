import { expect, test } from "@playwright/test";

/**
 * The batch-fill sheet has to fit the window it is drawn in.
 *
 * It shipped twice with the opposite: the body was unbounded, and twelve rows of
 * six fills — one of them a 4000-character blurb printed in full — ran off both
 * edges, leaving the title above the top of the screen and 补全 below the
 * bottom. Neither is visible in a screenshot of the list itself, which is why
 * this measures the box instead of trusting the look.
 *
 * `?demo=1` serves canned proposals (see `demoProposals`); the first one always
 * carries a full-length blurb, so the worst case is the case under test.
 */
test("the fill sheet fits the window and its list scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  // A shelf big enough to overflow the list: the default demo shelf is three
  // books, which fits and would have let the bug through.
  await page.goto("/?demo=1&books=24");
  await expect(page.getByRole("button", { name: /我们为什么会生病/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByRole("button", { name: "全选" }).click();
  await page.getByRole("button", { name: "补全信息" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("只填空着的字段");

  const box = await sheet.boundingBox();
  expect(box, "dialog has a box").not.toBeNull();
  // Both edges inside the window: a sheet that is taller than the viewport is
  // centred past the top, and the title disappears.
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);

  // The list is the part that scrolls — if it is not scrollable, the cap moved
  // to the wrong element and the sheet is growing again.
  const list = sheet.locator("ul").first();
  const metrics = await list.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(metrics.client, "the list keeps a readable height").toBeGreaterThan(150);
  expect(metrics.scroll, "and scrolls its overflow").toBeGreaterThan(metrics.client);

  // A blurb is summarised, never printed: one row of it was a page of copy.
  await expect(sheet).toContainText("简介 → 将填入（");
  await expect(sheet.getByRole("button", { name: /补全 \d+ 本/ })).toBeVisible();

  // Opening a row is a different gesture from ticking it — the reader who wants
  // to read the blurb before deciding must not tick the book by accident.
  const row = sheet.locator("li").first();
  const checkbox = row.locator("button[aria-pressed]").first();
  await expect(checkbox).toHaveAttribute("aria-pressed", "true");

  await row.locator('button[aria-expanded="false"]').first().click();
  await expect(row.locator('button[aria-expanded="true"]')).toHaveCount(1);
  await expect(checkbox, "opening a row does not untick it").toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The whole blurb, not the 「将填入（N 字）」 summary.
  await expect(row).toContainText("这是一段演示用的简介");

  // And it is bounded: a 1700-character blurb scrolls inside its own box.
  const blurb = row.locator("dd").last();
  const blurbBox = await blurb.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(blurbBox.scroll, "the blurb scrolls").toBeGreaterThan(blurbBox.client);
  expect(blurbBox.client).toBeLessThan(200);
});
