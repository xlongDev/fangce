import { describe, expect, it } from "vitest";

import { hexToHsv, hsvToHex, inkOn, normalizeHex } from "./color";

describe("the pickers' colour space", () => {
  it("loses nothing on the way there and back", () => {
    // A picker compares "what I would draw" with "what I was handed" to tell an
    // outside change from its own drag, so the round trip has to be exact.
    const samples = [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffd12e",
      "#56aee2",
      "#7f7f7f",
      "#010203",
      "#fefefe",
    ];
    for (const hex of samples) {
      const { h, s, v } = hexToHsv(hex);
      expect(hsvToHex(h, s, v), hex).toBe(hex);
    }
    // Every grey, since a hue of 0 is a lie the maths tells about all of them.
    for (let n = 0; n < 256; n += 1) {
      const hex = `#${n.toString(16).padStart(2, "0").repeat(3)}`;
      const { h, s, v } = hexToHsv(hex);
      expect(hsvToHex(h, s, v), hex).toBe(hex);
    }
  });

  it("reads the three primary hues and their opposites", () => {
    expect(hexToHsv("#ff0000").h).toBeCloseTo(0, 6);
    expect(hexToHsv("#ffff00").h).toBeCloseTo(60, 6);
    expect(hexToHsv("#00ff00").h).toBeCloseTo(120, 6);
    expect(hexToHsv("#00ffff").h).toBeCloseTo(180, 6);
    expect(hexToHsv("#0000ff").h).toBeCloseTo(240, 6);
    expect(hexToHsv("#ff00ff").h).toBeCloseTo(300, 6);
  });

  it("reports full value and no saturation where the eye sees them", () => {
    expect(hexToHsv("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv("#ff0000").s).toBe(1);
    expect(hexToHsv("#ff0000").v).toBe(1);
  });

  it("takes a hue from outside the circle, and a channel outside its range", () => {
    expect(hsvToHex(360, 1, 1)).toBe("#ff0000");
    expect(hsvToHex(-60, 1, 1)).toBe("#ff00ff");
    expect(hsvToHex(0, 2, 2)).toBe("#ff0000");
    expect(hsvToHex(0, -1, 0.5)).toBe("#808080");
  });

  it("answers with black rather than NaN when handed something that is not a colour", () => {
    // The callers only ever pass a parsed hex or the theme's own, so this is
    // insurance rather than a path: a NaN would reach the DOM as an invalid
    // style, which fails silently and looks like a missing control.
    expect(hexToHsv("nonsense")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvToHex(hexToHsv("nonsense").h, 0, 0)).toBe("#000000");
  });
});

describe("the accent's own ink", () => {
  it("normalises a typed hex before it reaches the store", () => {
    expect(normalizeHex("56A")).toBe("#5566aa");
    expect(normalizeHex("nope")).toBeNull();
  });

  it("picks the ink by contrast, not by theme", () => {
    expect(inkOn("#e9a13b")).toBe("#17120a");
    expect(inkOn("#96591a")).toBe("#fff8ec");
    expect(inkOn("nope")).toBe("#17120a");
  });
});
