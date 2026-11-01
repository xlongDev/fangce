import { describe, expect, it } from "vitest";

import { costOf, formatCost, formatUsage, priceOf } from "@/lib/aiUsage";

describe("priceOf", () => {
  it("treats a single input price as covering all input", () => {
    // The form says so out loud: 只填这一项时，全部输入 Token 都按它计算.
    expect(priceOf({ inputCached: 0, inputMiss: 2, output: 3 })).toEqual({
      cached: 2,
      miss: 2,
      output: 3,
    });
    expect(priceOf({ inputCached: 1, inputMiss: 0, output: 3 })).toEqual({
      cached: 1,
      miss: 1,
      output: 3,
    });
  });

  it("reads an absent price object as all zeroes", () => {
    expect(priceOf(undefined)).toEqual({ cached: 0, miss: 0, output: 0 });
    expect(priceOf(null)).toEqual({ cached: 0, miss: 0, output: 0 });
  });
});

describe("costOf", () => {
  const usage = { input: 1000, cached: 400, output: 200 };
  const price = { inputCached: 1, inputMiss: 2, output: 3 };

  it("charges the cache-hit rate for the cached share and the miss rate for the rest", () => {
    // 400×1 + 600×2 + 200×3 = 2200 per million.
    expect(costOf(usage, price)).toBeCloseTo(0.0022, 8);
  });

  it("says nothing when the model has not been priced", () => {
    expect(costOf(usage, undefined)).toBeNull();
    expect(costOf(usage, { inputCached: 0, inputMiss: 0, output: 0 })).toBeNull();
    // An output price alone is half a price list: a total from it would look
    // authoritative and be wrong.
    expect(costOf(usage, { inputCached: 0, inputMiss: 0, output: 3 })).toBeNull();
    expect(costOf(usage, { inputCached: 1, inputMiss: 1, output: 0 })).toBeNull();
  });

  it("has no opinion about an answer with no counts", () => {
    expect(costOf(null, price)).toBeNull();
  });

  it("never bills more cached tokens than there were input tokens", () => {
    const wrong = { input: 100, cached: 500, output: 0 };
    expect(costOf(wrong, { inputCached: 1, inputMiss: 1, output: 0 })).toBeNull();
    // Clamped to the 100 input tokens, all of them cached: 100×1 per million.
    expect(costOf(wrong, { inputCached: 1, inputMiss: 1, output: 2 })).toBeCloseTo(0.0001, 8);
  });
});

describe("formatCost", () => {
  it("keeps four decimals for pocket change and two for real money", () => {
    expect(formatCost(0.0022)).toBe("¥0.0022");
    expect(formatCost(0)).toBe("¥0.0000");
    expect(formatCost(1.234)).toBe("¥1.23");
    expect(formatCost(12)).toBe("¥12.00");
  });
});

describe("formatUsage", () => {
  it("mentions the cache only when something hit it", () => {
    expect(formatUsage({ input: 1200, cached: 0, output: 340 })).toBe("输入 1200 · 输出 340");
    expect(formatUsage({ input: 1200, cached: 1024, output: 340 })).toBe(
      "输入 1200 · 缓存命中 1024 · 输出 340",
    );
  });
});
