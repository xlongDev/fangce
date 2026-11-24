import { expect, test } from "@playwright/test";

/**
 * A long author name slides out from under the mask on hover.
 *
 * This is the one shelf behaviour that has no other symptom: `MarqueeText`
 * measures its own overflow and only then decides to scroll, so a component
 * that never measures looks exactly like a name that happens to fit — an
 * ellipsis, and nothing else. It shipped that way once. The first version
 * returned a bare `<span className="truncate">` while the overflow was zero
 * and attached the measuring refs only on the scrolling branch, which meant
 * the refs were never attached and the overflow could never leave zero.
 *
 * So the assertions are, in order: the fixture really is a long name in a
 * narrow slot (or the rest proves nothing), the component noticed, and the
 * name actually moves. The last one is the only one the dead version could not
 * have satisfied.
 *
 * `prefers-reduced-motion` turns the slide off by design, and Playwright's
 * default is `no-preference`, so the slide is expected here.
 */
test("a long author name marquees on hover instead of staying truncated", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  // The title now uses the same slot; the author assertions below must name
  // their slot or they would start measuring the wrong line.
  await expect(page.locator('[data-marquee-kind="title"]').first()).toBeVisible();
  const slot = page.locator('[data-marquee-kind="author"]').first();
  await expect(slot).toBeVisible();

  const measured = await slot.evaluate((el) => {
    const inner = el.firstElementChild as HTMLElement;
    return {
      slot: el.clientWidth,
      content: inner.scrollWidth,
      innerClass: inner.className,
      inline: el.getAttribute("style") ?? "",
    };
  });
  expect(
    measured.content,
    `the fixture has to overflow for this to mean anything (slot ${measured.slot}px, content ${measured.content}px)`,
  ).toBeGreaterThan(measured.slot + 8);
  // `truncate` while it fits, `w-max` once it scrolls — the two branches.
  expect(measured.innerClass).toContain("w-max");
  expect(measured.inline).toContain("mask-image");

  // `whileHover` is on the inner span, so the pointer goes to the text itself.
  await slot.hover();
  // The slide is aimed at `-overflow`: the distance the name has to cover to get
  // out from under the mask, which this fixture measures for itself rather than
  // taking as a constant. The same name is a different width in each engine —
  // WebKit resolves a different CJK font and the two disagree by about 15% — so
  // a fixed threshold turns a font metric into a pass or a fail. Measured on CI:
  // the travel was -20px against an assertion of `< -20`.
  const overflow = measured.content - measured.slot;
  const x = () =>
    page.evaluate(() => {
      const inner = document.querySelector('[data-marquee-kind="author"]')!
        .firstElementChild as HTMLElement;
      const match = /matrix\(([^)]+)\)/.exec(getComputedStyle(inner).transform);
      return match ? Math.round(Number((match[1] ?? "").split(",")[4] ?? 0)) : 0;
    });
  // Polled to the far end of the slide, rather than sampled for a minimum on the
  // frame grid. The name parks at that end for `PAUSE_SECONDS` — 1.2s, six looks
  // even at the five frames a second CI hands out — so the end state is
  // catchable at any frame rate, while a frame-by-frame minimum over a fixed 3s
  // window measures how far the animation got inside that window, which is a
  // statement about the runner rather than about the marquee.
  await expect.poll(x, { timeout: 15_000 }).toBeLessThanOrEqual(-(overflow - 1));
});

/**
 * The label line is the other slot that gets cut off on a 138px tile: three
 * short CJK tags already overflow it. It uses the same marquee, so the same
 * evidence applies — the fixture overflows, the slot noticed, and hovering
 * actually moves the run. `?tags=1` is what puts labels on the demo shelf.
 */
test("a long label run marquees on hover instead of hiding the last tag", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&tags=1");
  await expect(page.locator("[data-book-cover]").first()).toBeVisible();

  const slot = page.locator('[data-marquee-kind="tags"]').first();
  await expect(slot).toBeVisible();

  const measured = await slot.evaluate((el) => {
    const inner = el.firstElementChild as HTMLElement;
    return {
      slot: el.clientWidth,
      content: inner.scrollWidth,
      innerClass: inner.className,
      inline: el.getAttribute("style") ?? "",
      text: el.textContent ?? "",
      title: el.getAttribute("title"),
    };
  });
  expect(
    measured.content,
    `the fixture has to overflow for this to mean anything (slot ${measured.slot}px, content ${measured.content}px)`,
  ).toBeGreaterThan(measured.slot + 8);
  expect(measured.innerClass).toContain("w-max");
  expect(measured.inline).toContain("mask-image");
  expect(measured.title).toBe(measured.text);

  await slot.hover();
  const overflow = measured.content - measured.slot;
  const x = () =>
    page.evaluate(() => {
      const inner = document.querySelector('[data-marquee-kind="tags"]')!
        .firstElementChild as HTMLElement;
      const match = /matrix\(([^)]+)\)/.exec(getComputedStyle(inner).transform);
      return match ? Math.round(Number((match[1] ?? "").split(",")[4] ?? 0)) : 0;
    });
  await expect.poll(x, { timeout: 15_000 }).toBeLessThanOrEqual(-(overflow - 1));
});
