/**
 * The stylesheet injected into every foliate section document.
 *
 * Its own module because it is the one place where the reading settings meet
 * a book's own CSS, and because the rules are worth probing in isolation (a
 * WebKit fixture loads this exact string).
 */

import { LONE_FIGURE_ATTR } from "./loneFigure";
import type { WritingMode } from "./theme";
import type { ZhConvertMode } from "./zhConvert";

/** Typography and palette pushed into the book's own document. */
export type FoliateStyle = {
  fontSize: number;
  /**
   * The typeface forced over the book's own, or `null` for 原书字体 — the
   * book's faces win and no `font-family` is injected at all.
   */
  fontFamily: string | null;
  lineHeight: number;
  /** Paragraph gap in em, mirroring the prose path's per-`p` margin. */
  paraGap: number;
  /** Two-em first-line indent on every paragraph. */
  indent: boolean;
  /**
   * 正文加粗: force the bold weight onto the body text.
   *
   * Not part of the 使用书籍排版 deal below, on purpose — see
   * `ReaderState.bodyBold`. It is an accessibility override, and 跟随书籍 is
   * the default, so standing it down with the rest would leave it doing
   * nothing out of the box.
   */
  bodyBold: boolean;
  /**
   * 使用书籍排版: the book keeps its own paragraph styles — line height,
   * paragraph gap, first-line indent — and the reader's three settings stand
   * down. Font size is not part of the deal: the reader always owns the
   * body size the book's em-based sizes scale from.
   */
  bookTypography: boolean;
  fg: string;
  bg: string;
  dark: boolean;
  /** Invert the book's own images on a night page. Off by default: the
   *  palette already makes the page dark, and an inverted photograph is a
   *  defect rather than a feature. */
  invertImages: boolean;
  /** `@font-face` rules for the fonts the reader imported, from
   *  [`fontFaceCss`]. A section is a document of its own, so the app's own
   *  declarations do not reach inside it — the sheet has to carry them. */
  fontFaces: string;
  /**
   * The writing direction the reader asks for. `auto` injects nothing and
   * lets the book's own `writing-mode` stand — a 古籍 that typesets itself
   * vertical-rl paginates vertically because the paginator reads the
   * direction back off the section, not because we forced it.
   */
  writingMode: WritingMode;
  /**
   * 替换引号: rewrite western curly quotes into the vertical corner
   * brackets at section load. Not a stylesheet concern — no CSS maps one
   * character to another — but it travels with the style bundle because it
   * changes with the same settings and reloads the same sections.
   */
  quoteReplace: boolean;
  /**
   * 简繁转换: rewrite the section text between Simplified and Traditional
   * Chinese at section load, for the same reason quote replacement travels
   * here — it lives in the section text, not the sheet, and a flip reloads
   * the same sections the other typography settings do.
   */
  zhConvert: ZhConvertMode;
};

/**
 * Western curly quotes and the corner brackets vertical CJK is set with:
 * `“ ”` pair with ﹁ ﹂, `‘ ’` with ﹃ ﹄ (the Unicode vertical presentation
 * forms of 「」『』). A vertical column rotates a western quote with the
 * line, so it reads lying on its side; these stand upright.
 */
export const VERTICAL_QUOTES: Record<string, string> = {
  "\u201C": "\uFE41",
  "\u201D": "\uFE42",
  "\u2018": "\uFE43",
  "\u2019": "\uFE44",
};

/** The same mapping as a string rewrite — the testable half. */
export function verticalQuotes(text: string): string {
  return text.replace(/[\u201C\u201D\u2018\u2019]/g, (c) => VERTICAL_QUOTES[c] ?? c);
}

/** Elements whose text is code or sheet content, not prose: rewriting the
 *  quotes inside a `<style>` rule or a `<code>` sample would corrupt it. */
/**
 * The same mapping, applied to a section's text nodes by the shared rewrite
 * pipeline (`sectionText.ts`): 替换引号 is one `TextLayer` next to 简繁转换,
 * and both are replayed from the node's published string rather than from
 * each other's output.
 */

/**
 * Typography always. Colour follows the readest scheme and is dark-only:
 * the paginator lifts each section's wallpaper out of the document at load
 * time by reading the computed body background, and falls back to the html
 * background only when body is fully transparent (paginator.js
 * `getBackground`) — so html/body never get a background from us. Instead we
 * publish `--theme-bg-color` on `html`: the paginator's `#background` layer
 * paints it as the page fill for transparent sections, and its resolver swaps
 * the colour component of every section's own background (keeping wallpaper
 * images) for the theme colour. Text is recoloured with the same rules
 * readest ships in `getColorStyles`, including the element-level repaints.
 *
 * The app must not *leave* a colour scheme in force here, and neither may the
 * book: once a frame's used colour scheme resolves away from `normal`, WebKit
 * paints the iframe's transparent-root canvas OPAQUE (dark under `dark`, white
 * otherwise), which sits on top of and completely hides the `#background`
 * layer — the wallpaper vanishes, page fill falls back to the system colour and
 * a book that declares `:root { color-scheme: light dark }` goes black on a
 * dark-appearance OS even though the reader is not in night mode. So the
 * scheme is forced back to `normal` below rather than merely left alone.
 * `--override-color: true` drives the resolver colour swap without touching the
 * canvas, and the paginator's resolver keeps every image-bearing background
 * (Kindle paper textures) in its original colours, swapping only imageless page
 * fills for the theme colour.
 */
export const buildStyleSheet = ({
  fontSize,
  fontFamily,
  lineHeight,
  paraGap,
  indent,
  bodyBold,
  bookTypography,
  fg,
  bg,
  dark,
  invertImages,
  fontFaces,
  writingMode,
}: FoliateStyle) => {
  /* What the reader forces over the book, and what 使用书籍排版 stands down:
   * with it on, the book's own line height, paragraph gap and first-line
   * indent stand — measured on a KF8 file, the book restates them on every
   * paragraph class, so half-measures read as broken settings. 原书字体
   * (`fontFamily: null`) likewise leaves the book's faces alone. Font SIZE is
   * not part of either deal: it stays on html/body unconditionally, because
   * the book's em-based sizes scale with it, which keeps its headings and
   * title pages at the proportions its designer chose.
   *
   * 正文加粗 is the second exception, for a different reason: it is an
   * accessibility override, not a typographic opinion, so it is not the book's
   * to overrule. It lands in this same rule because the selector set below is
   * exactly "the elements body text lives in" — the one thing a book restates
   * its weight on, and the one `!important` has to reach. */
  /* "the elements body text lives in". Calibre wraps the actual characters in
   * <span class="calibreN"> and sets font-family on that span, so the list has
   * to name span too — an ancestor's !important does not override a descendant's
   * own declaration, only its inherited value. Without span a Calibre book keeps
   * the face the converter baked in and the reader's choice does nothing; the
   * same gap also let 正文加粗 slip past the body text on those books. */
  const textSelectors = "html, body, p, li, blockquote, dd, dt, td, th, div, span";
  const forced = [
    fontFamily ? `font-family: ${fontFamily} !important;` : "",
    bodyBold ? "font-weight: bold !important;" : "",
    bookTypography ? "" : `line-height: ${lineHeight} !important;`,
  ]
    .filter(Boolean)
    .join("\n  ");
  const typography = `${fontFaces}
:root {
  /* The system stack resolves to var(--font-sans) from the app shell,
     which does not exist inside a book iframe — define it here. */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto,
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
html, body {
  /* !important: KF8 books ship their own body typography for print paper;
     the reader always owns the body size. */
  font-size: ${fontSize}px !important;
}${
    forced
      ? `
${textSelectors} {
  ${forced}
}`
      : ""
  }${
    /* The book may declare its own colour scheme and this one does:
       :root { color-scheme: light dark }. On a dark-appearance OS WebKit then
       resolves the section's scheme to dark and paints the transparent-root
       canvas opaque — a black page with white margins on a read that is not in
       night mode. Forcing normal restores the transparent canvas (measured on a
       WebKit fixture carrying this exact declaration). Applied in both palettes:
       the symptom shows up precisely when night mode is off. A book that declares
       the scheme through a meta name="color-scheme" tag instead is handled where a
       section attaches — CSS one can't override that tag. */
    `
html {
  color-scheme: normal !important;
}`
  }${
    bookTypography
      ? ""
      : `
/* A Kindle book restates line-height, font-family, margins and text-indent on
   every paragraph class it ships, so html/body alone never reaches the
   text — measured on a KF8 file: body computed line-height followed the
   setting while every p kept the book's own 1.8. Repeat the settings on the
   text elements themselves.
   div is included because Calibre/KF8 mobi often wrap body paragraphs in
   div.calibre_2 instead of p — without it the three typography
   settings silently do nothing on those books (see probe on b3.mobi). */
p, li, blockquote, dd {
  margin-top: ${paraGap}em !important;
  margin-bottom: ${paraGap}em !important;
}
/* A paragraph <div> gets the same gap, but only when it really is one: an
   empty div, or one whose children are all blocks or all replaced elements,
   is a layout box the book put there to position something — and a gap on
   those is not cosmetic, see the figure note below. Kept in its own rule so
   that on a WebView without :has() support only this div clause is dropped,
   not the p/li clause above. */
div:not(:empty):not([class*="pagebreak"]):not(:has(> p, > div, > section, > table, > ul, > ol, > blockquote, > h1, > h2, > h3, > h4, > h5, > h6, > img, > svg, > picture, > figure, > video, > canvas)) {
  margin-top: ${paraGap}em !important;
  margin-bottom: ${paraGap}em !important;
}
/* Off must be as loud as on: the book's own 2em indent survives an omitted
   declaration, so the toggle only reads as broken when it is not forced.
   Same div handling as the gap above. */
p {
  text-indent: ${indent ? "2em" : "0"} !important;
}
div:not(:empty):not([class*="pagebreak"]):not(:has(> p, > div, > section, > table, > ul, > ol, > blockquote, > h1, > h2, > h3, > h4, > h5, > h6, > img, > svg, > picture, > figure, > video, > canvas)) {
  text-indent: ${indent ? "2em" : "0"} !important;
}`
  }
/* Replaced elements are the one thing a book cannot be trusted to size: a
   cover or a plate authored for print paper is routinely wider than the
   column, and the paginator only caps a replaced element against its own
   parent (setImageSize writes max-width: 100% of that parent), which is not
   the column when the book wrapped it in a print-width box. Cap the box,
   keep the ratio. */
img, svg, video, canvas, image {
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: contain;
}
/* A picture the paginator sizes to the full column is laid out on a line of
   its own, and a replaced element sits on a baseline, so that line box also
   carries the strut's descent *below* the picture — taller than the page. The
   residue spills into the next column and, nothing visible having gone with
   it, the reader renders that column as a blank page (an image-only Calibre
   section took three columns instead of one). Aligning to the box bottom
   drops the descent. Only for a picture that really owns its line, though:
   the same declaration is what moves an icon sharing a line with text off the
   baseline it was authored on (measured: 9px on an 18px icon), and a
   paragraph's markup cannot tell the two apart on its own — hence the mark,
   which attachSection puts on the sections as they load. */
[${LONE_FIGURE_ATTR}] {
  vertical-align: bottom !important;
}
/* The same defect from the other side. A Calibre cover is an <svg> with
   width="100%" height="100%" and preserveAspectRatio="none", and setImageSize
   caps that height at one column: holding the width at 100% while the height
   is capped squashes the artwork into whatever shape the page happens to be
   (measured: a 950x1388 cover painted 720x427). "none" means "stretch to the
   box", so the box *is* the picture — let the viewBox ratio size it instead.
   The max-width/max-height above still bound it, and the artwork keeps its
   proportions. Only the fill-the-box recipe is touched: an SVG that carries
   its own size keeps it. */
svg[viewBox][width*="%"][height*="%"] {
  width: auto !important;
  height: auto !important;
}
/* Same reason for a wrapper the book fixed to print width: the page has to
   fit the column, not the other way round. Only an explicit pixel width is
   clamped — percentages and fr units already resolve against the column. */
*[width]:not([width=""]):not([width*="%"]) {
  max-width: 100% !important;
}${
    writingMode === "auto"
      ? ""
      : `
/* Forced writing direction — 跟随书籍 (auto) injects nothing and the book's
   own writing-mode stands. Forced on the text elements rather than only on
   html/body for the same reason line-height is: a converted book restates
   writing-mode on its own paragraph classes, and a declaration there
   beats an inherited one. text-orientation is left at "mixed", so a Latin
   run inside a vertical column lies on its side the way a printed book
   sets it, rather than standing every letter up.
   The paginator reads writing-mode back off the section, so it gets the
   column axis, the page margins and the two-phase vertical page-turn
   slide out of this one declaration. */
${textSelectors} {
  writing-mode: ${writingMode === "vertical" ? "vertical-rl" : "horizontal-tb"} !important;
}`
  }`;
  if (!dark) return typography;
  return `${typography}
html {
  --bg-texture-id: none;
  --theme-bg-color: ${bg};
  --theme-fg-color: ${fg};
  --override-color: true;
}
html, body {
  color: ${fg};
}
/* Element-level repaint, the half of readest's getColorStyles this sheet was
   missing. html/body alone only reaches text that inherits straight from the
   root; a Calibre-converted book restates color on every one of its own
   classes (and inline on spans), so the page came up in print black on the
   night fill — measured on a converted EPUB, where the paragraph colour
   stayed rgb(0, 0, 0) while only the headings that happened to use the
   accent colour survived. These selectors carry !important so they also beat
   an inline style="color: …", which is the whole point. background-color is
   deliberately NOT forced here: the section's own backgrounds go through the
   paginator's --override-color resolver, which keeps image-bearing paper
   (Kindle textures) in its original colours. */
section, aside, blockquote, article, nav, header, footer, main, figure,
div, p, font, h1, h2, h3, h4, h5, h6, li, span, td, th, dd, dt, b, i, em,
strong, small, sup, sub, label, caption, figcaption, pre, code, q, cite {
  color: ${fg} !important;
}
a:any-link {
  color: lightblue;
}
/* Hardcoded black text the book shipped for white paper, including the
   rgb(0, 126, 221)-style accents that Calibre conversions sprinkle on Latin
   runs. */
font[color="#000000"], font[color="#000"], font[color="black"],
font[color="rgb(0,0,0)"], font[color="rgb(0, 0, 0)"],
*[style*="color: rgb(0,0,0)"], *[style*="color: rgb(0, 0, 0)"],
*[style*="color: #000"], *[style*="color: #000000"], *[style*="color: black"],
*[style*="color:rgb(0,0,0)"], *[style*="color:rgb(0, 0, 0)"],
*[style*="color:#000"], *[style*="color:#000000"], *[style*="color:black"] {
  color: ${fg} !important;
}
/* Callout boxes with inline white/light backgrounds (readest's
   getDarkModeLightBackgroundOverrides). */
*[style*="background-color: #fff"], *[style*="background-color:#fff"],
*[style*="background-color: #ffffff"], *[style*="background-color:#ffffff"],
*[style*="background-color: white"], *[style*="background-color:white"],
*[style*="background: #fff"], *[style*="background:#fff"],
*[style*="background: #ffffff"], *[style*="background:#ffffff"],
*[style*="background: white"], *[style*="background:white"],
*[style*="background-color: rgb(255"], *[style*="background-color:rgb(255"],
*[style*="background: rgb(255"], *[style*="background:rgb(255"] {
  background-color: ${bg} !important;
}${
    invertImages
      ? `
/* Opt-in, and dark-only: a night reader who wants fewer lumens can have the
   book's pictures inverted too. Off by default — see FoliateStyle. */
img, svg, video, canvas, image {
  filter: invert(1) hue-rotate(180deg);
}`
      : ""
  }`;
};
