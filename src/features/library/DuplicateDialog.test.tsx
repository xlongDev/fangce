import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ libraryDuplicates: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: { libraryDuplicates: mocks.libraryDuplicates },
}));

import { DuplicateDialog } from "@/features/library/DuplicateDialog";
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DuplicateDialog open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
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

  it("says so when the shelf has no suspects", async () => {
    mocks.libraryDuplicates.mockResolvedValue([]);
    open();

    await waitFor(() => expect(screen.getByText(/没找到疑似重复的书/)).toBeInTheDocument());
  });
});
