import { describe, expect, it } from "vitest";

import { curlGeometry, paperInk, type CurlShot } from "./pdfCurl";

/** A sheet the width of a page in the fixture. */
const WIDTH = 900;

describe("curlGeometry", () => {
  it("starts the fold at the edge the sheet lifts from", () => {
    // Forward lifts the outer edge: the fold begins level with the sheet's
    // right edge, so nothing is turned yet.
    expect(curlGeometry(WIDTH, 0, 1).offset).toBe(WIDTH);
    // Backward lifts the spine side instead.
    expect(curlGeometry(WIDTH, 0, -1).offset).toBe(0);
  });

  it("has carried the whole sheet past the fold by the end", () => {
    for (const dir of [1, -1] as const) {
      const { radius, offset } = curlGeometry(WIDTH, 1, dir);
      // How far the sheet's far edge sits past the fold, in the direction the
      // turn travels. Exactly one arc's worth is the fold clearing the sheet:
      // less and a strip of the old page is left lying on the new one, more
      // and the sheet is still moving after the turn is meant to have landed.
      const past = dir === 1 ? -offset : offset - WIDTH;
      expect(past).toBeCloseTo(Math.PI * radius, 6);
    }
  });

  it("tightens the curl as it travels, with a floor for narrow sheets", () => {
    const start = curlGeometry(WIDTH, 0, 1).radius;
    const end = curlGeometry(WIDTH, 1, 1).radius;
    expect(end).toBeLessThan(start);
    expect(end).toBeCloseTo(start * 0.6, 6);
    // A sliver of a page still bends like paper, not like a hinge.
    expect(curlGeometry(40, 0, 1).radius).toBe(24);
  });
});

describe("paperInk", () => {
  it("reads paper, not the transparent corner the turn itself cut away", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fdfdfe";
    ctx.fillRect(0, 0, 100, 100);
    // The turn burns its rounded corners into the snapshot before creating
    // the curl; the old sampling point is now transparent black.
    ctx.clearRect(0, 0, 4, 4);
    const shot: CurlShot = { canvas, x: 0, y: 0, w: 100, h: 100 };
    const [r, g, b] = paperInk(shot);
    expect(r).toBeCloseTo(253 / 255, 3);
    expect(g).toBeCloseTo(253 / 255, 3);
    expect(b).toBeCloseTo(254 / 255, 3);
  });

  it("falls back to white when no opaque paper pixel is available", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const shot: CurlShot = { canvas, x: 0, y: 0, w: 1, h: 1 };
    expect(paperInk(shot)).toEqual([1, 1, 1]);
  });
});
