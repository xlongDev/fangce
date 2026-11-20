import { expect, test } from "@playwright/test";

/**
 * Leaving the reader: the cover goes home and the shelf keeps its place.
 *
 * Opening a book flies its cover from the shelf tile into the reader's header
 * (`BookCoverFlight`); leaving used to drop it on the floor — the tile was not
 * in the DOM yet when the reader unmounted, so the handoff was simply not
 * started, and the cover vanished while the reader landed at the top of a shelf
 * they had scrolled halfway down. Both halves are asserted here because both
 * are invisible to the unit suite: they only exist across a route change.
 *
 * `?demo=1` supplies three sample books so the reader is reachable without the
 * Tauri backend.
 */
test("leaving the reader flies the cover home and restores the shelf's place", async ({ page }) => {
  // Short enough that three sample books overflow the shelf, which is what
  // makes the scroll half of this test mean anything.
  await page.setViewportSize({ width: 1280, height: 340 });
  await page.goto("/?demo=1");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();
  const overflow = await shelf.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the shelf has to be scrollable for this test to bite").toBeGreaterThan(40);

  // The grid tile, not the 续读 card above it: that one carries a cover of its
  // own — a differently-rounded one — and shares the book's name, so a bare
  // name match lands on it first.
  const tile = page
    .locator("button:has([data-book-cover])")
    .filter({ hasText: /我们为什么会生病/ })
    .first();

  // Clicked by coordinate, not by locator: Playwright scrolls a located element
  // into view before clicking it, which would move the very position this test
  // is about (the diagnostic run showed it landing at 175 instead of 40). The
  // band is scrolled so that the tile's cover, not the 续读 card, is what sits
  // under the point — they are rounded differently (18px against 14px), and
  // which one the flight picks up is exactly what is asserted below.
  const point = await shelf.evaluate((el) => {
    const band = el.getBoundingClientRect();
    const cover = el.querySelector("[data-book-cover]") as HTMLElement;
    const box = cover.getBoundingClientRect();
    el.scrollTop += box.top + box.height / 2 - (band.top + band.height / 2);
    const moved = cover.getBoundingClientRect();
    const x = moved.left + moved.width / 2;
    const y = moved.top + moved.height / 2;
    return {
      x,
      y,
      onCover: document.elementFromPoint(x, y)?.closest("[data-book-cover]") !== null,
      radius: getComputedStyle(cover).borderTopLeftRadius,
    };
  });
  expect(point.onCover, "a tile cover has to be under the point clicked").toBe(true);
  expect(point.radius, "the tile, not the 续读 card").toBe("18px");

  const left = await shelf.evaluate((el) => el.scrollTop);
  expect(left).toBeGreaterThan(0);

  // Everything below is sampled inside the page rather than asserted from the
  // outside, because three of the things under test live for a third of a
  // second: a flight is 420 ms, and the duplicate page it was drawn with only
  // lasted the length of an exit. A polling assertion loses that race as soon
  // as the suite runs both engines at once — it did.
  //
  // The duplicates: `AnimatePresence` keeps rendering the child it is sending
  // out, and a nested `<Outlet/>` in it re-resolves against the route that just
  // arrived — so the outgoing page *was* the incoming page, mounted twice for
  // the length of the exit (measured: two `ReaderPage`s from one commit, the
  // spare unmounting 229 ms later). The shelf did the same on the way back,
  // which is exactly why a cover looked redrawn just after a flight landed: two
  // copies of the tile were cross-fading ten pixels apart. AppShell renders
  // `useOutlet()` instead, and this is what holds that in place.
  await page.evaluate((flightSelector) => {
    const w = window as unknown as {
      peakCounts?: Record<string, number>;
      flightRadius?: string | null;
      flightSamples?: number;
      flightLanding?: { x: number; y: number } | null;
      lastTile?: string | null;
    };
    w.peakCounts = {};
    w.flightRadius = null;
    w.flightSamples = 0;
    w.flightLanding = null;
    w.lastTile = null;
    const rect = (el: Element) => {
      const b = el.getBoundingClientRect();
      return `${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    };
    const sample = () => {
      for (const selector of ["[data-header-cover]", "[data-shelf-scroller]"]) {
        w.peakCounts![selector] = Math.max(
          w.peakCounts![selector] ?? 0,
          document.querySelectorAll(selector).length,
        );
      }
      const flight = document.querySelector(flightSelector);
      const cover = document.querySelector("[data-book-cover]");
      // Where the cover actually is, sampled on the last frame it is visible.
      if (cover) w.lastTile = rect(cover);
      if (!flight) return;
      w.flightSamples = (w.flightSamples ?? 0) + 1;
      w.flightRadius ??= getComputedStyle(flight).borderTopLeftRadius;
      // Where the flight is *aimed*, not where a 5Hz runner last painted it.
      // The layer carries the decision as data attributes on the commit that
      // launches it, so this needs no frame. Comparing the flight's painted
      // rect against the tile on the last frame before it dissolves loses by
      // tens of pixels on a loaded runner — the compositor had not painted the
      // arrival yet. The destination's box is registered while its page is
      // still settling from its own entrance, so reading the decision next to
      // the tile's settled box is what catches a genuine miss (a one-shot box
      // left the flight 9px low and the tile then hopped into place).
      const lx = flight.getAttribute("data-flight-landing-x");
      const ly = flight.getAttribute("data-flight-landing-y");
      if (lx !== null && ly !== null) {
        w.flightLanding = { x: Number(lx), y: Number(ly) };
      }
    };
    sample();
    window.setInterval(sample, 16);
  }, "[data-cover-flight]");

  await page.mouse.click(point.x, point.y);

  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  await page.getByRole("button", { name: "返回书库" }).first().click();

  // Landed: the flight ends the handoff and the tile reveals its own cover.
  await expect(tile.locator("[data-book-cover]")).toHaveCSS("opacity", "1");

  // Back where it was left, not at the top. Within a pixel: this test parks the
  // shelf by adding a computed centre offset to `scrollTop`, so the position it
  // compares against is fractional while the restored one is whole.
  await expect
    .poll(async () => Math.abs((await shelf.evaluate((el) => el.scrollTop)) - left))
    .toBeLessThanOrEqual(1);

  const watched = await page.evaluate(() => {
    const w = window as unknown as {
      peakCounts?: Record<string, number>;
      flightRadius?: string | null;
      flightSamples?: number;
      flightLanding?: { x: number; y: number } | null;
      lastTile?: string | null;
    };
    return {
      peak: w.peakCounts,
      radius: w.flightRadius,
      samples: w.flightSamples ?? 0,
      landing: w.flightLanding ?? null,
      tile: w.lastTile ?? null,
      flying: document.querySelectorAll("[data-cover-flight]").length,
    };
  });

  // Seen at all — not seen *often*. How many samples a 16ms timer catches of a
  // 420ms flight is the machine's business (a loaded runner can block the thread
  // through most of it); that the flight was in the air is what this says.
  expect(watched.samples, "a flight has to have been seen in the air").toBeGreaterThan(0);
  expect(watched.flying, "and it has to be over").toBe(0);
  // The flight wears the corner of the cover it left: it sits exactly on the
  // tile while the tile stops showing its own, so a radius of its own would
  // read as a second, differently-rounded edge for the length of the handoff.
  expect(watched.radius, "the corner of the flight came from the tile").toBe(point.radius);
  expect(watched.peak?.["[data-header-cover]"], "one reader at a time").toBe(1);
  expect(watched.peak?.["[data-shelf-scroller]"], "one shelf at a time").toBe(1);
  // And it is aimed at where the tile actually is. Compare the flight's
  // *decision* (written on the launch commit, no frame needed) to the tile's
  // last painted box, not the flight's last painted box: a 5Hz runner can go
  // most of a 420ms flight without painting its arrival, so the painted pair
  // was 24.8px apart on CI for a flight that did land. A box registered once,
  // while the shelf was still rising out of its entrance, really did leave the
  // cover 9px low — that is the miss this still catches.
  expect(watched.landing, "a landing was aimed").not.toBeNull();
  expect(watched.tile, "the tile was sampled").not.toBeNull();
  const xy = (pair: string): [number, number] => {
    const [x = 0, y = 0] = pair.split(",").map(Number);
    return [x, y];
  };
  const [tileX, tileY] = xy(watched.tile ?? "0,0");
  expect(Math.abs(watched.landing!.x - tileX), "aimed at the tile, x").toBeLessThan(4);
  expect(Math.abs(watched.landing!.y - tileY), "aimed at the tile, y").toBeLessThan(4);
});

/**
 * The same handoff, with the reader taking over mid-flight.
 *
 * The shelf is live while its cover is in the air. Reporting the landing box on
 * every frame the destination moved meant a *scroll* re-targeted the flight
 * every frame — and a transition whose target changes restarts its duration, so
 * the cover chased the tile up out of the shelf and over the page header
 * (reported, with a screenshot, as the cover "running away upwards"). The
 * flight is aimed once now, so a scroll under it cannot move it.
 */
test("a scroll under a flight home does not drag the flight with it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Enough books to leave the shelf scrollable — the three sample books are not,
  // at this height.
  await page.goto("/?demo=1&books=24");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();

  await page.locator("[data-book-cover]").first().click();
  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  // Where the flight ends up, taken from the app rather than off the screen.
  //
  // This used to be a 16ms `setInterval` watching the flight's rect, and it was
  // a coin toss on CI: a flight lives 420ms and the runner hands out a frame
  // about every 200ms, so the sampling window holds two looks at best — and a
  // busy main thread delays the timer on top of that. Measured on CI: the last
  // look taken before the element was removed read the *aiming* position, 298px
  // from the slot the flight went on to land in, and the assertion read that as
  // the flight having chased the scroll. That is the sampler's blind spot, not
  // the flight: nothing on that runner had moved yet when it looked.
  //
  // `transitionend` is an event, so it is queued rather than dropped when the
  // main thread is busy, and it fires while the element is still mounted — the
  // app ends the handoff from its own listener on the same event, and this one
  // is on `document` in the capture phase, so it runs first. What it reads is
  // `data-flight-landing-y`: the aim the app committed, not a position the
  // compositor was asked to have painted by then. A re-aimed flight writes a new
  // one, so this still catches the regression it is here for.
  await page.evaluate(() => {
    const w = window as unknown as {
      aim?: { seen: number; landed: number | null; rect: number | null };
    };
    w.aim = { seen: 0, landed: null, rect: null };
    document.addEventListener(
      "transitionend",
      (event) => {
        const el = event.target as HTMLElement | null;
        if (!el?.hasAttribute("data-cover-flight")) return;
        if ((event as TransitionEvent).propertyName !== "transform") return;
        w.aim!.seen += 1;
        w.aim!.landed = Number(el.getAttribute("data-flight-landing-y"));
        // Kept for the next person reading a failure: never asserted, because a
        // rect read mid-flight is exactly the measurement this test stopped
        // trusting. If it disagrees with `landed`, the runner was the problem.
        w.aim!.rect = el.getBoundingClientRect().y;
      },
      true,
    );
  });

  await page.getByRole("button", { name: "返回书库" }).first().click();
  // A beat into the flight, then scroll the shelf out from under it. Waited for
  // rather than timed: the flight only launches once it has somewhere to land
  // (see `BookFlight`), so its leaving *is* the proof that the box was read — and
  // on a loaded runner that happens later than any fixed beat. Measured on CI:
  // the shelf mounted slowly enough that the scroll landed before the box was
  // read, the flight then aimed at the tile's scrolled slot and ended 262px from
  // where this test thought its aim was. That is the flight obeying the aim it
  // was given, not the "chased the scroll" regression under test — so the scroll
  // has to wait until there is an aim to not-chase.
  //
  // Waited for on the app's own state, not on the pixels moving. The layer
  // mounts *before* it has anywhere to land, so its existence is not the answer,
  // and "the box moved more than 4px" made a second question out of a first one:
  // it asked the compositor to deliver a frame during a 420ms transition that
  // headless WebKit on CI samples about twice, and it answered by timing out —
  // for 15s, once the timeout was raised from 5s. `data-flight-phase` is written
  // on the commit that starts the transition, so no frame has to be delivered
  // for it to be read.
  await expect(page.locator('[data-cover-flight][data-flight-phase="landing"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  // Read here, from the driver, rather than off a sampler: the tile's own y is
  // the baseline everything below is measured against, and a 16ms interval on a
  // runner that paints five times a second can miss the whole window between
  // this scroll and the flight landing.
  const tileBefore = await page
    .locator("[data-book-cover]")
    .first()
    .evaluate((el) => el.getBoundingClientRect().y);
  const scrolled = await shelf.evaluate((el) => {
    el.scrollTop += 260;
    return el.scrollTop;
  });
  expect(scrolled, "the shelf has to actually scroll").toBeGreaterThan(200);
  const tileAfter = await page
    .locator("[data-book-cover]")
    .first()
    .evaluate((el) => el.getBoundingClientRect().y);

  await expect(page.locator("[data-cover-flight]")).toHaveCount(0, { timeout: 5_000 });

  const aim = await page.evaluate(
    () =>
      (window as unknown as { aim: { seen: number; landed: number | null; rect: number | null } })
        .aim,
  );
  expect(aim?.seen ?? 0, "the flight has to have run its transition").toBeGreaterThan(0);
  // The tile moved a long way; the flight did not follow it.
  expect(Math.abs(tileAfter - tileBefore), "the shelf really moved the tile").toBeGreaterThan(200);
  // Within a few pixels, not within one: the slot is measured a moment after the
  // aim was registered, and a page still settling under it reads 2.4px apart in
  // the test above. What this guards is anything but a rounding error — the
  // re-aimed flight ended 262px away.
  expect(
    Math.abs((aim?.landed ?? 0) - tileBefore),
    "and the flight stayed on the aim it had",
  ).toBeLessThanOrEqual(4);
  // Stated the other way round, because this is the regression: the aim is the
  // slot the tile had when the flight left, not the one the scroll moved it to.
  expect(
    Math.abs((aim?.landed ?? 0) - tileAfter),
    "and not on the slot the scroll moved it to",
  ).toBeGreaterThan(200);
});

/**
 * And when the reader is the one scrolling, the flight yields.
 *
 * A flight home lands on the slot its tile had, so a *real* scroll under it has
 * to end it: otherwise the cover lands on a slot its tile has since left and
 * hops the difference (measured: 59px of hop for a 60px scroll, at the instant
 * the handoff ended — after the eye had followed the cover all the way). It is
 * dropped at the gesture instead, where the whole shelf is moving anyway.
 */
test("scrolling the shelf mid-flight hands the cover straight back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1&books=24");

  const shelf = page.locator("[data-shelf-scroller]");
  await expect(shelf).toBeVisible();

  await page.locator("[data-book-cover]").first().click();
  await expect(page.getByRole("button", { name: "返回书库" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  // Counting starts at the wheel, so what it measures is the flight's survival.
  await page.evaluate(() => {
    const w = window as unknown as { after?: { counting: boolean; frames: number } };
    w.after = { counting: false, frames: 0 };
    const sample = () => {
      if (!w.after!.counting) return;
      if (document.querySelector("[data-cover-flight]")) w.after!.frames += 1;
    };
    window.setInterval(sample, 16);
  });

  await page.getByRole("button", { name: "返回书库" }).first().click();
  // A beat into the flight, then a real wheel over the shelf.
  await page.waitForTimeout(150);
  const band = await shelf.boundingBox();
  if (!band) throw new Error("the shelf has to have a box");
  await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
  await page.mouse.wheel(0, 60);
  await page.evaluate(() => {
    const w = window as unknown as { after: { counting: boolean } };
    w.after.counting = true;
  });
  await page.waitForTimeout(700);

  const after = await page.evaluate(
    () => (window as unknown as { after: { frames: number } }).after,
  );
  // Gone within a frame or two of the gesture — not the ~350ms it had left.
  expect(after.frames, "the flight does not outlive the scroll").toBeLessThanOrEqual(3);
  // And its tile is showing its own cover again — polled rather than read off the
  // sampler, whose last sample is one 16ms window and can land before the tile's
  // own cover has finished fading back up.
  await expect(page.locator("[data-book-cover]").first()).toHaveCSS("opacity", "1");
});
