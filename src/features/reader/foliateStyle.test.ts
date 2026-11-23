import { afterEach, describe, expect, it } from "vitest";

import {
  applyNightBackgrounds,
  buildStyleSheet,
  mixHex,
  verticalQuotes,
  type FoliateStyle,
} from "./foliateStyle";
import { LONE_FIGURE_ATTR } from "./loneFigure";

/** A night page, so each case only states the field it is about. */
const style = (over: Partial<FoliateStyle> = {}): FoliateStyle => ({
  fontSize: 18,
  fontFamily: "Songti SC, serif",
  lineHeight: 1.7,
  paraGap: 0.9,
  indent: true,
  bodyBold: false,
  bookTypography: false,
  fg: "#c9ced8",
  bg: "#181c23",
  dark: true,
  invertImages: false,
  fontFaces: "",
  writingMode: "auto",
  quoteReplace: false,
  zhConvert: "off",
  ...over,
});

describe("buildStyleSheet", () => {
  it("hands the paginator the night palette and repaints the book's own text", () => {
    const css = buildStyleSheet(style());
    // The resolver reads these off the section's <html>; without them the page
    // keeps the book's own light paper.
    expect(css).toContain("--theme-bg-color: #181c23");
    expect(css).toContain("--override-color: true");
    // Element level, because a converted book restates colour on its own
    // classes and inline on spans — `html, body` alone never reaches them.
    expect(css).toContain("color: #c9ced8 !important");
  });

  it("leaves a light page on typography alone", () => {
    const css = buildStyleSheet(style({ dark: false }));
    expect(css).not.toContain("--theme-bg-color");
    expect(css).not.toContain("--override-color");
    expect(css).not.toContain("invert(1)");
    expect(css).not.toContain("background-color:");
    expect(css).not.toContain("box-shadow:");
  });

  it("strips print-era box shadows but leaves element backgrounds to the brightness pass", () => {
    // Flattening every background in CSS erased the chapter opener's panel
    // and badge; CSS also cannot tell a light fill from a dark one.
    expect(buildStyleSheet(style())).not.toContain("background-color: #181c23 !important");
    // The same circle ships a silver box-shadow; with its white fill mapped
    // to a dark panel the shadow alone would be a glowing crescent.
    expect(buildStyleSheet(style())).toContain("box-shadow: none !important");
  });

  it("pins the colour scheme to normal in both palettes", () => {
    // A book that declares `:root { color-scheme: light dark }` makes WebKit
    // paint the section canvas opaque on a dark-mode OS; the page goes black on
    // a read that is not in night mode. The scheme has to be reclaimed even on
    // a light page, which is exactly where the symptom shows.
    expect(buildStyleSheet(style())).toContain("color-scheme: normal !important");
    expect(buildStyleSheet(style({ dark: false }))).toContain("color-scheme: normal !important");
  });

  it("drops the baseline descent under a picture that owns its line", () => {
    // The paginator sizes a figure to the whole column (setImageSize). An
    // inline picture sits on a baseline, so its line box also carries the
    // strut's descent below it — taller than the page, and the residue spills
    // into a column with nothing visible in it, which the reader shows as a
    // blank page (measured: 3 columns for a 1-page cover).
    const css = buildStyleSheet(style({ dark: false }));
    expect(css).toContain("vertical-align: bottom !important");
    // Scoped to the marked figures: the same declaration would sink an icon
    // that shares a line with text, and the mark is what tells them apart.
    expect(css).toContain(`[${LONE_FIGURE_ATTR}]`);
  });

  it("lets an SVG keep its own proportions instead of the page's", () => {
    // A Calibre cover is `width="100%" height="100%" preserveAspectRatio="none"`
    // and the paginator caps only the height, so the artwork is stretched into
    // whatever shape the page is (measured: a 950x1388 cover painted 720x427).
    expect(buildStyleSheet(style({ dark: false }))).toContain("svg[viewBox]");
  });

  it("caps replaced elements the paginator would let overflow the column", () => {
    expect(buildStyleSheet(style({ dark: false }))).toContain("max-width: 100% !important");
  });

  it("keeps the paragraph gap off the book's own layout boxes", () => {
    const css = buildStyleSheet(style({ dark: false }));
    // An empty div, or one wrapping a picture, is not a paragraph: the gap
    // lands in front of a full-column figure and pushes it into the next
    // column, leaving the page it came from blank.
    expect(css).toContain("div:not(:empty)");
    expect(css).toContain("> img, > svg");
  });

  /**
   * 使用书籍排版: the book designed its own line height, paragraph gap and
   * first-line indent — the sheet injects none of them, and the reader's
   * three settings stand down entirely. Font size is not part of the deal.
   */
  it("leaves the book's paragraph styles alone when 使用书籍排版 is on", () => {
    const css = buildStyleSheet(style({ bookTypography: true, dark: false }));
    expect(css).not.toContain("line-height:");
    expect(css).not.toContain("margin-top");
    expect(css).not.toContain("text-indent");
    // The reader always owns the body size, typography or not.
    expect(css).toContain("font-size: 18px !important");
  });

  /**
   * 正文加粗: the panel's one accessibility override, and therefore the one
   * typography setting 使用书籍排版 does not stand down. 跟随书籍 is the
   * default, so tying it to that gate would ship a switch that does nothing
   * until the reader turns something else on first.
   */
  it("bolds the body text on its own switch, under either 书籍排版 setting", () => {
    // Off injects nothing at all — the book's own weight is not ours to reset.
    expect(buildStyleSheet(style({ dark: false }))).not.toContain("font-weight");

    expect(buildStyleSheet(style({ bodyBold: true, dark: false }))).toContain(
      "font-weight: bold !important",
    );

    // The point of the setting: it survives 跟随书籍, where line-height does not.
    const followed = buildStyleSheet(style({ bodyBold: true, bookTypography: true, dark: false }));
    expect(followed).toContain("font-weight: bold !important");
    expect(followed).not.toContain("line-height:");
  });

  it("forces the typeface unless the reader picked 原书字体", () => {
    // A real key wins over the book with !important — the KF8 books restate
    // the family on every paragraph class.
    expect(buildStyleSheet(style({ dark: false }))).toContain(
      "font-family: Songti SC, serif !important",
    );
    // 原书字体: no font-family anywhere; the book's faces stand.
    const book = buildStyleSheet(style({ fontFamily: null, dark: false }));
    expect(book).not.toContain("font-family:");
    expect(book).toContain("font-size: 18px !important");
  });

  it("reaches body text Calibre wraps in its own span, not just block elements", () => {
    // A Calibre-converted book puts the actual characters inside
    // <span class="calibre10"> and sets font-family on that span. A forced
    // family on html/body/p/div only beats the inherited value — the span's own
    // declaration still wins — so the selector list has to name span. Measured
    // on 《好猫八不》: without span the computed family on the body span stayed
    // "PingFang SC"; with it the reader's choice applies.
    expect(buildStyleSheet(style({ dark: false }))).toContain("div, span {");
  });

  it("overrides an inline body size without flattening the book's headings", () => {
    // 《世上为什么要有图书馆》 bakes font-size:16px into 1983 paragraph spans.
    // An inherited !important on html/body loses to that direct declaration,
    // so the size buttons did nothing while the em-based gap kept moving.
    // The same book puts 22px on its <h1> spans — those must stay untouched.
    const css = buildStyleSheet(style({ dark: false }));
    expect(css).toContain('> span[style*="font-size" i] {');
    // The stepper still owns the size even under 使用书籍排版.
    expect(buildStyleSheet(style({ dark: false, bookTypography: true }))).toContain(
      '> span[style*="font-size" i] {\n  font-size: 18px !important;',
    );

    // Selector scope, checked against the book's own markup shape: body text
    // matches, a heading span in an <h1> does not.
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<p><span style="font-size:16px">正文</span></p>' +
      '<h1><span style="font-size:22px">标题</span></h1>';
    const hit = doc.querySelectorAll(
      ':is(p, li, blockquote, dd, dt, td, th) > span[style*="font-size" i]',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0]?.textContent).toBe("正文");
  });

  it("pins the body size when the book bakes an em multiplier into its paragraph class", () => {
    // 《你的第一本哲学书》 sets p.calibre6 { font-size: 1.33333em }, so even at
    // the 15px minimum the body rendered at 20px — the inherited !important on
    // html/body loses to the paragraph's own relative declaration. The rule
    // must reach body blocks but leave headings and inline spans alone.
    const css = buildStyleSheet(style({ fontSize: 15, dark: false }));
    expect(css).toContain(
      ":is(p, li, blockquote, dd, dt, td, th) {\n  font-size: 15px !important;",
    );

    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<h1 class="calibre5">第一章</h1>' +
      '<p class="calibre6">正文<span class="footnote">注</span></p>';
    const bodySelector = ":is(p, li, blockquote, dd, dt, td, th)";
    const hit = doc.querySelectorAll(bodySelector);
    expect(hit).toHaveLength(1);
    expect(hit[0]?.tagName).toBe("P");
    expect(doc.querySelector("h1")?.matches(bodySelector)).toBe(false);
    expect(doc.querySelector("span")?.matches(bodySelector)).toBe(false);
  });

  it("carries the imported faces into the section, which is its own document", () => {
    // A book section is a document: the app's own @font-face never reaches it,
    // so the sheet has to bring the declaration along with the family name.
    const css = buildStyleSheet(style({ fontFaces: '@font-face { font-family: "cr-1" }' }));
    expect(css).toContain('@font-face { font-family: "cr-1" }');
  });

  it("inverts a book's pictures only when asked, and only on a night page", () => {
    expect(buildStyleSheet(style())).not.toContain("invert(1)");
    expect(buildStyleSheet(style({ dark: false, invertImages: true }))).not.toContain("invert(1)");
    expect(buildStyleSheet(style({ invertImages: true }))).toContain(
      "filter: invert(1) hue-rotate(180deg)",
    );
  });

  it("turns the text vertical only when asked, and can force it back horizontal", () => {
    // 跟随书籍 (auto) injects nothing: the book's own writing-mode stands.
    expect(buildStyleSheet(style())).not.toContain("writing-mode");
    // On the text elements, not only the root: a converted book restates
    // writing-mode on its own paragraph classes.
    expect(buildStyleSheet(style({ writingMode: "vertical" }))).toContain(
      "writing-mode: vertical-rl !important",
    );
    // 横排: a book that typesets itself vertical can be forced back.
    expect(buildStyleSheet(style({ writingMode: "horizontal" }))).toContain(
      "writing-mode: horizontal-tb !important",
    );
  });

  /**
   * 替换引号: the western curly quotes become the corner brackets vertical
   * CJK is set with (the Unicode vertical presentation forms of 「」『』).
   * Everything else — an apostrophe inside a word, a straight quote — passes
   * through untouched.
   */
  it("maps the four curly quotes to the vertical corner forms and nothing else", () => {
    expect(verticalQuotes("“引”和‘单’")).toBe("﹁引﹂和﹃单﹄");
    // The right single quote is an apostrophe in English text; it becomes the
    // vertical form too — readest does the same, and a vertical CJK page is
    // where this runs.
    expect(verticalQuotes("don’t")).toBe("don﹄t");
    expect(verticalQuotes("straight \" and ' stay")).toBe("straight \" and ' stay");
    expect(verticalQuotes("无引号")).toBe("无引号");
  });
});

/** 《史蒂夫·乔布斯传》: a grey chapter panel holding a white number circle. */
const makeSection = () => {
  // A real section iframe has its own window; createHTMLDocument does not,
  // and getComputedStyle needs one. jsdom also skips stylesheet colours, so
  // the fixture carries the book's declarations inline — WebKit sees them
  // from either source.
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML =
    '<div style="background-color:#DCDCDC"><div style="background-color:white;border-radius:50px">1</div><p>第一章</p></div>' +
    '<div style="background-color:#222831">注释</div>' +
    '<div style="background-image:url(cover.png)">插图</div><p>正文</p>';
  return doc;
};

describe("applyNightBackgrounds", () => {
  afterEach(() => {
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  });

  it("marks light flat fills as two panel tones and leaves dark or image fills alone", () => {
    const doc = makeSection();
    applyNightBackgrounds(doc, "#c9ced8", "#181c23", true);
    expect(doc.querySelector("body > div")?.getAttribute("data-foliate-night-bg")).toBe("panel");
    // A light fill nested in another light fill becomes the slightly brighter
    // chip — the number badge stays visible on the chapter panel.
    expect(doc.querySelector("body > div > div")?.getAttribute("data-foliate-night-bg")).toBe(
      "chip",
    );
    expect(
      doc.querySelector("body > div:nth-of-type(2)")?.hasAttribute("data-foliate-night-bg"),
    ).toBe(false);
    expect(
      doc.querySelector("body > div:nth-of-type(3)")?.hasAttribute("data-foliate-night-bg"),
    ).toBe(false);
    expect(doc.querySelector("p:last-child")?.hasAttribute("data-foliate-night-bg")).toBe(false);
    const sheet = doc.querySelector("style[data-foliate-night-bg-sheet]")?.textContent ?? "";
    expect(sheet).toContain(
      `[data-foliate-night-bg="panel"]{background-color:${mixHex("#181c23", "#c9ced8", 0.12)} !important}`,
    );
    expect(sheet).toContain(
      `[data-foliate-night-bg="chip"]{background-color:${mixHex("#181c23", "#c9ced8", 0.22)} !important}`,
    );
  });

  it("clears every mark on a light page so the book's own paper comes back", () => {
    const doc = makeSection();
    applyNightBackgrounds(doc, "#c9ced8", "#181c23", true);
    expect(doc.querySelectorAll("[data-foliate-night-bg]").length).toBeGreaterThan(0);
    applyNightBackgrounds(doc, "#23272e", "#fbfbfd", false);
    expect(doc.querySelectorAll("[data-foliate-night-bg]")).toHaveLength(0);
    expect(doc.querySelector("style[data-foliate-night-bg-sheet]")?.textContent).toBe("");
  });

  it("mixes #rrggbb colours without rounding past a byte", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#181c23", "#c9ced8", 0.12)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
