import { expect, test, type Page } from "@playwright/test";

/**
 * The rail is a jump table, not a highlight.
 *
 * Every entry has to land its own group at the top of the pane. The failure
 * this pins is a rail that lit up the entry you clicked while the pane stayed
 * where it was (or moved somewhere else entirely) — which reads as the page
 * ignoring you, because the one thing that visibly changed is the pill.
 */

const SCROLLER = "[data-settings-scroll]";

/** Rail label → the group it names. */
const ENTRIES: [label: string, id: string][] = [
  ["外观", "appearance"],
  ["AI 助手", "ai"],
  ["词典", "dictionary"],
  ["字体", "fonts"],
  ["同步", "sync"],
  ["重置", "reset"],
  ["关于", "about"],
];

// The router is a memory router that always boots on the shelf, so `?demo=1`
// rides in on the first navigation and the route is reached by clicking —
// see `e2e/notes-page.spec.ts`. Settings is a chrome button rather than a rail
// link, and it is labelled 设置 in both of the places it can sit.
async function openSettings(page: Page): Promise<void> {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.waitForTimeout(600);
  // Nothing below is meaningful until the pane stops growing: `AI 助手` and
  // `同步` render nothing at all until their configs resolve, and they sit above
  // most of the page, so every offset below them is a different number on each
  // pass until the last one arrives. Asked of the page rather than written down,
  // because how tall a group is is a font metric.
  await expect
    .poll(async () => {
      const before = await page.locator(SCROLLER).evaluate((el) => el.scrollHeight);
      await page.waitForTimeout(150);
      return (await page.locator(SCROLLER).evaluate((el) => el.scrollHeight)) === before;
    })
    .toBe(true);
}

test("each rail entry shows the group it names, and stays lit on it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettings(page);

  const pane = (await page.locator(SCROLLER).boundingBox())!;
  const rail = page.locator('nav[aria-label="设置分类"]');

  for (const [label, id] of ENTRIES) {
    await page.getByRole("button", { name: label, exact: true }).click();
    // The scroll is smooth; give it somewhere to finish.
    await page.waitForTimeout(900);

    const group = (await page.locator(`[data-section="${id}"]`).boundingBox())!;
    const off = group.y - pane.y;
    // The group it names has to be fully in view. It lands 16px below the
    // pane's top — the jump aims at `offsetTop - 16` — except for the last
    // two, which the pane runs out of scroll for and stops at the bottom with.
    expect(off, `${label} → ${id}: top at ${Math.round(off)}px`).toBeGreaterThan(-8);
    expect(
      off + group.height,
      `${label} → ${id}: bottom at ${Math.round(off + group.height)}px of ${Math.round(pane.height)}`,
    ).toBeLessThan(pane.height + 8);

    // And the rail still says it is there. This is the bug: a jump used to end
    // with the highlight on the *last* group while the pane showed the one
    // that was clicked — the pane stopping at the bottom reads as "at the end"
    // to the sight-line rules, and they handed the highlight on.
    await expect(rail.locator('[aria-current="true"]'), `after ${label}`).toHaveText(label);
  }
});

/**
 * And a jump that runs out of scroll still owns the highlight.
 *
 * The rule at the bottom of the pane is that the *last* group is the one being
 * read — but a jump to a group the pane has no scroll left for ends at that same
 * bottom, and its own smooth scroll goes on emitting events from there. Read as
 * "the reader scrolled to the end", those events handed the highlight to 关于
 * while the pane was showing 同步: the rail lit an entry nobody clicked.
 *
 * The trigger is layout, not timing — the runner's CJK font measures wide enough
 * that 同步 is the first entry whose jump bottoms the pane out — so it is staged
 * here instead of waited for, and the same jump is then asked for from a pane
 * that is already at its bottom, which is the state that made it visible.
 */
test("a jump that runs out of scroll keeps the highlight on the group it named", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettings(page);

  const rail = page.locator('nav[aria-label="设置分类"]');
  // Park the pane at its bottom first, so the rule's own answer (关于) is on
  // screen before the jump — otherwise a passing test could not say whether the
  // highlight came from the rule or from the click.
  await page.locator(SCROLLER).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(rail.locator('[aria-current="true"]'), "the pane starts at its end").toHaveText(
    "关于",
  );

  await page.getByRole("button", { name: "同步", exact: true }).click();
  await page.waitForTimeout(900);
  await expect(rail.locator('[aria-current="true"]'), "after 同步").toHaveText("同步");
});

/**
 * And the sight-line names the group the pane is actually showing.
 *
 * The rule is "the last group whose top has passed a line 15% down the pane",
 * and it reads the groups' offsets from a cache — for good reason, since reading
 * them per scroll frame would force a layout per frame. The cache was built
 * once, when `AI 助手` and `同步` had not rendered yet, and nothing ever rebuilt
 * it: those two groups arriving *moved* every offset below them without resizing
 * anything, and a `ResizeObserver` reports sizes, not positions. 关于 was cached
 * at 1414 against a real 2562 — the whole lower half of the page was held higher
 * than it is — so from 词典 down, every group answered as having passed the line
 * and the rail read 关于 wherever the reader scrolled to.
 */
test("the highlight follows a scroll the reader made", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettings(page);

  const rail = page.locator('nav[aria-label="设置分类"]');
  // Aimed by the group's own offset rather than at a remembered `scrollTop`: the
  // line is 15% down the pane and a group's height is a font metric, so a fixed
  // number would be a different question in each engine.
  const top = await page
    .locator('[data-section="fonts"]')
    .evaluate((el) => (el as HTMLElement).offsetTop);
  await page.locator(SCROLLER).evaluate((el, y) => {
    el.scrollTop = y;
  }, top - 10);

  await expect(rail.locator('[aria-current="true"]'), "the pane is over 字体").toHaveText("字体");
});

/**
 * A link from somewhere else in the app lands on the group it names.
 *
 * `去设置` beside a failed AI guide is the case that exists today: the reader
 * is four groups from the field the error is about, and arriving at the top of
 * the page would leave them to find it. The guide fails in the browser build
 * for its own reason (no backend), which is enough to get the button on screen
 * — the test presses it rather than quoting the message, since that reason is
 * engine-specific and this is not a test of it.
 */
test("去设置 lands on the AI group, not the top of the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: /我们为什么会生病/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(800);

  await page.getByRole("button", { name: "AI 导读" }).first().click();
  await page.waitForTimeout(1200);
  const drawer = page.locator("[data-reading-viewport] aside");
  await drawer.getByRole("button", { name: /去设置/ }).click();

  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.waitForTimeout(900);

  const pane = (await page.locator(SCROLLER).boundingBox())!;
  const group = (await page.locator('[data-section="ai"]').boundingBox())!;
  const off = Math.round(group.y - pane.y);
  // The jump aims at `offsetTop - 16`, so the group sits just under the pane's
  // top edge — not "somewhere in view", which is what arriving at 0 would be.
  expect(off, `AI 助手 landed at ${off}px`).toBeGreaterThanOrEqual(-8);
  expect(off, `AI 助手 landed at ${off}px`).toBeLessThan(60);
  await expect(page.locator('nav[aria-label="设置分类"] [aria-current="true"]')).toHaveText(
    "AI 助手",
  );
});
