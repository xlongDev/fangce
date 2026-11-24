import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    metadataPropose: vi.fn(),
    metadataApply: vi.fn(),
    metadataProposeTitles: vi.fn(),
    metadataApplyTitles: vi.fn(),
    metadataSourceList: vi.fn(),
  },
  isDesktopRuntime: true,
}));
vi.mock("@/lib/demo", () => ({ demoEnabled: () => false, demoProposals: () => [] }));

import { BatchFillDialog } from "@/features/library/BatchFillDialog";
import { ipc } from "@/lib/ipc";
import { useFillRun } from "@/stores/fillRun";
import { useToasts } from "@/stores/toasts";
import type { Candidate_Serialize, Proposal_Serialize, TitleProposal_Serialize } from "@/types/ipc";

function candidate(title: string, source: string, matchScore: number): Candidate_Serialize {
  return {
    source,
    title,
    subtitle: null,
    authors: [],
    publisher: null,
    publishedYear: null,
    description: null,
    rating: null,
    ratingCount: null,
    doubanUrl: null,
    language: null,
    isbn: null,
    coverUrl: null,
    matchScore,
  };
}

function proposal(
  bookId: string,
  bookTitle: string,
  fills: Proposal_Serialize["fills"] = [],
): Proposal_Serialize {
  return {
    bookId,
    bookTitle,
    fills,
    skipped: fills.length > 0 ? null : "字段都有",
    throttledForMs: null,
    matchScore: 0.8,
    rating: null,
    ratingCount: null,
    ratingSource: null,
    doubanUrl: null,
    coverUrl: null,
    coverReplaces: false,
    existing: [],
  };
}

function titleProposal(overrides: Partial<TitleProposal_Serialize>): TitleProposal_Serialize {
  return {
    bookId: "b1",
    bookTitle: "理想国译丛009 · 零年：1945",
    candidates: [],
    confident: false,
    skipped: null,
    ...overrides,
  };
}

const onClose = vi.fn();
function show() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BatchFillDialog open ids={["b1", "b2"]} onClose={onClose} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useFillRun.getState().reset();
  useToasts.setState({ toasts: [] });
  vi.mocked(ipc.metadataPropose).mockResolvedValue([
    proposal("b1", "理想国译丛009 · 零年：1945", [
      { field: "publisher", from: null, to: "某出版社" },
    ]),
    proposal("b2", "另一本"),
  ]);
  vi.mocked(ipc.metadataApply).mockResolvedValue(1);
  vi.mocked(ipc.metadataSourceList).mockResolvedValue([]);
  vi.mocked(ipc.metadataProposeTitles).mockResolvedValue([
    titleProposal({
      candidates: [candidate("零年：1945", "neodb", 0.75), candidate("零年", "douban", 0.65)],
      confident: true,
    }),
    titleProposal({
      bookId: "b2",
      bookTitle: "另一本",
      candidates: [candidate("另一个名字", "neodb", 0.42)],
      confident: false,
    }),
  ]);
  vi.mocked(ipc.metadataApplyTitles).mockResolvedValue(1);
});

const start = () => userEvent.click(screen.getByRole("button", { name: "开始查询 2 本" }));
const renameSwitch = () => screen.getByRole("checkbox", { name: /按来源改书名/ });

describe("补全弹窗先确认再查询", () => {
  it("打开时不查目录；选好开关并确认后才开始", async () => {
    show();
    expect(screen.getByRole("button", { name: "开始查询 2 本" })).toBeTruthy();
    expect(ipc.metadataPropose).not.toHaveBeenCalled();
    expect(ipc.metadataProposeTitles).not.toHaveBeenCalled();

    await userEvent.click(renameSwitch());
    expect(ipc.metadataPropose).not.toHaveBeenCalled();
    expect(ipc.metadataProposeTitles).not.toHaveBeenCalled();

    await start();
    await waitFor(() => expect(ipc.metadataPropose).toHaveBeenCalledTimes(1));
    expect(ipc.metadataProposeTitles).toHaveBeenCalledTimes(1);
  });
});

describe("补全弹窗里的改书名开关", () => {
  it("默认关着；重新选择打开后逐本预览，低匹配默认不勾", async () => {
    show();
    await start();
    expect(await screen.findByRole("button", { name: "补全 1 本" })).toBeTruthy();
    expect(screen.queryByText("→ 零年：1945")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "重新选择" }));
    await userEvent.click(renameSwitch());
    await start();

    expect(await screen.findByText("→ 零年：1945")).toBeTruthy();
    expect(screen.getByText("NeoDB · 匹配度 75%")).toBeTruthy();
    expect(screen.getByText(/匹配度 42% · 请自己确认/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "补全并改名 1 本" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "改名《另一本》" }));
    expect(screen.getByRole("button", { name: "补全并改名 2 本" })).toBeTruthy();
  });

  it("一次点击写两笔：补全字段，加上勾选的书名", async () => {
    show();
    await userEvent.click(renameSwitch());
    await start();
    await screen.findByText("→ 零年：1945");

    // Picking a different answer must write that answer, not the first one.
    await userEvent.click(screen.getByRole("button", { name: "2 · 零年" }));
    await userEvent.click(screen.getByRole("button", { name: "补全并改名 1 本" }));

    await waitFor(() =>
      expect(ipc.metadataApplyTitles).toHaveBeenCalledWith([{ id: "b1", title: "零年" }]),
    );
    expect(ipc.metadataApply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.metadataApply).mock.calls[0]![0][0]).toMatchObject({
      id: "b1",
      publisher: "某出版社",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("查询中就能转后台", async () => {
    vi.mocked(ipc.metadataPropose).mockReturnValue(new Promise(() => {}));
    show();
    await start();

    expect(screen.getByText(/正在查询书目来源/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "后台运行" })).toBeTruthy();
  });

  it("预览后转后台沿用勾选的书和书名", async () => {
    show();
    await userEvent.click(renameSwitch());
    await start();
    await screen.findByText("→ 零年：1945");

    const startRun = vi.spyOn(useFillRun.getState(), "start").mockImplementation(() => {});
    const showPill = vi.spyOn(useFillRun.getState(), "setBackground").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "后台运行" }));

    expect(startRun).toHaveBeenCalledWith(["b1"], false, true, [{ id: "b1", title: "零年：1945" }]);
    expect(showPill).toHaveBeenCalledWith(true);
  });

  it("开着开关但一本书名都不勾时只做补全", async () => {
    show();
    await userEvent.click(renameSwitch());
    await start();
    await screen.findByText("→ 零年：1945");
    await userEvent.click(
      screen.getByRole("button", { name: "取消改名《理想国译丛009 · 零年：1945》" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "补全 1 本" }));
    await waitFor(() => expect(ipc.metadataApply).toHaveBeenCalledTimes(1));
    expect(ipc.metadataApplyTitles).not.toHaveBeenCalled();
  });
});
