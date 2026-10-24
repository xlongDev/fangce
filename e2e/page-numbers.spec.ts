import { expect, test, type Page } from "@playwright/test";

/**
 * The page indicator's whole-book mode.
 *
 * Two paths produce that number and they are built differently on purpose:
 *
 * - a foliate book (EPUB / Kindle) is numbered by foliate itself — the reader's
 *   position in the book's own byte domain — so the total is a property of the
 *   book and the position only ever rises;
 * - the prose pager has no such scale, so what it counts is the chapters the
 *   layout has measured plus the rest of the book weighed at that density
 *   (`bookPagesOf`), which is why only that one is labelled an estimate.
 *
 * Both are probed by reading, not by rendering, because the defect they replace
 * looked entirely plausible on screen: the same EPUB printed 493, 977, 805,
 * 2202 and 939 pages to one reader as it was read, and a page turn inside a
 * chapter left the number standing still. What no unit test can see is whether
 * the right *input* reached the arithmetic, so each test walks the book page by
 * page and reads the indicator every time:
 *
 * 1. the total never changes — a book does not grow or shrink while it is read;
 * 2. the position rises as the reader moves, and reaches the total at the end;
 * 3. only the estimate says 约;
 * 4. a turn in a spread moves the counter by the two pages that turned.
 *
 * The shelf is deliberately not uniform: `demo-1`'s fourth chapter is a single
 * short paragraph against three long ones, and the EPUB fixture's chapters are
 * 40 / 40 / 20 / 1 paragraphs. A book whose chapters are all one length makes
 * every estimator look right — including the one that extrapolated the book
 * from whichever chapter happened to be on screen, which is how the 493/2202
 * numbers came out.
 *
 * Assertions are relational rather than absolute on purpose: WebKit lays the
 * same text out wider than Chromium and paginates it differently, so any pinned
 * page count would only be pinning the engine. `?demo=1` supplies the sample
 * shelf; `&epub=1` adds the fixture EPUB on top of it.
 */

/** The indicator's numbers, or null when it is not on screen at all. */
async function indicator(
  page: Page,
): Promise<{ page: number; total: number; est: boolean } | null> {
  const el = page.locator("[data-page-indicator]");
  if ((await el.count()) === 0) return null;
  const text = (await el.innerText()).trim();
  const match = /^(约\s*)?(\d+)\s*\/\s*(\d+)\s*页$/.exec(text);
  if (!match) throw new Error(`页码读不出来：${JSON.stringify(text)}`);
  return { est: match[1] !== undefined, page: Number(match[2]), total: Number(match[3]) };
}

async function readIndicator(page: Page) {
  const value = await indicator(page);
  expect(value, "页码指示器没有出现").not.toBeNull();
  return value!;
}

/** Opens a sample book and settles on the reader's first page. */
async function openReader(
  page: Page,
  { query = "/?demo=1", title = /我们为什么会生病/ }: { query?: string; title?: RegExp } = {},
) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(800);
}

/** Sets one chip in the settings drawer, then closes it. */
async function choose(page: Page, group: string, label: string) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  // Scoped to the group: 单页 and 双页 are layout chips, and 隐藏 / 当前章 /
  // 全书 are the page-number ones, but a bare label match would also find the
  // 排版模式 group's own rows.
  const row = page
    .locator("aside div")
    .filter({ has: page.getByText(group, { exact: true }) })
    .last();
  await row.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}

/** The reading page, so a flip has settled before the indicator is read. */
async function flip(page: Page, times: number) {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(400);
}

/**
 * The indicator read **twice**, the second one taken.
 *
 * A page turn's own animation runs for up to 450ms, and `flip` waits 560 — which
 * is enough on a laptop and not on a loaded runner, where the reading right after
 * a turn is still the page before it. That is not a cosmetic slip either: the
 * walk to the end of the book then finishes one page short and the whole-book
 * invariant 「读完一本后页码应当停在总页数上」 goes red on CI while passing
 * everywhere else. Reading until the number stops moving is the same rule the
 * ruler's own suite follows for its boxes (「读标尺要先等它静止」).
 */
async function settledReading(page: Page) {
  let previous = await readIndicator(page);
  // Three tries at 200ms: the turn's own animation is up to 450ms, so the second
  // reading is normally the settled one, and the loop is only there for a runner
  // slower than the animation. Bounded tightly on purpose — this runs up to sixty
  // times per walk, and a generous settle turned the walk into a timeout on CI.
  for (let i = 0; i < 3; i += 1) {
    await page.waitForTimeout(200);
    const next = await readIndicator(page);
    if (next.page === previous.page && next.total === previous.total) return next;
    previous = next;
  }
  return previous;
}

/**
 * Turns pages to the end of the book, reading the indicator on every page.
 *
 * A chapter's last page and its successor's first can report the same number —
 * the boundary rounds to the same page — so "the reading stopped changing"
 * takes three turns in a row, not one. Bounded, because an unbounded loop would
 * hang the suite rather than fail it.
 */
async function walkToTheEnd(page: Page) {
  const readings = [await settledReading(page)];
  let still = 0;
  for (let i = 0; i < 60 && still < 3; i += 1) {
    await flip(page, 1);
    const next = await settledReading(page);
    const last = readings[readings.length - 1]!;
    still = next.page === last.page && next.total === last.total ? still + 1 : 0;
    readings.push(next);
  }
  return readings;
}

/** The invariants both paths share, checked against a whole walk. */
function expectSteady(
  readings: { page: number; total: number }[],
  label: string,
): { page: number; total: number } {
  const totals = [...new Set(readings.map((reading) => reading.total))];
  expect(
    totals,
    `${label}的全书页数在阅读中变了：${readings.map((r) => r.total).join(" → ")}`,
  ).toHaveLength(1);

  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  for (const [index, reading] of readings.entries()) {
    if (index === 0) continue;
    expect(
      reading.page,
      `${label}的页码会倒退：${readings.map((r) => r.page).join(" → ")}`,
    ).toBeGreaterThanOrEqual(readings[index - 1]!.page);
  }
  expect(last.page, "读完一本后页码应当停在总页数上").toBe(last.total);
  expect(first.page, "翻过一整本书之后页码应当动过").toBeLessThan(last.page);
  return last;
}

test("a foliate book's whole-book count is the book's own, and never moves", async ({ page }) => {
  // Sixty turns, each read only once it has stopped moving — longer than the
  // 30s default on a loaded runner.
  test.setTimeout(120_000);
  // The reported defect: an EPUB's whole-book number swung by hundreds of pages
  // as it was read, stood still across a page turn, and printed the section's
  // own "1 / 1" wherever the estimate had nothing to work with.
  await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");

  const first = await readIndicator(page);
  // foliate numbers the book's own bytes, which is measured, not estimated:
  // there is nothing to warn about with 约.
  expect(first.est, "foliate 的书内页码不是估算，不该带「约」").toBe(false);
  expect(first.page).toBeLessThanOrEqual(first.total);

  const last = expectSteady(await walkToTheEnd(page), "EPUB");
  expect(last.total, "一本 12 页的样书不该报成几十页").toBeLessThan(100);
});

test("the prose pager's whole-book count does not move as the book is read", async ({ page }) => {
  test.setTimeout(120_000);
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");

  const first = await readIndicator(page);
  expect(first.est, "全书页码必须标出它是估算").toBe(true);
  expect(first.page).toBeLessThanOrEqual(first.total);

  expectSteady(await walkToTheEnd(page), "纯文本样书");
});

test("the chapter scope is not an estimate and the indicator says so", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "当前章");

  const chapter = await readIndicator(page);
  expect(chapter.est, "当前章页码是实测的，不该带「约」").toBe(false);

  // Same position, whole-book scope: an estimate, and a longer book than one
  // chapter of it.
  await choose(page, "页码", "全书");
  const book = await readIndicator(page);
  expect(book.est).toBe(true);
  expect(book.total).toBeGreaterThan(chapter.total);
});

test("hiding the indicator takes it off the page", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "全书");
  expect(await indicator(page)).not.toBeNull();

  await choose(page, "页码", "隐藏");
  expect(await indicator(page), "隐藏之后不该还有页码").toBeNull();
});

/**
 * 页码停在哪一角：左下 / 居中 / 右下。
 *
 * 三处都在页面下方同一条檐里 —— 换的只是横向的落点。量的是**盒子相对阅读视口**
 * 的位置，不是绝对像素：两个引擎的行高与字宽不同，绝对坐标只会钉住引擎。判据
 * 取得松（20px 内算贴边、居中差 4px 内算居中），因为它要挡的是「点了没反应」和
 * 「跑到对面去了」，不是亚像素。
 */
test("the indicator can sit in either bottom corner, or stay centred", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "当前章");

  const pane = (await page.locator("[data-reading-viewport]").boundingBox())!;
  const box = async () => (await page.locator("[data-page-indicator]").boundingBox())!;

  const centred = await box();
  expect(
    Math.abs(centred.x + centred.width / 2 - (pane.x + pane.width / 2)),
    "默认没有居中",
  ).toBeLessThan(4);

  await choose(page, "页码", "左下");
  const left = await box();
  expect(left.x - pane.x, "左下没有贴到左边").toBeLessThan(20);

  await choose(page, "页码", "右下");
  const right = await box();
  expect(pane.x + pane.width - (right.x + right.width), "右下没有贴到右边").toBeLessThan(20);
});

/**
 * 自动隐藏：无操作 3 秒后页码自己收起，动一下鼠标就回来。
 *
 * 量的是 `opacity` —— 隐藏是**淡出**而不是 `display:none`（那样会把这条檐重新排一遍，
 * 也让「藏起来」变成「没有」）。因此 `toBeVisible()` 在这里没有意义：opacity 0 的元素
 * 仍然有盒子。
 *
 * 收起是计时器而不是「指针离开」：读者的指针停在页面上读一段字，页码也该让开。
 */
test("自动隐藏：静置 3 秒页码自己收起，指针一动就回来", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "当前章");

  const indicatorEl = page.locator("[data-page-indicator]");
  const pane = page.locator("[data-reading-viewport]");

  // 刚动过（点完芯片），所以先看得见。
  await expect(indicatorEl).toHaveCSS("opacity", "0.7");
  // 静置 3 秒 → 页码与指针一起让开。
  await expect(indicatorEl, "静置之后页码没有收起").toHaveCSS("opacity", "0", { timeout: 6000 });
  await expect(pane, "静置之后指针没有让开").toHaveCSS("cursor", "none");

  // 动一下 → 都回来。
  await pane.hover();
  await expect(indicatorEl, "指针动过之后页码没回来").toHaveCSS("opacity", "0.7");
  await expect(pane, "指针动过之后鼠标箭头没回来").not.toHaveCSS("cursor", "none");

  // 关掉开关：它就该一直在了，静置也不动。
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("switch", { name: "页码自动隐藏" }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await expect(indicatorEl, "关掉自动隐藏之后页码不该再藏").toHaveCSS("opacity", "0.7", {
    timeout: 6000,
  });
});

/**
 * 静置之后，指针在**书页上**动一下页码也该回来 —— EPUB 那一侧。
 *
 * 这是静置版上线后漏掉的一条：上面那条走 prose，而 foliate 的正文是 iframe，
 * 一份文档自己的事件留在自己里面，窗格上的 `pointermove` 在指针压在书上时
 * **一次都不会响**。所以「移出再移入」能唤醒（iframe 元素的 pointerenter 照旧
 * 冒到窗格），「在书上挪一下」不能 —— 读者报的就是后者。
 *
 * 判据故意把两步分开：先移出再移入（旧代码也能过），再原地挪一小步（只有把
 * pointermove 从 section 文档里转出来才过得去）。
 */
test("静置之后，指针在 EPUB 书页上动一下页码也回来", async ({ page }) => {
  await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
  await choose(page, "排版模式", "单页");
  await choose(page, "页码", "当前章");

  const indicatorEl = page.locator("[data-page-indicator]");
  const pane = page.locator("[data-reading-viewport]");
  const box = (await pane.boundingBox())!;
  // 书页正中 —— 指针在这里是压在 foliate 的 section iframe 上的。
  const onBook = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };

  // 先进到书上（这一下唤醒的是 pointerenter，新旧代码都算）。
  await page.mouse.move(onBook.x, onBook.y);
  await expect(indicatorEl).toHaveCSS("opacity", "0.7");
  // 静置到收起。
  await expect(indicatorEl, "静置之后页码没有收起").toHaveCSS("opacity", "0", { timeout: 6000 });

  // 原地挪一小步：全程没有离开书，窗格什么都不会听到。
  await page.mouse.move(onBook.x + 24, onBook.y + 12);
  await expect(indicatorEl, "指针在书页上动过，页码没回来").toHaveCSS("opacity", "0.7");
});

/**
 * A spread turns two pages, so the counter has to move two.
 *
 * The number is what a reader checks a turn against: if the page visibly moves
 * on by two and "N / M 页" moves on by one, the count and the page disagree, and
 * a reader who counts pages (or quotes one) is off by one from wherever they
 * actually are. Both paths are asserted, because both count pages of their own
 * unit — foliate columns per turn, the prose pager's column pitch — and only
 * one of them got it right before.
 */
test("one turn moves the chapter counter by the two pages a spread shows", async ({ page }) => {
  await openReader(page, { query: "/?demo=1&epub=1", title: /页码样书/ });
  await choose(page, "排版模式", "双页");
  await choose(page, "页码", "当前章");

  const before = await readIndicator(page);
  await flip(page, 1);
  const after = await readIndicator(page);
  expect(after.page - before.page, "EPUB 双页排版一次翻页应当走过两页").toBe(2);
  expect(after.total, "翻页不该改动本章的页数").toBe(before.total);
  expect(after.page).toBeLessThanOrEqual(after.total);
});

test("the prose pager also counts a spread's two pages", async ({ page }) => {
  await openReader(page);
  await choose(page, "排版模式", "双页");
  await choose(page, "页码", "当前章");

  const before = await readIndicator(page);
  await flip(page, 1);
  const after = await readIndicator(page);
  expect(after.page - before.page, "纯文本双页排版一次翻页应当走过两页").toBe(2);
  expect(after.total).toBe(before.total);
  expect(after.page).toBeLessThanOrEqual(after.total);
});
