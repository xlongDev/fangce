import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The notes page's manage mode, its export and its edit affordance.
 *
 * Four things are worth pinning down here, and none of them can be seen from
 * jsdom:
 *
 * 1. The batch bar sits centred on the *page*, not on the window. The shelf
 *    learned this the hard way twice — first a `motion` transform ate an
 *    inline `-50%`, then a `-translate-x-1/2` centred the bar on the window
 *    while the sidebar pushes the pane ~130px right of that. The bar here is
 *    placed against the pane's measured box, so the assertion measures the
 *    same element the effect does.
 *
 * 2. A row in manage mode is one big target. The passage stops being a button
 *    and an overlay carries the gesture instead, with the content underneath
 *    dropping pointer events — `click()` is the assertion, because Playwright
 *    refuses to click an element that does not receive the pointer at its own
 *    centre. That is exactly the failure the shelf's scrim produced.
 *
 * 3. There is no scrim. One on the shelf covered the selection surface, so
 *    every click on a card exited the mode. Escape is the keyboard way out and
 *    it is asserted here for the same reason.
 *
 * 4. A batch delete takes exactly the rows that were picked, across books, and
 *    the tally follows. The two fixture books are demo-1 (我们为什么会生病,
 *    three highlights) and demo-2 (金色梦乡, two) — five in all.
 */

const PAGE = "[data-notes-page]";
const BAR = "[data-batch-bar]";

/** The five fixture highlights, by a fragment of their passage. */
const P1 = /身体是一台被反复修补过的机器/;
const P2 = /咳嗽、发烧、呕吐/;
const P3 = /为什么自然选择没有把衰老剔除掉/;
const P4 = /医学擅长处理近因/;
const P5 = /理解这一点并不会立刻治好什么病/;

/**
 * Boots the app, walks to the notes page, and answers with a locator scoped to
 * it.
 *
 * `goto("/notes?demo=1")` does not work and looks like it should: the router is
 * a *memory* router with `initialEntries: ["/"]`, so the app always boots on the
 * shelf whatever the path says. `?demo=1` still has to be on the document URL,
 * because that is what `demoEnabled()` reads — so the demo flag rides in on the
 * boot navigation and the route is reached by clicking, as a reader would.
 *
 * Everything afterwards is scoped to the returned locator rather than to the
 * page, because the route cross-fade keeps the *shelf* mounted while the notes
 * page arrives — and the shelf has a 选择 button of its own. Measured: an
 * unscoped `getByRole("button", { name: "选择", exact: true })` resolves to two
 * elements during the transition and Playwright refuses to guess.
 */
async function openNotes(page: Page): Promise<Locator> {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.getByRole("link", { name: "笔记", exact: true }).click();
  const notes = page.locator(PAGE);
  await expect(notes).toBeVisible();
  return notes;
}

test("manage mode selects rows instead of opening them, and its bar is centred on the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const notes = await openNotes(page);
  await expect(notes.getByText(P1)).toBeVisible();

  await notes.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.locator(BAR);
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("已选 0 条");

  // The pane the bar is centred in is the page root — the exact element the
  // placement effect measures, so the assertion and the implementation cannot
  // drift apart. It is not the window: that is the bug this replaced.
  const pane = (await notes.boundingBox())!;
  const box = (await bar.boundingBox())!;
  const paneCentre = pane.x + pane.width / 2;
  const barCentre = box.x + box.width / 2;
  // ±2px slack — the spring lands within a couple of pixels at this size.
  expect(Math.abs(barCentre - paneCentre)).toBeLessThan(2);
  // And the pane's centre is not the window's, which is what a plain
  // `left: 50%` would have produced — with the sidebar open they are ~130px
  // apart. Without this the assertion above would still pass if both had
  // drifted together.
  expect(Math.abs(barCentre - 1280 / 2)).toBeGreaterThan(20);

  // `click()` rather than a coordinate: the overlay must actually receive the
  // pointer, which is what makes the whole row a target.
  await notes.getByRole("button", { name: P1 }).click();
  await expect(bar).toContainText("已选 1 条");
  // Selecting does not navigate: the row is a toggle in this mode, and the
  // passage's own 在书中打开 is not rendered at all. Navigating would unmount
  // the page, so the page still being here is the assertion.
  await expect(notes).toBeVisible();

  await notes.getByRole("button", { name: P5 }).click();
  await expect(bar).toContainText("已选 2 条");

  // Clicking a selected row again takes it back out.
  await notes.getByRole("button", { name: P1 }).click();
  await expect(bar).toContainText("已选 1 条");

  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  // Re-entering starts from nothing rather than from the last selection.
  await notes.getByRole("button", { name: "选择", exact: true }).click();
  await expect(page.locator(BAR)).toContainText("已选 0 条");
});

test("a batch delete removes exactly the rows that were picked, across books", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const notes = await openNotes(page);

  // Five highlights across two books to start with. The toolbar's tally is a
  // `<p>`; the resident live region carries the same number in an `<output>`,
  // so an unscoped text match resolves to two elements.
  const tally = notes.locator("p").filter({ hasText: /条标注/ });
  await expect(tally).toContainText("5 条标注");

  await notes.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.locator(BAR);
  // One from each book, so the delete spans books rather than one list.
  await notes.getByRole("button", { name: P1 }).click();
  await notes.getByRole("button", { name: P4 }).click();
  await expect(bar).toContainText("已选 2 条");

  // The bar's 删除 opens a confirmation; it does not delete on the spot.
  await bar.getByRole("button", { name: "删除" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("删除选中的 2 条标注？");
  await expect(notes.getByText(P1)).toBeVisible();

  await dialog.getByRole("button", { name: "删除" }).click();

  await expect(notes.getByText(P1)).toHaveCount(0);
  await expect(notes.getByText(P4)).toHaveCount(0);
  // The three that were not picked are untouched, in both books.
  await expect(notes.getByText(P2)).toBeVisible();
  await expect(notes.getByText(P3)).toBeVisible();
  await expect(notes.getByText(P5)).toBeVisible();
  await expect(tally).toContainText("3 条标注");

  // The selection is spent but the mode is not — the reader can keep pruning.
  await expect(bar).toContainText("已选 0 条");
});

test("the export dialog counts the screen, and names the one book it narrowed to", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const notes = await openNotes(page);

  // The whole screen: two books, five highlights. The dialog is a lazy chunk,
  // so this waits for it rather than assuming it is already there.
  await notes.getByRole("button", { name: "导出", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("这 2 本书有 5 条标注");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();

  // Narrowed to one book, the dialog says so — the subject is the caller's
  // phrase, and this is what proves the caller derived it from what is shown
  // rather than from the whole library.
  await notes.getByRole("textbox", { name: "搜索标注" }).fill("金色梦乡");
  // Narrowed, the toolbar's tally changes shape — it stops saying 条标注 and
  // starts comparing against the whole library, which is the point of it.
  await expect(notes.getByText("2 / 5 条")).toBeVisible();

  await notes.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog).toContainText("《金色梦乡》有 2 条标注");
  // …and the 有笔记 filter narrows the payload without changing the book.
  await dialog.getByRole("button", { name: "取消" }).click();

  await notes.getByRole("button", { name: "有笔记" }).click();
  await notes.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog).toContainText("《金色梦乡》有");
});

test("the row's edit button opens the note field", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const notes = await openNotes(page);

  // The passage's row, not the note's own text — the pencil is the affordance
  // the clickable note never advertised.
  const row = notes.locator("li").filter({ hasText: P1 });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "编辑笔记" }).click();

  const field = row.getByRole("textbox", { name: "标注笔记" });
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(/全书的主线/);

  await field.fill("改过一遍的想法");
  // Clicking away commits, which is the path the reader actually takes.
  await notes.getByRole("heading", { name: "笔记" }).click();

  await expect(row.getByText("改过一遍的想法")).toBeVisible();
  await expect(row.getByText(/全书的主线/)).toHaveCount(0);
});
