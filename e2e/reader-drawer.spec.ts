import { expect, test } from "@playwright/test";

/**
 * The reader's drawer is bounded by the reading viewport, not by the window.
 *
 * Three things have to hold, and none of them is covered by the unit suite
 * because the drawer only exists once a book is open:
 *
 * - it stops at the header above and the footer below, instead of running the
 *   full height of the app and sitting over both bars;
 * - its own content never spills sideways, and nothing widens the document;
 * - opening it does not reflow the book — the page keeps its width, so the
 *   reader does not lose their place.
 *
 * `?demo=1` supplies three sample books so the reader is reachable without the
 * Tauri backend; without it the web build has no data to open.
 */

const PANELS = [
  { key: "settings", label: "阅读设置" },
  { key: "toc", label: "目录与书签" },
  { key: "annotations", label: "标注" },
  { key: "summary", label: "章节摘要" },
  // The card wall is a grid of fixed-ratio cards; a grid is exactly the kind of
  // panel that widens its own box instead of wrapping. The demo has no
  // characters (the graph lives in the desktop store), so this covers the empty
  // state and the panel's own chrome — the two rows that exist without data.
  { key: "characters", label: "角色卡" },
] as const;

interface Metrics {
  innerWidth: number;
  docScrollWidth: number;
  headerBottom: number | null;
  footerTop: number | null;
  drawerTop: number | null;
  drawerBottom: number | null;
  drawerRight: number | null;
  viewportRight: number | null;
  asideScroll: [number, number] | null;
  insideViewport: boolean;
  panelOverflowBy: number | null;
}

// The helpers stay inside `measure` on purpose: `page.evaluate` serialises the
// function and runs it in the browser, where nothing from module scope exists.
function measure(): Metrics {
  const round = (v: number) => Math.round(v);
  const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;
  const viewport = document.querySelector("[data-reading-viewport]");
  const drawer = viewport?.querySelector("aside") ?? null;
  const scroller = drawer?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
  const header = rect(document.querySelector("header"));
  const footer = rect(document.querySelector("footer"));
  const vp = rect(viewport);
  const d = rect(drawer);
  return {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    headerBottom: header ? round(header.bottom) : null,
    footerTop: footer ? round(footer.top) : null,
    drawerTop: d ? round(d.top) : null,
    drawerBottom: d ? round(d.bottom) : null,
    drawerRight: d ? round(d.right) : null,
    viewportRight: vp ? round(vp.right) : null,
    // `scrollIntoView` walks every scrollable ancestor, so a panel that
    // centres its current row that way drags the whole aside sideways inside
    // its own box — the content lurches even though nothing outside moved.
    asideScroll: drawer ? [Math.round(drawer.scrollLeft), Math.round(drawer.scrollTop)] : null,
    insideViewport: drawer !== null && drawer.parentElement === viewport,
    panelOverflowBy: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
  };
}

function paragraphEdges() {
  const p = document.querySelector("[data-reading-content] p");
  const r = p?.getBoundingClientRect();
  return r ? { left: Math.round(r.left), right: Math.round(r.right) } : null;
}

test("the drawer is bounded by the header and the footer, and never reflows the book", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1");

  await page
    .getByRole("button", { name: /我们为什么会生病/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(1000);

  const closedEdges = await page.evaluate(paragraphEdges);

  for (const { key, label } of PANELS) {
    await page.getByRole("button", { name: label }).first().click();

    // The panel rises in on open; measuring mid-flight would read the
    // entrance transform rather than the settled layout.
    await page.waitForTimeout(800);

    const m = await page.evaluate(measure);

    expect(m.insideViewport, `${key}: drawer must be anchored to the reading viewport`).toBe(true);
    // Bounded by the chrome, not by the window: top at the header's foot,
    // bottom at the footer's head. This is the whole point — the drawer used
    // to run the full height of the app and sit over both bars.
    expect(m.drawerTop, `${key}: drawer must start below the header`).toBe(m.headerBottom);
    expect(m.drawerBottom, `${key}: drawer must stop above the footer`).toBe(m.footerTop);
    // Anchored to the reading area, so its right edge is the viewport's — and
    // nothing inside it may widen the document.
    expect(m.drawerRight, `${key}: drawer must be flush with the reading area`).toBe(
      m.viewportRight,
    );
    expect(m.docScrollWidth, `${key}: document must not scroll sideways`).toBe(m.innerWidth);
    expect(m.panelOverflowBy, `${key}: panel content must not overflow sideways`).toBe(0);
    // A panel scrolling its own scroller is fine; a panel scrolling the drawer
    // is not. `scrollIntoView` walks every scrollable ancestor, so a panel that
    // centres its current row that way drags the whole sheet sideways inside
    // its own box and the content lurches on open. Nothing outside moves, which
    // is exactly what makes this one easy to miss.
    expect(m.asideScroll, `${key}: the drawer must not be scrolled inside its own box`).toEqual([
      0, 0,
    ]);
    // Opening a panel must not touch the page's own layout.
    expect(await page.evaluate(paragraphEdges), `${key}: the book must not reflow`).toEqual(
      closedEdges,
    );

    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
});
