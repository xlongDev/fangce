import { describe, expect, it } from "vitest";

import { searchTags } from "@/features/library/labelSearch";
import type { TagSummary } from "@/types/ipc";

const tag = (name: string, count = 1): TagSummary => ({ id: `t-${name}`, name, count });

const names = (tags: TagSummary[]) => tags.map((entry) => entry.name);

describe("标签搜索", () => {
  /** 空格分词、AND、且与顺序无关：读者不该记住自己看到的是哪两个字在前。 */
  it("按空格分词，全部命中才算", () => {
    const shelf = [tag("美国文学"), tag("文学批评"), tag("美国")];

    expect(names(searchTags(shelf, "美国 文学"))).toEqual(["美国文学"]);
    expect(names(searchTags(shelf, "文学 美国"))).toEqual(["美国文学"]);
    expect(names(searchTags(shelf, "美国 诗歌"))).toEqual([]);
  });

  it("完全匹配排在前缀前，前缀排在子串前", () => {
    const shelf = [tag("中国历史"), tag("历史"), tag("世界历史")];

    expect(names(searchTags(shelf, "历史"))).toEqual(["历史", "中国历史", "世界历史"]);
  });

  /** 字之间隔着别的字也能找到，但只能落在「包含」后面。 */
  it("子序列是最后手段", () => {
    const shelf = [tag("历史"), tag("中国历史")];

    expect(names(searchTags(shelf, "中历"))).toEqual(["中国历史"]);
    expect(names(searchTags(shelf, "历史 中"))).toEqual(["中国历史"]);
  });

  it("首字母与全拼都能找到", () => {
    const shelf = [tag("中国历史")];

    expect(names(searchTags(shelf, "zgls"))).toEqual(["中国历史"]);
    expect(names(searchTags(shelf, "zg"))).toEqual(["中国历史"]);
    expect(names(searchTags(shelf, "zhongguo"))).toEqual(["中国历史"]);
    expect(names(searchTags(shelf, "lishi"))).toEqual(["中国历史"]);
  });

  it("匹配得多的排在前面", () => {
    // 两个词都命中的，胜过一个词命中的
    const shelf = [tag("美国文学"), tag("美国文学史")];
    const found = names(searchTags(shelf, "美国 文学"));
    expect(found[0]).toBe("美国文学");
  });

  it("空查询原样返回，顺序不动", () => {
    const shelf = [tag("乙"), tag("甲")];
    expect(searchTags(shelf, "   ")).toBe(shelf);
  });

  it("什么都不匹配时是空数组", () => {
    expect(searchTags([tag("中国历史")], "zzz")).toEqual([]);
  });
});
