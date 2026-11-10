import { describe, expect, it } from "vitest";

import { preview } from "@/features/library/BatchFillDialog";
import type { Fill } from "@/types/ipc";

const fill = (field: string, to: string): Fill => ({ field, from: null, to });

describe("preview", () => {
  // The regression this exists for: a 4000-character 简介 printed in full turned
  // one row into a page of marketing copy and pushed the dialog off both edges
  // of the window.
  it("summarises the blurb instead of printing it", () => {
    const blurb = "★亚马逊编辑推荐".repeat(400);
    const line = preview(fill("description", blurb));
    expect(line).toBe(`将填入（${blurb.length} 字）`);
    expect(line.length).toBeLessThan(40);
  });

  it("shortens a long value and leaves a short one alone", () => {
    expect(preview(fill("publisher", "重庆出版社"))).toBe("重庆出版社");
    const long = "一家名字特别特别长的出版社有限公司某某某分社（北京）编辑中心第三编辑部";
    expect(preview(fill("publisher", long))).toBe(`${long.slice(0, 32)}…`);
  });

  it("keeps the year readable", () => {
    expect(preview(fill("publishedYear", "2014"))).toBe("2014");
  });
});
