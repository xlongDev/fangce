import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TagIndex } from "@/features/library/TagIndex";
import type { TagSummary } from "@/types/ipc";

const tag = (name: string, count = 1): TagSummary => ({ id: `t-${name}`, name, count });

/**
 * Three bands, in the order the backend hands them over (most-used first):
 * 3 labels the reader uses constantly, 30 that carry a few books, 2 singletons.
 * The middle band is the one that folds — that is the shape of the real library
 * this was built for (15 / 114 / 152).
 */
const shelf = (): TagSummary[] => [
  ...Array.from({ length: 3 }, (_, index) => tag(`常用${index}`, 30 - index)),
  ...Array.from({ length: 30 }, (_, index) => tag(`普通${index}`, 5)),
  ...Array.from({ length: 2 }, (_, index) => tag(`一次性${index}`, 1)),
];

function open(tags: TagSummary[], selected: string | null = null) {
  const onSelect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TagIndex tags={tags} selected={selected} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect, user: userEvent.setup() };
}

const row = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}，`) });

describe("标签索引", () => {
  /** 281 行平铺是墙，不是目录：频次给层次，规模决定折哪一带。 */
  it("按频次分带，超过一屏的带默认折起来", () => {
    open(shelf());

    expect(row("常用0")).toBeTruthy();
    expect(row("普通0")).toBeNull();
    expect(row("一次性0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开 30 个" })).toBeTruthy();
  });

  it("展开之后能收回来", async () => {
    const { user } = open(shelf());

    await user.click(screen.getByRole("button", { name: "展开 30 个" }));
    expect(row("普通0")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(row("普通0")).toBeNull();
    expect(screen.getByRole("button", { name: "展开 30 个" })).toBeTruthy();
  });

  /** 打字是在找一个词，不是在浏览，所以搜索把每一带都打开。 */
  it("搜索越过折叠", async () => {
    const { user } = open(shelf());

    await user.type(screen.getByLabelText("搜索标签或拼音首字母"), "普通12");

    expect(row("普通12")).toBeTruthy();
    expect(row("普通0")).toBeNull();
    expect(screen.getByText("匹配 1")).toBeTruthy();
  });

  /** 读者知道标签叫什么，但输入法只有 ASCII：两个字母胜过翻 114 行。 */
  it("拼音首字母也能找到标签", async () => {
    const { user } = open(shelf());

    // 纯字母才当首字母（带数字的查询按原文匹配），所以打 cy 找「常用0」
    await user.type(screen.getByLabelText("搜索标签或拼音首字母"), "cy");

    expect(row("常用0")).toBeTruthy();
    expect(row("普通0")).toBeNull();
  });

  /** 搜索时不分带：分组会把相关度顺序打散成三堆，而读者只在一个词。 */
  it("搜索时不再显示分组标题", async () => {
    const { user } = open(shelf());
    expect(screen.getByText(/本以上/)).toBeTruthy();

    await user.type(screen.getByLabelText("搜索标签或拼音首字母"), "常用");

    expect(screen.queryByText(/本以上/)).toBeNull();
    expect(row("常用0")).toBeTruthy();
  });

  /** 两个字不挨着也能找：空格分词让「常用 2」命中「常用2」。 */
  it("空格分隔的多个词都要命中", async () => {
    const { user } = open(shelf());

    await user.type(screen.getByLabelText("搜索标签或拼音首字母"), "常用 2");

    expect(row("常用2")).toBeTruthy();
    expect(row("常用0")).toBeNull();
  });

  it("没有匹配时给出计数，而不是空着", async () => {
    const { user } = open(shelf());

    await user.type(screen.getByLabelText("搜索标签或拼音首字母"), "zzz");

    expect(screen.getByText("匹配 0")).toBeTruthy();
  });

  /** 选中的标签所在的带默认展开，但**读者按了收起就必须能收起**。
   *  上一版把「选中的带自动展开」写成了硬规则，于是当前筛选项所在的那一带
   *  永远收不起来——恰恰是最想收起来的那一带。 */
  it("选中的标签在那一带时，收起仍然有效", async () => {
    const { user } = open(shelf(), "普通3");

    expect(row("普通3")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "收起" }));

    expect(row("普通3")).toBeNull();
    expect(screen.getByRole("button", { name: "展开 30 个" })).toBeTruthy();
  });

  /** 选中的那个即使落在折起来的带里也必须看得见 —— 否则筛选栏看起来像没选中任何东西。 */
  it("选中的标签在折叠带里也可见", () => {
    open(shelf(), "普通3");

    expect(row("普通3")).toBeTruthy();
  });

  it("点一行就按它筛选，点「全部」回到整架", async () => {
    const { user, onSelect } = open(shelf());

    await user.click(row("常用1") ?? screen.getByText("常用1"));
    expect(onSelect).toHaveBeenCalledWith("常用1");

    await user.click(screen.getByRole("button", { name: "全部" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  /** 高亮是**一层**玻璃，在行之间移动，而不是每行各涂一块底色。
   *  jsdom 量不出位置，但「它存在、且是玻璃材质」可以钉住。 */
  it("选中高亮是一层玻璃，不是行自己的底色", () => {
    open(shelf(), "常用0");

    const pane = document.querySelector("[data-tag-indicator]");
    expect(pane).toBeTruthy();
    expect(pane?.className).toContain("glass");
    expect(pane?.className).toContain("pointer-events-none");
  });

  /** 281 行逐个 Tab 是折磨：整条索引只有一个站位，方向键负责走。 */
  it("整条索引只有一个 Tab 站位", () => {
    open(shelf());

    const stops = document.querySelectorAll('[data-tag-row][tabindex="0"]');
    expect(stops.length).toBe(1);
    // 没选中时是「全部」——它是回到整架的入口。
    expect(stops[0]?.getAttribute("data-tag-row")).toBe("");
  });

  /** 方向键走焦点，Enter 才筛选：每一个筛选都是一次查询，按住 ↓ 不该连问二十次。 */
  it("方向键在行之间移动焦点，不改变筛选", async () => {
    const { user, onSelect } = open(shelf());

    row("常用0")!.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("常用1"));

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(row("一次性1"));

    await user.keyboard("{Home}");
    expect(document.activeElement?.getAttribute("data-tag-row")).toBe("");

    expect(onSelect).not.toHaveBeenCalled();

    // 到了想去的那一行，Enter 才算数。
    row("常用1")!.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("常用1");
  });

  /** 打完两个字母，↓ 直接落到结果里——伸手拿鼠标才是这一步的成本。 */
  it("在搜索框里按 ↓ 进入列表", async () => {
    const { user } = open(shelf());

    await user.click(screen.getByLabelText("搜索标签或拼音首字母"));
    await user.keyboard("{ArrowDown}");

    expect(document.activeElement?.getAttribute("data-tag-row")).toBe("");
  });

  /** 删除只在这一行被指向时出现：破坏性控件不该挡在读者要点的标签前面。 */
  it("删除要经确认，先说清几本书会失去它", async () => {
    const { user } = open(shelf(), "常用0");

    await user.click(screen.getByLabelText("删除标签 常用0"));
    expect(screen.getByText(/30 本书会失去这个标签/)).toBeTruthy();
  });
});
