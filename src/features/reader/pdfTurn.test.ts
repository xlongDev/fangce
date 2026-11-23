import { describe, expect, it } from "vitest";

import { CURL_MS, pdfTurn, pushClip, verticalTurnMs } from "./pdfTurn";
import type { PageTransition } from "./theme";

/** The frame a turn ends on — where the outgoing sheet has gone. Empty when
    the setting has no animation, so an assertion naming a frame fails
    instead of passing against a turn that was never built. */
const end = (mode: PageTransition, dir: 1 | -1, travel = 400): Keyframe =>
  pdfTurn(mode, dir, travel)?.frames.at(-1) ?? {};

describe("pdfTurn", () => {
  it("runs the vertical turns slower than the horizontal ones", () => {
    // The mesh curl is rAF-driven and exposes no WAAPI timing, so its duration
    // lives here as a constant. The flat fold is asserted in its own test.
    expect(CURL_MS).toBe(500);
    expect(pdfTurn("paper", 1, 400)?.duration).toBe(500);
    expect(pdfTurn("pan", 1, 400)?.duration).toBe(380);
  });

  it("pushes sheet and live page together, without a shadow (readest Push)", () => {
    const pan = pdfTurn("pan", 1, 477);
    expect(pan?.duration).toBe(380);
    expect(pan?.easing).toBe("cubic-bezier(0.42, 0, 0.58, 1)");
    expect(pan?.push).toBe(true);
    expect(pan?.edgeShadow).toBeUndefined();
    expect(end("pan", 1, 477).transform).toBe("translateX(-477px)");
    expect(end("pan", -1, 477).transform).toBe("translateX(477px)");
  });

  it("slides only the old sheet, trailing an edge shadow (readest Slide)", () => {
    const cover = pdfTurn("slide", 1, 477);
    expect(cover?.duration).toBe(380);
    expect(cover?.easing).toBe("cubic-bezier(0.42, 0, 0.58, 1)");
    expect(cover?.edgeShadow).toBe(true);
    expect(cover?.push).toBeUndefined();
    expect(end("slide", 1, 477).transform).toBe("translateX(-477px)");
    expect(end("slide", -1, 477).transform).toBe("translateX(477px)");
  });

  it("fades without moving the sheet", () => {
    expect(end("fade", 1).opacity).toBe(0);
    expect(end("fade", 1).transform).toBeUndefined();
  });

  it("folds about the sheet's own spine, not the viewport's", () => {
    const forward = pdfTurn("paper", 1, 400);
    expect(forward?.duration).toBe(500);
    expect(forward?.fold).toBe(true);
    expect(end("paper", 1).transform).toContain("rotateY(-88deg)");

    const backward = pdfTurn("paper", -1, 400);
    expect(backward?.fold).toBe(true);
    expect(end("paper", -1).transform).toContain("rotateY(88deg)");
  });

  it("has nothing to play when the reader asked for none", () => {
    expect(pdfTurn("none", 1, 400)).toBeNull();
  });
});

describe("verticalTurnMs", () => {
  // Curl and fold bend the whole book box: one page wide in 单页, a spread's
  // union in 双页. A fixed time would send the spread twice as far in the same
  // 500 ms — the "spread turns faster" the reader noticed.
  it("keeps the single-page turn at the 500 ms baseline", () => {
    expect(verticalTurnMs(477, 477)).toBe(500);
    expect(verticalTurnMs(974, 974)).toBe(500);
  });

  it("scales the spread by its sheet-to-pitch ratio", () => {
    // A 974-px sheet turning a 477-px pitch travels 2.04x as far.
    expect(verticalTurnMs(974, 477)).toBe(Math.round(500 * (974 / 477)));
    expect(verticalTurnMs(974, 477)).toBeGreaterThan(verticalTurnMs(477, 477));
    // Same paper speed: duration/width is equal for one page and a spread.
    expect(verticalTurnMs(974, 477) / 974).toBeCloseTo(500 / 477, 1);
  });

  it("falls back to the baseline on a degenerate box", () => {
    expect(verticalTurnMs(0, 477)).toBe(500);
    expect(verticalTurnMs(974, 0)).toBe(500);
  });
});

describe("pushClip", () => {
  // A centred single page, or one half of a 954-wide spread.
  it("hides the incoming page completely at the book's far edge", () => {
    expect(pushClip(0, 477, 477, 477, 1)).toBe("inset(0 477px 0 0)");
    expect(pushClip(0, 477, 477, -477, -1)).toBe("inset(0 0 0 477px)");
    // Half of a spread: its own offset is part of the distance to hide.
    expect(pushClip(477, 477, 954, 954, 1)).toBe("inset(0 954px 0 0)");
  });

  it("opens fully once the page has come to rest in the book box", () => {
    expect(pushClip(0, 477, 477, 0, 1)).toBe("inset(0 0px 0 0)");
    expect(pushClip(0, 477, 477, 0, -1)).toBe("inset(0 0 0 0px)");
    // Both halves of a spread rest unclipped even though each is half-width.
    expect(pushClip(477, 477, 954, 0, 1)).toBe("inset(0 0px 0 0)");
    expect(pushClip(477, 477, 954, 0, -1)).toBe("inset(0 0 0 0px)");
  });

  it("reveals only the part of the strip still inside the book box", () => {
    // Single page, halfway through a forward turn: the right half of the book
    // is covered by the arriving page, the left half by the one leaving.
    expect(pushClip(0, 477, 477, 238.5, 1)).toBe("inset(0 238.5px 0 0)");
    // Backward mirrors it onto the left edge.
    expect(pushClip(0, 477, 477, -238.5, -1)).toBe("inset(0 0 0 238.5px)");
    // A spread's left half, halfway: the page is half-width, so only the part
    // that has reached the book box shows — never the reader's margin.
    expect(pushClip(0, 477, 954, 477, 1)).toBe("inset(0 0px 0 0)");
    // A spread's right half at the same instant is still one full width out.
    expect(pushClip(477, 477, 954, 477, 1)).toBe("inset(0 477px 0 0)");
  });

  it("rounds the exposed edge like the paper it reveals", () => {
    // The clip's outer corner is the one the reader watches slide into the
    // book; a square inset there undoes the page's own rounded corner.
    expect(pushClip(0, 477, 477, 238.5, 1, 24)).toBe("inset(0 238.5px 0 0 round 24px)");
    expect(pushClip(0, 477, 477, -238.5, -1, 24)).toBe("inset(0 0 0 238.5px round 24px)");
  });
});
