import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { useScrollLayout } from "./layout";

/**
 * The reading ruler: a band over a block of real lines, with everything outside
 * it washed toward the paper.
 *
 * The band is a *window cut in the page*, not a strip laid over one, and it is
 * sized to the lines it covers rather than to an arithmetic offset — so the
 * assertions here are geometry, measured off the page rather than pinned:
 * WebKit lays the same Chinese text out differently from Chromium, so a
 * hardcoded band height would only be pinning the engine. What is asserted is
 * the shape of the thing:
 *
 * 1. the band and the four washes tile the reading area exactly — nothing
 *    outside the band is left at full contrast, and the band is rounded;
 * 2. its thickness follows the reader's line count;
 * 3. it lands on whole lines, and lands on whole lines again after a page turn
 *    (the foliate path is the one that has to be asked where its lines are);
 * 4. dragging it moves it, follows the hand, and the place is remembered;
 * 5. the colour and the opacity reach the pixels;
 * 6. vertical type stands the band up;
 * 7. on a spread it covers *one* column, and the other one is washed with the
 *    rest of the page;
 * 8. an arrow key steps it a whole block at a time, and the step is a move
 *    rather than a jump.
 *
 * The line boxes are read straight out of the page — for a foliate book through
 * `foliate-view`'s shadow DOM, which is where the section iframe lives. That is
 * the same reading the ruler itself makes, deliberately: what no unit test can
 * see is whether the ruler got the *sections'* geometry and not some other
 * document's, and this is what checks that it did.
 */

/** One line of type: its extent along the reading axis, and across it. */
/**
 * A line as `LINES` reports it: `start`/`end` along the reading axis,
 * `left`/`right` across the page, and `crossFrom`/`crossTo` the fragment's own
 * extent on the *window* axis — which in vertical is the column's height, and
 * is not on `left`/`right` there.
 */
type Interval = {
  start: number;
  end: number;
  left: number;
  right: number;
  crossFrom: number;
  crossTo: number;
};

/** A line as it is read off the page, with or without its cross-axis extent. */
type Span = { start: number; end: number };

/** A rectangle in window coords. */
type Box = { top: number; bottom: number; left: number; right: number };

/** One painted region of the ruler. */
type Painted = { box: Box; opacity: string; background: string };

/** What the ruler has drawn, read off the live DOM. */
type Drawn = {
  host: Box;
  band: Box;
  vertical: boolean;
  fill: string;
  radius: string;
  borders: string[];
  before: Painted;
  after: Painted;
  leading: Painted;
  trailing: Painted;
};

/** The box of every part of the ruler, with its paint. */
const DRAWN = `(() => {
  const host = document.querySelector("[data-reading-viewport]");
  const band = document.querySelector("[data-ruler-band]");
  const washOf = (name) => document.querySelector('[data-ruler-wash="' + name + '"]');
  const before = washOf("before");
  const after = washOf("after");
  const leading = washOf("leading");
  const trailing = washOf("trailing");
  if (!host || !band || !before || !after || !leading || !trailing) return null;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const paint = (el) => {
    const style = getComputedStyle(el);
    return { box: box(el), opacity: style.opacity, background: style.backgroundColor };
  };
  const bandBox = box(band);
  const style = getComputedStyle(band);
  return {
    host: box(host),
    band: bandBox,
    vertical: bandBox.bottom - bandBox.top > bandBox.right - bandBox.left,
    fill: style.backgroundColor,
    radius: style.borderTopLeftRadius,
    borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
    before: paint(before),
    after: paint(after),
    leading: paint(leading),
    trailing: paint(trailing),
  };
})()`;

/**
 * The lines of type on screen, in window coordinates.
 *
 * A prose page is walked directly. A foliate book is not: its words are in a
 * section iframe inside the view's shadow DOM, so the walk goes through it and
 * converts with the frame's own box — which is what the ruler's measurement
 * does, and the point of doing it here too.
 *
 * Only what is *on screen* counts, which is the same window the ruler measures
 * through: a paged chapter is one long strip of pages behind a moving window, so
 * every page of it is in the document at once, and a line from the page next
 * door sits at a height the reader cannot see while landing squarely inside the
 * band's own range.
 *
 * Each line carries both its extents, because a spread's two columns have
 * disagreeing line grids and a line can only be told which column it belongs to
 * by where it is across the page.
 */
const LINES = `(() => {
  const host = document.querySelector("[data-reading-viewport]");
  const band = document.querySelector("[data-ruler-band]");
  const hostBox = host?.getBoundingClientRect();
  if (!hostBox) return [];
  const bandBox = band?.getBoundingClientRect();
  const vertical = !!bandBox && bandBox.height > bandBox.width;
  const intervals = [];
  const collect = (doc, dx, dy) => {
    const root = doc.querySelector("[data-reading-content]") ?? doc.body;
    if (!root) return;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      // A fragment a test put into the section is not the book's text. The
      // ruler measures the page, and a probe element must not be measured as
      // part of it — otherwise the ghost below is read back as one of the
      // page's own lines and every assertion about the band's width ends up
      // made against the probe instead of against the words.
      if (node.parentElement?.closest("[data-ghost]")) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const top = rect.top + dy;
        const bottom = rect.bottom + dy;
        const left = rect.left + dx;
        const right = rect.right + dx;
        // On the page being read, by the ruler's own rule: *across* the page a
        // fragment counts when more than half of it is inside the area — the
        // page next door sits flush against the edge, and a page laid out again
        // under the band can leave a column of itself straddling it, and neither
        // is this page's text. *Along* the axis, what the window reaches.
        const across = vertical
          ? [top, bottom, hostBox.top, hostBox.bottom]
          : [left, right, hostBox.left, hostBox.right];
        if (
          Math.min(across[1], across[3]) - Math.max(across[0], across[2]) <=
          (across[1] - across[0]) / 2
        ) {
          continue;
        }
        if (
          (vertical ? right - hostBox.left <= 1 || hostBox.right - left <= 1 : bottom - hostBox.top <= 1 || hostBox.bottom - top <= 1)
        ) {
          continue;
        }
        intervals.push({
          start: vertical ? hostBox.right - right : top,
          end: vertical ? hostBox.right - left : bottom,
          left: vertical ? top : left,
          right: vertical ? bottom : right,
          // The fragment's own extent on the window axis. In vertical a column's
          // height is what tells the band's height, and left/right carry the
          // column's width there, so the cross extent has to be on the record.
          crossFrom: vertical ? top : left,
          crossTo: vertical ? bottom : right,
        });
      }
    }
  };
  const view = document.querySelector("foliate-view");
  if (view?.shadowRoot) {
    const frames = view.shadowRoot
      .querySelector("foliate-paginator")
      ?.shadowRoot?.querySelectorAll("iframe");
    for (const frame of frames ?? []) {
      const doc = frame.contentDocument;
      const box = frame.getBoundingClientRect();
      if (!doc || box.width <= 0 || box.height <= 0) continue;
      collect(doc, box.left, box.top);
    }
  } else {
    collect(document, 0, 0);
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last) {
      const overlap = last.end - interval.start;
      const shorter = Math.min(last.end - last.start, interval.end - interval.start);
      if (overlap > shorter / 2) {
        last.end = Math.max(last.end, interval.end);
        last.left = Math.min(last.left, interval.left);
        last.right = Math.max(last.right, interval.right);
        last.crossFrom = Math.min(last.crossFrom, interval.crossFrom);
        last.crossTo = Math.max(last.crossTo, interval.crossTo);
        continue;
      }
    }
    merged.push({ ...interval });
  }
  return merged;
})()`;

/**
 * The lines of one column of a spread, in window coordinates.
 *
 * A prose page's words are in this document, so this walks it directly. The
 * column has to be picked *before* the fragments are merged: on a spread the two
 * columns' lines sit at the same heights, so merging first would read them as one
 * line spanning the gutter — which is the very thing the band must not do.
 *
 * Which column is by the reading area's own middle and not by the band: reading
 * the band's own range back to itself would assert nothing.
 */
const columnLines = (page: Page, side: -1 | 1) =>
  page.evaluate((sign: number) => {
    const host = document.querySelector("[data-reading-viewport]");
    const root = document.querySelector("[data-reading-content]");
    if (!host || !root) return [];
    const hostBox = host.getBoundingClientRect();
    const middle = (hostBox.left + hostBox.right) / 2;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const intervals: Interval[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        // On screen by more than a hair (the page next door sits flush against
        // the window), and on the side the band is reading.
        if (
          rect.right - hostBox.left <= 1 ||
          hostBox.right - rect.left <= 1 ||
          rect.bottom - hostBox.top <= 1 ||
          hostBox.bottom - rect.top <= 1
        ) {
          continue;
        }
        const centre = rect.left + rect.width / 2;
        if ((centre - middle) * sign <= 0) continue;
        intervals.push({
          start: rect.top,
          end: rect.bottom,
          left: rect.left,
          right: rect.right,
          crossFrom: rect.left,
          crossTo: rect.right,
        });
      }
    }
    intervals.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last) {
        const overlap = last.end - interval.start;
        const shorter = Math.min(last.end - last.start, interval.end - interval.start);
        if (overlap > shorter / 2) {
          last.end = Math.max(last.end, interval.end);
          last.left = Math.min(last.left, interval.left);
          last.right = Math.max(last.right, interval.right);
          last.crossFrom = Math.min(last.crossFrom, interval.crossFrom);
          last.crossTo = Math.max(last.crossTo, interval.crossTo);
          continue;
        }
      }
      merged.push({ ...interval });
    }
    return merged;
  }, side);

/** A page's line pitch, taken from the lines themselves: the glyph box. */
function pitchOf(lines: readonly Span[]): number {
  const extents = lines.map((line) => line.end - line.start).toSorted((a, b) => a - b);
  return extents[Math.floor(extents.length / 2)]!;
}

/**
 * The page's line *advance*: the typical distance from one line to the next.
 *
 * Not the same as the pitch above, which is the glyph box. A page sets its lines
 * further apart than its letters are tall, so the step is the larger of the two
 * — and it is the one a step of the band has to be measured against.
 */
function advanceOf(lines: readonly Span[]): number {
  const steps = lines
    .slice(1)
    .map((line, i) => line.start - lines[i]!.start)
    .filter((step) => step > 0)
    .toSorted((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] ?? pitchOf(lines);
}

/** A box's extent along the reading axis. */
const along = (box: Box, vertical: boolean) =>
  vertical ? box.right - box.left : box.bottom - box.top;

/** …and across it, which is the page's width for horizontal type. */
const across = (box: Box, vertical: boolean) =>
  vertical ? box.bottom - box.top : box.right - box.left;

/**
 * The lines the band covers, and how far its own edges stand off theirs.
 *
 * Read by centres, which is the only reading that survives the padding: the band
 * is drawn a fixed distance *outside* the first and last line it covers, and
 * that distance is under half a line of leading, so a covered line's centre is
 * inside the band and its neighbour's is not. A band that fell back to
 * arithmetic has edges at arbitrary offsets instead — which is what a stand-off
 * beyond one line's leading is here to catch, since an arithmetic band is drawn
 * at the settings' leading and the page's own lines are the renderer's.
 *
 * Not "centred on the lines it covers": the band runs *from* the leading edge of
 * its block downwards, and a block on a sparse page — a chapter title centred in
 * three-quarters of a blank page, a section opening — is far taller than the
 * lines the band is asked to cover. Centring on the block's middle put the band
 * in the gap between two lines, on blank paper, hundreds of pixels from the words
 * it was marking. What has to hold is the stand-off at each end.
 */
function coveredLines<T extends Span>(drawn: Drawn, lines: readonly T[], label = "") {
  const vertical = drawn.vertical;
  const low = vertical ? drawn.band.left : drawn.band.top;
  const high = vertical ? drawn.band.right : drawn.band.bottom;
  let covered = lines.filter((line) => {
    const centre = (line.start + line.end) / 2;
    return centre > low && centre < high;
  });
  expect(covered.length, `${label}带没有盖住任何一行`).toBeGreaterThan(0);

  const lead = advanceOf(lines);
  const head = covered[0]!.start - low;
  const tail = high - covered.at(-1)!.end;
  expect(head, `${label}带的上边离第一行太远`).toBeLessThan(lead);
  expect(tail, `${label}带的下边离最后一行太远`).toBeLessThan(lead);
  // …and it hugs them: the band's own thickness is the lines it covers plus a
  // stand-off at each end, so a band drawn well past them — on a figure, on the
  // gap between two paragraphs, on the page's own width — is caught here too.
  const thickness = covered.at(-1)!.end - covered[0]!.start;
  expect(
    high - low - thickness,
    `${label}带比它盖住的那些行厚出一截（它罩住了行与行之间的空白）`,
  ).toBeLessThan(lead * 2);

  return { count: covered.length, first: covered[0]!.start, covered };
}

/**
 * The band hugs the lines it covers, across the page.
 *
 * The extent the ruler draws to is those lines' own outermost edges, a pad
 * outside them; what it must never be is a strip across the whole window, nor
 * one that stops short of them — the first reads as a band fading out into the
 * margin, the second as a wash cutting into the words.
 *
 * Handed the lines the band *covers*, not every line on the page: the band is a
 * window on the block it is drawn on, so a longer line elsewhere on the page is
 * washed like the rest of the page and says nothing about the band's width. (It
 * used to be handed the whole page, and the width came from every fragment the
 * section holds — including boxes for text nobody can see, which on a real book
 * put the band 13–29% of the window wider than the words.)
 */
function hugsText(drawn: Drawn, lines: readonly Interval[], label = "") {
  const vertical = drawn.vertical;
  if (lines.length === 0) return;
  // `left`/`right` are the line's cross-axis extent in window coords in both
  // writing modes; `start`/`end` are the *reading* axis, which for vertical type
  // runs leftward and would compare apples to oranges here. The band's cross
  // extent runs the other way round: across the page for horizontal type, up and
  // down for vertical.
  const low = Math.min(...lines.map((line) => line.left));
  const high = Math.max(...lines.map((line) => line.right));
  const bandLow = vertical ? drawn.band.top : drawn.band.left;
  const bandHigh = vertical ? drawn.band.bottom : drawn.band.right;
  // The pad outside the text is a fraction of the reader's leading, which the
  // page's own advance approximates. Half the advance, not three tenths: the
  // band pads by 0.3 × the advance *it* measures, and with 使用书籍排版 the
  // page's steps are bimodal (行距 and 段距), so the two medians can land on
  // different modes and the two 0.3s disagree by a few pixels. Half an advance
  // still sits far under the failure this exists to catch — a band as wide as
  // the page instead of the words is tens of percent of the window.
  const pad = advanceOf(lines) * 0.5 + 2;
  expect(bandLow, `${label}带没有对齐正文的这一边`).toBeGreaterThanOrEqual(low - pad);
  expect(bandLow, `${label}带没有对齐正文的这一边`).toBeLessThanOrEqual(low + pad);
  expect(bandHigh, `${label}带没有对齐正文的那一边`).toBeGreaterThanOrEqual(high - pad);
  expect(bandHigh, `${label}带没有对齐正文的那一边`).toBeLessThanOrEqual(high + pad);
}

async function openBook(page: Page, query: string, title: RegExp) {
  await page.setViewportSize({ width: 1280, height: 820 });
  // Pinned rather than inherited: the ruler animates its step, and a machine
  // with reduce-motion on would turn the step into a jump and quietly hollow out
  // the test that says it animates.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(900);
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
}

/** The settings drawer's 「阅读标尺」 group. Assumes the drawer is open. */
const rulerGroup = (page: Page) =>
  page
    .locator("aside div")
    .filter({ has: page.getByText("阅读标尺", { exact: true }) })
    .last();

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
}

/**
 * Presses one chip in the settings drawer, opening and closing it around the
 * press.
 *
 * By label rather than by the group it sits in: these labels are unique among the
 * chips, and the groups are what move when the drawer is reordered.
 */
async function choose(page: Page, label: string) {
  await openSettings(page);
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
}

/** Turns the ruler on and leaves the drawer closed. */
async function enableRuler(page: Page) {
  await openSettings(page);
  await rulerGroup(page).getByRole("button", { name: "开启", exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
}

/**
 * What the ruler has drawn, read once it has stopped moving.
 *
 * A read can land while the band is still in flight: a step's own transition, a
 * re-measure after the drawer closes and the one that follows a page turn are
 * all still running when a `waitForTimeout` expires on a loaded runner, and a
 * moving box is exactly how a geometry assertion flakes. So the picture is taken
 * until two of them agree — not a frame count, which is the other way a suite
 * like this gets flaky.
 *
 * A band that is not there *yet* is waited for rather than asserted on the
 * first read. The reopen path is the one that gets here: the ruler re-mounts
 * with the book and its first measure lands after the reader chrome is already
 * up, which on a loaded runner is later than the wait `openBook` leaves behind.
 * CI run 154 lost a test to exactly that — `drawn` was still null when the
 * first read asserted it was not. Waiting does not weaken the assertion: a
 * ruler that never draws still fails, with the same message, after the same
 * bounded wait.
 */
async function rulerDrawn(page: Page): Promise<Drawn> {
  let last: Drawn | null = null;
  for (let i = 0; i < 64; i += 1) {
    const drawn = (await page.evaluate(DRAWN)) as Drawn | null;
    if (!drawn) {
      last = null;
      await page.waitForTimeout(60);
      continue;
    }
    const still =
      last !== null &&
      Math.abs(last.band.top - drawn!.band.top) < 0.5 &&
      Math.abs(last.band.bottom - drawn!.band.bottom) < 0.5 &&
      Math.abs(last.band.left - drawn!.band.left) < 0.5 &&
      Math.abs(last.band.right - drawn!.band.right) < 0.5;
    last = drawn!;
    if (still) return drawn!;
    await page.waitForTimeout(60);
  }
  expect(last, "阅读标尺没有画出来").not.toBeNull();
  return last!;
}

/**
 * The lines under the band, read until two of them agree.
 *
 * Same reasoning as {@link rulerDrawn}, one step later: the band and the text are
 * read in two round trips, and a re-measure that lands between them moves the
 * lines under a band that has not moved. Every geometry assertion in this file
 * compares those two reads, so the comparison is only meaningful once both sides
 * come from the same layout — hence one helper rather than a wait at each site.
 */
async function rulerLines(page: Page): Promise<Interval[]> {
  let last = "";
  for (let i = 0; i < 16; i += 1) {
    const lines = (await page.evaluate(LINES)) as Interval[];
    const key = JSON.stringify(lines);
    if (key === last) return lines;
    last = key;
    await page.waitForTimeout(60);
  }
  return (await page.evaluate(LINES)) as Interval[];
}

/** How much of the reading area the parts add up to, along the reading axis. */
const spanAlong = (drawn: Drawn) =>
  along(drawn.before.box, drawn.vertical) +
  along(drawn.band, drawn.vertical) +
  along(drawn.after.box, drawn.vertical);

/** …and across it, which on a spread is the two columns and the gutter. */
const spanAcross = (drawn: Drawn) =>
  across(drawn.leading.box, drawn.vertical) +
  across(drawn.band, drawn.vertical) +
  across(drawn.trailing.box, drawn.vertical);

/** Whole-book progress, as the footer prints it — monotonic across chapters. */
async function progress(page: Page): Promise<number> {
  const text = await page.locator("[data-reader-progress]").first().innerText();
  return Number(text.replace("%", "").trim());
}

test("the band and its washes tile the reading area, at the parked fraction", async ({ page }) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const drawn = await rulerDrawn(page);
  const height = drawn.host.bottom - drawn.host.top;
  const width = drawn.host.right - drawn.host.left;
  const bandTop = drawn.band.top - drawn.host.top;

  // A window, not a strip: the two washes along the axis plus the band are the
  // whole reading area, so nothing outside the band is left at full contrast.
  expect(bandTop, "带上面的遮罩没有盖住带以上的部分").toBeGreaterThan(0);
  expect(drawn.before.box.bottom, "带上面的遮罩没有盖住带以上的部分").toBeCloseTo(
    drawn.band.top,
    0,
  );
  expect(spanAlong(drawn), "带与上下遮罩加不满阅读区").toBeCloseTo(height, 0);
  // …and the same across the page, where the two washes are the slivers the
  // band's own inset leaves. An absolutely positioned box with one extent and no
  // other shrinks to nothing, so this is what says the four washes are four and
  // not two.
  expect(spanAcross(drawn), "带与左右遮罩加不满阅读区的宽度").toBeCloseTo(width, 0);
  expect(across(drawn.before.box, drawn.vertical), "带上下两块遮罩没有铺满页宽").toBeCloseTo(
    width,
    0,
  );

  // Parked at the fraction the settings hold (33). The band is centred on a
  // measured block rather than placed at that exact pixel, so this is the
  // neighbourhood of a third, not a third.
  const fraction = ((drawn.band.top + drawn.band.bottom) / 2 - drawn.host.top) / height;
  expect(fraction, "带没有停在三分之一处").toBeGreaterThan(0.22);
  expect(fraction, "带没有停在三分之一处").toBeLessThan(0.45);

  // The wash is the page's own colour, so the text fades toward the paper.
  expect(drawn.before.background, "遮罩不是页面底色").toBe(drawn.after.background);
  expect(Number(drawn.before.opacity), "不透明度没有反映到遮罩上").toBeCloseTo(0.5, 2);

  // Rounded, and rounded on the page's own scale rather than a hairline.
  expect(Number.parseFloat(drawn.radius), "带的角没有圆").toBeGreaterThanOrEqual(8);

  // And the band is as wide as the words it covers: a strip that runs on past
  // the text into the margins reads as if it had faded out before and after the
  // lines it marks.
  const lines = await rulerLines(page);
  expect(lines.length, "一个行盒都没量到").toBeGreaterThan(3);
  hugsText(drawn, coveredLines(drawn, lines).covered);
});

test("the band's thickness follows the reader's line count", async ({ page }) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const setLines = async (value: string) => {
    await openSettings(page);
    await rulerGroup(page).getByRole("slider", { name: "突出显示行数微调" }).fill(value);
    await page.waitForTimeout(400);
    await closeSettings(page);
    return rulerDrawn(page);
  };
  const two = await setLines("2");
  const four = await setLines("4");

  const lines = await rulerLines(page);
  expect(lines.length, "一个行盒都没量到").toBeGreaterThan(3);

  // Counted, not measured: two lines asked for is two lines covered. A band that
  // fell back to arithmetic would cover some other number — it would be drawn at
  // the settings' leading while these lines are the renderer's.
  expect(coveredLines(two, lines).count, "设置两行时带覆盖的行数不对").toBe(2);
  expect(coveredLines(four, lines).count, "设置四行时带覆盖的行数不对").toBe(4);
});

test("a page with no words on it gets no band", async ({ page }) => {
  // A plate, a cover, a full-page diagram: there is nothing on the page for the
  // ruler to point at, and a band drawn anyway is a large empty rounded
  // rectangle floating on blank paper. That is not a cosmetic difference — the
  // reader sees a shape where there is no text and reads it as "it selected an
  // empty thing".
  //
  // Distinct from *a line near where the band wants to be* (a paragraph gap, a
  // figure, the lines just off the top of the window), which still gets an
  // arithmetic band: that one marks a real place on a page that has text.
  // 🔴 The wordless page is a **book of its own whose first section is one image
  // and no text node at all**. The sparse-title fixture used to supply one by
  // having foliate render its opener as an empty section — which is what it does
  // on macOS and *not* on the Linux runner, so the slot went red there with
  // 「插图页上竟然量到了行」 and no change of mine could have been the cause. Turning
  // to it across sections was the other half of the problem: the turn is the part
  // that differs between platforms, and this slot is about a page without lines,
  // not about chapter turning. So the shape is the **first screen** instead.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/plate-book.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  await page.waitForTimeout(1200);

  const lines = await rulerLines(page);
  expect(lines.filter((l) => l.start >= 0).length, "插图页上竟然量到了行").toBe(0);
  await expect(
    page.locator("[data-ruler-band]"),
    "无字页上画了带子（一个挂在空白上的空框）",
  ).toHaveCount(0);

  // And the washes go with it: there is no block of text for them to be outside.
  await expect(page.locator('[data-ruler-wash="after"]')).toHaveCount(0);

  // On to the words, and the band comes back with them. One turn, to the section
  // right beside the plate.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  const drawn = await rulerDrawn(page);
  const prose = await rulerLines(page);
  const covered = prose.filter((line) => {
    const centre = (line.start + line.end) / 2;
    return centre > drawn.band.top && centre < drawn.band.bottom;
  });
  // As many lines as the reader asked for — the point of this half is that the
  // band *came back*, not how many lines it covers (the line count has slots of
  // its own, and the prose here is many lines long by design).
  expect(covered.length, "翻到有字的页后带子仍然没落在任何一行上").toBeGreaterThan(0);
  hugsText(drawn, covered);
});

test("the band lands on the words, not the gap above them, on a chapter opener", async ({
  page,
}) => {
  // Every fixture in this suite is dense, evenly leaded prose, where a block of
  // lines is barely taller than the band drawn over it — so a band centred on
  // the block and a band running from its leading edge look the same, and the
  // difference went unnoticed for three rounds of "fixed".
  //
  // A chapter opener is not like that. Its title is centred in three-quarters of
  // a blank page, and the first paragraph sits hundreds of pixels below it, so
  // the block that holds both is far taller than the band. Centred on the
  // block, the band lands in the gap between the two lines: on blank paper,
  // below the title it was marking, and — taking its width from the whole block
  // rather than the lines it washes — as wide as the page. Measured on a real
  // book: a 576px band with nothing at all under it.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);
  // The fixture opens on its plate (a page with no text at all — see the case
  // above). The opener is the next one.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);

  /** The lines the band is on, and the width it drew itself to match them. */
  const on = async (label = "") => {
    const band = await rulerDrawn(page);
    const lines = await rulerLines(page);
    expect(lines.length, `${label}标题页一个字的行盒都没量到`).toBeGreaterThan(0);
    let covered = lines.filter((line) => {
      const centre = (line.start + line.end) / 2;
      return centre > band.band.top && centre < band.band.bottom;
    });
    // On a line at all, which is the half that was broken: the band covered a
    // stretch of page with no text anywhere in it.
    expect(covered.length, `${label}带子底下没有一行字（它落在标题与正文之间的空白上了）`).toBe(1);
    // And as wide as the words it is on — the title, not the paragraphs far
    // below it that share the block.
    hugsText(band, covered, `${label}：`);
  };

  await on();
  // And it stays on it when the pane changes width: the block is re-derived,
  // and a band centred on a block that tall lands in the gap again.
  for (const label of ["折叠侧边栏", "全屏阅读"]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForTimeout(2600);
    await on(`${label}：`);
  }
});

test("no screen in the book leaves the band floating where there is no line", async ({ page }) => {
  // The one assertion that covers the report as a whole rather than one state:
  // walk the book, and at every screen the band is either on a line and as wide
  // as it, or not drawn at all. There is no third answer.
  //
  // A paged book hands this more states than a reader visits on purpose: every
  // section boundary is a screen whose window reaches no line at all, and the
  // section that arrives is mounted *outside* it (measured: the frame sitting
  // 9,000–116,000px above the window). A band sized from a fragment like that
  // is a wide empty rectangle on blank paper — the "it selected an empty thing"
  // report — and a per-state check never sees it, because each state is
  // checked on a page that happens to have words on it.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
  await rulerGroup(page).getByRole("button", { name: "开启", exact: true }).click();
  await page.waitForTimeout(400);
  await closeSettings(page);
  await page.waitForTimeout(1200);

  /** `on a line` | `not drawn` — and which of the two, with the numbers. */
  const verdict = async () =>
    (await page.evaluate(() => {
      const host = document.querySelector("[data-reading-viewport]")!.getBoundingClientRect();
      const bandEl = document.querySelector("[data-ruler-band]");
      const spans: { c: number; l: number; r: number }[] = [];
      for (const frame of document
        .querySelector("foliate-view")
        ?.shadowRoot?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelectorAll("iframe") ?? []) {
        const doc = frame.contentDocument;
        const fb = frame.getBoundingClientRect();
        if (!doc?.body || fb.width <= 0) continue;
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        const range = doc.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            if (r.width <= 0 || r.height <= 0) continue;
            const l = r.left + fb.left - host.left;
            const right = r.right + fb.left - host.left;
            if (Math.min(right, host.width) - Math.max(l, 0) <= (right - l) / 2) continue;
            spans.push({ c: (r.top + r.bottom) / 2 + fb.top - host.top, l, r: right });
          }
        }
      }
      if (!bandEl)
        return { state: "none", nWin: spans.filter((s) => s.c >= 0 && s.c < host.height).length };
      const b = bandEl.getBoundingClientRect();
      const covered = spans.filter(
        (s) => s.c > b.top - host.top + 1 && s.c < b.bottom - host.top - 1,
      );
      if (covered.length === 0) {
        return { state: "adrift", nWin: spans.filter((s) => s.c >= 0 && s.c < host.height).length };
      }
      const lo = Math.min(...covered.map((s) => s.l));
      const hi = Math.max(...covered.map((s) => s.r));
      return {
        state: "on a line",
        nWin: spans.filter((s) => s.c >= 0 && s.c < host.height).length,
        slack: Math.min(Math.abs(b.left - host.left - lo), Math.abs(hi - (b.right - host.left))),
      };
    })) as { state: string; nWin: number; slack?: number };

  const tally = { onALine: 0, none: 0 };
  for (let screen = 0; screen < 12; screen += 1) {
    const v = await verdict();
    expect(v.state, `第 ${screen} 屏：带子浮在没有一行字的地方`).not.toBe("adrift");
    if (v.state === "none") {
      tally.none += 1;
      // Nothing on the page to mark: a wordless screen draws no band at all.
      expect(v.nWin, `第 ${screen} 屏：屏内有 ${v.nWin} 行字，却没画带子`).toBe(0);
    } else {
      tally.onALine += 1;
      expect(v.slack, `第 ${screen} 屏：带子与它罩住的那些行差 ${v.slack}px`).toBeLessThan(16);
    }
    await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
    await page.waitForTimeout(1400);
  }
  // Both answers must actually occur, or this walked one kind of screen twice.
  expect(tally.onALine, "全程没有一屏带子落在字上，扫的不是正文").toBeGreaterThan(0);
  expect(tally.none, "全程没有一屏无字，扫的不是标题页/插图页").toBeGreaterThan(0);
});

test("the band's padding comes off the page's own leading, not the setting's", async ({ page }) => {
  // 使用书籍排版 hands the book back its own paragraph styles, so the page's line
  // height is whatever the book set and the reader's line-height setting says
  // nothing about it. The ruler padded the band by a fraction of the *configured*
  // leading anyway, so on a book set tighter than the setting the padding was a
  // larger fraction of a real line than the intended three tenths — and the band
  // reached past the words it was marking into the line above and the line below.
  //
  // Measured on a real book (《认识世界》, 18px type, 跟随书籍): the page advanced
  // 21.6px a line, the ruler padded by 10px — 46% of a line — and the band came
  // out 66.6px over 46.6px of words, three lines under a two-line setting. That
  // is the whole of 「没有适配」: the ruler was padding against a number that was
  // not on the screen. 🔴 The four guards already in `bandOver`'s path (outOfSight,
  // onPage, the placement key, crossOf) all passed here — they are about *which*
  // lines, and this was about how thick the band around them is.
  //
  // The fixture is the sparse-title book, and both of its shapes are load-bearing
  // here — 🔴 each was found by asking "can this slot tell the two paths apart?"
  // and getting the wrong answer first:
  //
  // - Its stylesheet sets `line-height: 1.2`, nowhere near a reader preset
  //   (1.6 / 1.8 / 2.0 / 2.2 → 28.8 / 32.4 / 36 / 39.6px at 18px), so the page's
  //   21.6px leading cannot be confused with the setting. It was **1.75** at
  //   first — 0.9px from the 1.8 preset — and the slot stayed green with the
  //   guard removed.
  // - Its paragraphs run to three or more lines, so a `rulerLines`-long block
  //   sits *inside* one and the padding is measurable beside it. At two lines the
  //   block was the whole paragraph, its extent already carried the 0.78em gap,
  //   and the padding was a rounding error — green again, for a different reason.
  //
  // The demo prose book was tried here too and cannot be used: it ships no
  // stylesheet, so 跟随书籍 leaves it on the browser's `normal` leading, which on
  // WebKit is an 18px advance against a 25.2px glyph box — the line boxes
  // *overlap*, which no real book sets and which makes "how many lines did the
  // band cover" meaningless.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  // Off the plate, onto the opener, and one page on to the prose: a leading is a
  // leading there, where it is not a chapter title's own (this book sets its h1
  // to 1.38).
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1800);

  /**
   * The band's padding in the page's own units: how far it stands off the first
   * and last line it covers, over the distance from one line to the next. Three
   * tenths of a line is the design; what is caught here is a pad taken from a
   * leading that is not this page's.
   */
  const padding = async (label: string) => {
    const drawn = await rulerDrawn(page);
    const lines = await rulerLines(page);
    expect(lines.length, `${label}：一个字的行盒都没量到`).toBeGreaterThan(3);
    let covered = lines.filter((line) => {
      const centre = (line.start + line.end) / 2;
      return centre > drawn.band.top && centre < drawn.band.bottom;
    });
    expect(covered.length, `${label}：带子底下没有一行字`).toBeGreaterThan(0);
    const lead = advanceOf(lines);
    const first = lines.indexOf(covered[0]!);
    const last = lines.indexOf(covered.at(-1)!);
    const above = lines[first - 1];
    const below = lines[last + 1];
    return {
      lead,
      count: covered.length,
      head: (covered[0]!.start - drawn.band.top) / lead,
      tail: (drawn.band.bottom - covered.at(-1)!.end) / lead,
      /**
       * How far the band's own edges reach **past** the neighbouring lines it
       * does not cover, in leads. This is the assertion that holds whatever the
       * platform's font metrics do to where the block happens to sit: `head` and
       * `tail` are distances to the marked lines, which is the design's number
       * only while the block is inside one paragraph — and under 自定义 the block
       * may legitimately span a paragraph gap (bandOver's own rule), which puts
       * that gap inside the tail. Reach is the promise that does not move.
       */
      reach: {
        head: above ? Math.max(0, drawn.band.top - above.end) / lead : 0,
        tail: below ? Math.max(0, drawn.band.bottom - below.start) / lead : 0,
      },
    };
  };

  /** 书籍排版 group, not 字体 — both carry a 跟随书籍 chip. */
  const typography = async (label: string) => {
    await openSettings(page);
    await page
      .locator("aside div")
      .filter({ has: page.getByText("书籍排版", { exact: true }) })
      .last()
      .getByRole("button", { name: label, exact: true })
      .click();
    await page.waitForTimeout(500);
    await closeSettings(page);
    // The setting re-opens the view, so the band is derived from scratch again.
    await page.waitForTimeout(1800);
  };

  await typography("跟随书籍");
  const follow = await padding("跟随书籍");
  // The page's own leading, and the band's own ends: three tenths of a line each,
  // give or take the rounding. A pad off the 1.8 preset on a page advancing 25px
  // is 0.4 of a line and lands here red.
  expect(follow.head, "跟随书籍：带的上边留白不是一个行距的三成").toBeLessThan(0.38);
  expect(follow.tail, "跟随书籍：带的下边留白不是一个行距的三成").toBeLessThan(0.38);
  // The over-padded band's other half: its extra reach swallows a third line.
  // (Under 自定义 the block can legitimately span a paragraph gap, which is its
  // own rule — so the count is only pinned where the block is intra-paragraph.)
  expect(follow.count, "跟随书籍：带子多罩了一行（padding 是按设置的行距算的）").toBe(2);

  // The same page with the reader owning the leading again: same words, same
  // settings, a different line height on the page. The band has to follow the
  // page, and the page's leading is now the larger of the two.
  await typography("自定义");
  const custom = await padding("自定义");
  expect(custom.lead, "自定义：页面的行距没有跟着设置走").toBeGreaterThan(follow.lead);
  expect(custom.head, "自定义：带的上边留白不是一个行距的三成").toBeLessThan(0.45);
  // 🔴 The tail is **not** held to three tenths here, and the runner is why: the
  // book's own leading puts the block wherever paragraph geometry puts it, so
  // under 自定义 it can legitimately span a paragraph gap — which the band's own
  // rule allows — and then the tail is that gap, not padding. Pinned to three
  // tenths it read as 「带的下边留白不是一个行距的三成」 on the Linux runner and
  // nowhere else. What holds either way, and what the reader can see, is that
  // neither edge reaches into the line it is not marking: at most one padding
  // (0.3 lead) past where that line begins.
  expect(custom.reach.head, "自定义：带子上缘伸进了没罩的那一行").toBeLessThanOrEqual(0.35);
  expect(custom.reach.tail, "自定义：带子下缘伸进了没罩的那一行").toBeLessThanOrEqual(0.35);
});

test("the band's padding never outgrows the air between the lines", async ({ page }) => {
  // Two passes over the settings (each re-derives the whole page) plus a walk of
  // eight steps: ~25s on a laptop, and the 30s default timed the run out on the
  // Linux runner without a single assertion failing.
  test.setTimeout(120_000);
  // Three tenths of a line is a padding, not a distance. It only reads as
  // breathing room where there *is* room, and a page can have none: a book whose
  // leading is tighter than its own type is high has line boxes that overlap, so
  // two consecutive lines share a few pixels of box and there is no whitespace
  // between them at all. 使用书籍排版 hands exactly such a book back its own
  // paragraph styles.
  //
  // Measured on the book that reported it (《认识世界》, 18px type): under
  // 跟随书籍 the page advanced 21.6px a line while each line's box was 25px tall
  // — 3.4px of overlap — and the ruler padded 6px at each end regardless. The
  // band was 46.6px over 46.6px of words and its edges sat 6px *inside* the
  // neighbouring lines, which is the whole of 「上下均超出了一些」. The same page
  // under 自定义 advances 32.4px, leaves 7.4px of air, and the same arithmetic
  // reached 2.6px in — close enough to look right, which is why only the tight
  // book was reported and why this was read as 「跟随书籍坏了」 rather than as an
  // arithmetic that ignores its own inputs.
  //
  // The rule asserted is that the band never reaches further from the lines it
  // marks than the gap to the line it is *not* marking: reach <= air on each
  // side, and where the air is negative the only reach that satisfies it is none.
  // Stated as "clear of the neighbour" instead it would be unsatisfiable — the
  // neighbour's box already overlaps the marked line, so no edge position clears
  // it. What is both satisfiable and visible is not reaching *any further* in.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  // Onto the prose: the fixture's leading is 1.2, and its chapter opener sets
  // its own title's leading besides, so this is the page where a leading is a
  // leading.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1800);

  /** 书籍排版 group, not 字体 — both carry a 跟随书籍 chip. */
  const typography = async (label: string) => {
    await openSettings(page);
    await page
      .locator("aside div")
      .filter({ has: page.getByText("书籍排版", { exact: true }) })
      .last()
      .getByRole("button", { name: label, exact: true })
      .click();
    await page.waitForTimeout(500);
    await closeSettings(page);
    // The setting re-opens the view, so the band is derived from scratch again.
    await page.waitForTimeout(1800);
  };

  /**
   * How far the band's edges stand off the lines it marks, minus the air each
   * side actually has. Both must be <= 0.
   *
   * The band is walked down the page with the arrow keys rather than scrolled or
   * turned: a page turn hands the band to the arriving page's first block, and
   * the band is placed at the top of the area to begin with, so both leave it on
   * the page's first line — where there is no line above to overrun into and only
   * the tail side is ever scored.
   */
  const overreach = async (label: string) => {
    let worstHead = -Infinity;
    let worstTail = -Infinity;
    let headSides = 0;
    let tailSides = 0;
    // Four steps down and four back up — the band's interior positions and no
    // further. The walk is kept off both ends of the page deliberately: the first
    // and last blocks are the ones `clampAnchor` pulls against the reading area,
    // and a clamped edge sits wherever the area's edge is rather than where the
    // padding put it, so a score taken there measures the clamp. The padding is
    // the same at every position, and these are the positions where it is the
    // padding being measured.
    for (const key of [...Array(4).fill("ArrowDown"), ...Array(4).fill("ArrowUp")]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(450);
      // Read the band without insisting it is there: stepping off the end of a
      // page lands on a stretch with no lines in the window, and the band is then
      // deliberately not drawn (a page with no words gets no band). Such a step has
      // nothing to score, which is not a failure.
      const drawn = (await page.evaluate(DRAWN)) as Drawn | null;
      if (!drawn) continue;
      const lines = await rulerLines(page);
      const { vertical, band, host } = drawn;
      const low = vertical ? band.left : band.top;
      const high = vertical ? band.right : band.bottom;
      const marked: number[] = [];
      lines.forEach((line, i) => {
        const centre = (line.start + line.end) / 2;
        if (centre > low && centre < high) marked.push(i);
      });
      if (marked.length === 0) continue;
      const first = marked[0]!;
      const last = marked[marked.length - 1]!;

      // A side is only scored when it has a neighbour to overrun into and the band
      // is not sitting against the reading area on it.
      //
      // No neighbour means the page's own edge — nothing to reach into, and
      // counting it would fold an infinity into the worst case and hide every
      // other screen. Against the area is `clampAnchor`'s doing and not the
      // padding's: a band that would hang off the area is pulled back inside it
      // whole, so that edge is wherever the area's edge is rather than where the
      // padding put it. Scored there, this measures the clamp and reports it as a
      // padding bug — and the walk reaches both ends of a page, so it would do so
      // on every run.
      const pinnedLow = vertical ? band.left <= host.left + 1 : band.top <= host.top + 1;
      const pinnedHigh = vertical ? band.right >= host.right - 1 : band.bottom >= host.bottom - 1;
      if (first > 0 && !pinnedLow) {
        headSides += 1;
        worstHead = Math.max(
          worstHead,
          lines[first]!.start - low - Math.max(0, lines[first]!.start - lines[first - 1]!.end),
        );
      }
      if (last < lines.length - 1 && !pinnedHigh) {
        tailSides += 1;
        worstTail = Math.max(
          worstTail,
          high - lines[last]!.end - Math.max(0, lines[last + 1]!.start - lines[last]!.end),
        );
      }
    }
    expect(headSides, `${label}：没有一屏的上缘旁边有行，扫不到上缘`).toBeGreaterThan(2);
    expect(tailSides, `${label}：没有一屏的下缘旁边有行，扫不到下缘`).toBeGreaterThan(2);
    console.log(
      `${label}: head ${headSides}x worst=${worstHead.toFixed(1)}; ` +
        `tail ${tailSides}x worst=${worstTail.toFixed(1)}`,
    );
    return { worstHead, worstTail };
  };

  // A hair of slack for the arithmetic: the band's edges land on fractional
  // coordinates and the line boxes are measured to a tenth, so a band that is
  // exactly as padded as the air allows can read a hundredth over. The overrun
  // being caught is 5–6px on this book, so nothing here hides it.
  const SLACK = 0.5;
  await typography("跟随书籍");
  const follow = await overreach("跟随书籍");
  expect(follow.worstHead, "跟随书籍：带子上缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);
  expect(follow.worstTail, "跟随书籍：带子下缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);

  // And the roomier page, where the design's three tenths has real air to sit in:
  // the same rule holds, and the band is still padded rather than welded on.
  await typography("自定义");
  const custom = await overreach("自定义");
  expect(custom.worstHead, "自定义：带子上缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);
  expect(custom.worstTail, "自定义：带子下缘伸得比两行之间的空隙还远").toBeLessThanOrEqual(SLACK);
});

test("the band still hugs the text when the sidebar leaves the pane", async ({ page }) => {
  // Collapsing, hiding and showing the sidebar (and going fullscreen) each resize
  // the reading pane, and the pane's own resize is only half the story: the page
  // is pinned through the spring and laid out *again* once the pin lets go, at a
  // moment no element resizes.
  //
  // So the band has to follow the words to the *second* layout, and the trap is
  // that the second layout arrives inside a reading area of the size it already
  // has. A placement keyed on the area alone therefore decides, on the pinned
  // layout, that the band is already where this pane wants it — and the words
  // then re-wrap under a band that kept the measure of the page it was drawn on.
  // Measured here: 117px out on a 1208px pane, on the one state whose width is
  // set in two steps (hiding the sidebar collapses the rail to zero, and the
  // pane re-wraps a frame later). The key carries the measure the words were
  // set in, so the re-wrap is a different page as far as the band is concerned.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  // 滚动: the band follows the words through the pane's second layout, which is
  // a scroll position — chosen, not the store's default (单页 since 2026-10-21).
  await useScrollLayout(page);
  await enableRuler(page);

  for (const label of ["折叠侧边栏", "隐藏侧边栏", "全屏阅读"]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    // Wait for the band to come to rest, *then* read the page: the pane re-wraps
    // and the band re-derives a frame or two after the transition starts, and a
    // line list read in between belongs to a layout neither number came from.
    await page.waitForTimeout(1600);
    const drawn = await rulerDrawn(page);
    await page.waitForTimeout(200);
    const lines = await rulerLines(page);
    expect(lines.length, `${label}：一个字的行盒都没量到`).toBeGreaterThan(3);
    // On whole lines, and as wide as the ones it is on.
    const covered = coveredLines(drawn, lines, `${label}：`);
    hugsText(drawn, covered.covered, `${label}：`);
  }
});

test("the page next door does not widen the band, in either page layout", async ({ page }) => {
  // A paginated section is one long strip of pages inside a single iframe, and
  // the page on screen is a *window* onto it: the strip is a chapter wide, the
  // paginator clips it to a page box narrower than the reading pane, and the
  // pages either side are simply not painted.
  //
  // The pane's own coordinates cannot tell that from text. The page next door
  // starts *inside* the pane's outer margin, so its first line — a short one, a
  // heading or a paragraph's first line — is a fragment a couple of hundred
  // pixels long sitting well inside the pane, and it clears every "is it in the
  // reading area" test there is. The band's width is the union of the lines it
  // washes, so that one phantom line dragged the band's edge out to the pane's
  // own edge and the reader saw a band running a third of a page past the words.
  //
  // It is the *painted page* that has to decide, and only the renderer knows
  // where that is. Measured on a real book, 折叠侧边栏: the band 929px wide on
  // 672px of words, the phantom a `P` 162px wide starting 79px past the page box.
  //
  // Both page layouts are walked, because the two differ in exactly the way that
  // matters — a single page puts the next page one column away, a spread puts a
  // whole second column of the *same* page on the other side of the gutter, and
  // a band that is only too wide on one of them is a band that is only too wide
  // when the reader happens to be reading there.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  // Puts a line where the page next door would put one: inside the reading
  // pane, outside the page the paginator paints, at the height the band is on.
  // It is a real box with real text and every platform reports it visible —
  // nothing about the fragment can refuse it, only the page box can.
  const phantom = (on: boolean) =>
    page.evaluate((show: boolean) => {
      const frame = document
        .querySelector("foliate-view")
        ?.shadowRoot?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelector("iframe");
      const doc = frame?.contentDocument;
      if (!frame || !doc?.body) return false;
      const existing = doc.querySelector("[data-phantom]");
      if (!show) {
        existing?.remove();
        return true;
      }
      if (existing) return true;
      const frameBox = frame.getBoundingClientRect();
      // The page box: the first ancestor of the frame narrower than the strip.
      let painted = null;
      for (let el = frame.parentElement; el; el = el.parentElement) {
        const box = el.getBoundingClientRect();
        if (box.width > 0 && box.width < frameBox.width) {
          painted = box;
          break;
        }
      }
      if (!painted) return false;
      const band = document.querySelector("[data-ruler-band]")?.getBoundingClientRect();
      if (!band) return false;
      const line = doc.createElement("p");
      line.setAttribute("data-phantom", "");
      line.textContent = "下一页的第一行，在页面之外，谁也看不见。".repeat(4);
      // Positioned in the *frame's* coordinates, past the page's right edge and
      // level with the band: inside the reading pane, outside the painted page.
      line.style.cssText = [
        "position:absolute",
        "margin:0",
        "white-space:nowrap",
        `left:${painted.right - frameBox.left + 40}px`,
        `top:${band.top - frameBox.top + 4}px`,
      ].join(";");
      doc.body.append(line);
      return true;
    }, on);

  // Both states are exercised from a fresh sidebar each time: collapsing it is
  // what puts the phantom inside the pane's margin in the first place, and the
  // toggles are only on screen while the sidebar is showing.
  for (const [mode, collapse] of [
    ["单页", "折叠侧边栏"],
    ["双页", "隐藏侧边栏"],
  ] as const) {
    await choose(page, mode);
    await page.getByRole("button", { name: collapse, exact: true }).first().click();
    await page.waitForTimeout(2000);

    expect(await phantom(false), "没有找到 section 的文档，注入没做").toBe(true);
    const before = await rulerDrawn(page);
    expect(await phantom(true), "没有找到 section 的文档，注入没做").toBe(true);
    // The pane's own resize is the ruler's re-measure, and it is the one thing
    // here that is not the subject under test: the same width, the same page,
    // the same lines, measured again with and without the phantom in it.
    await page.setViewportSize({ width: 1282, height: 820 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.waitForTimeout(1200);
    const withPhantom = await rulerDrawn(page);
    expect(await phantom(false), "没有找到 section 的文档，注入没做").toBe(true);
    await page.waitForTimeout(1200);
    const after = await rulerDrawn(page);

    const area = before.host.right - before.host.left;
    // Same width, same page, same lines: the only difference is a fragment on a
    // page the reader cannot see, so neither edge of the band may have moved.
    expect(
      Math.abs(withPhantom.band.left - before.band.left),
      `${mode}：看不见的下一页把带的左缘拖走了`,
    ).toBeLessThan(1.5);
    expect(
      Math.abs(withPhantom.band.right - before.band.right),
      `${mode}：看不见的下一页把带的右缘拖走了`,
    ).toBeLessThan(1.5);
    // …and nowhere near the pane's own edge, which is the shape of the report:
    // the phantom reaches into the pane's margin, so a band that counted it
    // runs to within a hair of the edge.
    expect(
      withPhantom.band.right - before.host.left,
      `${mode}：带子顶到了阅读区的右缘（它量到了看不见的下一页）`,
    ).toBeLessThan(area - 40);
    // …and taking it away puts the band back, which is what says the two
    // readings above are of the same page.
    expect(
      Math.abs(after.band.right - before.band.right),
      `${mode}：带子没有回到原位`,
    ).toBeLessThan(1.5);
    // Back to a showing sidebar for the next layout. Two different controls
    // answer — the rail's own chevron for a collapsed rail, the title bar's
    // toggle for a hidden one — and both are on screen, so the regex matches
    // whichever applies.
    const restore = page.getByRole("button", { name: /展开侧边栏|显示侧边栏/ }).first();
    await restore.click();
    await page.waitForTimeout(1800);
  }
});

/**
 * One state, measured against the words rather than against an earlier picture
 * of the band.
 *
 * This used to read the band twice — with the ghost and without — and hold the
 * two within 1.5px. That is not what it looks like: the 180%-wide box widens the
 * section's strip, and a platform whose font metrics fill the page differently
 * re-anchors the reading position by a few pixels under it (8.53 on the Linux
 * runner, the same number on every attempt — deterministic, so the retries this
 * describe used to carry never helped). A band compared with its own earlier
 * position then reports a translation it is *right* to follow.
 *
 * Compared with the lines it covers, the same reading still catches the thing
 * this is here for: a band that counted the box would be drawn 180% of the
 * column wide, which `hugsText` sees from a mile off. It also stops depending on
 * where in the strip the box happens to land, which is a function of how full
 * the page is — that is, of the runner's font metrics.
 */
test("text nobody can see does not widen the band", async ({ page }) => {
  // A book that carries text the reader never sees — a print-only running head, a
  // clipped helper, a line with no font but a leading — has a *box* for it all
  // the same, and a box is all a ruler can read. Measured on a real book, one of
  // those was the widest thing in the section: the band came out 13–29% of the
  // window wider than the words, in every state that re-lays the pane out (the
  // sidebar collapsing, hiding or coming back; fullscreen).
  //
  // Nothing can filter that fragment out by looking at it: it is inside the
  // reading area, inside the page, and the platform reports it visible. The band
  // is a window on the block it is drawn on, so the width comes from those lines
  // and this box is simply not one of them.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  /** Puts a line into the section that the reader cannot see, over the part of
   *  the page the column's own text stops at — the only place a fragment like
   *  this can hide from a filter. `null` takes it away again. */
  const ghost = (on: boolean) =>
    page.evaluate((show: boolean) => {
      const frame = document
        .querySelector("foliate-view")
        ?.shadowRoot?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelector("iframe");
      const doc = frame?.contentDocument;
      if (!doc?.body) return false;
      const existing = doc.querySelector("[data-ghost]");
      if (!show) {
        existing?.remove();
        return true;
      }
      if (existing) return true;
      // A real box — real height, real width, the full content width of the
      // page — that simply paints nothing: `color: transparent` is how a book
      // carries a print-only running head or a helper line, and every platform
      // reports it visible, because it is. Nothing that looks at the fragment
      // can refuse it; only the band's own width, taken from the lines it is
      // drawn on, can.
      const line = doc.createElement("p");
      line.setAttribute("data-ghost", "");
      line.textContent = "没有人看得见的一行字，但它照样有一个盒子。".repeat(8);
      // Wider than the column on purpose, and out to the right of where the
      // column's own text stops — the shape the report had: a box as wide as the
      // page's content where the words are a narrower measure inside it. The demo
      // prose fills its column, so a ghost the same width as the text would prove
      // nothing.
      line.style.cssText = "color:transparent;margin:0;width:180%;white-space:nowrap";
      doc.body.append(line);
      return true;
    }, on);

  // The pane's own resize is the ruler's re-measure, and it is the one thing
  // here that is not the subject under test. Same width out and back, so the
  // band is read on the layout it was drawn on rather than on the one the
  // nudge lands on.
  const remeasure = async (width: number) => {
    await page.setViewportSize({ width: width + 2, height: 820 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(900);
    return rulerDrawn(page);
  };
  const width = 1264;

  expect(await ghost(true), "没有找到 section 的文档，注入没做").toBe(true);
  const drawn = await remeasure(width);
  const lines = await rulerLines(page);
  expect(lines.length, "一个字的行盒都没量到").toBeGreaterThan(3);

  // The band still lands on whole lines of the page in front of the reader…
  const covered = coveredLines(drawn, lines, "");
  // …and is as wide as those lines and no wider. This is the assertion the
  // old two-state reading was standing in for: `hugsText` holds the band's
  // own edges to the covered lines' extent plus half a leading of pad, so a
  // band drawn out to the 180%-wide box — the shape of the report — fails by
  // most of the window rather than by a pixel.
  hugsText(drawn, covered.covered, "");
  // …and nowhere near the pane's own edge, which is what a fragment this wide
  // does to it — the shape of the report, in one number.
  const area = drawn.host.right - drawn.host.left;
  expect(drawn.band.right - drawn.host.left, "带子顶到了阅读区的右缘").toBeLessThan(area - 40);

  expect(await ghost(false), "没有找到 section 的文档，注入没做").toBe(true);
});

test("the band lands on whole lines, on a real EPUB, and again after a page turn", async ({
  page,
}) => {
  // The foliate path is the one with a question to answer: its lines are in a
  // section iframe, so a ruler that measured its own document would fall back to
  // arithmetic and no test of the prose path would ever notice.
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  const onWholeLines = async (label: string) => {
    const drawn = await rulerDrawn(page);
    const lines = await rulerLines(page);
    expect(lines.length, `${label}：一个字的行盒都没量到`).toBeGreaterThan(3);
    return coveredLines(drawn, lines, `${label}：`);
  };

  const before = await onWholeLines("翻页前");
  // `PageDown`, not an arrow: the ruler owns the arrows while it is on — that is
  // what reading with it means — and these are the page-turner's own keys.
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1400);
  const after = await onWholeLines("翻页后");

  // The page moved under the band and the band was re-derived from the page it is
  // now over: it still covers whole lines of the page in front of the reader.
  expect(after.count, "翻页之后带覆盖的行数变了").toBe(before.count);
  // A turn is a page the reader *arrives on*, so the band meets it at its start
  // — the first block of the new page, not wherever the band was when the old
  // page left (that is the bottom of it, after a page read with the ruler).
  const lines = await rulerLines(page);
  const firstIndex = lines.findIndex((line) => line.start === after.first);
  expect(firstIndex, "翻页之后带没有回到下一页的顶部").toBeGreaterThanOrEqual(0);
  expect(firstIndex, "翻页之后带没有回到下一页的顶部").toBeLessThanOrEqual(3);
});

/**
 * The one case in this suite that has failed while running alone.
 *
 * It was load-sensitive by measurement, not by guess: it failed three times in
 * twelve during PR#2 — always in the window right after a full vitest run and
 * a full e2e run, with one attempt killed outright — and twice more in a
 * 13.1-minute full run at load average 12.46. On an idle machine it passes,
 * and so does a run under synthetic load up to ~2.5 (this sandbox cannot
 * reach the load it failed at).
 *
 * Two of those failures were the band not being drawn yet when it was first
 * read, which `rulerDrawn` now waits out (see its note). The rest were one
 * assertion standing four pixels from the edge: the restore lands *near* the
 * dragged spot rather than on it — 35px short locally, and the shortfall moves
 * a few pixels with the runner's font metrics — so a fixed "+80px below where
 * it started" had margin on a Mac and failed by 1.4px on the Linux runner,
 * the same number on all three attempts. The threshold is now one line's
 * advance, which both platforms clear by ~30px, and the precise "it is where
 * it was dragged" check below it is unchanged.
 *
 * The retries this describe still carries are for the load half only; they
 * cannot help a deterministic failure, and the deterministic half is now
 * measured rather than guessed.
 */
test.describe("a dragged band, remembered", () => {
  test.describe.configure({ retries: 2 });

  test("dragging the band moves it, follows the hand, and the place is remembered", async ({
    page,
  }) => {
    await openBook(page, "/?demo=1", /我们为什么会生病/);
    await enableRuler(page);

    const before = await rulerDrawn(page);
    const box = (await page.locator('[data-ruler-edge="leading"]').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 120, { steps: 12 });

    // While it is still held: the band is where the hand is, and it stays there.
    // The old one re-snapped onto the nearest line on every frame, which is what
    // made it look like it was fighting the pointer.
    const holding = (await page.evaluate(DRAWN)) as Drawn | null;
    expect(holding, "阅读标尺没有画出来").not.toBeNull();
    expect(holding!.band.top, "拖动中带没有跟住指针").toBeGreaterThan(before.band.top + 80);
    await page.mouse.up();
    await page.waitForTimeout(400);

    const dragged = await rulerDrawn(page);
    expect(dragged.band.top, "松开之后带没有停在拖动到的位置").toBeGreaterThan(
      before.band.top + 80,
    );
    expect(spanAlong(dragged), "拖动之后带与上下遮罩不再铺满阅读区").toBeCloseTo(
      spanAlong(before),
      0,
    );

    // Remembered: a fresh visit reopens on the place it was left, not on the parked
    // fraction it started at.
    await openBook(page, "/?demo=1", /我们为什么会生病/);
    const remembered = await rulerDrawn(page);
    const lead = advanceOf(await rulerLines(page));
    // Measured, not guessed: the band is stored as a fraction and re-derived
    // from the lines on the way back, so it lands near — not on — the dragged
    // spot. Locally that is 35px short of it, and the shortfall moves by a few
    // pixels with the runner's font metrics (78.6 below the start here against
    // 84.8 on a Mac, out of a 120px drag). A fixed 80px therefore had four
    // pixels of margin on one platform and failed by 1.4 on the other. One
    // line's advance below where it started says the same thing — "it did not
    // snap back to the default" — with room for both.
    expect(remembered.band.top, "重新打开之后带回到了默认位置").toBeGreaterThan(
      before.band.top + lead,
    );
    expect(
      Math.abs(remembered.band.top - dragged.band.top),
      "重新打开之后带没有停在拖动到的位置",
    ).toBeLessThan(lead * 2);
  });
});

test("the colour reaches the band: 仅描边 draws hairlines, 黄色 fills it", async ({ page }) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await enableRuler(page);

  const clear = await rulerDrawn(page);
  expect(clear.fill, "仅描边是默认，不该给带填色").toBe("rgba(0, 0, 0, 0)");
  expect(
    clear.borders.filter((width) => Number.parseFloat(width) > 0),
    "仅描边应当给带的四条边各画一条：只有两条长边的话，带的两端读起来是断开的",
  ).toHaveLength(4);

  await choose(page, "黄色");
  const yellow = await rulerDrawn(page);
  expect(yellow.fill, "选了黄色，带却没有填色").not.toBe("rgba(0, 0, 0, 0)");
  expect(yellow.fill).not.toBe(clear.fill);
});

test("vertical type turns the band into a column, as tall as the text it washes", async ({
  page,
}) => {
  // The fixture's **one-paragraph section**, and the reason is that a paragraph
  // in 竖排 is a column — so one paragraph is a short column, and a band's height
  // has to be able to describe one. Every other section of it (and every column of
  // the demo prose book) runs the full height of the page, so *there* a band drawn
  // at the page's height is indistinguishable from a correct one: with only long
  // paragraphs this slot stayed green against the bug, exactly like the two
  // line-height fixtures before it.
  //
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  await choose(page, "竖排");
  // To the one-line section: a whole page of one line. Every page of the other two
  // is full-height columns, so this is the only page where a band's height can be
  // told apart from the page's. (A fixture with the shape on its *first* screen was
  // tried and reads worse: in 竖排 whether a band is 「taller than wide」 is the
  // fixture's column length, not the ruler's doing, so the shape has to be walked
  // to from a page of full columns — that comparison is the slot's real subject.)
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
    await page.waitForTimeout(2400);
  }
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(2000);

  const first = await rulerDrawn(page);
  const width = first.host.right - first.host.left;
  const height = first.host.bottom - first.host.top;
  // A line is a column now, so the band stands up and the washes sit to its left
  // and right — along the page, because that is the axis the type now reads on.
  expect(first.vertical, "竖排下标尺应当变成竖条").toBe(true);
  expect(spanAlong(first), "竖排下带与左右遮罩加不满阅读区").toBeCloseTo(width, 0);

  // `LINES` reports window coordinates, and so does the band. One basis
  // throughout: 🔴 reading one of them host-relative and the other in window
  // coordinates puts them 108px apart when they are 10px apart, which is how this
  // first went red against a band that was already correct.
  const firstLines = await rulerLines(page);
  // At least one column, i.e. the probe reads columns in vertical at all — not
  // "several": this book puts the short column on a page of its own, so how many
  // columns the page *starts* with is the fixture's arrangement, not the contract.
  // What has to hold further down is that the walk reaches a short one.
  expect(firstLines.length, "竖排：一个字的列都没量到").toBeGreaterThan(0);

  /** The columns the band is standing on. */
  const under = (d: Drawn, ls: readonly Interval[]) =>
    ls.filter((line) => {
      const centre = (line.start + line.end) / 2;
      return centre > d.host.right - d.band.right && centre < d.host.right - d.band.left;
    });

  // Step onto a SHORT column — the fixture's whole point. One of its sections is a
  // single line, so somewhere there is a column a fraction of the page's height,
  // and only on that one can a band drawn at the page's height be caught. The walk
  // is what gets there: whether it takes one step or a dozen is the book's
  // arrangement, and the page the band starts on may not even hold a short one.
  let drawn = await rulerDrawn(page);
  let lines = await rulerLines(page);
  let covered = under(drawn, lines);
  const shortest = Math.min(...lines.map((line) => line.crossTo - line.crossFrom));
  for (let step = 0; step < 12; step += 1) {
    const onShort = covered.some((line) => line.crossTo - line.crossFrom < shortest * 3);
    if (onShort) break;
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(600);
    drawn = await rulerDrawn(page);
    lines = await rulerLines(page);
    covered = under(drawn, lines);
  }
  console.log(
    "cols " +
      lines.map((l) => l.start.toFixed(0) + "/h" + (l.crossTo - l.crossFrom).toFixed(0)).join(" ") +
      " | band covers h" +
      covered.map((l) => (l.crossTo - l.crossFrom).toFixed(0)).join(",") +
      " [" +
      covered.map((l) => l.crossFrom.toFixed(0) + "-" + l.crossTo.toFixed(0)).join(" ") +
      "]" +
      " | band t" +
      drawn.band.top.toFixed(0) +
      " b" +
      drawn.band.bottom.toFixed(0) +
      " host t" +
      drawn.host.top.toFixed(0) +
      " b" +
      drawn.host.bottom.toFixed(0),
  );
  expect(covered.length, "竖排：带子底下没有一列字").toBeGreaterThan(0);
  // The band must have reached a short column, or the rest proves nothing.
  expect(
    Math.min(...covered.map((line) => line.crossTo - line.crossFrom)),
    "走位没有落到短列上，这条用例测不到带子的高度",
  ).toBeLessThan(height * 0.5);

  // 🔴 The assertion this test used to make, and why it was wrong: it read the
  // band's height as the **page's** height. A vertical column is a block of text
  // with a real top and a real bottom — its height is whatever the paragraph is —
  // so the columns of one page run to different lengths and a chapter's last is
  // one short line. Measured on a real book (《认识世界》, 18px 竖排) the ruler drew
  // every band the full 636px of the reading area, overhanging the words below by
  // 269–418px. The old assertion could not have caught that: it asserted the band
  // *equalled* the page, so a band running past it passed too.
  //
  // What holds: the band is as tall as the text it washes, give or take a line's
  // padding — and the padding is the *reader's own* configured leading, not the
  // page's, because that is what `pad` is in the render (`round(pitch × 0.3)` with
  // `pitch` the reader's font size times its line-height preset). In vertical the
  // page's own leading is the *step between columns*, the other axis, so it says
  // nothing about how far the band may stand off the top of a column.
  //
  // So the slack is bounded by what a padding of that size can possibly be: at
  // most three tenths of a line, and the line is at least as tall as the smallest
  // column on the page. Read that off the fixture rather than hardcoding a
  // setting — 🔴 hardcoding 18 × 1.8 failed here for a reason worth keeping: the
  // number is the *default* preset, and the assertion then silently measures the
  // defaults rather than what this reader has.
  const textTop = Math.min(...covered.map((line) => line.crossFrom));
  const textBottom = Math.max(...covered.map((line) => line.crossTo));
  // The smallest column is the floor for how tall a line can be here, so three
  // tenths of it is the least padding any reader's setting can produce.
  const shortestColumn = Math.min(...covered.map((line) => line.crossTo - line.crossFrom));
  const slack = Math.max(advanceOf(lines), shortestColumn) * 0.35;
  console.log(
    "band t" +
      drawn.band.top.toFixed(0) +
      " b" +
      drawn.band.bottom.toFixed(0) +
      " | text " +
      textTop.toFixed(0) +
      ".." +
      textBottom.toFixed(0) +
      " | head " +
      (textTop - drawn.band.top).toFixed(1) +
      " tail " +
      (drawn.band.bottom - textBottom).toFixed(1) +
      " | slack " +
      slack.toFixed(1),
  );
  expect(textTop - drawn.band.top, "竖排：带子上缘伸到它框的列之外").toBeLessThan(slack);
  expect(drawn.band.bottom - textBottom, "竖排：带子下缘伸到它框的列之外").toBeLessThan(slack);
  // …and it is padded at all, so a band flush with its text cannot pass the two
  // above for the wrong reason.
  expect(textTop - drawn.band.top, "竖排：带子紧贴文字，没有留白").toBeGreaterThan(0);
  // …and inside the reading area, which the old one could not say.
  expect(drawn.band.bottom - drawn.band.top, "竖排：带子比阅读区还高").toBeLessThanOrEqual(
    height + 0.5,
  );
});

test("in vertical type the band lands on columns, inside the type", async ({ page }) => {
  // 竖排 puts the reading axis across the page, measured leftward from the right
  // edge — and that measurement was being taken from the wrong edge. The ruler
  // handed `toSpans` the reading area's *cross* extent (its height) where the
  // vertical axis wants its *width*, so every column came out shifted by
  // width − height and the whole line list sat off the axis: negative starts, ends
  // past the far side. The two extents are the same number in horizontal, which is
  // why only 竖排 showed it.
  //
  // What the reader saw, measured on a real book after a chapter turn: a two-line
  // band **175px wide over 8 columns**, hanging **93px outside the words** and
  // covering the page's right margin where there is no type at all. On a page it
  // happened to land on something, it looked merely misaligned.
  //
  // The fixture is the sparse-title book rather than the reader's own: 跟随书籍
  // hands the book its paragraph styles back, and this is a bug about the axis the
  // ruler measures, so what matters is that the page's columns are far enough
  // apart for the two extents to differ — which any paginated vertical page is,
  // since the pane is wider than it is tall.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  await choose(page, "竖排");
  // Off the plate and the opener, onto a page of ordinary columns. The fixture
  // opens on a plate — a whole page of no words, where the band is deliberately
  // not drawn — so the walk has to start past it.
  await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
  await page.waitForTimeout(2600);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(2000);
  // …and a screen with no lines in the window has no band, which is the honest
  // answer rather than a failure. `rulerDrawn` insists the band is there, so read
  // it directly and skip such a screen.
  const drawnOrNull = async () => (await page.evaluate(DRAWN)) as Drawn | null;

  for (const label of ["第一屏", "下一章", "上一章"]) {
    if (label === "下一章") {
      await page
        .getByRole("button", { name: "下一章", exact: true })
        .first()
        .click({ force: true });
      await page.waitForTimeout(2200);
    } else if (label === "上一章") {
      await page
        .getByRole("button", { name: "上一章", exact: true })
        .first()
        .click({ force: true });
      await page.waitForTimeout(2200);
    }
    const lines = await rulerLines(page);
    if (lines.length <= 3) {
      console.log(`${label}: no lines in the window, skipped`);
      continue;
    }
    const drawn = await drawnOrNull();
    expect(drawn, `${label}：有字却没有标尺`).not.toBeNull();
    expect(drawn!.vertical, `${label}：竖排下标尺应当是竖条`).toBe(true);

    // `LINES` reports a vertical span as its distance from the host's *right*
    // edge — that is the axis, and it is what makes forward mean the same thing in
    // both writing modes. A window x converts back with `host.right - x`, and the
    // band has to be converted too or the two are in different places entirely.
    const toSpan = (x: number) => drawn!.host.right - x;
    const low = toSpan(drawn!.band.right);
    const high = toSpan(drawn!.band.left);

    // The axis the ruler measures on has to be the axis it places on. That is not
    // observable from here — `LINES` does its own projection, so asserting on it
    // would only assert the probe agrees with itself. What *is* observable, and is
    // the whole of the bug, is where the band ends up: on a line it is washing, or
    // out in the margin where there is no type at all. The wrong edge put it in the
    // second place, so that is what the assertions below say.

    // …and the band is on the lines it is washing, as wide as they are and no
    // wider. A band out in the margin beside the text, or stretched over the page
    // next door, is the shape of this bug: 175px over 8 columns, 93px outside the
    // words, sitting where there is no type at all.
    let covered = lines.filter((line) => {
      const centre = (line.start + line.end) / 2;
      return centre > low && centre < high;
    });
    expect(covered.length, `${label}：带子底下没有一行字`).toBeGreaterThan(0);
    const words = covered.reduce(
      (acc, line) => ({ l: Math.min(acc.l, line.start), r: Math.max(acc.r, line.end) }),
      { l: Infinity, r: -Infinity },
    );
    // The band's own ends, within one line's padding of the words' outer edges —
    // a relation, because the two engines space a vertical column differently.
    const pad = advanceOf(lines);
    expect(low, `${label}：带子左缘伸到它框的列之外`).toBeGreaterThanOrEqual(words.l - pad);
    expect(high, `${label}：带子右缘伸到它框的列之外`).toBeLessThanOrEqual(words.r + pad);
    // …and on this page: those columns are inside the host, which is the axis
    // the band is placed on.
    const hostWidth = drawn!.host.right - drawn!.host.left;
    expect(words.l, `${label}：带子框住的列不在阅读区内`).toBeGreaterThanOrEqual(-0.5);
    expect(words.r, `${label}：带子框住的列不在阅读区内`).toBeLessThanOrEqual(hostWidth + 0.5);
  }
});

test("on a spread the band covers one column, and the other one is washed", async ({ page }) => {
  // A spread is two independent flows side by side, and their line grids do not
  // agree — one column's paragraph may break where the other's does not. A band
  // spanning both would cut lines in one of them whichever column it snapped to,
  // so it covers the column being read and the other one goes with the rest of
  // the washed page.
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await choose(page, "双页");
  await enableRuler(page);

  const drawn = await rulerDrawn(page);
  const width = drawn.host.right - drawn.host.left;
  const middle = (drawn.host.left + drawn.host.right) / 2;

  expect(across(drawn.band, false), "双页下标尺横跨了整页").toBeLessThan(width * 0.6);
  expect(
    drawn.band.right <= middle || drawn.band.left >= middle,
    "双页下标尺横跨了中缝：它应当只盖住正在读的那一栏",
  ).toBe(true);
  // The other column is part of the wash, and the window still tiles the page.
  expect(spanAcross(drawn), "双页下带与两侧遮罩加不满阅读区").toBeCloseTo(width, 0);
  expect(
    Math.max(across(drawn.leading.box, false), across(drawn.trailing.box, false)),
    "双页下另一栏没有被洗淡",
  ).toBeGreaterThan(width * 0.2);

  // And it is still on whole lines — of its own column, which is the column the
  // band is on and only that one — and as wide as that column's own text, not a
  // strip that runs past it into the margin or the gutter.
  const side: -1 | 1 = drawn.band.right <= middle ? -1 : 1;
  const inColumn = await columnLines(page, side);
  expect(inColumn.length, "双页下带所在的一栏一行都没量到").toBeGreaterThan(3);
  const covered = coveredLines(drawn, inColumn);
  expect(covered.count, "双页下带没有盖住整行").toBe(2);
  hugsText(drawn, covered.covered);
});

test("an arrow steps the band a whole block at a time, and the step is a move", async ({
  page,
}) => {
  // 单页, because that is where the arrows are the ruler's: in the scroll layout
  // they are the reader's own scrolling, and the band stays where it is while the
  // text moves under it.
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await choose(page, "单页");
  await enableRuler(page);

  // A step declares a transition on the band; a jump declares none. Counting the
  // events the band itself reports keeps this a fact about the band rather than a
  // race against the frame it happens to be drawn on.
  const installed = await page.evaluate(`(() => {
    const band = document.querySelector("[data-ruler-band]");
    if (!band) return false;
    window.__rulerRuns = 0;
    band.addEventListener("transitionrun", () => { window.__rulerRuns += 1; });
    return true;
  })()`);
  expect(installed, "标尺没有画出来").toBe(true);

  const start = await rulerDrawn(page);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(800);
  const stepped = await rulerDrawn(page);

  const lines = await rulerLines(page);
  const lead = advanceOf(lines);
  const moved = stepped.band.top - start.band.top;
  // One block down: two lines of the reader's setting, and no further.
  expect(moved, "按方向键之后带没有前进").toBeGreaterThan(lead * 1.4);
  expect(moved, "按方向键之后带走过了不止一个块").toBeLessThan(lead * 3.2);
  expect(coveredLines(stepped, lines).count, "步进之后带没有盖住整行").toBe(2);
  expect(
    (await page.evaluate("window.__rulerRuns")) as number,
    "步进没有动画，带是直接跳过去的",
  ).toBeGreaterThan(0);

  // Walk to the foot of the page. The band refuses at the last block, and what
  // the key does then is what a page turn is: the page moves on.
  const wasAt = await progress(page);
  for (let i = 0; i < 26; i += 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1600);

  const end = await rulerDrawn(page);
  const endLead = advanceOf(await rulerLines(page));
  const thickness = end.band.bottom - end.band.top;
  expect(thickness, "走到底之后带变薄了").toBeGreaterThan(endLead * 1.4);
  expect(thickness, "走到底之后带变厚了").toBeLessThan(endLead * 4);
  expect(end.band.top, "走到底之后带跑出了阅读区的上边").toBeGreaterThanOrEqual(end.host.top - 1);
  expect(end.band.bottom, "走到底之后带跑出了阅读区的下边").toBeLessThanOrEqual(
    end.host.bottom + 1,
  );
  // …and it is still *on the page*: a ruler that lives inside the scrolling
  // content is carried off with the page that just left, and only its geometry
  // says so.
  expect(end.band.left, "翻页之后带被带出了阅读区的左边").toBeGreaterThanOrEqual(end.host.left - 1);
  expect(end.band.right, "翻页之后带被带出了阅读区的右边").toBeLessThanOrEqual(end.host.right + 1);
  expect(await progress(page), "带走到页面末尾之后，方向键没有翻页").toBeGreaterThan(wasAt);
});

test("an arrow still reaches the ruler with the caret inside the book", async ({ page }) => {
  // 🔴 The caret moves into the section, and the keys stop working.
  //
  // A book section is an iframe, and an iframe is its own browsing context: its
  // events stop at its edge. foliate focuses a section's own window after every
  // page it lays out — `paginator.focusView`, on `goTo` and on the resize a
  // change of writing mode causes — so this is not a corner case, it is where the
  // reader is after the first page turn. Measured on a real book with the caret
  // on a `<p>` inside the section: a `keydown` listener on `window` saw **none**
  // of three presses and `move` was never called. The band sat on the page and
  // every arrow did nothing.
  //
  // Written in 竖排 because that is where it was reported, and because 竖排 is
  // what puts the caret in the section here: re-laying the page out sideways is
  // the resize that focuses it. The band answers `ArrowDown` by stepping along
  // the reading axis, which runs **leftward** from the right edge in 竖排 — so
  // the step is `band.left` *decreasing*, and asserting the wrong sign is how a
  // test of this can pass against a band that did not move at all.
  // The sparse-title book, not the reader's own prose: this bug is about the
  // keyboard reaching *out of a book section*, so there has to be a section — the
  // prose book is read in the plain-text path, which has no iframe to lose the
  // event in — and 竖排 has to be a layout this book offers.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await choose(page, "竖排");
  await enableRuler(page);
  // Off the plate and off the chapter opener: the fixture's first section is a
  // whole page with no text node on it, and the ruler draws nothing to measure.
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
    await page.waitForTimeout(2400);
  }

  const drawn = await rulerDrawn(page);
  expect(drawn.vertical, "竖排下标尺应当变成竖条").toBe(true);

  // Put the caret in the section the way a reader does: by clicking the page.
  // Then proof that it is really there, asked of the *section's* window rather
  // than the parent window's — without this the slot would pass against a band
  // that never had to relay anything.
  const section = page.frames().find((f) => f !== page.mainFrame());
  const paragraph = section?.locator("p").first();
  expect(await paragraph?.count(), "书页里一个段落都没有，这条用例测不到中继").toBeGreaterThan(0);
  await paragraph!.click();
  await page.waitForTimeout(300);
  expect(section, "书页 iframe 一个都没找到").toBeDefined();

  const seen = await page.evaluate(`(() => {
    const frames = document.querySelector("foliate-view")?.shadowRoot
      ?.querySelector("foliate-paginator")?.shadowRoot?.querySelectorAll("iframe") ?? [];
    window.__sectionKeys = 0;
    for (const frame of frames) {
      const view = frame.contentWindow;
      if (!view) continue;
      view.addEventListener("keydown", () => { window.__sectionKeys += 1; });
    }
    return frames.length;
  })()`);
  expect(seen, "书页 iframe 一个都没找到，这条用例测不到中继").toBeGreaterThan(0);

  const before = (await rulerDrawn(page)).band.left;
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(900);
  const after = await rulerDrawn(page);
  expect(
    (await page.evaluate("window.__sectionKeys")) as number,
    "按键没有落在书页里，这条用例测的不是中继",
  ).toBeGreaterThan(0);
  expect(
    before - after.band.left,
    "竖排下按方向键，带没有沿着阅读方向（向左）走一步",
  ).toBeGreaterThan(20);
});

test("dragging the band sideways in 竖排 follows the hand, not the axis", async ({ page }) => {
  // 🔴 竖排 runs its axis from the reading area's **right** edge, so `start`
  // grows as the pointer goes **left** — the opposite of the screen's own
  // direction. The drag fed it the pointer's delta as it stands, so the band ran
  // away from the hand: measured on a real book, dragging the band 120px to the
  // **left** moved it 120px to the **right** (846 → 966).
  //
  // 横排 is the control and it is here on purpose: there the drag is down the
  // page only, so a sideways drag must leave the band where it was — a test that
  // only checked the sign in 竖排 would pass against a band that moved on both
  // axes at once.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync(new URL("../public/demo/sparse-title.epub", import.meta.url)),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await choose(page, "单页");
  await enableRuler(page);
  // Off the plate: the fixture's first section is a whole page with no text node
  // on it, and the ruler has nothing there to measure.
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "下一章", exact: true }).first().click({ force: true });
    await page.waitForTimeout(2400);
  }

  const before = await rulerDrawn(page);
  const box = (await page.locator('[data-ruler-edge="leading"]').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // Hold it out at the right-hand end of the page, so a step left has room and
  // the band is not already against the edge it is being asked to cross.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 12 });
  const holding = await rulerDrawn(page);
  expect(before.band.left - holding.band.left, "横排下横向拖动不该把带子带走").toBeLessThan(8);
  await page.mouse.up();
  await page.waitForTimeout(400);

  await choose(page, "竖排");
  await rulerDrawn(page);
  const upright = await rulerDrawn(page);
  const grip = (await page.locator('[data-ruler-edge="leading"]').boundingBox())!;
  const gx = grip.x + grip.width / 2;
  const gy = grip.y + grip.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx - 120, gy, { steps: 12 });
  const dragged = await rulerDrawn(page);
  await page.mouse.up();
  expect(
    upright.band.left - dragged.band.left,
    "竖排下向左拖，带子没有跟着手往左走",
  ).toBeGreaterThan(80);
});

test("in the scrolled layout the arrows walk the band, and the page follows past the trigger", async ({
  page,
}) => {
  // The scrolled ruler's model, rewritten: the arrows move the band and never
  // scroll instead of it; once the band reaches the trigger line the *page*
  // steps under it, by exactly the measured distance between two blocks' first
  // lines — so the band holds its place on screen and stays on whole lines.
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await useScrollLayout(page);
  await enableRuler(page);

  const scrollOf = () =>
    page.evaluate(() => document.querySelector("[data-reading-content]")?.scrollTop ?? -1);

  // Above the trigger line a step is the band's alone: the page holds still.
  const start = await rulerDrawn(page);
  const atRest = await scrollOf();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  const walked = await rulerDrawn(page);
  expect(walked.band.top, "方向键没有移动标尺").toBeGreaterThan(start.band.top);
  expect(await scrollOf(), "标尺还没到触发线，页面就滚动了").toBe(atRest);

  // Walk it down. The moment the page starts stepping while the band's top
  // stays put is the crossing: from there the band is parked on screen.
  let parked = walked;
  let prevTop = walked.band.top;
  let scrolled = atRest;
  let crossed = false;
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(400);
    parked = await rulerDrawn(page);
    const now = await scrollOf();
    if (now > scrolled && Math.abs(parked.band.top - prevTop) < 2) {
      crossed = true;
      break;
    }
    prevTop = parked.band.top;
    scrolled = now;
  }
  expect(crossed, "带子越过触发线后页面没有开始联动").toBe(true);
  const hostHeight = start.host.bottom - start.host.top;
  const trigger = start.host.top + hostHeight * (2 / 3);
  expect(parked.band.top, "联动开始时标尺停在触发线以下太深").toBeLessThanOrEqual(trigger);

  // Held: another step moves the page, not the band — and the band is still
  // sitting on whole lines, which is the measured-distance scroll's whole point.
  const heldTop = parked.band.top;
  const heldScroll = await scrollOf();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  const held = await rulerDrawn(page);
  const lines = await rulerLines(page);
  const lead = advanceOf(lines);
  expect(Math.abs(held.band.top - heldTop), "联动后标尺没有停在原地").toBeLessThan(lead / 2);
  expect(await scrollOf(), "联动后页面没有前进一块").toBeGreaterThan(heldScroll);
  expect(coveredLines(held, lines).count, "联动后带没有盖住整行").toBe(2);

  // Stepping back holds the band too: the page steps the other way under it.
  const backScroll = await scrollOf();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(700);
  const backed = await rulerDrawn(page);
  expect(Math.abs(backed.band.top - heldTop), "回退时标尺没有停在原地").toBeLessThan(lead / 2);
  expect(await scrollOf(), "回退时页面没有跟着退").toBeLessThan(backScroll);
});

test("in the scrolled layout Left/Right switch chapters while the ruler is on", async ({
  page,
}) => {
  await openBook(page, "/?demo=1", /我们为什么会生病/);
  await useScrollLayout(page);
  await enableRuler(page);

  const before = await progress(page);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1400);
  const after = await progress(page);
  expect(after, "右方向键没有切到下一章").toBeGreaterThan(before);

  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(1400);
  expect(await progress(page), "左方向键没有切回上一章").toBeLessThan(after);
});

test("on a real EPUB the absorbed steps hold the band on consecutive blocks", async ({ page }) => {
  // 🔴 The absorbed steps are where the line grid's real shape shows. A book's
  // own typography (使用书籍排版) sets a leading tighter than the type is high, so
  // the line boxes overlap, and both a pad-derived "current block" and a
  // first-box-wins anchor read one line off: measured on a real book, every
  // absorbed step landed a line early and the band walked up its own page while
  // the text ran on beneath it — 一段接不上一段. Routed over the 页码样书 card:
  // long chapters, no CSS, the book's own tight leading.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync("public/demo/long-chapter.epub"),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await useScrollLayout(page);
  await enableRuler(page);

  const scrollOf = () =>
    page.evaluate(() => {
      const view = document.querySelector("foliate-view");
      const container = view?.shadowRoot
        ?.querySelector("foliate-paginator")
        ?.shadowRoot?.querySelector("#container");
      return container?.scrollTop ?? -1;
    });

  // Walk to the trigger. The crossing is the step where the page starts moving
  // while the band's top stays put.
  let crossed = false;
  let parked = await rulerDrawn(page);
  let prevTop = parked.band.top;
  let scrolled = await scrollOf();
  for (let i = 0; i < 24 && !crossed; i += 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(600);
    parked = await rulerDrawn(page);
    const now = await scrollOf();
    if (now > scrolled && Math.abs(parked.band.top - prevTop) < 2) crossed = true;
    prevTop = parked.band.top;
    scrolled = now;
  }
  expect(crossed, "带子越过触发线后页面没有开始联动").toBe(true);
  const heldTop = parked.band.top;
  const lead = advanceOf(await rulerLines(page));

  // The box changing is a change the reader is looking at: a parked band holds
  // its place, but each new block is taller or shorter and reaches further
  // across the page, and it arrives on the landing curve. Counted on the band
  // itself (`transitionrun`), not by sampling boxes — sampling races the frame
  // it is drawn on. Installed after the crossing, so only absorbed steps count.
  const listening = await page.evaluate(`(() => {
    const band = document.querySelector("[data-ruler-band]");
    if (!band) return false;
    window.__absorbedRuns = 0;
    band.addEventListener("transitionrun", () => { window.__absorbedRuns += 1; });
    return true;
  })()`);
  expect(listening, "标尺没有画出来").toBe(true);

  // Six absorbed steps: the page advances by whole measured blocks while the
  // band holds its place on screen, still sitting on whole lines. A landing one
  // line early drifts the band up the window a line at a time — exactly what
  // the hold assertion catches.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(700);
    const held = await rulerDrawn(page);
    expect(Math.abs(held.band.top - heldTop), `第${i + 1}次联动后标尺没有停在原地`).toBeLessThan(
      lead / 2,
    );
    expect(await scrollOf(), `第${i + 1}次联动后页面没有前进`).toBeGreaterThan(scrolled);
    scrolled = await scrollOf();
    const fresh = await rulerLines(page);
    expect(coveredLines(held, fresh).count, `第${i + 1}次联动后带没有盖住整行`).toBe(2);
  }
  expect(
    (await page.evaluate("window.__absorbedRuns")) as number,
    "联动落位时标尺框是瞬变的，没有动画",
  ).toBeGreaterThan(0);
});

test("on a chapter opener the first step lands on the paragraph, not past it", async ({ page }) => {
  // A band parked on a title with a couple of hundred pixels of clearance under
  // it — a chapter opener, the shape a real book opens every chapter in. The
  // title's block used to swallow the paragraph's first line (a block is the
  // anchor's line plus the next ones, and a title has nothing near it), and the
  // first press then stepped over that line: measured on a real book in 滚动
  // (《堂吉诃德》荐读), the band went from the title to the paragraph's second and
  // third lines. The fixture puts the title at a third of the first screen, so
  // the stored place parks on it — no scrolling to find the shape.
  await page.route(/page-numbers\.epub/, (route) =>
    route.fulfill({
      body: readFileSync("public/demo/sparse-opener.epub"),
      contentType: "application/epub+zip",
    }),
  );
  await openBook(page, "/?demo=1&epub=1", /页码样书/);
  await enableRuler(page);

  /** The tallest line on the screen: this book's title, nothing else. */
  const titleIndexOf = (lines: readonly Interval[]) =>
    lines.indexOf(
      lines.reduce((best, line) => (line.end - line.start > best.end - best.start ? line : best)),
    );
  const coveredIndices = async (drawn: Drawn) => {
    const lines = await rulerLines(page);
    return coveredLines(drawn, lines).covered.map((line) => lines.indexOf(line));
  };

  const start = await rulerDrawn(page);
  const lines = await rulerLines(page);
  const title = titleIndexOf(lines);
  expect(
    lines[title]!.end - lines[title]!.start,
    "夹具里没有找到标题行（标题不高于正文行）",
  ).toBeGreaterThan(advanceOf(lines));
  expect(await coveredIndices(start), "带子开局没有停在标题行上").toEqual([title]);

  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(800);
  const stepped = await rulerDrawn(page);
  expect(await coveredIndices(stepped), "按一次下键跳过了段落的第一行（标题的块吞掉了它）").toEqual(
    [title + 1, title + 2],
  );
});
