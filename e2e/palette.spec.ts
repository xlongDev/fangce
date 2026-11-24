import { expect, test, type Page } from "@playwright/test";

/**
 * The palette, opened from where the reader actually is.
 *
 * A reflowable book is rendered by foliate into one `blob:` iframe per
 * section, and once the reader clicks the text, focus lives inside that
 * iframe. A keydown dispatched there never bubbles to the parent window, so
 * the global registry (`useHotkeys`) hears nothing — ⌘K opened the palette on
 * the shelf, in settings, and everywhere else, and did nothing at all in a
 * book. `FoliateBookView` forwards the presses a command is bound to; this is
 * the test that the forward is still there.
 *
 * It has to run in a real browser: the whole failure is a property of iframe
 * event routing, which jsdom does not have. The click before the press is the
 * point of the test, not setup — without it focus is on the shelf button and
 * the shortcut works for the wrong reason.
 */

async function openKindleBook(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&kindle=1");
  await page
    .getByRole("button", { name: /Kindle 样书/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  // The section has to be *rendered*, not merely present: foliate attaches the
  // forwarding listener when a section loads, and a click that lands in a
  // frame which exists but has not loaded yet puts the caret somewhere no
  // listener is watching. Polling the book's own words is the same readiness
  // signal `kindle-reading.spec.ts` uses.
  await expect
    .poll(() => sectionText(page), { timeout: 10_000 })
    .toContain("AZW3 与 MOBI 是同一个容器");
}

/** The text of every foliate section document currently mounted. */
async function sectionText(page: Page): Promise<string> {
  const frames = page.frames().filter((frame) => frame.url().startsWith("blob:"));
  const parts = await Promise.all(
    frames.map((frame) =>
      frame
        .locator("body")
        .innerText()
        .catch(() => ""),
    ),
  );
  return parts.join("\n");
}

test("⌘K opens the palette while the focus is inside the book", async ({ page }) => {
  await openKindleBook(page);

  const section = page.frames().find((frame) => frame.url().startsWith("blob:"))!;
  const box = await section.locator("body").boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 3);
  // The host document reports the shadow host, not the element holding the
  // caret — this is how the test knows the click landed in the section.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe("FOLIATE-VIEW");

  // `Control` rather than `Meta`: the matcher accepts either for `mod`, and
  // the runner is not always macOS.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();

  // Typing lands in the palette's own field, so the keyboard is the palette's
  // now — the section did not keep it.
  await page.keyboard.type("标签");
  await expect(page.getByRole("dialog")).toContainText("标签");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/**
 * ⌘F is a command in the same registry as ⌘K, so it is rebindable from 设置 ›
 * 快捷键 and is forwarded out of foliate's section iframes by the same rule.
 * This pins the visible half: the hotkey opens the search body of the palette
 * shell, with the caret already in its field, and Escape gives the page back.
 */
test("⌘F opens the library-wide search", async ({ page }) => {
  await page.goto("/?demo=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("Control+f");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("全局搜索");

  const field = page.getByRole("textbox", { name: "搜索正文" });
  await expect(field).toBeFocused();
  await page.keyboard.type("哲学");
  await expect(field).toHaveValue("哲学");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

/**
 * The row highlight is ONE element that glides from row to row, not one that
 * remounts per row. A `layoutId` on each active row re-measured and re-rasterised
 * the glass on every hover, which read as sticky; a single measured element
 * hands the tween to the compositor. The glide must also be *visible*: the
 * first attempt used a 120ms expo-out that covered 94% of a 126px hop in 60ms
 * and looked like a jump, so this pins a mid-flight frame between two rows.
 */
test("the palette cursor glides between rows as one element", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const cursor = page.locator("[data-palette-cursor]");
  const rows = dialog.locator("li[data-row]");
  await expect(cursor).toHaveCount(1);

  // Settle on the first row, then jump to a row three down and watch the whole
  // journey. A visible glide has a frame strictly between the two positions;
  // the old expo-out was already at the target by the first sample.
  //
  // 🔴 Sample every frame, do not read once after a fixed wait. CI WebKit runs
  // rAF at roughly a fifth of Chromium's rate, so a 90ms probe lands wherever
  // the spring happens to be then: it read 327 on 2026-11-23 — already past a
  // target at 324 — and failed a test that was really gliding. The contract is
  // that a mid-flight frame exists at all, which a full trace sees regardless
  // of when any single frame arrived (and regardless of the spring's overshoot).
  await rows.nth(0).hover();
  const fromY = (await cursor.boundingBox())!.y;
  const target = (await rows.nth(3).boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { paletteTrail?: number[] };
    const el = document.querySelector("[data-palette-cursor]");
    w.paletteTrail = [];
    let stop = false;
    const tick = () => {
      if (stop) return;
      if (el) w.paletteTrail!.push(el.getBoundingClientRect().y);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as unknown as { stopPaletteTrail?: () => void }).stopPaletteTrail = () => {
      stop = true;
    };
  });
  await rows.nth(3).hover();
  // Let the spring finish before reading the trace — expect.poll, never a
  // fixed timeout that could stop sampling before the glide is over.
  await expect
    .poll(async () => Math.abs((await cursor.boundingBox())!.y - target.y))
    .toBeLessThan(3);
  const trail = await page.evaluate(() => {
    const w = window as unknown as { paletteTrail: number[] };
    (window as unknown as { stopPaletteTrail: () => void }).stopPaletteTrail();
    return w.paletteTrail;
  });
  expect(
    trail.some((y) => y > fromY + 8 && y < target.y - 8),
    `没有严格位于起终点之间的滑行帧：${fromY} → ${target.y}，采样 ${trail.length} 帧`,
  ).toBe(true);

  // It lands on the row (settled above), keeps its own height (rows differ),
  // and stays one node under both pointer and keyboard moves. The spring curve
  // is shared with the tag rail's highlight.
  expect(Math.abs((await cursor.boundingBox())!.height - target.height)).toBeLessThan(3);
  await expect(cursor).toHaveCount(1);
  expect(await cursor.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.34s");
  expect(await cursor.evaluate((el) => getComputedStyle(el).transitionTimingFunction)).toContain(
    "cubic-bezier(0.34, 1.26, 0.64, 1)",
  );

  await dialog.getByRole("textbox").focus();
  await page.keyboard.press("ArrowUp");
  await expect(cursor).toHaveCount(1);
  expect(await cursor.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.34s");
});

/**
 * A cover keeps its box when the row's title is long. Tailwind's base
 * `img{max-width:100%}` caps the picture at its flex wrapper: without
 * `shrink-0` there, a long title squeezed the wrapper to 8px and the cover
 * became a narrow strip while its height stayed 28px.
 */
test("a book cover keeps its size when the title is long", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("生病");
  const cover = dialog.locator("li[data-row] img");
  await expect(cover).toBeVisible();
  const before = (await cover.boundingBox())!;
  await dialog
    .locator("li[data-row] button span.block.truncate")
    .first()
    .evaluate((el) => (el.textContent = "我们为什么会生病".repeat(12)));
  const after = (await cover.boundingBox())!;

  // Compare against the same cover before the title grew: engines round
  // subpixel widths differently, but a squeezed slot loses most of its width.
  expect(after.width / before.width).toBeGreaterThan(0.9);
  expect(after.height / before.height).toBeGreaterThan(0.9);
});

test("a copy press still reaches the book", async ({ page }) => {
  await openKindleBook(page);

  const section = page.frames().find((frame) => frame.url().startsWith("blob:"))!;
  const box = await section.locator("body").boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 3);

  // The forwarder answers "is a command bound to this press"; ⌘C is not one,
  // so the press must reach the section untouched. `preventDefault` there
  // would have killed copy inside every book, silently.
  //
  // Started before the press and awaited after it: the evaluate returns the
  // verdict the section's own listeners leave on the event, and the reader's
  // forwarder runs in the capture phase, ahead of this bubble-phase read.
  const verdict = section.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const read = (event: KeyboardEvent) => {
          if (event.key !== "c") return;
          window.removeEventListener("keydown", read);
          resolve(event.defaultPrevented);
        };
        window.addEventListener("keydown", read);
      }),
  );
  await page.keyboard.press("Control+c");
  expect(await verdict).toBe(false);
});

test("clearing recent searches empties both the list and the stored history", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("fangce.search-history", JSON.stringify(["哲学", "小说"]));
    } catch {
      // A blocked store just leaves the empty state empty.
    }
  });
  await page.goto("/?demo=1");
  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("哲学", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "清除最近搜过" }).click();

  await expect(dialog.getByText("哲学", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("最近搜过")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("fangce.search-history"))).toBeNull();
});

/**
 * The other half of a hit: the term is painted in the chapter it opens.
 *
 * A search result navigates through `fangce:navigate` with `?q=...`, so the
 * event is the same one the palette uses — the web fixture has no SQLite
 * chapters for the result list itself, but the reader's prose path is real.
 * The assertion is on the computed ink, not just the class: the default shape
 * is the vendor's 方框, drawn on the prose path as glyph outlines (`washCss`)
 * rather than a wash.
 */
test("a hit's term is visibly marked in the chapter it opens", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("fangce:navigate", {
        detail: "/reader?book=demo-1&chapter=0&q=%E8%BA%AB%E4%BD%93&at=0",
      }),
    ),
  );

  const marks = page.locator("[data-reading-content] mark[data-search-hit]");
  await expect(marks.first()).toBeVisible();
  expect(await marks.count()).toBeGreaterThan(0);

  const ink = await marks.first().evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, outline: style.textShadow };
  });
  expect(ink.outline, "the default 方框 outlines the glyphs").not.toBe("none");
  expect(ink.background, "no wash under the outline shape").toBe("rgba(0, 0, 0, 0)");
});
