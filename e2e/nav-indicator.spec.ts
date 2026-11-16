import { expect, test, type Page } from "@playwright/test";

/**
 * The sidebar's selection indicator.
 *
 * It has to sit exactly on the row the router calls active, on every
 * navigation, and it must be *one* element that travels — a fresh element per
 * row would be the shared-layout version this replaced, which re-rastered the
 * glass material on every switch and moved at 20fps while the arriving page
 * mounted (`NavList` explains the measurement).
 *
 * Both engines, because the geometry is read from the live DOM: rows are
 * 15% wider in WebKit, and an indicator placed from a constant instead of the
 * row's own box would land short there first.
 */
const ROWS = ["最近", "标签", "统计", "回收站", "书库"];

/** Placements within this many px of the row's box count as "on the row".
 *  Sub-pixel only: the indicator is set from the row's own rect. */
const TOUCHING = 1;

interface Box {
  top: number;
  height: number;
  left: number;
  right: number;
  opacity: number;
}

/** Rects come from one read of the live DOM, so the two boxes cannot be one
 *  layout apart. The transition is waited out with `expect.poll`, never a
 *  fixed delay: a 340ms curve finishes when it finishes. */
async function boxes(page: Page): Promise<{ row: Box; indicator: Box } | null> {
  return page.evaluate(() => {
    const nav = document.querySelector("nav[aria-label='主导航']");
    const row = nav?.querySelector<HTMLElement>('a[aria-current="page"]');
    const indicator = document.querySelector<HTMLElement>("[data-nav-indicator]");
    if (!nav || !row || !indicator) return null;
    const read = (el: HTMLElement): Box => {
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        left: Math.round(r.left * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        opacity: Number(getComputedStyle(el).opacity),
      };
    };
    return { row: read(row), indicator: read(indicator) };
  });
}

test("the indicator travels to whichever row is active", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=3");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  // Identity is the whole contract: the node must survive every switch.
  const first = await page.evaluate(() => {
    const el = document.querySelector("[data-nav-indicator]");
    (window as unknown as { seen?: Element | null }).seen = el;
    return el !== null;
  });
  expect(first, "the indicator exists on the shelf").toBe(true);

  for (const label of ROWS) {
    await page.getByRole("link", { name: label }).first().click();
    await expect
      .poll(
        async () => {
          const b = await boxes(page);
          if (!b) return "no rows";
          const dy = Math.abs(b.indicator.top - b.row.top);
          const dh = Math.abs(b.indicator.height - b.row.height);
          const dx =
            Math.abs(b.indicator.left - b.row.left) + Math.abs(b.indicator.right - b.row.right);
          return Math.max(dy, dh, dx);
        },
        { message: `indicator under ${label}` },
      )
      .toBeLessThanOrEqual(TOUCHING);

    const b = await boxes(page);
    expect(b?.indicator.opacity, `indicator visible on ${label}`).toBe(1);

    const same = await page.evaluate(() => {
      const el = document.querySelector("[data-nav-indicator]");
      return el !== null && el === (window as unknown as { seen?: Element | null }).seen;
    });
    // A new element per row is exactly what the FLIP version did; the fix is
    // that this one is never replaced.
    expect(same, `the same indicator node after ${label}`).toBe(true);
  }
});

test("the indicator keeps its row in the collapsed rail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=3");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.getByRole("link", { name: "最近" }).first().click();

  const drift = async () => {
    const b = await boxes(page);
    if (!b) return "no rows";
    return Math.max(
      Math.abs(b.indicator.top - b.row.top),
      Math.abs(b.indicator.height - b.row.height),
      Math.abs(b.indicator.left - b.row.left),
      Math.abs(b.indicator.right - b.row.right),
    );
  };

  // The label loses its width instead of leaving the layout, so the rows keep
  // their height and the indicator should not have to move at all — but it is
  // placed from the row's box, so a rail that did reflow would still land on it.
  await page.getByRole("button", { name: "折叠侧边栏" }).first().click();
  await expect.poll(drift, { message: "collapsed rail" }).toBeLessThanOrEqual(TOUCHING);

  /**
   * In the 76px rail the highlight is a small object the eye can see off
   * centre: before this was fixed it sat 17px from the pane's left edge and
   * 15px from its right, and the icon 11 / 15 inside it. Two separate causes —
   * the material's 1px rim was not subtracted from the inner column, and the
   * label still took its 27px of width. Both are relational, so both are
   * asserted as relations: equal air around the highlight, equal air around the
   * icon inside it.
   */
  const asymmetry = () =>
    page.evaluate(() => {
      const pane = document.querySelector("aside");
      const row = document.querySelector<HTMLElement>(
        "nav[aria-label='主导航'] a[aria-current='page']",
      );
      const icon = row?.querySelector<HTMLElement>("span");
      const highlight = document.querySelector<HTMLElement>("[data-nav-indicator]");
      if (!pane || !row || !icon || !highlight) return 99;
      const p = pane.getBoundingClientRect();
      const h = highlight.getBoundingClientRect();
      const i = icon.getBoundingClientRect();
      return Math.max(
        Math.abs(h.left - p.left - (p.right - h.right)),
        Math.abs(i.left - h.left - (h.right - i.right)),
      );
    });
  await expect
    .poll(asymmetry, { message: "collapsed rail, centred" })
    .toBeLessThanOrEqual(TOUCHING);

  await page.getByRole("button", { name: "展开侧边栏" }).first().click();
  await expect.poll(drift, { message: "expanded rail again" }).toBeLessThanOrEqual(TOUCHING);

  /**
   * The rail's own collapse has to stretch the highlight, not swap it: the
   * inner column is pinned to its final width the instant the state flips, so a
   * pane sized by `right-1` would go 214px → 42px in one frame.
   *
   * Asserted as "width is in the transition list" rather than by sampling a
   * mid-flight width: a 420ms tween on a 5Hz runner can legitimately produce no
   * sample between the endpoints, and that would read as a failure of a pane
   * that is actually tweening. The timings themselves were measured in-page
   * (214 → 199 → 176 → … → 38 → 42 on the way in).
   */
  const transitions = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-nav-indicator]");
    return el
      ? getComputedStyle(el)
          .transitionProperty.split(",")
          .map((p) => p.trim())
      : [];
  });
  expect(transitions, "the highlight's width is animated").toContain("width");
});

test("the indicator is gone where no row is active", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=3");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  const opacity = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[data-nav-indicator]");
      return el ? Number(getComputedStyle(el).opacity) : -1;
    });

  // 设置 is a chrome action, not a nav row: nothing in the list is current.
  // The router is in-memory, so the page is the only evidence of the route.
  await page.getByRole("button", { name: "设置" }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await expect.poll(opacity, { message: "no row, no indicator" }).toBe(0);
});
