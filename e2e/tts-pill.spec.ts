import { expect, test, type Page } from "@playwright/test";

import { useScrollLayout } from "./layout";

/**
 * The read-aloud pill, and the one thing it exists for: a session outliving the
 * page it was started on.
 *
 * Read-aloud used to be the reader's own — engine, queue and player all mounted
 * by `ReaderPage` — so walking off to the shelf cancelled the voice in that
 * page's teardown. The engine is hosted by the shell now (`TtsHost`), the pill
 * rides with it, and the reader only *lends* it a transport while it is on
 * screen. What the reader gives up in exchange is its footer: the pill is
 * anchored to the content pane, so the pane's bottom edge is a shared edge and
 * the pill has to be lifted clear of the footer rather than land on it.
 *
 * What is asserted is the teardown, not the voice, because a headless browser
 * has no voice to hear: `speechSynthesis.cancel()` being called across a
 * navigation *is* the bug, whichever engine would have answered. The suite runs
 * in both engines (see `playwright.config.ts`) and the count is the one fact
 * they agree on — Chromium's headless voice really speaks and WebKit's does
 * not, and neither of those is what this is about.
 */

const PILL = "[data-tts-pill]";

/** How the demo book is named on the shelf and in the pill. */
const DEMO_BOOK = /我们为什么会生病/;

/** The engine is built as the app mounts, so the platform call has to be
 *  wrapped before the boot navigation. Counted rather than guarded: `cancel()`
 *  is the engine's own "start over" as well (every `play` makes one), so the
 *  assertion is that the count does not *move*, not that it stays at zero. */
async function countCancels(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = window.SpeechSynthesis?.prototype;
    if (!proto) return;
    const counter = { count: 0 };
    (window as unknown as { readAloudCancels?: typeof counter }).readAloudCancels = counter;
    const original = proto.cancel;
    proto.cancel = function cancel(this: SpeechSynthesis) {
      counter.count += 1;
      return original.call(this);
    };
  });
}

const cancels = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { readAloudCancels?: { count: number } }).readAloudCancels?.count ?? -1,
  );

/** Air between the pill's bottom edge and the reader footer's top edge.
 *
 *  This is the geometry the pill had when it lived *inside* the reading
 *  viewport (20px above the footer), and the reason the shell's copy carries a
 *  lift at all. A `-1` means the footer is not on screen — fullscreen, or
 *  another route — which is a state of its own, not a failure. */
async function gapToFooter(page: Page): Promise<number> {
  const footer = await page.locator("footer").boundingBox();
  const pill = await page.locator(PILL).boundingBox();
  if (!footer || !pill) return -1;
  return Math.round(footer.y - (pill.y + pill.height));
}

/** Air between the pill's bottom edge and the content pane's. */
async function gapToPane(page: Page): Promise<number> {
  const pane = await page.locator("[data-content-pane]").boundingBox();
  const pill = await page.locator(PILL).boundingBox();
  if (!pane || !pill) return -1;
  return Math.round(pane.y + pane.height - (pill.y + pill.height));
}

/**
 * A speech engine whose utterances start and never finish.
 *
 * This file asserts wiring — that the session outlives the page, that the pill
 * can drive the voice with no reader on screen, that the reader adopts the
 * session on its way back — and none of that is about a voice. What it was
 * also, accidentally, about was the session being alive when each assertion
 * ran. It usually is: the demo chapter takes longer to read than the test takes
 * to check. But "usually" is a race, and a race is what a red CI run is — the
 * session ended first, the pill played its 12px exit and left, and every click
 * after that landed on an element that was already on its way out
 * (`element was detached from the DOM`, six times over).
 *
 * So: one voice, and utterances that begin and never end. Everything these tests
 * do — pause, resume, step, stop, navigate away and back — is the app's own
 * state, and all of it keeps working. `cancel()` is left alone, because counting
 * it is the whole point of the first test.
 *
 * Note this is not the same as an engine that *fails*: an engine that fires
 * `error` on every utterance stalls the queue, which also keeps the session
 * alive, and that was measured too. This one is the honest version — the app is
 * left doing exactly what it does on a reader's machine, only slower.
 */
function installVoiceThatNeverFinishes(): void {
  const proto = window.SpeechSynthesis?.prototype;
  if (!proto) return;
  const voice = {
    name: "Test Voice",
    lang: "zh-CN",
    default: true,
    localService: true,
    voiceURI: "test",
  } as SpeechSynthesisVoice;
  proto.getVoices = () => [voice];
  proto.speak = () => {};
  proto.pause = () => {};
  proto.resume = () => {};
}

/** Opens a demo book and waits for the reader's chrome, which is the earliest
 *  thing that says the page is up and the footer is there to be pressed. */
async function openBook(page: Page, query: string, book: RegExp): Promise<void> {
  await page.addInitScript(installVoiceThatNeverFinishes);
  await page.goto(query);
  await page.getByRole("button", { name: book }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(900);
}

/** Starts the voice from the reader's footer. */
async function startSpeaking(page: Page): Promise<void> {
  await page.getByRole("button", { name: "从当前位置朗读" }).first().click();
  await expect(page.locator(PILL)).toBeVisible();
}

/** Leaves the reader the way a reader would — the sidebar, so the route changes
 *  and the document does not. A `goto` would take the whole app with it, which
 *  is the thing this file is not testing. */
async function goToShelf(page: Page): Promise<void> {
  await page.getByRole("link", { name: "书库", exact: true }).click();
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
}

test("a running session outlives the page it was started on", async ({ page }) => {
  await countCancels(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);

  // Nothing is up before the voice is: the pill is not a permanent fixture of
  // the shell, it is what a session leaves behind.
  await expect(page.locator(PILL)).toHaveCount(0);

  await startSpeaking(page);
  await expect(page.locator(PILL)).toContainText(DEMO_BOOK);

  // Over the reader's footer, not on it — and still over it when the reader's
  // type is bigger than ours. The lift used to be a hand-measured 58px, so a
  // platform with taller metrics (a CI runner with no CJK font: the footer grew
  // from 57px to 78px) ate the pill's 20px of air and left it 8px above the
  // reader's own controls, which is what a red run here was reporting. The size
  // of the clearance is a font question and is left alone on purpose; the
  // invariant is that the pill is above the footer, and that growing the type
  // cannot make it worse.
  const gap = await gapToFooter(page);
  expect(gap).toBeGreaterThan(0);
  await page.addStyleTag({ content: "html { font-size: 22px }" });
  await page.waitForTimeout(400);
  expect(await gapToFooter(page)).toBeGreaterThan(gap - 1);
  await page.addStyleTag({ content: "html { font-size: 16px }" });
  await page.waitForTimeout(400);

  const before = await cancels(page);
  await goToShelf(page);

  // The pill followed, and it is still this book: neither the session nor what
  // the reader is listening to was torn down on the way out.
  const pill = page.locator(PILL);
  await expect(pill).toBeVisible();
  await expect(pill).toContainText(DEMO_BOOK);

  // With no reading viewport under it the pill drops back down: the lift is the
  // reader's, so away from the reader the same 20px of air is measured against
  // the pane's own edge instead of against a footer that is not there. Upper
  // bound first here — it is the one the *dropped* end state satisfies, so it is
  // what waits out the transition.
  await expect.poll(() => gapToPane(page)).toBeLessThan(30);
  await expect.poll(() => gapToPane(page)).toBeGreaterThan(12);

  // The old cleanup called `cancel()` here. That call is the regression.
  expect(await cancels(page)).toBe(before);
});

test("with the reader gone the pill still drives the voice", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);
  await startSpeaking(page);
  await goToShelf(page);

  const pill = page.locator(PILL);

  // With no reader on screen there is no queue of the reader's to drive, so
  // the transport falls through to the engine's own four calls. Pause is the
  // one that says so without a voice: the status is the app's own state.
  await pill.getByRole("button", { name: "暂停" }).click();
  await expect(pill.getByRole("button", { name: "继续" })).toBeVisible();
  await expect(pill).toContainText("已暂停");

  await pill.getByRole("button", { name: "继续" }).click();
  await expect(pill.getByRole("button", { name: "暂停" })).toBeVisible();

  // 停止 ends the session, and a pill with no session behind it goes away —
  // which is also what says the pill's lifetime is the session's, not the route's.
  await pill.getByRole("button", { name: "停止朗读" }).click();
  await expect(page.locator(PILL)).toHaveCount(0);
});

test("the pill is the session; every setting is one tap behind it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);
  await startSpeaking(page);

  const pill = page.locator(PILL);

  // The cover and the title both open the card — a title that opens and a cover
  // that does nothing would be the same surface telling two stories.
  await pill.getByRole("button", { name: "展开朗读播放器" }).first().click();
  const rate = page.getByRole("button", { name: /语速/ });
  await expect(rate).toBeVisible();
  await expect(pill).toHaveCount(0);

  await rate.click();
  const chip = page.getByRole("button", { name: "1.25×", exact: true });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");

  // Every drill-down leads back, and closing the card is a detour ending rather
  // than a session ending: the pill comes back on the book it was reading.
  // `exact`, because the reader's own 返回书库 is behind the card.
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(rate).toContainText("1.25×");
  await page.getByRole("button", { name: "收起播放器" }).click();
  await expect(pill).toBeVisible();
  await expect(pill).toContainText(DEMO_BOOK);
});

test("the footer's rate button opens the speeds, not the card's table of contents", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);
  await startSpeaking(page);

  // The button says 1×, so it is a shortcut *into* 语速. Landing on the tiles
  // instead would ask for a second tap to reach the one thing it names — and the
  // tiles are the card's own contents, not somewhere else.
  await page.getByRole("button", { name: "倍速" }).click();
  await expect(page.getByRole("button", { name: "1.5×", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /语速/ })).toHaveCount(0);

  // The longest label the reader can pick has to fit the circle drawn around it.
  // `1.75×` is five characters in a 32px box with no padding, and at 11px it
  // measured *wider than the button*. Relational on purpose — the assertion is
  // "inside its own button", not a pixel budget, which is the one thing a font
  // or engine change is allowed to move. Set here, while the speeds are on
  // screen: the footer button is a toggle, so it cannot re-open the card.
  await page.getByRole("button", { name: "1.75×", exact: true }).click();
  await page.getByRole("button", { name: "收起播放器" }).click();
  const rate = await page.evaluate(() => {
    const button = document.querySelector('[aria-label="倍速"]')!;
    const text = button.querySelector("span")!.getBoundingClientRect();
    return {
      text: Math.round(text.width),
      button: Math.round(button.getBoundingClientRect().width),
    };
  });
  expect(rate.text).toBeLessThan(rate.button);

  // …and the shortcut does not stick: the pill opens the card on its transport
  // view like anything else.
  await page.locator(PILL).getByRole("button", { name: "展开朗读播放器" }).first().click();
  await expect(page.getByRole("button", { name: /语速/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "1.5×", exact: true })).toHaveCount(0);
});

test("the shell's chrome wears the page's own material", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);

  // The paper furthest from the app chrome's: if the pill were tinted by the
  // shell rather than by the page, this is the surface where it shows.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: "护眼", exact: true }).first().click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await startSpeaking(page);

  // The pill is drawn by the shell, outside the reader's token re-root, so it
  // has to be handed the same set. Resolved values rather than a colour: this
  // stays true for whichever surface is picked. The body is the control — if
  // both sides had fallen back to the app's tokens, they would match each
  // other, and the pill would still be the wrong material.
  const inks = await page.evaluate(() => {
    const read = (el: Element | null, name: string) =>
      el ? getComputedStyle(el).getPropertyValue(name).trim() : "(none)";
    const pill = document.querySelector("[data-tts-pill]");
    const reader = document.querySelector("[data-reading-viewport]")?.parentElement ?? null;
    const names = ["--text-1", "--text-2", "--hairline", "--glass-btn", "--surface-2"];
    return {
      pill: names.map((name) => read(pill, name)),
      reader: names.map((name) => read(reader, name)),
      app: names.map((name) => read(document.body, name)),
    };
  });
  expect(inks.pill).toEqual(inks.reader);
  expect(inks.pill).not.toEqual(inks.app);
});

test("the card opens over the page, not over the reader's footer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);
  await startSpeaking(page);
  await page.locator(PILL).getByRole("button", { name: "展开朗读播放器" }).first().click();
  await expect(page.locator("[data-tts-card]")).toBeVisible();

  // The card is bottom-aligned in the same layer as the pill, so it inherits
  // the same lift — which is the only reason it is not sitting on top of the
  // footer's own controls.
  const gap = async () =>
    page.evaluate(() => {
      const footer = document.querySelector("footer")?.getBoundingClientRect();
      const card = document.querySelector("[data-tts-card]")?.getBoundingClientRect();
      if (!footer || !card) return -1;
      return Math.round(footer.top - card.bottom);
    });
  await expect.poll(gap).toBeGreaterThan(12);
  await expect.poll(gap).toBeLessThan(30);
});

test("coming back to the book hands the voice back to the reader", async ({ page }) => {
  await countCancels(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);
  await startSpeaking(page);
  await goToShelf(page);

  const before = await cancels(page);

  // Back in by the book's own cover, which is how it is opened.
  await page.getByRole("button", { name: DEMO_BOOK }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });

  // The reader that mounts builds the queue the voice has been walking all
  // along, so it adopts the session rather than starting over. The guard only
  // stops a session belonging to another book or another chapter, where the
  // index the engine holds would wash somebody else's sentence.
  const pill = page.locator(PILL);
  await expect(pill).toBeVisible();
  await expect(pill).toContainText(DEMO_BOOK);
  expect(await cancels(page)).toBe(before);

  // And the reader is driving again: the pill is back over its footer, which is
  // the reader's signal that the bottom edge is occupied.
  await expect.poll(() => gapToFooter(page)).toBeGreaterThan(12);
});

/** Pins 朗读高亮 to 句子 before the voice starts.
 *
 *  The wash is only this file's probe for *where the voice is*, and at 词语 it
 *  is painted from the engine's own `boundary` event — which the stub voice
 *  above never fires, so there is no mark to find and every reading comes back
 *  `-1`. The default became 词语 in b529333; this test is about the landing,
 *  not the wash's granularity (the word path is unit-tested in speech.test.ts).
 */
async function useSentenceWash(page: Page): Promise<void> {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(600);
  const row = page
    .locator("aside div")
    .filter({ has: page.getByText("朗读高亮", { exact: true }) })
    .last();
  await row.getByRole("button", { name: "句子", exact: true }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}

test("coming back lands on the sentence being read, not on the chapter's top", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openBook(page, "/?demo=1", DEMO_BOOK);
  // 滚动: the landing has to bring a whole paragraph into the reading area, and
  // in a paged layout the paragraph it lands on can sit in the next column —
  // "visible on both axes" is a scroll-layout fact.
  await useScrollLayout(page);
  await useSentenceWash(page);
  await startSpeaking(page);
  await goToShelf(page);

  // Walk the voice well down the chapter while no page is there to follow it.
  // The reader published this queue on its way out, so the pill can drive it
  // with no reader mounted — which is exactly the state the reader has to
  // recover from.
  const pill = page.locator(PILL);
  for (let step = 0; step < 30; step += 1) {
    await pill.getByRole("button", { name: "下一句" }).click();
  }

  await page.getByRole("button", { name: DEMO_BOOK }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });

  /**
   * Where the page is, as the two facts that say it: which paragraph the voice
   * is on, and whether that paragraph is on screen. Measured in the reading
   * viewport on both axes — a scrolled layout reaches a later paragraph by
   * moving the text up, a paged one by moving the columns sideways, and
   * "visible" has to mean the same thing in either. Lengths, never frame
   * counts: the two engines render at completely different rates.
   */
  const reading = async () =>
    page.evaluate(() => {
      const wash = document.querySelector("[data-tts-wash]")?.closest("[data-para-idx]");
      const viewport = document.querySelector("[data-reading-viewport]");
      if (!wash || !viewport) return { index: -1, visible: false };
      const a = wash.getBoundingClientRect();
      const b = viewport.getBoundingClientRect();
      return {
        index: Number((wash as HTMLElement).dataset.paraIdx),
        visible:
          a.top >= b.top - 2 &&
          a.bottom <= b.bottom + 2 &&
          a.left >= b.left - 2 &&
          a.right <= b.right + 2,
      };
    });

  // The precondition that makes the next line mean something: the voice really
  // did walk down the chapter while the page was away. Verified without the
  // landing, too — this one passes either way.
  await expect.poll(async () => (await reading()).index).toBeGreaterThan(0);
  // And the sentence being read is on screen — the whole of「回到正在朗读的位置」.
  // This is the line that only holds while the page lets the voice decide where
  // it opens: measured with the landing taken out, it is the one that fails.
  await expect.poll(async () => (await reading()).visible).toBe(true);
});
