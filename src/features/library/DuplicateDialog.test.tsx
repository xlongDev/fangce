import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ libraryDuplicates: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: { libraryDuplicates: mocks.libraryDuplicates },
}));

import { DuplicateDialog, searchTerm } from "@/features/library/DuplicateDialog";
import type { DuplicateGroup } from "@/types/ipc";

const group: DuplicateGroup = {
  reason: "同一 ISBN",
  books: [
    {
      id: "a",
      title: "三体",
      isbn: "9787536692930",
      format: "epub",
      fileSize: 1_048_576,
      addedAt: 1_700_000_000,
    },
    {
      id: "b",
      title: "三体：地球往事",
      isbn: "9787536692930",
      format: "azw3",
      fileSize: 2_097_152,
      addedAt: 1_700_086_400,
    },
  ],
};

function open() {
  const onLocate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DuplicateDialog open onClose={vi.fn()} onLocate={onLocate} />
    </QueryClientProvider>,
  );
  return { onLocate };
}

beforeEach(() => {
  mocks.libraryDuplicates.mockReset();
  mocks.libraryDuplicates.mockResolvedValue([group]);
});

describe("the duplicate report", () => {
  it("names the evidence and lists every copy, without offering to delete one", async () => {
    open();

    await waitFor(() => expect(screen.getByText(/《三体》 · 2 本/)).toBeInTheDocument());
    expect(screen.getByText("同一 ISBN")).toBeInTheDocument();
    expect(screen.getByText("三体：地球往事")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();
    // A read-only report: the only action is closing it.
    expect(screen.queryByRole("button", { name: /删除|合并/ })).not.toBeInTheDocument();
  });

  /** A read-only report is only useful if the reader can get back to the
   *  books it named. The lookup word is the main title, a little wider than
   *  the group so a copy with a subtitle shows up too. */
  it("points the shelf's search at the group", async () => {
    const { onLocate } = open();
    const button = await screen.findByRole("button", { name: "在书架中查看这一组" });
    await userEvent.setup().click(button);
    expect(onLocate).toHaveBeenCalledWith("三体");
  });

  it("says so when the shelf has no suspects", async () => {
    mocks.libraryDuplicates.mockResolvedValue([]);
    open();

    await waitFor(() => expect(screen.getByText(/没找到疑似重复的书/)).toBeInTheDocument());
  });
});

describe("searchTerm", () => {
  it("drops a subtitle or edition note, but never a name or a volume", () => {
    expect(searchTerm("神曲：插图珍藏本")).toBe("神曲");
    expect(searchTerm("安娜·卡列尼娜（于大卫译）")).toBe("安娜·卡列尼娜");
    expect(searchTerm("彼得·林奇的成功投资")).toBe("彼得·林奇的成功投资");
    expect(searchTerm("玩转ChatGPT-秒变AI写作高手")).toBe("玩转ChatGPT-秒变AI写作高手");
    expect(searchTerm("大唐狄公案·第二辑套装【上海译文出品！")).toBe("大唐狄公案·第二辑套装");
  });

  /** A one-character head is not a search word — use the whole title. */
  it("keeps the whole title when the head is too short", () => {
    expect(searchTerm("A：附录")).toBe("A：附录");
  });
});
