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

  /**
   * How far the pane is from the row it belongs to, in both directions.
   *
   * Both rects are read in one evaluate so the two numbers come from one
   * layout — and the gap is computed in the page rather than compared in Node,
   * because a scroll between two separate reads would be a false pass or a
   * false failure depending on the direction it happened to move.
   */
  const gap = () =>
    target.evaluate((button) => {
      const row = button.parentElement;
      const pane = document.querySelector("[data-tag-indicator]");
      if (!row || !pane) return null;
      const rowBox = row.getBoundingClientRect();
      const paneBox = pane.getBoundingClientRect();
      return {
        top: Math.abs(paneBox.top - rowBox.top),
        height: Math.abs(paneBox.height - rowBox.height),
      };
    });

  // The pane travels on a spring, so 「aligned」 is a state it reaches rather
  // than one it holds: measured on this machine it peaks 8px past the row at
  // 260ms and settles by 300ms. A fixed wait is therefore a bet on how fast the
  // first frame arrives, and on a loaded runner that bet loses — CI read the
  // overshoot (7.76px) and called it a miss. Polling asserts the same thing
  // (exact alignment) without asserting *when*.
  await expect.poll(async () => (await gap())?.top ?? 999, { timeout: 5000 }).toBeLessThan(1);
  expect((await gap())!.height).toBeLessThan(1);

  // The pane is positioned in the list's own coordinates, so scrolling must
  // carry it along instead of leaving it floating over whatever is on screen.
  await list(page).evaluate((el) => {
    el.scrollTop = 60;
  });
  await expect.poll(async () => (await gap())?.top ?? 999, { timeout: 3000 }).toBeLessThan(1);
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

/**
 * Tag management lives in the same rail: a mode that turns the browse list
 * into a checklist with rename/delete controls. Demo mode has no backend, so
 * this asserts the UI the reader reaches before any write — entering the mode,
 * ticking rows and the confirmation sheets — not the mutation itself.
 */
test("the rail turns into a checklist with bulk and rename controls", async ({ page }) => {
  await openTags(page);

  await expect(rail(page).getByText("全部删除")).toHaveCount(0);
  await rail(page).getByLabel("整理标签").click();
  await expect(rail(page).getByText("全选")).toBeVisible();
  await expect(rail(page).getByText("全部删除")).toBeVisible();

  // Ticking a row is a selection, not a filter: the books stay on the shelf.
  // In manage mode the row's accessible name changes from 「name, N 本」 to
  // 「选择标签 name」, so the browse helper no longer matches it.
  await rail(page).getByLabel("选择标签 社会学").click();
  await expect(rail(page).getByText("删除所选 (1)")).toBeVisible();

  await rail(page).getByText("全选").click();
  await expect(rail(page).getByText("删除所选 (20)")).toBeVisible();

  // Both destructive sheets open with an explicit, non-undoable warning.
  await rail(page).getByText("全部删除").click();
  await expect(page.getByText("删除全部标签？")).toBeVisible();
  await expect(page.getByText(/无法撤销/)).toBeVisible();
});
