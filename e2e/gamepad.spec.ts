import { expect, test, type Page } from "@playwright/test";

/**
 * A gamepad on the reader: the shoulders and the D-pad page, a stick pushed
 * across pages, a stick pushed along the reading axis steps the ruler, and the
 * reader's own switch turns the whole thing off.
 *
 * The Gamepad API has no events and no way to synthesize a press from script —
 * `navigator.getGamepads()` is read-only and a real pad is the only thing that
 * makes it answer — so the pad is **faked at the API boundary**: the same object
 * shape the browser hands out, installed before the app boots so the reader's
 * initial "is a pad already attached?" read finds it. Everything above that line
 * is the real hook, polling a real `requestAnimationFrame` loop.
 *
 * `?demo=1` supplies the sample book. Four chapters of the same prose, so a
 * progress span read off the wrong chapter would not be monotone — and the
 * layouts are exercised for real: 滚动 is the default here, 单页 and 双页 are
 * the paged ones the same reader reaches through 阅读设置 → 排版模式.
 */

const BOOK = /我们为什么会生病/;

/**
 * Installs a fake pad. `window.pad` is the live state the test mutates: a button
 * by index, and the two stick axes.
 */
const installPad = () => {
  const pad = {
    index: 0,
    id: "Fake Pad (Vendor: dead Product: beef)",
    connected: true,
    mapping: "standard",
    // 17 buttons and 4 axes, a full standard pad — a page-turner with only six
    // buttons must not be the shape the reader is developed against.
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    axes: [0, 0, 0, 0],
    timestamp: 0,
  };
  (window as unknown as { pad: typeof pad }).pad = pad;
  // A pad that arrives while the page is listening also fires
  // `gamepadconnected`, which is how the hook starts its loop; here the fake is
  // already there at boot, so the hook's *initial* read is what has to find it.
  Object.defineProperty(navigator, "getGamepads", {
    value: () => [pad],
    configurable: true,
  });
  // A frame counter, and the reason `pushStick`/`holdButton` release a held
  // input only after frames have run: the hook polls the pad on
  // `requestAnimationFrame` (the Gamepad API has no events), so an input that
  // is set and cleared inside one long task is never polled at all.
  const counter = window as unknown as { frameCount: number };
  counter.frameCount = 0;
  const countFrame = () => {
    counter.frameCount += 1;
    requestAnimationFrame(countFrame);
  };
  requestAnimationFrame(countFrame);
};

type Pad = {
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
};

/** Holds a button down for a few frames, then lets it up — one press, not a hold. */
async function press(page: Page, index: number) {
  await holdButton(page, index, 120);
}

/**
 * Holds a button down for `ms`, then lets it up.
 *
 * The long hold is a different gesture from the short one and is tested as one:
 * a pad that answers a held button with exactly one press cannot walk the ruler
 * down a page, and `REPEAT_DELAY` is where that decision lives.
 *
 * The release waits for frames as well as for the clock — see `pushStick`.
 */
async function holdButton(page: Page, index: number, ms: number) {
  const from = await page.evaluate((i) => {
    const w = window as unknown as { pad: Pad; frameCount: number };
    w.pad.buttons[i]!.pressed = true;
    w.pad.buttons[i]!.value = 1;
    return w.frameCount;
  }, index);
  await page.waitForTimeout(ms);
  await waitFrames(page, from);
  await page.evaluate((i) => {
    const p = (window as unknown as { pad: Pad }).pad;
    p.buttons[i]!.pressed = false;
    p.buttons[i]!.value = 0;
  }, index);
  await page.waitForTimeout(120);
}

/**
 * Waits until two real animation frames have run since `from`.
 *
 * rAF callbacks run in registration order inside a frame, and the hook's poll
 * loop registers itself before `installPad`'s counter does — so every frame
 * this waits for is a frame the hook already polled the pad in.
 */
async function waitFrames(page: Page, from: number) {
  await page.waitForFunction(
    (start) => (window as unknown as { frameCount: number }).frameCount >= start + 2,
    from,
  );
}

/**
 * Pushes a stick to the stop and holds it there for `ms`, then centers it.
 *
 * The hold is the point twice over: a latch that forgets to re-arm turns this
 * into a step per frame, and a stick that never repeats turns a held push into
 * a single step.
 *
 * 🔴 **The release waits for frames, not only for the clock.** The hook polls
 * the pad on `requestAnimationFrame` — the Gamepad API has no events — so a
 * push that is set and cleared inside one long task is never polled at all:
 * the step is lost and every assertion after it reads "nothing happened".
 * Measured: a 300ms spin on the main thread with the push inside it drops the
 * step every time; the same push, released after two real frames, lands. That
 * is the shape of what CI kept reporting — a push after a layout switch and one
 * after the ruler's first measurement, both heavy. Two frames is ~33ms on a
 * healthy machine and however long it takes on a loaded one, and it stays well
 * under `REPEAT_DELAY` (420ms) so the hold is still one press rather than a
 * walk.
 */
async function pushStick(page: Page, axisIndex: 0 | 1, to: number, ms = 160) {
  const from = await page.evaluate(
    (move) => {
      const w = window as unknown as { pad: Pad; frameCount: number };
      w.pad.axes[move.axisIndex] = move.to;
      return w.frameCount;
    },
    { axisIndex, to },
  );
  await page.waitForTimeout(ms);
  await waitFrames(page, from);
  await page.evaluate(
    (back) => {
      (window as unknown as { pad: Pad }).pad.axes[back.axisIndex] = 0;
    },
    { axisIndex },
  );
  await page.waitForTimeout(120);
}

/** The whole-book progress the footer prints. */
async function progress(page: Page): Promise<number> {
  const text = await page.locator("[data-reader-progress]").first().innerText();
  return Number(text.replace("%", "").trim());
}

/** The scroll offsets of the reading area, in page coordinates. */
async function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-reading-content]");
    return el ? Math.round(el.scrollTop) : -1;
  });
}

/** Where the reading ruler's band sits down the page, in window coordinates. */
async function bandTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ruler-band]");
    return band ? Math.round(band.getBoundingClientRect().top) : -1;
  });
}

/** The reading area's own horizontal offset — where a spread stands. */
async function spreadColumn(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-reading-content]");
    return el ? Math.round(el.scrollLeft) : -1;
  });
}

/**
 * The header's 「第 N / M 章」, parsed.
 *
 * `textContent` rather than `innerText`: WebKit blanks `innerText` on a node it
 * is not currently laying out, and the header is re-rendered while the drawer
 * animates — which is exactly when this is being polled.
 */
async function chapterIndex(page: Page): Promise<number> {
  const text = (await page.locator("header p").nth(1).textContent()) ?? "";
  const match = /第\s*(\d+)\s*\/\s*(\d+)\s*[章页]/.exec(text);
  return match ? Number(match[1]) : -1;
}

async function openBook(page: Page, url = "/?demo=1", book: RegExp = BOOK) {
  await page.addInitScript(installPad);
  await page.goto(url);
  await page.getByRole("button", { name: book }).first().click();
  // The reading container, **not** a paragraph in it: the sample EPUB opens on a
  // plate — a whole page with no text node on it — so waiting for prose here
  // times out on exactly the books this file most needs to open.
  await page.waitForSelector("[data-reading-content]", { timeout: 15_000 });
  await page.waitForTimeout(900);
}

async function chooseLayout(page: Page, label: string) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1600);
}

test("手柄翻页：肩键、方向键、摇杆三者都驱动阅读，滚动排版下页面跟着走一屏，开关关掉后不动", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await openBook(page);

  // The pad is there before the reader mounts: a fixture that only appears after
  // would never be found by the hook's initial read, and the whole suite would
  // pass without a pad ever having been polled.
  expect(await page.evaluate(() => navigator.getGamepads().some(Boolean)), "假手柄没装上").toBe(
    true,
  );

  // 滚动 first: the layout where a step of the page is a chapter, so it pins
  // the pedal before any paged layout is involved. Chosen rather than assumed —
  // the store's default is 单页 since 2026-10-21, and a test that does not say
  // which layout it is in is testing whatever the default happens to be.
  await chooseLayout(page, "滚动");
  const start = await progress(page);
  await press(page, 5); // R1
  await page.waitForTimeout(900);
  const afterShoulder = await progress(page);
  expect(afterShoulder, "R1 没有推进阅读").toBeGreaterThan(start);

  await press(page, 4); // L1 — back to where it started
  await page.waitForTimeout(900);
  expect(await progress(page), "L1 没有退回原处").toBeLessThan(afterShoulder);

  // A stick held over must be one page, not a page a frame — so this pushes,
  // holds, and centers in one go and then reads.
  await pushStick(page, 0, 1);
  await page.waitForTimeout(900);
  const afterStick = await progress(page);
  expect(afterStick, "摇杆右推没有推进阅读").toBeGreaterThan(start);
  await pushStick(page, 0, -1);
  await page.waitForTimeout(900);
  expect(await progress(page), "摇杆左推没有退回").toBeLessThan(afterStick);

  // The vertical axis is the ruler's, and in 滚动 that means the reader's own
  // scroll — the same step the down arrow takes. Asserted on `scrollTop`, not on
  // progress: a step inside a chapter moves the text and not the book's place,
  // so the footer percentage is the wrong witness for this one.
  const beforeDown = await scrollTop(page);
  await pushStick(page, 1, 1);
  await page.waitForTimeout(900);
  const afterDown = await scrollTop(page);
  expect(afterDown, "摇杆下推没有滚动正文").toBeGreaterThan(beforeDown);
  await pushStick(page, 1, -1);
  await page.waitForTimeout(900);
  expect(await scrollTop(page), "摇杆上推没有退回原处").toBeLessThan(afterDown);

  // 滚动's own scroll answers a step inside a chapter. 单页 cannot scroll — it is
  // paged, so the same stick turns the page instead, which is the fallback the
  // down arrow has and the reason the two share one call.
  await chooseLayout(page, "单页");
  const beforePaged = await progress(page);
  await pushStick(page, 1, 1);
  await page.waitForTimeout(900);
  expect(await progress(page), "单页下摇杆下推没有推进阅读").toBeGreaterThan(beforePaged);

  // 🔴 And the reading ruler, which is what the vertical stick is *for*. With
  // the band on, the same stick moves the band and the page does not turn — the
  // two are told apart by the page staying put, which is what makes this an
  // assertion about the ruler rather than about paging.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page
    .locator("aside div")
    .filter({ has: page.getByText("阅读标尺", { exact: true }) })
    .last()
    .getByRole("button", { name: "开启", exact: true })
    .click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1600);

  expect(
    await page.locator("[data-ruler-band]").count(),
    "阅读标尺没有画出来，这条用例测不到摇杆上下",
  ).toBeGreaterThan(0);
  const beforeBand = await bandTop(page);
  const pageBefore = await progress(page);
  await pushStick(page, 1, 1);
  await page.waitForTimeout(900);
  // Down the page, so the band's top edge moves **down** too — the sign is the
  // whole assertion: one that accepted either direction would pass against a
  // band that moved up.
  const stepped = await bandTop(page);
  expect(stepped - beforeBand, "摇杆下推没有把标尺往下带一行").toBeGreaterThan(5);
  expect(
    Math.abs((await progress(page)) - pageBefore),
    "标尺开着的时候摇杆下推把页翻了 —— 那不是标尺的动作",
  ).toBeLessThan(1);

  // …and back up to where it started. Asserted against the position after the
  // step, not against the start: 「往上走一步」 means one step back, which is
  // the place it came from — a band that overshot above it would also be moving
  // up, and this is the reading ruler's own symmetric step that must catch that.
  await pushStick(page, 1, -1);
  await page.waitForTimeout(900);
  const back = await bandTop(page);
  expect(stepped - back, "摇杆上推没有把标尺带回去一步").toBeGreaterThan(5);
  expect(Math.abs(back - beforeBand), "上下各推一次之后标尺没有回到原处").toBeLessThan(6);

  // 🔴 The D-pad's own up and down, which is the same axis the stick drives.
  // Asserted separately because it is a different input on purpose: a stick has
  // to be pushed and released to say anything and a d-pad does not, so for a
  // reader whose pad has one this is the walk with a thumb that never leaves it
  // — and on a pad with no stick at all it is the *only* way to reach the ruler.
  //
  // 🔴 **13 is down and 12 is up.** The d-pad is numbered clockwise from the top,
  // so a table that pairs 12 with "next" drives the ruler backwards — and it is
  // invisible on a stick, which reports axes rather than directions, which is
  // exactly why it went unnoticed until someone played it on a pad.
  const beforeDpad = await bandTop(page);
  await press(page, 13); // D-pad down
  await page.waitForTimeout(900);
  const dpadDown = await bandTop(page);
  expect(dpadDown - beforeDpad, "方向键下没有把标尺往下带一行").toBeGreaterThan(5);
  await press(page, 12); // D-pad up
  await page.waitForTimeout(900);
  expect(dpadDown - (await bandTop(page)), "方向键上没有把标尺带回去").toBeGreaterThan(5);
  expect(
    Math.abs((await progress(page)) - pageBefore),
    "标尺开着的时候方向键上下把页翻了 —— 那不是标尺的动作",
  ).toBeLessThan(1);

  // 🔴 Held down is a walk, not one step. Both inputs, because they are two
  // ways of asking the same question and the answer has to be the same: a reader
  // with a thumb parked on the d-pad, and a reader with the stick pushed over,
  // should both keep reading without letting go.
  //
  // Counted with `transitionrun` on the band rather than by sampling where it
  // went. Sampling was tried first and it is wrong twice over: the band travels
  // over `RULER_STEP_MS` (340ms) while the repeat cadence is 130ms, so a poll
  // reads places the band was only passing through and misses the ones it rests
  // on; and WebKit's rAF runs at about a fifth of Chromium's, so any threshold
  // between the two is a threshold that works on one engine and not the other
  // (measured: 335px on Chromium, 99px on WebKit for the same hold). A step
  // declares a transition and a hop does not, so counting the events the band
  // itself reports is a fact about the band rather than a race with its
  // animation.
  const countSteps = async (hold: () => Promise<void>) => {
    await page.evaluate(() => {
      const band = document.querySelector("[data-ruler-band]");
      if (!band) return;
      (window as unknown as { runs: number }).runs = 0;
      band.addEventListener("transitionrun", () => {
        (window as unknown as { runs: number }).runs += 1;
      });
    });
    await hold();
    await page.waitForTimeout(600);
    return (await page.evaluate("window.runs")) as number;
  };

  // One press is one transition. A hold that answered with a single press is the
  // bug; `REPEAT_DELAY` then `REPEAT_INTERVAL` put a 1.6s hold well past three.
  //
  // 2.6s on CI, where this file's own note above measures WebKit's rAF at about
  // a fifth of Chromium's: the repeat cadence is counted in frames, so the same
  // hold buys a fifth of the ticks it does on a laptop. The assertion is
  // unchanged — "held down walks, it does not step once" — the hold just has to
  // be long enough for a slow frame clock to deliver more than one repeat.
  const HOLD = process.env.CI ? 2600 : 1600;
  const dpadSteps = await countSteps(() => holdButton(page, 13, HOLD));
  expect(dpadSteps, "长按方向键下，标尺没有连续往下走（只走了一步）").toBeGreaterThan(2);

  const stickSteps = await countSteps(() => pushStick(page, 1, 1, HOLD));
  expect(stickSteps, "长按摇杆下，标尺没有连续往下走（只走了一步）").toBeGreaterThan(2);
  expect(Math.min(stickSteps, dpadSteps), "摇杆与方向键有一个不连发").toBeGreaterThan(2);
  // The two are the same gesture asked two ways, so both walk: a pad whose stick
  // repeated and whose d-pad did not would be the bug this catches, and it would
  // pass either assertion above on its own.

  await chooseLayout(page, "单页");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page
    .locator("aside div")
    .filter({ has: page.getByText("阅读标尺", { exact: true }) })
    .last()
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // 双页: the same pad, the other paged layout, so the two are not the same path
  // that happens to work in one of them.
  //
  // 🔴 Read as the page's own **column**, not as the book's progress. A spread
  // turn walks inside the chapter — two pages of it — and the footer prints the
  // whole-book percentage, which does not move for a turn that stays inside one
  // chapter. Measured: 33 → 33 across a real spread turn on WebKit, with the
  // chapter unmoved and the column moved. Same trap as the scroll layout's
  // `scrollTop` earlier: the witness has to be the thing that actually changes.
  await chooseLayout(page, "双页");
  await page.waitForTimeout(1200);
  const columnBefore = await spreadColumn(page);
  await press(page, 5);
  await page.waitForTimeout(900);
  expect(await spreadColumn(page), "双页下 R1 没有翻页（列位置没动）").not.toBe(columnBefore);

  // And the switch: 手柄翻页 off means the pad does nothing here at all — not
  // the shoulders, not the stick. Asserted against a layout where every one of
  // them does something, so this cannot pass by the input having gone quiet for
  // an unrelated reason.
  const padGroup = page
    .locator("aside div")
    .filter({ has: page.getByText("手柄翻页", { exact: true }) })
    .last();
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await padGroup.getByRole("button", { name: "关闭", exact: true }).click();
  // 🔴 The switch being off is the *premise* of everything after it, and it is
  // the premise this test got wrong first: with the chip mis-targeted the press
  // went to another group's 「关闭」, the pad stayed live, and "nothing moved"
  // passed for the wrong reason — the page simply had not turned yet.
  await expect(
    padGroup.getByRole("button", { name: "关闭", exact: true }),
    "手柄翻页没有切到关闭",
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  const beforeOff = await progress(page);
  await press(page, 5);
  await pushStick(page, 0, 1);
  await pushStick(page, 1, 1);
  await page.waitForTimeout(1200);
  expect(await progress(page), "关掉手柄翻页之后手柄还在操作阅读").toBeCloseTo(beforeOff, 0);

  // …and turning it back on brings the same pad back to life, or the switch is
  // one-way and the reader has no way back to the feature they shipped with.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await padGroup.getByRole("button", { name: "开启", exact: true }).click();
  await expect(
    padGroup.getByRole("button", { name: "开启", exact: true }),
    "手柄翻页没有切回开启",
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const beforeBack = await progress(page);
  await press(page, 5);
  await page.waitForTimeout(900);
  expect(await progress(page), "重新开启之后手柄还是不动").toBeGreaterThan(beforeBack);
});

/**
 * 🔴 The scrolled layout on a book **foliate renders** — which is every EPUB,
 * and the only kind most readers have.
 *
 * This case exists because the bug it guards was invisible for two rounds: the
 * scrolled-layout tests all ran on `/?demo=1`, and that sample is a **plain-text**
 * book, whose `[data-reading-content]` really is `overflow-y-auto`. A book
 * foliate renders is `overflow-hidden` — foliate owns the scrollport inside the
 * section — so the same code wrote its scroll to a box that cannot scroll. Every
 * symptom followed from that one fact: the page never followed the band, and the
 * chapter switched when the band reached the bottom of the *window* rather than
 * of the chapter (「页面才滚动到显示页面的底部就切换到下一章」).
 *
 * So: a real EPUB, and the assertion is the contract the scroll layout now has.
 * The band's own steps walk it down the window; past the trigger line the step
 * stops moving the band and moves the **page** instead — the text glides one
 * measured block under a band that holds its place. Either way the chapter must
 * not change while the chapter still has text left: a switch here means the flow
 * stopped early.
 */
test("滚动排版下真书：越过触发线后页面跟上来，且一章读完才换章", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  // The real EPUB, not routed: the point is which renderer owns the scrollport.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await chooseLayout(page, "滚动");
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page
    .locator("aside div")
    .filter({ has: page.getByText("阅读标尺", { exact: true }) })
    .last()
    .getByRole("button", { name: "开启", exact: true })
    .click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1800);
  expect(
    await page.locator("[data-ruler-band]").count(),
    "阅读标尺没有画出来，这条用例测不到滚动",
  ).toBeGreaterThan(0);

  // 🔴 `[data-reading-content]` must NOT be the scroller here — that is the fact
  // the whole case turns on, and asserting it keeps the fixture honest if the
  // sample book is ever swapped for one that scrolls.
  const overflow = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-reading-content]");
    return el ? getComputedStyle(el).overflowY : "";
  });
  expect(
    ["hidden", "clip"].includes(overflow),
    `真书的阅读容器不滚动（overflow-y: ${overflow}），这条用例就测不到 foliate 的滚动通道`,
  ).toBe(true);

  const flow = () =>
    page.evaluate(() => {
      const view = document.querySelector("foliate-view");
      const container = view?.shadowRoot
        ?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelector("#container");
      if (!container) return { top: -1, max: -1 };
      return {
        top: Math.round(container.scrollTop),
        max: Math.round(container.scrollHeight - container.clientHeight),
      };
    });
  const host = await page.evaluate(() => {
    const box = document.querySelector("[data-reading-viewport]")?.getBoundingClientRect();
    return box ? { top: box.top, height: box.height } : null;
  });
  expect(host, "阅读区没有高度，这条用例测不到滚动").not.toBeNull();

  // The two halves of the contract, both read off the walk: past the trigger
  // line the **page** steps (its scroll offset grows, repeatedly — the old bug
  // grew it once, at the bottom of the window), and the band **parks** where the
  // handover left it instead of walking on down the page. Note that a parked
  // band's top sits *above* the trigger line: it stops at the place it was
  // standing when it crossed, so "is the band past the trigger" is the wrong
  // question — "did the page move while the band did not" is the right one.
  const chapter = await chapterIndex(page);
  let scrolled = (await flow()).top;
  let followed = 0;
  let parkedAt = -1;
  let drifts = 0;
  let switchedAt = -1;
  for (let step = 0; step < 40; step += 1) {
    await press(page, 13);
    await page.waitForTimeout(700);
    const now = await flow();
    if (now.top > scrolled) {
      followed += 1;
      const top = await bandTop(page);
      if (parkedAt < 0) parkedAt = top;
      // A step's worth of drift on the page's account is one line of leading at
      // most; the band's own place does not move at all.
      else if (Math.abs(top - parkedAt) > 24) drifts += 1;
    }
    scrolled = now.top;
    // foliate lays consecutive sections end to end in **one** scrollport, so the
    // chapter flips when the flow really crosses the boundary — which is the
    // correct answer, and where this walk ends.
    if ((await chapterIndex(page)) !== chapter) {
      switchedAt = now.top;
      break;
    }
  }
  expect(followed, "标尺走了一路，页面没有被带着走（联动滚动没有发生）").toBeGreaterThanOrEqual(3);
  expect(drifts, "联动之后标尺还在继续往下走（没有驻留）").toBe(0);
  if (switchedAt >= 0) {
    expect(switchedAt, "一章还没走完就切到了下一章 —— 页面提前停了").toBeGreaterThan(host!.height);
  }
});
