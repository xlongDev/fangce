import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookQuery } from "@/types/ipc";
import type * as Ipc from "@/lib/ipc";

// The bug this guards: `useBooks` used to spell out every narrowing field in
// its key, and a new one (无标签) was forgotten — the chip lit up while the
// grid kept showing the previous query's books.
const calls = vi.hoisted(() => [] as BookQuery[]);

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof Ipc>("@/lib/ipc");
  return {
    ...actual,
    // `useBooks` calls `ipc.bookList`, not the bare generated export.
    ipc: {
      ...actual.ipc,
      bookList: (query: BookQuery) => {
        calls.push(query);
        return Promise.resolve([]);
      },
    },
  };
});

import { useBooks } from "@/hooks/useLibrary";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  calls.length = 0;
});

describe("useBooks — 筛选变化要重查", () => {
  it("refetches when the 无标签 narrowing changes", async () => {
    const { rerender } = renderHook(({ untagged }) => useBooks({ untagged }), {
      wrapper,
      initialProps: { untagged: false },
    });
    await waitFor(() => expect(calls).toHaveLength(1));

    rerender({ untagged: true });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.untagged).toBe(true);
  });
});
