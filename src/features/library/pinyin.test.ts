import { describe, expect, it } from "vitest";

import { initialsOf, matchesInitials } from "@/features/library/pinyin";

describe("拼音首字母", () => {
  it("取每个字的声母", () => {
    expect(initialsOf("中国历史")).toBe("zgls");
    expect(initialsOf("心理学")).toBe("xlx");
    expect(initialsOf("长篇")).toBe("cp");
  });

  it("非中文原样留下，空格与标点去掉", () => {
    expect(initialsOf("iOS 开发")).toBe("ioskf");
    expect(initialsOf("三体 · 全集")).toBe("stqj");
  });

  it("只有纯字母的查询才当首字母", () => {
    expect(matchesInitials("中国历史", "zg")).toBe(true);
    expect(matchesInitials("中国历史", "gls")).toBe(true);
    expect(matchesInitials("心理学", "zg")).toBe(false);
    // 中文查询交给原文匹配，不再走首字母
    expect(matchesInitials("中国历史", "历史")).toBe(false);
    // 数字与符号也不当首字母
    expect(matchesInitials("中国历史", "2")).toBe(false);
  });

  it("同一个名字只解析一次", () => {
    const first = initialsOf("俄罗斯文学");
    expect(initialsOf("俄罗斯文学")).toBe(first);
  });
});
