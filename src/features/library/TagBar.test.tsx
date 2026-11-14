import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TagBar } from "@/features/library/TagBar";
import type { TagSummary } from "@/types/ipc";

const tag = (name: string, count = 1): TagSummary => ({ id: `t-${name}`, name, count });

/** `n` tags, so the fold has something to fold. */
const many = (n: number): TagSummary[] =>
  Array.from({ length: n }, (_, index) => tag(`标签${index}`, n - index));

function open(tags: TagSummary[], selected: string | null = null) {
  const onSelect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TagBar tags={tags} selected={selected} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect, user: userEvent.setup() };
}

const chip = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}，`) });

describe("标签栏", () => {
  /** 273 个标签平铺是墙，不是列表。 */
  it("默认只显示前 40 个，其余折起来", async () => {
    const { user } = open(many(45));

    expect(screen.getByText(/共 45 个/)).toBeTruthy();
    expect(chip("标签0")).toBeTruthy();
    expect(chip("标签44")).toBeNull();

    await user.click(screen.getByRole("button", { name: /还有 5 个/ }));
    expect(chip("标签44")).toBeTruthy();
  });

  /** 展开之后要能收回来 —— 273 个 chip 铺满屏幕而没有回头路，就是另一个 bug。 */
  it("展开后能从顶部收起", async () => {
    const { user } = open(many(45));

    await user.click(screen.getByRole("button", { name: /还有 5 个/ }));
    expect(chip("标签44")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /收起/ }));

    expect(chip("标签44")).toBeNull();
    expect(chip("标签0")).toBeTruthy();
    expect(screen.getByRole("button", { name: /还有 5 个/ })).toBeTruthy();
  });

  /** 长尾靠打字，不靠翻。 */
  it("搜索时展开全部匹配项", async () => {
    const { user } = open(many(45));

    await user.type(screen.getByLabelText("搜索标签"), "标签44");

    expect(screen.getByText(/匹配 1 个/)).toBeTruthy();
    expect(chip("标签44")).toBeTruthy();
    expect(chip("标签0")).toBeNull();
    expect(screen.queryByRole("button", { name: /还有/ })).toBeNull();
  });

  it("没有匹配时说一句，而不是留空白", async () => {
    const { user } = open(many(5));

    await user.type(screen.getByLabelText("搜索标签"), "不存在");

    expect(screen.getByText("没有匹配的标签")).toBeTruthy();
  });

  /** 折叠不能把正在筛选的那个标签藏起来。 */
  it("选中的标签在第 40 个之后也看得见", () => {
    open(many(45), "标签44");

    // 选中的那个 chip 渲染成带删除按钮的 span，不是 button —— 靠删除按钮的
    // 可访问名断言它确实在屏幕上了。
    expect(screen.getByLabelText("删除标签 标签44")).toBeTruthy();
  });

  it("点标签就是把筛选切过去", async () => {
    const { user, onSelect } = open([tag("科幻"), tag("文学")]);

    await user.click(screen.getByRole("button", { name: /科幻/ }));

    expect(onSelect).toHaveBeenCalledWith("科幻");
  });
});
