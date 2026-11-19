import { expect, test } from "@playwright/test";

/**
 * The shelf renders a window of the list, not the list.
 *
 * A 500-book library is what this is for, and the shelf's cost is linear in the
 * number of tiles on screen — so the grid renders the rows the viewport can
 * reach plus two either side, and holds the rest open with two spacers. Three
 * things have to hold for that to be invisible:
 *
 * - the scrollbar: the two spacers and the grid must add up to the height the
 *   full list would have had, or the end of the list stops where the scroll
 *   does and the last row is cut off;
 * - the scroll: the window has to follow it, and stay a window while it moves;
 * - the motion: a tile that arrives because the window slid under it must not
 *   fade in, or scrolling would look like a filter change.
 */
const SHELF = "/?demo=1&books=500";

/** Tiles the window is allowed to hold. Two rows of overscan either side of a
 *  viewport that shows two, at six columns, is 36 — the bound is loose on
 *  purpose, and a shelf that ignores the window renders 500. */
const WINDOW_LIMIT = 60;

test("the shelf renders a window of the list, and holds its true height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SHELF);

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  // Counts the tiles and the palest a card ever gets, sampled inside the page:
  // both exist for the length of a scroll frame.
  await page.evaluate(() => {
    const w = window as unknown as { seen?: { peak: number; palest: number } };
    w.seen = { peak: 0, palest: 1 };
    const sample = () => {
      const covers = document.querySelectorAll("[data-book-cover]");
      w.seen!.peak = Math.max(w.seen!.peak, covers.length);
      for (const cover of covers) {
        const card = cover.parentElement?.parentElement;
        if (!card) continue;
        const opacity = Number.parseFloat(getComputedStyle(card).opacity);
        w.seen!.palest = Math.min(w.seen!.palest, opacity);
      }
    };
    sample();
    window.setInterval(sample, 16);
  });

  const band = await shelf.boundingBox();
  if (!band) throw new Error("the shelf has to have a box");
  await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
  for (let step = 0; step < 10; step += 1) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(70);
  }

  const seen = await page.evaluate(
    () => (window as unknown as { seen: { peak: number; palest: number } }).seen,
  );
  expect(seen.peak, "a window, not the list").toBeLessThan(WINDOW_LIMIT);
  expect(
    seen.palest,
    "tiles scrolled into view are already there — no fade-in for a scroll",
  ).toBeGreaterThan(0.9);

  // The end of the list: the last row has to sit exactly at the end of the
  // scroll, which is the whole point of computing the spacers instead of
  // guessing them. Measured against the tile — not the cover inside it, which is
  // a text block shorter — and against the scroller's padding box, which its own
  // padding sits inside.
  await shelf.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
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

  // And the window is still a window down there: 500 books, no more than a
  // couple of screens' worth rendered.
  expect(await page.locator("[data-book-cover]").count()).toBeLessThan(WINDOW_LIMIT);
});

/**
 * Favouriting is a mark on one book, not a state of the shelf. It used to go
 * through the same `busy` flag as deleting: every card's open button was
 * disabled — and therefore 50% opaque — for the length of one write, which
 * read as the whole shelf blinking. Sample every frame of the gesture instead
 * of looking at the end state, where the flash is already over.
 */
test("favouriting a book leaves the rest of the shelf opaque", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  const covers = page.locator("[data-shelf-grid] [data-book-cover]");
  await covers.nth(1).hover();
  const star = page.getByRole("button", { name: "收藏", exact: true }).first();

  await page.evaluate(() => {
    const probe = window as unknown as { palest: number; frames: number; stop: boolean };
    probe.palest = 1;
    probe.frames = 0;
    probe.stop = false;
    const sample = () => {
      for (const button of document.querySelectorAll<HTMLElement>(
        "[data-shelf-grid] > div > button",
      )) {
        probe.palest = Math.min(probe.palest, Number.parseFloat(getComputedStyle(button).opacity));
      }
      probe.frames += 1;
      if (!probe.stop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await star.click();
  // A frame count, not a fixed wait: the point is to have watched the whole
  // mutation, however long the machine takes to run it.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { frames: number }).frames))
    .toBeGreaterThan(12);
  const palest = await page.evaluate(() => {
    const probe = window as unknown as { palest: number; stop: boolean };
    probe.stop = true;
    return probe.palest;
  });
  expect(palest, "no card dims while one book is favourited").toBe(1);
});
