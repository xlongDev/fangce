import { afterEach, describe, expect, it } from "vitest";

import {
  FONT_STACKS,
  READING_SURFACES,
  adoptedFacesFor,
  adoptedFontFaces,
  catalogFontOptions,
  customFontFamily,
  customFontKey,
  fontFaceCss,
  readerGlassVars,
  resolveFont,
} from "./theme";
import { catalogFontById } from "@/lib/fontCatalog";

describe("resolveFont", () => {
  it("falls back to the system stack for a key it does not know", () => {
    expect(resolveFont("system")).toBe("var(--font-sans)");
    // A font deleted while it was still selected would leave such a key behind.
    expect(resolveFont("made-up")).toBe("var(--font-sans)");
  });

  it("names an imported font after its id, quoted", () => {
    // Unquoted, a uuid is not a valid family name and the whole declaration
    // would be invalid rather than merely wrong.
    expect(resolveFont(customFontKey("7f1c"))).toBe('"cr-7f1c"');
  });

  it("resolves a catalogue key to the catalogue's own stack", () => {
    expect(resolveFont("catalog:noto-serif-sc")).toBe(catalogFontById("noto-serif-sc")!.stack);
    // A font retired from the catalogue would leave such a key behind, the
    // same way a deleted import does — it resolves to the system stack rather
    // than throwing.
    expect(resolveFont("catalog:retired")).toBe("var(--font-sans)");
  });
});

describe("FONT_STACKS", () => {
  it("offers only faces the platform itself can resolve", () => {
    // Every entry here is a family the platform already has, or the book's own
    // (`book`). 霞鹜文楷 is deliberately not one: it is a catalogue entry, and
    // the picker gets it from `catalogFontOptions` once the reader installs it.
    // A chip for it here would select a stack whose first family nothing
    // declares — the silent fall-through to 楷体 the catalogue exists to avoid.
    expect(FONT_STACKS.map((font) => font.key)).not.toContain("lxgw");
  });
});

describe("fontFaceCss", () => {
  const id = "abc-123";

  it("declares one face per imported font", () => {
    const css = fontFaceCss([{ id, url: "fangce://localhost/font/abc-123" }]);
    expect(css).toContain(`font-family: "${customFontFamily(id)}"`);
    expect(css).toContain("fangce://localhost/font/abc-123");
  });

  it("swaps the face in rather than blocking on it", () => {
    // The default is to hide text while the face downloads; a CJK font is tens
    // of megabytes, so that is a blank page for as long as it takes.
    expect(fontFaceCss([{ id, url: "u" }])).toContain("font-display: swap");
  });

  it("agrees with the family the picker's key resolves to", () => {
    // Two derivations of the same name. If they ever differ, selecting a font
    // would ask for a family that was never declared anywhere.
    expect(fontFaceCss([{ id, url: "u" }])).toContain(customFontFamily(id));
    expect(resolveFont(customFontKey(id))).toBe(`"${customFontFamily(id)}"`);
  });

  it("declares nothing when nothing is imported", () => {
    expect(fontFaceCss([])).toBe("");
  });
});

/**
 * The adopted-face read-back, against stylesheets shaped like the webfont
 * packages': one `@font-face` per `unicode-range` subset, at several weights,
 * authored `font-display: swap` like the real ones.
 *
 * **What these tests cannot see.** jsdom's CSSOM parses only a subset of the
 * `@font-face` descriptors — `src`, `unicode-range` and `font-display` are all
 * dropped on the way in, so `rule.cssText` comes back as little more than the
 * family and the weight. That leaves the url rewrite untestable here, and it is
 * covered the only way it can be: by installing a catalogue font in a real
 * engine and reading the family back out of `document.fonts` (`font-display`
 * and `font-catalog` specs).
 *
 * **The dropped `font-display` has a second consequence.** Because the
 * descriptor never survives into `cssText` here, `withBlockDisplay` takes its
 * insertion branch in every one of these tests. In a real engine it survives —
 * every rule of a fetched 霞鹜文楷 sheet reads back as `block`, in both engines
 * — and the replacement branch is the one that runs. The two branches agree on
 * their output, which is what the assertions below pin down; which one produced
 * it is an environment detail.
 *
 * So what is pinned down below is the *selection* — which rules are carried,
 * and for whom — which is the half jsdom can answer for.
 */
const installed: HTMLStyleElement[] = [];

function install(css: string): void {
  const element = document.createElement("style");
  element.textContent = css;
  document.head.append(element);
  installed.push(element);
}

function face(family: string, weight: string, url: string, display = "swap"): string {
  return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-display: ${display}; src: url("${url}") format("woff2"); }`;
}

afterEach(() => {
  for (const element of installed.splice(0)) element.remove();
});

describe("adoptedFontFaces", () => {
  it("reads back only the family asked for", () => {
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));
    install(face("Some Other Face", "400", "/assets/other.woff2"));

    const css = adoptedFontFaces("LXGW WenKai");
    expect(css).toContain('font-family: "LXGW WenKai"');
    expect(css).not.toContain("Some Other Face");
  });

  it("carries only the weights a book's body text uses", () => {
    install(face("LXGW WenKai", "300", "light.woff2"));
    install(face("LXGW WenKai", "400", "regular.woff2"));
    install(face("LXGW WenKai", "700", "bold.woff2"));

    const css = adoptedFontFaces("LXGW WenKai");
    // 300 and the package's monospace cut would add rules to every section
    // document for a weight no book body text asks for.
    expect(css).not.toContain("font-weight: 300");
    expect(css).toContain("font-weight: 400");
    expect(css).toContain("font-weight: 700");
  });

  it("takes the weights it is asked for instead", () => {
    install(face("LXGW WenKai", "300", "light.woff2"));
    install(face("LXGW WenKai", "400", "regular.woff2"));

    const css = adoptedFontFaces("LXGW WenKai", ["300"]);
    expect(css).toContain("font-weight: 300");
    expect(css).not.toContain("font-weight: 400");
  });

  it("holds the face back instead of swapping it in late", () => {
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));

    const css = adoptedFontFaces("LXGW WenKai");
    // A late 霞鹜文楷 is the whole of "页面字体先会变成楷体再变成霞鹜文楷": the
    // section paints in 楷体, the next family in the stack, and changes under
    // the reader once the subsets land. `block` spends that moment showing
    // nothing rather than the wrong face.
    expect(css).toContain("font-display: block");
    expect(css).not.toContain("font-display: swap");
  });

  it("leaves exactly one display mode on a rule", () => {
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));

    // A second declaration would be harmless in effect, but it would mean the
    // rewrite ran twice over the same rule.
    expect(adoptedFontFaces("LXGW WenKai").match(/font-display/g) ?? []).toHaveLength(1);
  });

  it("is empty for a family nothing declares", () => {
    expect(adoptedFontFaces("Nobody Ships This")).toBe("");
  });

  it("is empty when no stylesheet declares anything at all", () => {
    expect(adoptedFontFaces("LXGW WenKai")).toBe("");
  });
});

describe("adoptedFacesFor", () => {
  it("carries a catalogue face, which no section can see otherwise", () => {
    // The bug: the reader installs 霞鹜文楷, the section document has no such
    // face, and the stack falls through to "Kaiti SC" — the system kaiti.
    install(face("LXGW WenKai", "400", "https://cdn.example/files/lxgw-4.woff2"));
    expect(adoptedFacesFor("catalog:lxgw")).toContain('font-family: "LXGW WenKai"');
  });

  it("carries nothing for the faces the platform provides", () => {
    // These resolve inside the section document on their own; injecting
    // anything would be a no-op at best. An imported font comes through
    // `fontFaceCss` instead, and a key nothing knows falls back to `system`.
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));
    expect(adoptedFacesFor("song")).toBe("");
    expect(adoptedFacesFor("kai")).toBe("");
    expect(adoptedFacesFor("hei")).toBe("");
    expect(adoptedFacesFor("system")).toBe("");
    expect(adoptedFacesFor("custom:7f1c")).toBe("");
    expect(adoptedFacesFor("made-up")).toBe("");
  });

  it("carries nothing for the key the bundled build used to answer", () => {
    // `lxgw` was the dev-only bundled key, retired in favour of `catalog:lxgw`
    // (the reader store migrates a stored value to `kai`). Nothing declares a
    // face for it any more, and this must not resurrect one out of the
    // document just because the family happens to be there.
    install(face("LXGW WenKai", "400", "/assets/lxgw.woff2"));
    expect(adoptedFacesFor("lxgw")).toBe("");
  });
});

describe("catalogFontOptions", () => {
  it("offers an installed catalogue font the picker can select", () => {
    const noto = catalogFontById("noto-serif-sc")!;
    expect(catalogFontOptions(["noto-serif-sc"])).toEqual([
      { key: "catalog:noto-serif-sc", label: "思源宋体 / Noto Serif SC", stack: noto.stack },
    ]);
  });

  it("offers nothing for a font that was never installed", () => {
    // The picker's list is the installed list: a chip for a face whose sheets
    // are not in the document would select a stack with nothing behind it.
    expect(catalogFontOptions([])).toEqual([]);
  });

  it("drops an id the catalogue no longer carries", () => {
    // The installed list is persisted settings; a retired font must not
    // leave a chip selecting a stack with no face behind it.
    expect(catalogFontOptions(["retired-font"])).toEqual([]);
  });
});

/** Independent of the implementation's own maths on purpose: a test that reuses
 *  it can only prove it agrees with itself. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/**
 * `--text-3` was a flat 60% of the paper's ink, which states how much ink to add
 * rather than how much contrast survives — the two only coincide on one paper.
 * Measured, that same 60% came out at 3.22 on 护眼 and 4.06 on 标准, so 12px meta
 * copy in the reader chrome (chapter counts, hints, empty states) failed AA on
 * every light paper, for no reason a reader could see.
 */
describe("readerGlassVars", () => {
  it("gives every light paper a muted ink that clears AA on it", () => {
    for (const surface of READING_SURFACES.filter((one) => one.mode === "light")) {
      const ink = (readerGlassVars(surface) as Record<string, string>)["--text-3"]!;
      expect(ink, `${surface.label} 的 --text-3 该是解出来的实色`).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(ink, surface.tint), `${surface.label} 的 --text-3`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("keeps the dark papers on the translucent mix", () => {
    // Not an oversight. Dark chrome glass comes out *lighter* than the paper it
    // floats on, and a translucent ink follows it up for free; a solid solved
    // against the paper does not, and measured it read worse (the drawer's 书签
    // label: 3.70 translucent, 3.17 solved). Dark needs its own ground, not this
    // one — so it keeps what it had rather than trading a light-paper gain for
    // a dark-paper loss.
    for (const surface of READING_SURFACES.filter((one) => one.mode === "dark")) {
      const ink = (readerGlassVars(surface) as Record<string, string>)["--text-3"]!;
      expect(ink, surface.label).toBe(`color-mix(in srgb, ${surface.fg} 60%, transparent)`);
    }
  });
});
