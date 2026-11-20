import { describe, expect, it } from "vitest";

import { sourceLabel } from "@/lib/metadata";

describe("sourceLabel", () => {
  it("keeps the built-in names", () => {
    expect(sourceLabel("douban")).toBe("豆瓣");
    expect(sourceLabel("neodb")).toBe("NeoDB");
  });

  it("knows a reader-defined source by its row id", () => {
    const names = { "8f1c": "我的目录" };
    expect(sourceLabel("8f1c", names)).toBe("我的目录");
    expect(sourceLabel("unknown", names)).toBe("评分");
    expect(sourceLabel(null, names)).toBe("评分");
  });
});
