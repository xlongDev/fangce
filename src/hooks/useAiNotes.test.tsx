import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { useSaveRecap, useSavedRecap } from "@/hooks/useAiNotes";

const recapGet = vi.fn();
const recapSave = vi.fn();

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: {
    notesRecapGet: (...args: unknown[]) => recapGet(...args),
    notesRecapSave: (...args: unknown[]) => recapSave(...args),
    notesDraftSuggest: vi.fn(),
    notesDraftApply: vi.fn(),
  },
}));

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("保存 AI 整理的回顾", () => {
  beforeEach(() => {
    recapGet.mockReset();
    recapSave.mockReset();
  });

  it("打开页面读的是已保存的那份，不是模型流", async () => {
    recapGet.mockResolvedValueOnce("上一次保存的回顾");
    const { result } = renderHook(() => useSavedRecap("b1"), { wrapper: wrap() });

    await waitFor(() => expect(result.current.data).toBe("上一次保存的回顾"));
    expect(recapGet).toHaveBeenCalledWith("b1");
    expect(recapSave).not.toHaveBeenCalled();
  });

  it("只有读者点保存时才写库，写的是预览文本", async () => {
    recapSave.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useSaveRecap(), { wrapper: wrap() });
    expect(recapSave).not.toHaveBeenCalled();

    await act(async () => {
      result.current.mutate({ bookId: "b1", text: "新预览" });
    });

    expect(recapSave).toHaveBeenCalledWith("b1", "新预览");
  });
});
