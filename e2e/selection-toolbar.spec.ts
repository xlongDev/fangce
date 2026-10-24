import { expect, test, type Page } from "@playwright/test";

/**
 * The reader's selection toolbar.
 *
 * The unit suite covers the note field's logic, but two of the three contracts
 * here are invisible to it, and both were found by measuring rather than by
 * reading:
 *
 * 1. Where the panel lands. jsdom has no layout at all, so the placement maths
 *    can only be checked against a real engine. It used to be computed from a
 *    hardcoded height — 84 closed, 144 with the note field open — and the
 *    clamp was measured against *those numbers*. Reality was 91 and 186, and
 *    the 42px gap arrived with the note field's action strip, so for a
 *    selection in that band the panel hung past the page's foot. It is
 *    measured from the panel's own height now.
 *
 * 2. Whether a press on the panel's own controls counts as leaving it. jsdom
 *    focuses a button on mousedown, the way Chrome does — but WebKit, which is
 *    the engine this app ships on (Tauri is WKWebView), does not. Focus falls
 *    to `body`, the field's focusout arrives with `relatedTarget: null`, and
 *    the panel's own guard read that as "the reader left": the note committed,
 *    the field unmounted, and the button's click never landed. 清空 and 删除
 *    were dead buttons in the shipping engine and worked in the dev one.
 *
 * `?demo=1` supplies the sample books and their highlights; without it the web
 * build has nothing to open.
 */

const BOOK = /我们为什么会生病/;
const PANEL = "[data-toolbar-rev]";
/** An annotation-backed run in the prose: tapping one opens the toolbar in
 *  edit mode, which is where 删除笔记 has anything to act on. */
const MARK = '[data-reading-content] a[href^="#note-"]';
/** The placement's own two clearances, mirrored from `SelectionToolbar.tsx`:
 *  the panel keeps `EDGE` off the reading area and `GAP` off the words. The
 *  "is there room for it clear of the passage" arithmetic below is the
 *  placement's, so it has to spend the same two. */
const EDGE = 12;
const GAP = 2;

/** Room for the retried navigation below. The first attempt spends its whole
 *  budget before the second one starts, and the body of each test still needs
 *  the file's original 30s on top of that. */
test.describe.configure({ timeout: 60_000 });

/**
 * The first navigation, with one retry.
 *
 * This one `goto` has timed out four times across long runs — always WebKit,
 * always the first navigation of this file, and always with the file passing
 * when it is run on its own afterwards. Normal here is 75–120 ms and the page
 * pulls eight resources, so a 30 s miss is not slowness, it is a navigation
 * that never lands. A wedged navigation does not recover by waiting; a fresh
 * one does, which is all "rerun it and it passes" was ever doing by hand.
 *
 * `domcontentloaded` rather than `load` because `load` is not a wait this test
 * has any use for: the shelf is built in JS, and every step below is either an
 * auto-waiting locator or an explicit `waitForSelector` for the prose. Measured
 * on the built app, `load` arrives ~40 ms after `domcontentloaded`, so nothing
 * is gained by holding the navigation open for it — only the exposure to
 * whatever is stalling.
 *
 * The cause is still unproven. Eighty fresh-context navigations in a single
 * WebKit process and the page in isolation both came back in under 120 ms every
 * time, so neither "the browser has been up a while" nor "a font is slow"
 * explains it. What is proven is that a second attempt lands.
 */
async function gotoDemo(page: Page) {
  const options = { waitUntil: "domcontentloaded" } as const;
  try {
    await page.goto("/?demo=1", { ...options, timeout: 12_000 });
  } catch {
    await page.goto("/?demo=1", options);
  }
}

async function openBook(page: Page) {
  await gotoDemo(page);
  await page.getByRole("button", { name: BOOK }).first().click();
  await page.waitForSelector("[data-reading-content] p", { timeout: 15_000 });
  await page.waitForTimeout(900);
}

/**
 * Selects part of the lowest paragraph still inside the content box, fires the
 * mouseup the reader's own handler listens for, and reports the selection's own
 * box alongside the reading area's.
 *
 * The selection's rect is what gives the assertion below its power. The old
 * code computed the panel's top from a height 42px short of the real one, so
 * whenever it placed the panel *above* the words it put the panel's foot 40px
 * below their top — on top of the line being annotated. That holds for any
 * selection in the lower half of the page, not just one band of it. (Asserting
 * only that the panel stays inside the area was tried first and passed against
 * the broken code: the overflow it caused needs the selection inside a 42px
 * band, and none of these window heights landed in it.)
 *
 * The helpers stay inside `page.evaluate` on purpose: it serialises the
 * function and runs it in the browser, where nothing from module scope exists.
 */
async function selectLowestParagraph(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector("[data-reading-content]");
    if (!content) return { ok: false as const, why: "no [data-reading-content]" };
    const box = content.getBoundingClientRect();
    const usable = [...content.querySelectorAll("[data-para-idx]")].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.bottom < box.bottom - 20 && r.top > box.top;
    });
    const target = usable.at(-1);
    if (!target) return { ok: false as const, why: `no usable paragraph of ${usable.length}` };
    const text = [...target.childNodes].find(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 8,
    );
    if (!text) return { ok: false as const, why: "no long text node" };
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(12, (text.textContent ?? "").trim().length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    const r = range.getBoundingClientRect();
    return {
      ok: true as const,
      selTop: Math.round(r.top),
      selBottom: Math.round(r.bottom),
      areaTop: Math.round(box.top),
      areaBottom: Math.round(box.bottom),
    };
  });
}

/** The panel's box, in window coordinates. */
function panelBox() {
  const panel = document.querySelector("[data-toolbar-rev]");
  if (!panel) return null;
  const p = panel.getBoundingClientRect();
  return { top: Math.round(p.top), bottom: Math.round(p.bottom) };
}

/**
 * Waits for the panel's entrance to finish.
 *
 * The panel enters on `SPRING.enter` — stiffness 420, damping 30 — which is a
 * damping ratio of 0.73 and roughly 400–500 ms to settle, `scale: 0.92 → 1`
 * included. A flat 400 ms sits *inside* that window, so what it measured was
 * whatever the spring happened to have reached, and on a runner dropping frames
 * that is still mid-flight: Playwright's click then waits for the button's box
 * to stop moving while the spring is still moving it ("element is not stable"),
 * and the box this file measures is one the panel is about to leave.
 *
 * Two consecutive frames with an identical box is the witness, and it is the
 * only thing here that is not a guess about the frame rate. A panel that never
 * comes to rest fails here rather than quietly measuring a moving target.
 *
 * The record is cleared on the way in: the slot lives on `window`, so without
 * that the first poll of a later call compares against the *previous* call's
 * last box and can return true on a panel that has not come to rest at all.
 */
async function panelAtRest(page: Page) {
  await page.evaluate(() => {
    delete (window as unknown as { panelRestBox?: DOMRect }).panelRestBox;
  });
  await page.waitForFunction(
    () => {
      const panel = document.querySelector("[data-toolbar-rev]");
      if (!panel) return false;
      const box = panel.getBoundingClientRect();
      // Carried on `window` because `waitForFunction` re-evaluates this body
      // every frame: the previous frame's box has to survive between polls.
      const slot = window as unknown as { panelRestBox?: DOMRect };
      const seen = slot.panelRestBox;
      slot.panelRestBox = box;
      if (!seen) return false;
      return (
        Math.abs(seen.top - box.top) < 0.5 &&
        Math.abs(seen.left - box.left) < 0.5 &&
        Math.abs(seen.width - box.width) < 0.5 &&
        Math.abs(seen.height - box.height) < 0.5
      );
    },
    undefined,
    { polling: "raf", timeout: 8000 },
  );
}

/** The panel, mounted and at rest — the state every measurement below assumes. */
async function panelSettled(page: Page) {
  await page.waitForSelector(PANEL, { timeout: 5000 });
  await panelAtRest(page);
}

/**
 * Waits for the panel to be *gone*, not merely dismissed.
 *
 * The exit runs the same `SPRING.enter` the entrance does — 460–490 ms here,
 * longer on a runner that drops frames — and `AnimatePresence` keeps the node
 * in the DOM for all of it. A flat 300 ms therefore leaves the previous round's
 * panel still mounted while the next round's is appearing: `querySelector`
 * returns the dying one first, so every box measured after it belongs to a panel
 * that is on its way out, and `getByRole` resolves to two 记笔记 buttons. Both
 * were seen on the runner.
 */
async function panelGone(page: Page) {
  await page.waitForSelector(PANEL, { state: "detached", timeout: 8000 });
}

test("the note field never pushes the panel off the page or over the words", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  // A shorter window moves the last paragraph towards the content's foot, which
  // is where the placement has the least room and the old constants failed.
  // Varying the frame rather than the content keeps the fixture untouched.
  for (const height of [820, 620, 500, 420]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(350);

    const picked = await selectLowestParagraph(page);
    expect(picked.ok, `a paragraph to select at ${height}px: ${picked.ok ? "" : picked.why}`).toBe(
      true,
    );
    if (!picked.ok) continue;
    await panelSettled(page);

    for (const step of ["closed", "open"] as const) {
      if (step === "open") {
        await page.getByRole("button", { name: "记笔记" }).click();
        await panelAtRest(page);
      }
      const box = await page.evaluate(panelBox);
      expect(box, `${height}px ${step}: the panel must be mounted`).not.toBeNull();
      if (!box) continue;
      const where = `${height}px ${step}: panel ${box.top}..${box.bottom}, area ${picked.areaTop}..${picked.areaBottom}, words ${picked.selTop}..${picked.selBottom}`;
      // On the page. The panel keeps a 12px clearance inside the area, but
      // pinning that exact figure here would pin `EDGE` twice.
      expect(box.top, `${where} — must not rise past the top`).toBeGreaterThanOrEqual(
        picked.areaTop,
      );
      expect(box.bottom, `${where} — must not hang past the foot`).toBeLessThanOrEqual(
        picked.areaBottom,
      );
      // And clear of the passage: the panel goes below the words or above them,
      // never across them — but only where that is possible. On a page too
      // short to hold the panel clear of the selection there is no placement
      // that satisfies both, and staying on the page is the one that matters
      // (at a 420px window the area is 252px tall and the open panel is 186px,
      // which leaves 150px above the words and 81px below: neither fits). The
      // cases with room are the ones held to it, and they are the ones the old
      // placement failed.
      //
      // "Room" is the placement's own arithmetic, not the raw gap: the panel
      // keeps `EDGE` (12) clear of the area and `GAP` (2) off the words, so the
      // space it can actually occupy is the raw gap less both. Without that the
      // guard claims a placement exists in the 14px band where it does not —
      // which is what CI's 500px round measured (186px panel into a 190px raw
      // gap: the panel clamps to the area's top and lands 8px onto the words).
      const panelHeight = box.bottom - box.top;
      const room =
        Math.max(picked.selTop - picked.areaTop, picked.areaBottom - picked.selBottom) - EDGE - GAP;
      if (room >= panelHeight) {
        expect(
          box.bottom <= picked.selTop || box.top >= picked.selBottom,
          `${where} — must not cover the words`,
        ).toBe(true);
      }
    }

    // Closing the panel is also what ends the round: the note field dies with
    // its selection, so the next round opens over a panel that is not already
    // noting. The wait is for the node to leave the DOM — see `panelGone`.
    await page.getByRole("button", { name: "关闭" }).click();
    await panelGone(page);
  }
});

/**
 * The layout's own re-anchor must not read as the reader leaving.
 *
 * A paged layout re-anchors on a column boundary after every re-flow, and a
 * resize is a re-flow: the ResizeObserver fires, a frame later the scroller is
 * written to. That scroll used to dismiss the toolbar — the reader had not
 * moved, the page had been re-laid-out under them — so resizing the window
 * with a note half-written threw the note away and closed the panel. It is the
 * same gesture the placement loop above makes four times, which is why this
 * only ever failed on the runner: there the re-anchor lands *after* the
 * selection, where locally it lands before it.
 *
 * The panel is followed onto the words rather than dropped, so it has to still
 * be there *and* still be over the selection afterwards.
 */
test("a re-flow under an open toolbar re-anchors it instead of closing it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  const picked = await selectLowestParagraph(page);
  expect(picked.ok, picked.ok ? "" : picked.why).toBe(true);
  if (!picked.ok) return;
  await panelSettled(page);

  // A note in flight, because that is what a reader loses when this breaks.
  await page.getByRole("button", { name: "记笔记" }).click();
  await panelAtRest(page);
  const field = page.getByRole("textbox", { name: "笔记" });
  await field.fill(" resize 之后这句话还在 ");

  // The re-flow itself: a narrower pane re-wraps the columns and the scroller
  // is written to a new column boundary.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(600);

  await expect(page.locator(PANEL), "the re-flow must not close the toolbar").toHaveCount(1);
  await expect(field, "and the note in it must survive the re-flow").toHaveValue(
    " resize 之后这句话还在 ",
  );

  // Still over the words, not stranded where they used to be.
  const after = await page.evaluate(() => {
    const panel = document.querySelector("[data-toolbar-rev]")?.getBoundingClientRect();
    const content = document.querySelector("[data-reading-content]")?.getBoundingClientRect();
    if (!panel || !content) return null;
    return {
      panelTop: Math.round(panel.top),
      panelBottom: Math.round(panel.bottom),
      areaTop: Math.round(content.top),
      areaBottom: Math.round(content.bottom),
    };
  });
  expect(after, "the panel and the reading area must both be measurable").not.toBeNull();
  if (!after) return;
  expect(after.panelTop, `panel ${after.panelTop}..${after.panelBottom}`).toBeGreaterThanOrEqual(
    after.areaTop,
  );
  expect(
    after.panelBottom,
    `panel ${after.panelTop}..${after.panelBottom}, area ${after.areaTop}..${after.areaBottom}`,
  ).toBeLessThanOrEqual(after.areaBottom);
});

test("a press on the panel's own controls does not count as leaving it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  await page.locator(MARK).first().click();
  await panelSettled(page);
  await page.getByRole("button", { name: "记笔记" }).click();
  await panelAtRest(page);

  const field = page.getByRole("textbox", { name: "笔记" });
  await field.fill("写到一半换个颜色");

  // An ink swatch: a control with nothing to do with the note. In WebKit this
  // used to commit the note and close the whole toolbar.
  await page.getByRole("button", { name: "黄色" }).click();
  await page.waitForTimeout(500);
  await expect(page.locator(PANEL), "the panel must survive its own control").toHaveCount(1);
  await expect(field, "and keep the draft").toHaveValue("写到一半换个颜色");

  // The buttons this row exists for must still be reachable after the press —
  // they were unmounted mid-click before, which is what made them dead.
  await expect(page.getByRole("button", { name: "保存笔记" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "清空输入" })).toBeEnabled();
});

test("清空 empties the field only, and 删除 drops the note but not the highlight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openBook(page);

  const openField = async () => {
    await page.locator(MARK).first().click();
    await panelSettled(page);
    await page.getByRole("button", { name: "记笔记" }).click();
    await panelAtRest(page);
  };

  await openField();
  const field = page.getByRole("textbox", { name: "笔记" });
  // Pre-filled from the highlight's own note, and 保存 is dead until something
  // changes — a save button that is always live invites a pointless write.
  await expect(field).not.toHaveValue("");
  const saved = await field.inputValue();
  await expect(page.getByRole("button", { name: "保存笔记" })).toBeDisabled();

  // 清空 touches the field and nothing else. Escape closes the field without
  // committing (closing the *panel* does commit — that is its rule), so what
  // the next open shows is the note as it still stands in the store.
  await page.getByRole("button", { name: "清空输入" }).click();
  await expect(field).toHaveValue("");
  await expect(page.getByRole("button", { name: "清空输入" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "关闭" }).click();
  await page.waitForTimeout(500);

  await openField();
  await expect(
    page.getByRole("textbox", { name: "笔记" }),
    "清空 must not have written",
  ).toHaveValue(saved);

  // 删除 drops the note and leaves the highlight standing. The write closes the
  // toolbar — `noteOnSelection` clears the pending selection once the note is
  // in — so wait for it to go rather than measure mid-exit.
  const marks = await page.locator(MARK).count();
  await page.getByRole("button", { name: "删除笔记" }).click();
  await page.waitForSelector(PANEL, { state: "detached", timeout: 5000 });
  await page.waitForTimeout(900);
  expect(await page.locator(MARK).count(), "the highlight stays").toBe(marks);

  await openField();
  await expect(page.getByRole("textbox", { name: "笔记" })).toHaveValue("");
  // Nothing left to drop, so the button is not offered: one that is always
  // there and sometimes does nothing is worse than one that appears when it
  // applies.
  await expect(page.getByRole("button", { name: "删除笔记" })).toHaveCount(0);
});
