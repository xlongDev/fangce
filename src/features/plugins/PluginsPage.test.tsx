import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sourceList: vi.fn(),
  sourceSave: vi.fn(),
  sourceDelete: vi.fn(),
  ask: vi.fn(),
  desktop: true,
}));

vi.mock("@/lib/ipc", () => ({
  get isDesktopRuntime() {
    return mocks.desktop;
  },
  desktopQuery: (offline: unknown, call: () => Promise<unknown>) => () =>
    mocks.desktop ? call() : Promise.resolve(offline),
  ipc: {
    sourceList: mocks.sourceList,
    sourceSave: mocks.sourceSave,
    sourceDelete: mocks.sourceDelete,
  },
  onSourceProgress: vi.fn(),
}));

vi.mock("@/hooks/useAi", () => ({
  useChatStream: () => ({ ask: mocks.ask, streaming: false }),
}));

import { PluginsPage } from "@/features/plugins/PluginsPage";
import type { SourceEntry, SourceRules } from "@/types/ipc";

function source(
  id: string,
  name: string,
  category: string | null,
  extra: Partial<SourceRules> = {},
): SourceEntry {
  const def: SourceRules = {
    name,
    category,
    baseUrl: `https://${id}.example.com/api`,
    permissions: { hosts: [] },
    search: {
      url: "/search?q={{keyword}}",
      list: "$.list[*]",
      title: "$.title",
      author: "",
      intro: "",
      cover: "",
      bookUrl: "$.url",
    },
    book: { title: "$.title", author: "", intro: "", cover: "" },
    chapters: { list: "$.list[*]", title: "$.title", url: "$.url" },
    content: { paragraphs: "$.body" },
    ...extra,
  };
  return { id, name, def };
}

const SOURCES: SourceEntry[] = [
  source("a", "星光小说", "小说"),
  source("b", "mirror", "漫画", {
    script: { code: "function transform(input) { return input; }" },
  }),
  source("c", "本地测试源", null),
];

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.desktop = true;
  mocks.sourceList.mockReset().mockResolvedValue(SOURCES);
  mocks.sourceSave.mockReset().mockResolvedValue("new-id");
  mocks.sourceDelete.mockReset().mockResolvedValue(null);
  mocks.ask.mockReset();
});

describe("PluginsPage", () => {
  it("filters by category and by search text", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("星光小说");

    await user.click(screen.getByRole("button", { name: "漫画" }));
    expect(screen.getByText("mirror")).toBeTruthy();
    expect(screen.queryByText("星光小说")).toBeNull();

    await user.click(screen.getByRole("button", { name: "全部" }));
    await user.type(screen.getByRole("textbox", { name: "搜索书源" }), "b.example.com");
    expect(screen.getByText("mirror")).toBeTruthy();
    expect(screen.queryByText("星光小说")).toBeNull();
  });

  it("marks sources that carry a script", async () => {
    open();
    await screen.findByText("mirror");
    expect(screen.getByLabelText("带脚本")).toBeTruthy();
    expect(screen.queryByLabelText("带脚本")).toBeTruthy();
    expect(screen.getByText("共 3 个书源 · 1 个带脚本")).toBeTruthy();
  });

  it("deletes every selected source after confirmation", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("星光小说");

    await user.click(screen.getByRole("checkbox", { name: "选择星光小说" }));
    await user.click(screen.getByRole("checkbox", { name: "选择mirror" }));
    await user.click(screen.getByRole("button", { name: /删除所选/ }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(mocks.sourceDelete).toHaveBeenCalledTimes(2);
    });
    expect(mocks.sourceDelete).toHaveBeenCalledWith("a");
    expect(mocks.sourceDelete).toHaveBeenCalledWith("b");
  });

  it("offers a fillable example to readers new to sources", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("星光小说");

    await user.click(screen.getByRole("button", { name: /新建书源/ }));
    await user.click(screen.getByText("怎么填？先看说明和示例"));
    await user.click(screen.getByRole("button", { name: "填入示例" }));

    const editor = screen.getByRole("textbox", { name: "书源规则" }) as HTMLTextAreaElement;
    expect(editor.value).toContain("https://zh.wikisource.org");
    expect(editor.value).toContain("{{keyword}}");

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.sourceSave).toHaveBeenCalledTimes(1));
    expect(mocks.sourceSave.mock.calls[0]?.[1].name).toBe("维基文库（公有领域）");
    expect(mocks.sourceSave.mock.calls[0]?.[1].script?.code).toContain("function transform");
  });

  it("keeps the actions outside the editor's scroll area", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("星光小说");
    await user.click(screen.getByRole("button", { name: /新建书源/ }));
    await user.click(screen.getByText("怎么填？先看说明和示例"));

    // The expanded help makes the sheet taller than the window. The form
    // scrolls on its own; 保存 is always beside it, not below the viewport.
    const editor = screen.getByRole("textbox", { name: "书源规则" });
    const scroller = editor.closest(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("max-h-[62vh]");
    // Block layout, not flex: a flex column shrinks the h-80 editor and
    // overrides its native resize handle (the reported "compressed" sheet).
    expect(scroller?.className).not.toContain("flex");
    expect(scroller?.contains(screen.getByRole("button", { name: "保存" }))).toBe(false);
  });

  it("lets AI write a source definition into the editor", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("星光小说");
    await user.click(screen.getByRole("button", { name: /新建书源/ }));
    await user.click(screen.getByText("怎么填？先看说明和示例"));

    const generated: SourceRules = {
      name: "AI 生成的源",
      baseUrl: "https://ai.example.com",
      permissions: { hosts: [] },
      search: {
        url: "/s?q={{keyword}}",
        list: "$.l[*]",
        title: "$.t",
        author: "",
        intro: "",
        cover: "",
        bookUrl: "$.u",
      },
      book: { title: "$.t", author: "", intro: "", cover: "" },
      chapters: { list: "$.c[*]", title: "$.t", url: "$.u" },
      content: { paragraphs: "$.p[*]" },
    };
    mocks.ask.mockResolvedValueOnce({
      content: "```json\n" + JSON.stringify(generated) + "\n```",
      reasoning: "",
      citations: [],
      usage: null,
      tools: [],
    });

    await user.type(screen.getByRole("textbox", { name: "书源需求描述" }), "站点 ai.example.com");
    await user.click(screen.getByRole("button", { name: "让 AI 写" }));

    await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(1));
    const editor = screen.getByRole("textbox", { name: "书源规则" }) as HTMLTextAreaElement;
    await waitFor(() => expect(JSON.parse(editor.value).name).toBe("AI 生成的源"));
    expect(editor.value).toContain("https://ai.example.com");
  });

  it("saves a new source with the chosen category", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("星光小说");

    await user.click(screen.getByRole("button", { name: /新建书源/ }));
    await user.type(screen.getByRole("textbox", { name: "书源分类" }), "科幻");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(mocks.sourceSave).toHaveBeenCalledTimes(1);
    });
    expect(mocks.sourceSave.mock.calls[0]?.[1].category).toBe("科幻");
  });
});
