import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TagDialog } from "@/features/library/TagDialog";
import type { BookSummary, TagSummary } from "@/types/ipc";

const book: BookSummary = {
  id: "b1",
  title: "三体",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 1_024,
  coverUrl: null,
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: null,
  location: null,
  favorite: false,
  isbn: null,
  publishedYear: null,
  rating: null,
  ratingCount: null,
  ratingSource: null,
  doubanUrl: null,
  authors: ["刘慈欣"],
  tags: [],
};

const all = (...names: string[]): TagSummary[] =>
  names.map((name) => ({ name, id: `t-${name}`, count: 1 })) as unknown as TagSummary[];

function open(tags: TagSummary[], saved = vi.fn()) {
  render(<TagDialog books={[book]} allTags={tags} onCancel={vi.fn()} onSave={saved} />);
  return { saved, user: userEvent.setup(), field: screen.getByLabelText("新建标签") };
}

describe("标签面板", () => {
  /** 273 个标签的库里，翻找不是工作方式，打字才是。 */
  it("输入就过滤，只留下匹配的标签", async () => {
    const { user, field } = open(all("长篇小说", "心理学", "美国文学"));

    expect(screen.getByRole("button", { name: /长篇小说/ })).toBeTruthy();
    await user.type(field, "心理");

    expect(screen.getByRole("button", { name: /心理学/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /长篇小说/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /美国文学/ })).toBeNull();
  });

  /** 没有匹配项时，输入框剩下的意义就是「造这个词」。 */
  it("没有匹配时给一个「创建」的入口", async () => {
    const { user, field, saved } = open(all("哲学"));

    expect(screen.queryByRole("button", { name: /创建/ })).toBeNull();
    await user.type(field, "伦理学");

    const create = screen.getByRole("button", { name: /创建「伦理学」/ });
    await user.click(create);
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(saved).toHaveBeenCalledWith({ add: ["伦理学"], remove: [] });
  });

  /** 已经勾上的标签不能被过滤藏起来 —— 那样保存前就看不见自己要写什么。 */
  it("过滤时已选中的标签仍在列表里", async () => {
    const { user, field } = open(all("心理学", "美国文学"));

    await user.click(screen.getByRole("button", { name: /心理学/ }));
    await user.type(field, "美国");

    expect(screen.getByRole("button", { name: /美国文学/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /心理学/ })).toBeTruthy();
  });

  /** 输入的是已有标签时，回车是「选它」，不是「再造一个同名的」。 */
  it("回车命中已有标签就选中它", async () => {
    const { user, field, saved } = open(all("心理学"));

    await user.type(field, "心理学{Enter}");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(saved).toHaveBeenCalledWith({ add: ["心理学"], remove: [] });
  });
});
