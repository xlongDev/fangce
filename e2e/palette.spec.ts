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
