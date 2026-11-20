import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: {
    metadataSourceList: mocks.list,
    metadataSourceSave: mocks.save,
    metadataSourceDelete: mocks.remove,
  },
  showToast: vi.fn(),
}));

import { MetadataSourcesPanel } from "@/features/plugins/MetadataSourcesPanel";
import type { CustomSourceEntry } from "@/types/ipc";

const ENTRY: CustomSourceEntry = {
  id: "row-1",
  name: "我的目录",
  def: {
    name: "我的目录",
    baseUrl: "https://books.example.com",
    searchUrl: "/api/search?q={{query}}",
    list: "$.data[*]",
    title: "$.title",
    authors: "$.author",
    intro: "",
    publisher: "",
    publishedYear: "",
    language: "",
    isbn: "",
    rating: "",
    cover: "",
  },
};

const OPEN_LIBRARY: CustomSourceEntry["def"] = {
  name: "Open Library",
  baseUrl: "https://openlibrary.org",
  searchUrl: "/search.json?q={{query}}&limit=2",
  list: "$.docs[*]",
  title: "$.title",
  authors: "$.author_name[*]",
  intro: "",
  publisher: "",
  publishedYear: "$.first_publish_year",
  language: "",
  isbn: "",
  rating: "",
  cover: "",
};

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MetadataSourcesPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue([ENTRY]);
  mocks.save.mockReset().mockResolvedValue("row-2");
  mocks.remove.mockReset().mockResolvedValue(null);
});

describe("MetadataSourcesPanel", () => {
  it("lists a saved source", async () => {
    open();
    expect(await screen.findByText("我的目录")).toBeTruthy();
    expect(screen.getByText("books.example.com")).toBeTruthy();
  });

  it("saves a new source from the JSON editor", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("我的目录");

    await user.click(screen.getByRole("button", { name: /新建/ }));
    const editor = screen.getByRole("textbox", { name: "元数据来源规则" });
    fireEvent.change(editor, {
      target: {
        value:
          '{"name":"第二个","baseUrl":"https://two.example.com","searchUrl":"/s?q={{query}}","list":"$.d[*]","title":"$.t"}',
      },
    });
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[1].name).toBe("第二个");
  });

  it("saves the Open Library definition without dropping fields", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("我的目录");
    await user.click(screen.getByRole("button", { name: /新建/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "元数据来源规则" }), {
      target: { value: JSON.stringify(OPEN_LIBRARY, null, 2) },
    });
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[1]).toEqual(OPEN_LIBRARY);
  });

  it("deletes a source", async () => {
    open();
    const user = userEvent.setup();
    await screen.findByText("我的目录");
    await user.click(screen.getByRole("button", { name: "删除我的目录" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("row-1"));
  });
});
