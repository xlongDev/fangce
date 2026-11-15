import { expect, test, type Page } from "@playwright/test";

/**
 * The tag rail: two columns, a fold that holds, and a highlight that lands
 * where it says it does.
 *
 * This page was rebuilt eight times, and every round was verified with a
 * throwaway script that was deleted afterwards — which is to say there was no
 * guard at all, and the same four failures were rediscovered by hand each time.
 * They are all geometric, so they belong here rather than in jsdom, which does
 * not lay anything out:
 *
 *   1. the rail and the shelf start on one line (a second line in the rail put
 *      them 15px apart, which read as 「顶边不齐」 but was not);
 *   2. a folded band does not squash the rows it kept (a `max-h` flex column
 *      shrinks its children, so 32px became 24px the moment a band opened);
 *   3. the list scrolls instead of pushing the page (a `max-height` that the
 *      content nearly fills leaves nothing to scroll);
 *   4. the glass pane sits exactly on the selected row, before and after
 *      scrolling the list.
 *
 * `?demo=1&books=84&tags=1` puts three tiers of labels on the sample shelf —
 * nine labels over 8 books, eleven between 2 and 7 — which is the only shape
 * where the fold has one band to hold open and one to close. The fixture is
 * asserted to be that shape at the top of the fold test, so a change to the
 * distribution fails there with a readable message rather than three assertions
 * later with a confusing one.
 */
const TAGS = "/?demo=1&books=84&tags=1";

const rail = (page: Page) => page.locator('nav[aria-label="标签索引"]');
const list = (page: Page) => rail(page).locator("> ul");
/** One per tag row. 「全部」 is a bare `<li><button>`, so it is not in here. */
const panes = (page: Page) => rail(page).locator("li > div");
const rowNamed = (page: Page, name: string) =>
  rail(page).getByRole("button", { name: new RegExp(`^${name}，`) });

async function openTags(page: Page): Promise<void> {
  await page.goto(TAGS);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();
  await page.getByRole("link", { name: "标签", exact: true }).click();
  await expect(rail(page)).toBeVisible();
}

test("the rail's field starts on the toolbar's line", async ({ page }) => {
  await openTags(page);

  const field = page.locator('input[aria-label="搜索标签或拼音首字母"]');
  const toolbar = page.locator('input[aria-label="搜索书名或作者"]');
  const [railBox, shelfBox] = await Promise.all([field.boundingBox(), toolbar.boundingBox()]);
  expect(railBox).not.toBeNull();
  expect(shelfBox).not.toBeNull();

  // Equal rather than 「within N px」: the two fields are one row of controls,
  // and the bug this guards against was a whole extra line (15px), not drift.
  expect(Math.abs(railBox!.y - shelfBox!.y)).toBeLessThan(1);
  expect(Math.abs(railBox!.height - shelfBox!.height)).toBeLessThan(1);
});

test("a band longer than two rows folds, and opening it shows the rest", async ({ page }) => {
  await openTags(page);

  // The fixture's shape, stated once: nine labels that gather 8+ books, eleven
  // that gather 2–7. Only the second group is over the fold.
  await expect(rail(page).locator("li > p")).toHaveCount(2);
  const fold = rail(page).locator('button[aria-expanded="false"]');
  await expect(fold).toHaveCount(1);

  const before = await panes(page).count();
  await fold.click();
  await expect(rail(page).locator('button[aria-expanded="true"]')).toHaveCount(1);

  expect(await panes(page).count()).toBeGreaterThan(before);
  // Nothing was hidden behind a second fold — the whole shelf is now on screen.
  expect(await panes(page).count()).toBe(20);
});

test("expanding does not squash the rows", async ({ page }) => {
  await openTags(page);

  const row = panes(page).first();
  const before = (await row.boundingBox())!.height;

  await rail(page).locator('button[aria-expanded="false"]').click();
  await expect(rail(page).locator('button[aria-expanded="true"]')).toHaveCount(1);

  // `max-h` on a flex column shrinks its children by default: the row went from
  // 32px to 24px as soon as the list got taller than the column. Same height
  // before and after is the whole assertion.
  const after = (await row.boundingBox())!.height;
  expect(Math.abs(after - before)).toBeLessThan(0.5);
});

test("the list scrolls once it is taller than the rail", async ({ page }) => {
  await openTags(page);
  await rail(page).locator('button[aria-expanded="false"]').click();
  await expect(rail(page).locator('button[aria-expanded="true"]')).toHaveCount(1);

  const metrics = await list(page).evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(metrics.scroll).toBeGreaterThan(metrics.client + 1);

  // …and it is the list that scrolls, not the page behind it.
  const moved = await list(page).evaluate((el) => {
    el.scrollTop = 120;
    return el.scrollTop;
  });
  expect(moved).toBeGreaterThan(0);
});

test("the highlight sits on the row it selected, and stays there while scrolling", async ({
  page,
}) => {
  await openTags(page);
  await rail(page).locator('button[aria-expanded="false"]').click();
  await expect(rail(page).locator('button[aria-expanded="true"]')).toHaveCount(1);

  const target = rowNamed(page, "社会学");
  await target.click();
  // The pane travels on `--ease-spring` (420ms); measuring mid-flight would
  // read the overshoot as a miss.
  await page.waitForTimeout(700);

  const measure = () =>
    target.evaluate((button) => {
      const row = button.parentElement!;
      const pane = document.querySelector("[data-tag-indicator]");
      if (!pane) return null;
      // One read of both rects, so the two numbers come from one layout.
      const rowBox = row.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      return {
        rowTop: rowBox.top,
        rowHeight: rowBox.height,
        paneTop: paneBox.top,
        paneHeight: paneBox.height,
      };
    });

  const settled = await measure();
  expect(settled).not.toBeNull();
  expect(Math.abs(settled!.paneTop - settled!.rowTop)).toBeLessThan(1);
  expect(Math.abs(settled!.paneHeight - settled!.rowHeight)).toBeLessThan(1);

  // The pane is positioned in the list's own coordinates, so scrolling must
  // carry it along instead of leaving it floating over whatever is on screen.
  await list(page).evaluate((el) => {
    el.scrollTop = 60;
  });
  await page.waitForTimeout(200);

  const scrolled = await measure();
  expect(scrolled).not.toBeNull();
  expect(Math.abs(scrolled!.paneTop - scrolled!.rowTop)).toBeLessThan(1);
});

test("a search shows matches, in one flat list", async ({ page }) => {
  await openTags(page);

  await page.locator('input[aria-label="搜索标签或拼音首字母"]').fill("mgwx");

  await expect(rail(page).getByText("匹配 1")).toBeVisible();
  await expect(panes(page)).toHaveCount(1);
  await expect(rowNamed(page, "美国文学")).toBeVisible();
  // Bands are a way to browse; relevance order is a way to find. Splitting a
  // search result into frequency groups throws the order away.
  await expect(rail(page).locator("li > p")).toHaveCount(0);

  // The way back to the whole shelf stays put, and it is not a band: the count
  // is its only label (`全部 84`), where a tag row spells out `名字，N 本`.
  await expect(rail(page).getByRole("button", { name: /^全部/ })).toBeVisible();
});

test("the keyboard walks the rail, and Enter is what picks", async ({ page }) => {
  await openTags(page);

  const rows = page.locator("[data-tag-row]");
  await page.locator('input[aria-label="搜索标签或拼音首字母"]').focus();
  await page.keyboard.press("ArrowDown");
  // Out of the field and onto 「全部」 — the first row, not the first tag.
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  const second = rows.nth(1);
  await expect(second).toBeFocused();
  // Walking is not choosing: no query has been fired yet.
  await expect(rail(page).locator('[aria-current="true"]')).toHaveAttribute("data-tag-row", "");

  const name = await second.getAttribute("data-tag-row");
  await page.keyboard.press("Enter");

  await expect(rail(page).getByRole("button", { name: new RegExp(`^${name}，`) })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();
});
