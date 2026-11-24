import { expect, test, type Page } from "@playwright/test";

/**
 * The shelf cut into sections.
 *
 * The headings are lines of the windowed list rather than labels floating over
 * it, which costs the window its single row pitch: two kinds of line mean two
 * heights, and every position had to be recomputed from the items. That makes
 * the interesting failures the ones a flat list would never show, so they are
 * what is pinned here:
 *
 * - the shelf is actually **reordered** into its piles, not merely labelled —
 *   two of three books change slots below;
 * - a heading *takes room*, so the two spacers plus the rendered lines still
 *   have to add up to the height the whole list would have had — the 84-book
 *   scroll test below is the only thing that would catch a heading measured
 *   differently from how it is drawn;
 * - a folded pile is out of the list, not hidden in it, so its cards stop
 *   being rendered and the shelf closes up;
 * - nothing is sectioned until a group is chosen.
 */
const SHELF = "/?demo=1";

/** The sample shelf's three books, in the order `lib/demo.ts` lists them. */
const FIRST = "我们为什么会生病";
const SECOND = "金色梦乡";
const THIRD = "长日将尽";

/** The titles on screen, in the order the shelf is showing them. */
function titles(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-book-cover]")].map(
      // The author/format line became a <p> when the card label was reworked,
      // so the first <p> is no longer the title. MarqueeText tags the title.
      (cover) =>
        cover.closest("button")?.querySelector("[data-marquee-kind='title']")?.textContent ?? "",
    ),
  );
}

test("grouping reorders the shelf into piles, each under its own heading", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SHELF);
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  const headings = page.locator("[data-shelf-header]");
  await expect(headings, "a shelf nobody has grouped has no headings").toHaveCount(0);

  // First put the shelf in an order the piles will visibly disagree with: the
  // samples arrive oldest-first, and flipping the direction reverses them.
  await page.getByLabel("排序方式").selectOption("progressDesc");
  await page.getByRole("button", { name: "当前降序，改为升序" }).click();
  await expect.poll(() => titles(page)).toEqual([THIRD, SECOND, FIRST]);

  await page.getByLabel("分组方式").selectOption("progress");

  // A heading per pile, both on screen at once. This is what the heading could
  // not do while it floated over the grid: it named only the pile the top of
  // the viewport was in, so a boundary could be passed but never seen coming.
  await expect(headings).toHaveCount(2);
  await expect(page.locator("[data-shelf-header='reading']")).toContainText("在读");
  await expect(page.locator("[data-shelf-header='reading']")).toContainText("2 本");
  await expect(page.locator("[data-shelf-header='unread']")).toContainText("未开始");
  await expect(page.locator("[data-shelf-header='unread']")).toContainText("1 本");

  // The reorder is the point: the two in-progress books move to the front,
  // keeping their relative order, and the unread one sinks behind them.
  await expect.poll(() => titles(page)).toEqual([SECOND, FIRST, THIRD]);

  // And back to one pile, which is not a pile.
  await page.getByLabel("分组方式").selectOption("none");
  await expect(headings).toHaveCount(0);
  await expect.poll(() => titles(page)).toEqual([THIRD, SECOND, FIRST]);
});

test("a heading folds its pile away and brings it back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SHELF);
  await page.getByLabel("分组方式").selectOption("progress");
  // Left in the order the samples arrive: both in-progress books are already
  // ahead of the unread one, so grouping moves nothing and the pile reads in
  // its own order — which is the point of the fold, not the reorder.
  await expect.poll(() => titles(page)).toEqual([FIRST, SECOND, THIRD]);

  const unread = page.locator("[data-shelf-header='unread']");
  await unread.click();
  await expect(unread).toHaveAttribute("aria-expanded", "false");
  // Folded means gone from the list, not hidden inside it, so the card is not
  // rendered at all.
  await expect.poll(() => titles(page)).toEqual([FIRST, SECOND]);
  // The count is the pile's, not the shelf's: a folded pile still says how much
  // is in it, which is the whole reason to fold one rather than filter.
  await expect(unread).toContainText("1 本");

  await unread.click();
  await expect(unread).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => titles(page)).toEqual([FIRST, SECOND, THIRD]);
});

test("a heading sits in the flow at the gap the grid keeps between lines", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=84");
  await page.getByLabel("分组方式").selectOption("progress");
  await expect(page.locator("[data-shelf-header='unread']")).toBeVisible();

  const measure = () =>
    page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>("[data-shelf-grid]");
      if (!grid) return null;
      const gap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0;
      const kids = [...grid.children];
      // The second pile's heading: the first one has nothing above it but the
      // toolbar, and this is about the heading *between* two lines.
      const at = kids.findIndex(
        (kid, index) =>
          index > 0 && index < kids.length - 1 && kid.hasAttribute("data-shelf-header"),
      );
      const heading = kids[at];
      const above = kids[at - 1];
      const below = kids[at + 1];
      if (!heading || !above || !below) return null;
      return {
        gap,
        above: Math.round(
          heading.getBoundingClientRect().top - above.getBoundingClientRect().bottom,
        ),
        below: Math.round(
          below.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
        ),
      };
    });

  // Waited for rather than read once: the cards fly to their new slots as the
  // grouping lands, and a card mid-flight reports the move it is making —
  // measured on the first frame, 68px, which is exactly the room the heading
  // took. What this is about is the layout they settle into.
  await expect
    .poll(
      async () => {
        const measured = await measure();
        if (!measured) return false;
        return measured.above === measured.gap && measured.below === measured.gap;
      },
      {
        message:
          "a heading is an ordinary line of the grid — the row gap above and below it, " +
          "not a margin, a padding, or a height of its own",
      },
    )
    .toBe(true);
});

test("a grouped shelf still ends where the scroll does", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=84");
  await page.getByLabel("分组方式").selectOption("progress");

  const shelf = page.locator("[data-shelf-scroller]");
  await shelf.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // The arithmetic of the whole feature, in one assertion: the spacers are
  // computed from a heading height and a row pitch, and if either is off the
  // last row stops short of the end of the scroll — or runs past it.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const scroller = document.querySelector("[data-shelf-scroller]");
          const covers = document.querySelectorAll("[data-book-cover]");
          const card = covers[covers.length - 1]?.parentElement?.parentElement;
          if (!scroller || !card) return 999;
          const padding = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
          return Math.abs(
            Math.round(
              scroller.getBoundingClientRect().bottom -
                card.getBoundingClientRect().bottom -
                padding,
            ),
          );
        }),
      { message: "the last row ends where the scroll does" },
    )
    .toBeLessThanOrEqual(2);

  // Still a window down there with the headings in the list.
  expect(await page.locator("[data-book-cover]").count()).toBeLessThan(60);
});
