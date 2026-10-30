/**
 * Reading surfaces and typefaces for the reading viewport.
 *
 * Surfaces are absolute (a reader may keep a paper surface while the app shell
 * follows the OS theme): every entry pairs a background with a foreground that
 * clears AA on it, so the picker can never produce an unreadable combination.
 * The custom surface reuses the day palette under a strong scrim for the same
 * reason: a user image must not decide text contrast.
 */

import type { CSSProperties } from "react";

import { CATALOG_FONTS, catalogFontById, catalogIdOfKey, catalogKey } from "@/lib/fontCatalog";
import type { LocalFont } from "@/types/ipc";

export interface ReadingSurface {
  key: string;
  label: string;
  /** CSS `background` for the reading viewport. */
  background: string;
  /** Body text color, contrast-checked against `background`. */
  fg: string;
  /** Solid representative color for tinting the reader chrome (header,
   * footer, glass buttons) so the whole page reads as one material. */
  tint: string;
  /** Which app chrome palette pairs with this surface while reading. */
  mode: "light" | "dark";
}

export type PageTransition = "none" | "pan" | "slide" | "fade" | "flip" | "paper";
export type LayoutMode = "scroll" | "single" | "double";
/**
 * The writing direction the reader asks for. `auto` follows the book's own
 * `writing-mode` (nothing injected); the other two force it. Foliate books
 * only — prose and PDF have no writing-mode to follow or force.
 */
export type WritingMode = "auto" | "horizontal" | "vertical";

export const READING_SURFACES: ReadingSurface[] = [
  {
    key: "standard",
    label: "标准",
    // Translucent, so the shell's ground and its two glows show through the
    // paper the way they show through every pane in the rest of the app. An
    // opaque sheet was the one surface in the window that ignored the
    // backdrop — the shelf's panel and this page's panel are the same glass,
    // but only the shelf's lets you see what is behind it.
    background: "rgba(251, 251, 253, 0.72)",
    fg: "#23272e",
    tint: "#f4f5f8",
    mode: "light",
  },
  {
    key: "sepia",
    label: "护眼",
    background: "#f4ecd8",
    fg: "#443c2c",
    tint: "#f2e9d2",
    mode: "light",
  },
  {
    key: "green",
    label: "绿色",
    background: "#e4eee2",
    fg: "#2c3a2c",
    tint: "#e2ecdf",
    mode: "light",
  },
  {
    key: "mist",
    label: "雾蓝",
    background: "#e9eef5",
    fg: "#2b3440",
    tint: "#e8edf4",
    mode: "light",
  },
  {
    key: "blush",
    label: "霞粉",
    background: "#f6ebe8",
    fg: "#40302c",
    tint: "#f4e9e6",
    mode: "light",
  },
  {
    key: "dusk",
    label: "暮紫",
    background: "#edeaf3",
    fg: "#332e3e",
    tint: "#ebe8f1",
    mode: "light",
  },
  {
    key: "night",
    label: "夜间",
    background: "#15181d",
    fg: "#c9ced8",
    tint: "#181c23",
    mode: "dark",
  },
  {
    key: "pine",
    label: "松烟",
    background: "#1b231e",
    fg: "#c5d1c8",
    tint: "#1e2620",
    mode: "dark",
  },
  {
    key: "indigo",
    label: "黛蓝",
    background: "#131a26",
    fg: "#c3cbd9",
    tint: "#161d29",
    mode: "dark",
  },
  {
    key: "void",
    label: "玄黑",
    background: "#0e1013",
    fg: "#c6cad2",
    tint: "#111317",
    mode: "dark",
  },
  {
    key: "paper",
    label: "纸纹",
    background:
      "repeating-linear-gradient(0deg, rgba(120,90,40,0.035) 0px, rgba(120,90,40,0.035) 1px, transparent 1px, transparent 3px), #f7f3ea",
    fg: "#3f3a30",
    tint: "#f5f1e7",
    mode: "light",
  },
  {
    key: "linen",
    label: "亚麻",
    background:
      "repeating-linear-gradient(45deg, rgba(90,110,90,0.04) 0px, rgba(90,110,90,0.04) 2px, transparent 2px, transparent 6px), #eef0e9",
    fg: "#33382e",
    tint: "#edefe7",
    mode: "light",
  },
];

/** Day palette applied under the custom image scrim. */
const CUSTOM_SURFACE_FG = "#23272e";
/** White veil over user images; keeps body text at standard-surface contrast. */
const CUSTOM_SURFACE_SCRIM = "rgba(251,251,253,0.88)";

export function resolveSurface(key: string, customImage: string | null): ReadingSurface {
  if (key === "custom" && customImage) {
    return {
      key: "custom",
      label: "自定义",
      background: `linear-gradient(${CUSTOM_SURFACE_SCRIM}, ${CUSTOM_SURFACE_SCRIM}), url("${customImage}") center / cover no-repeat`,
      fg: CUSTOM_SURFACE_FG,
      tint: "#f4f5f8",
      mode: "light",
    };
  }
  return READING_SURFACES.find((surface) => surface.key === key) ?? READING_SURFACES[0]!;
}

function channels(hex: string): number[] {
  const bare = hex.slice(1);
  const six = bare.length === 3 ? [...bare].map((c) => c + c).join("") : bare;
  return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16));
}

function channelLuminance(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: number[]): number {
  return (
    0.2126 * channelLuminance(rgb[0]!) +
    0.7152 * channelLuminance(rgb[1]!) +
    0.0722 * channelLuminance(rgb[2]!)
  );
}

/** `ink` laid over `paper` at `alpha`, i.e. what the eye actually sees. */
function over(ink: number[], paper: number[], alpha: number): number[] {
  return ink.map((value, i) => value * alpha + paper[i]! * (1 - alpha));
}

function contrast(a: number[], b: number[]): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/**
 * The muted ink for one **light** paper: the faintest tint of `fg` that still
 * clears AA against that paper, as an opaque colour.
 *
 * A percentage cannot do this job, and that is what broke it. `60%` says how
 * much ink to add, not how much contrast survives — the two only coincide on
 * one paper. Measured across the seven light papers: the same 60% lands at
 * **3.22 on 护眼 and 4.06 on 标准**, because the headroom comes from the paper,
 * not the ink (护眼's `#443c2c` is only 9.2:1 to begin with, 标准's `#23272e` is
 * 14.5:1). 12px meta copy — chapter counts, hints, empty states — needs 4.5 on
 * every one of them, so the ratio is what gets fixed and the colour is solved.
 *
 * Light papers only, deliberately. In the dark palettes the chrome glass comes
 * out **lighter** than the paper it floats on, and a translucent ink follows it
 * up there for free — an opaque ink solved against the paper does not, and
 * measured it read *worse* (the drawer's 书签 label: 3.70 translucent against
 * 3.17 solved). So dark keeps the mix it had; see `readerGlassVars`.
 */
function mutedInk(fg: string, paper: string, target = 4.5): string {
  const ink = channels(fg);
  const ground = channels(paper);
  // 1.01 because the result is rounded to 8 bits, which moves the ratio by up
  // to ~0.01 — enough to land at 4.494 and fail the very line it was solved for.
  const want = target * 1.01;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    if (contrast(over(ink, ground, mid), ground) < want) low = mid;
    else high = mid;
  }
  const hex = over(ink, ground, high)
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

/** Re-roots the glass token set on a reading surface: chrome styled from these
 *  derives its ink, hairlines and glass fills from the same paper colours as
 *  the reading viewport, so everything reads as one material. Ratios mirror
 *  the theme defaults in globals.css, except `--text-3`: on a light paper it is
 *  solved to AA rather than fixed at a percentage (see `mutedInk`), and on a
 *  dark one it keeps the mix, which is what tracks the lighter glass there. */
export function readerGlassVars(surface: ReadingSurface): CSSProperties {
  return {
    "--text-1": surface.fg,
    "--text-2": `color-mix(in srgb, ${surface.fg} 72%, transparent)`,
    "--text-3":
      surface.mode === "light"
        ? mutedInk(surface.fg, surface.tint)
        : `color-mix(in srgb, ${surface.fg} 60%, transparent)`,
    "--hairline": `color-mix(in srgb, ${surface.fg} 12%, transparent)`,
    "--hairline-strong": `color-mix(in srgb, ${surface.fg} 24%, transparent)`,
    "--surface-1": `color-mix(in srgb, ${surface.fg} 5%, transparent)`,
    "--surface-2": `color-mix(in srgb, ${surface.fg} 9%, transparent)`,
    "--surface-3": `color-mix(in srgb, ${surface.tint} 96%, ${surface.fg})`,
    // Chrome buttons fill with the paper colour (not the ink), so floating
    // controls read as clear glass instead of a dark ink wash on the page.
    "--glass-btn": `color-mix(in srgb, ${surface.tint} 82%, transparent)`,
  } as CSSProperties;
}

export interface FontOption {
  key: string;
  label: string;
  /** CSS `font-family` for the article body. */
  stack: string;
}

export const FONT_STACKS: FontOption[] = [
  /**
   * 原书字体 — the default, and the odd one out: on a foliate book the
   * stylesheet simply does not inject a `font-family` (the book's own faces
   * win), so the stack here is only what the prose and PDF paths — which have
   * no book fonts to keep — resolve it to. That fallback is the system stack.
   */
  { key: "book", label: "原书", stack: "var(--font-sans)" },
  { key: "system", label: "系统", stack: "var(--font-sans)" },
  { key: "song", label: "宋体", stack: '"Songti SC", "STSong", "SimSun", Georgia, serif' },
  { key: "kai", label: "楷体", stack: '"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", serif' },
  {
    key: "hei",
    label: "黑体",
    stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  // 霞鹜文楷 is deliberately not here. No build ships a CJK face — that is the
  // whole point of the catalogue — so it is an entry the reader installs with
  // one click and selects as `catalog:lxgw`, offered from `CATALOG_FONTS`
  // rather than from this list. It used to sit here behind a `bundled` marker
  // that only `pnpm dev` satisfied, which meant the face was in the picker in
  // exactly the builds nobody else ran.
];

/**
 * An imported font is selected as `custom:<id>` and declared in CSS as
 * `cr-<id>`. Both names come from the id alone, which is what keeps
 * [`resolveFont`] a pure function of the stored settings value: the picker has
 * the list of imported fonts, the style builders do not.
 */
const CUSTOM_FONT = "custom:";
const CUSTOM_FAMILY = "cr-";

/** The settings key that selects an imported font. */
export function customFontKey(id: string): string {
  return `${CUSTOM_FONT}${id}`;
}

/** The `font-family` an imported font is declared and used under. */
export function customFontFamily(id: string): string {
  return `${CUSTOM_FAMILY}${id}`;
}

export function resolveFont(key: string): string {
  if (key.startsWith(CUSTOM_FONT)) {
    // Quoted: a uuid is not a valid bare family name, and an unquoted one makes
    // the whole declaration invalid rather than merely wrong.
    return `"${customFontFamily(key.slice(CUSTOM_FONT.length))}"`;
  }
  const catalogId = catalogIdOfKey(key);
  if (catalogId !== null) return catalogFontById(catalogId)?.stack ?? FONT_STACKS[0]!.stack;
  return (FONT_STACKS.find((font) => font.key === key) ?? FONT_STACKS[0]!).stack;
}

/**
 * `@font-face` for the fonts the reader imported.
 *
 * Each document needs its own copy: a book section is a document of its own, so
 * neither the app's declarations nor another section's reach into it. Taking
 * ids and urls rather than whole records lets the picker build the same rules
 * without the list the reader page holds.
 *
 * `font-display: swap` is load-bearing, not decoration: an imported CJK face
 * can be twenty megabytes, and the alternative is a page of invisible text
 * while it arrives. The URL is the resource protocol's — the backend builds it
 * because the origin depends on the platform the app was compiled for.
 */
export function fontFaceCss(fonts: readonly Pick<LocalFont, "id" | "url">[]): string {
  return fonts
    .map(
      (font) =>
        `@font-face { font-family: "${customFontFamily(font.id)}"; src: url("${font.url}"); font-display: swap; }`,
    )
    .join("\n");
}

/**
 * `@font-face` for a face the app adopted at runtime, read back out of the
 * app's own stylesheets so a book section can carry a copy.
 *
 * The bug this exists for: a catalogue font is adopted into the app document
 * as an inline `<style>` (see `catalogFont.ts`), and a foliate section is a
 * document of its own. A section asking for `"Noto Serif SC"` finds no such
 * face in *its* document, falls through the stack, and renders as `"Songti
 * SC"` — the reader installs 思源宋体 and gets the system 宋体. The rules have
 * to be handed to the section, which is the same thing `fontFaceCss` already
 * does for imported faces.
 *
 * Reading them back rather than fetching the sheet a second time keeps one
 * copy of the rules in the build: `useAdoptedFontKey` needs them in the app
 * document for the prose surface, and the section needs the same rules.
 *
 * Only the weights a book's body text uses. Both packages publish more than
 * that; carrying the rest would add rules to every section document for a
 * weight no book body text asks for.
 */
export function adoptedFontFaces(
  family: string,
  weights: readonly string[] = ["400", "700"],
): string {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      // A cross-origin sheet cannot be read. Every adopted sheet is inline, so
      // this is only ever a third party's.
      continue;
    }
    for (const rule of cssRules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const declared = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (declared !== family) continue;
      if (!weights.includes(rule.style.getPropertyValue("font-weight"))) continue;
      rules.push(
        withBlockDisplay(rule.cssText).replace(
          /url\((["']?)([^"')]+)\1\)/g,
          (_match, _quote: string, url: string) =>
            // Resolved against the document, not against the section: an
            // adopted `<style>` has no href of its own, and a section document
            // would otherwise read a relative url as relative to the *book*.
            // The catalogue rewrites its urls to absolute before adopting
            // (`rewriteSheetUrls`), so this resolves nothing today — it is the
            // backstop for a sheet that arrives relative.
            `url("${new URL(url, sheet.href ?? document.baseURI).href}")`,
        ),
      );
    }
  }
  return rules.join("\n");
}

/**
 * The same face, held back until it has arrived instead of swapping in late.
 *
 * The webfont packages author every subset with `font-display: swap`, which is
 * the right default for a page that can afford a fallback and the wrong one
 * here: a reader switching to 霞鹜文楷 watches the book render in 楷体 — the
 * next family in the stack — for as long as the subsets take to arrive, and
 * then change under them. That flash is what "只是变成了楷体" looked like.
 *
 * `block` spends the same moment showing *nothing* rather than the wrong face.
 * It is a short moment: a section only ever needs the handful of subsets its
 * own glyphs fall into, and the rules are injected before the section paints —
 * so the reader sees the text arrive already in the font they chose.
 *
 * Two callers, both on the adoption path: `downloadCatalogFont` rewrites a
 * whole fetched sheet before adopting it (which is what the app document and
 * the prose surface see), and `adoptedFontFaces` rewrites each rule again on
 * its way into a book section. One function so the two cannot drift.
 *
 * Global, because a sheet is one `@font-face` per subset and every one of them
 * is authored `swap`. A non-global replace left all but the first still
 * swapping, which is the flash this function exists to remove.
 */
export function withBlockDisplay(css: string): string {
  return /font-display\s*:/.test(css)
    ? css.replace(/font-display\s*:\s*[a-z]+/gi, "font-display: block")
    : css.replace(/\{\s*/g, "{ font-display: block; ");
}

/** The `@font-face` rules a font key needs inside a book section, or an empty
 *  string for every key whose face the section can resolve on its own. */
export function adoptedFacesFor(key: string): string {
  const id = catalogIdOfKey(key);
  const family = id === null ? undefined : catalogFontById(id)?.family;
  return family ? adoptedFontFaces(family) : "";
}

/**
 * Picker entries for the catalogue fonts the reader has installed.
 *
 * An id the catalogue no longer carries is dropped: the installed list is
 * persisted settings, and a font retired from the catalogue must not leave a
 * chip that selects a stack with no face behind it. The sheets themselves are
 * not the picker's business — `useAdoptedFontKey` adopts them on selection.
 */
export function catalogFontOptions(downloaded: readonly string[]): FontOption[] {
  return CATALOG_FONTS.filter((font) => downloaded.includes(font.id)).map((font) => ({
    key: catalogKey(font.id),
    label: font.name,
    stack: font.stack,
  }));
}

export const PAGE_TRANSITIONS: { key: PageTransition; label: string }[] = [
  { key: "none", label: "无" },
  { key: "pan", label: "左右平移" },
  { key: "slide", label: "覆盖" },
  { key: "fade", label: "淡入淡出" },
  { key: "flip", label: "翻牌" },
  { key: "paper", label: "仿真" },
];

export const LAYOUT_MODES: { key: LayoutMode; label: string }[] = [
  { key: "scroll", label: "滚动" },
  { key: "single", label: "单页" },
  { key: "double", label: "双页" },
];

export const WRITING_MODES: { key: WritingMode; label: string }[] = [
  { key: "auto", label: "跟随书籍" },
  { key: "horizontal", label: "横排" },
  { key: "vertical", label: "竖排" },
];
