import { describe, expect, it } from "vitest";

import { neighbors } from "./neighbors";
import type { GraphRelation } from "@/types/ipc";

function edge(subject: string, relation: string, object: string, chapterIdx = 0): GraphRelation {
  return { subject, relation, object, evidence: "", chapterIdx };
}

describe("neighbors", () => {
  it("folds repeated edges to one destination and counts them", () => {
    const rows = [
      edge("林昭", "拜师", "玄清道人", 2),
      edge("林昭", "拜师", "玄清道人", 5),
      edge("林昭", "居于", "青云山", 3),
    ];
    expect(neighbors("林昭", rows)).toEqual([
      { name: "玄清道人", count: 2, sample: "拜师" },
      { name: "青云山", count: 1, sample: "居于" },
    ]);
  });

  it("reads the relation from either direction", () => {
    const rows = [edge("玄清道人", "收徒", "林昭"), edge("林昭", "居于", "青云山")];
    // Both have one edge, so pinyin order decides: 青 (qing) before 玄 (xuan).
    expect(neighbors("林昭", rows).map((entry) => entry.name)).toEqual(["青云山", "玄清道人"]);
  });

  it("drops self-relations and edges that do not touch the centre", () => {
    const rows = [
      edge("林昭", "自省", "林昭"),
      edge("甲", "结盟", "乙"),
      edge("林昭", "拜师", "玄清道人"),
    ];
    expect(neighbors("林昭", rows)).toHaveLength(1);
    expect(neighbors("林昭", rows)[0]?.name).toBe("玄清道人");
  });

  it("sorts by edge count, then by name so the strip does not reshuffle", () => {
    const rows = [
      edge("林昭", "见", "乙"),
      edge("林昭", "见", "甲"),
      edge("林昭", "见", "乙"),
      edge("林昭", "见", "丙"),
    ];
    // Count first; equal counts fall back to pinyin order (丙 bing < 甲 jia).
    expect(neighbors("林昭", rows).map((entry) => [entry.name, entry.count])).toEqual([
      ["乙", 2],
      ["丙", 1],
      ["甲", 1],
    ]);
  });

  it("a book with no relations has nowhere to walk to", () => {
    expect(neighbors("林昭", [])).toEqual([]);
  });
});
