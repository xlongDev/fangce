import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SummaryPanel } from "./SummaryPanel";
import type { ChapterSummary } from "@/types/ipc";

// The two hooks are the seam: what the panel does with the rows it is given is
// the whole of it. The build and the recap are mocked to their idle shapes.
const { summary, recap } = vi.hoisted(() => ({
  summary: {
    list: { isPending: false, data: [] as ChapterSummary[] },
    build: { build: { isPending: false, mutate: vi.fn(), error: null }, progress: null },
  },
  recap: {
    text: "",
    streaming: false,
    error: null as string | null,
    sendRecap: vi.fn(),
  },
}));

vi.mock("@/hooks/useSummary", () => ({
  useChapterSummaries: () => summary.list,
  useSummaryBuild: () => summary.build,
}));
vi.mock("@/hooks/useAi", () => ({ useAiChat: () => recap }));

function mount(onJump = vi.fn()) {
  render(<SummaryPanel bookId="b1" currentIdx={2} onJump={onJump} />);
  return onJump;
}

function rows(): ChapterSummary[] {
  return [
    { idx: 0, title: "第一章", summary: "林昭进了大殿。", createdAt: 1, chars: 3000 },
    { idx: 1, title: "第二章", summary: "", createdAt: 0, chars: 2800 },
    { idx: 2, title: "第三章", summary: "他离开了。", createdAt: 1, chars: 2500 },
  ];
}

describe("SummaryPanel", () => {
  it("counts what is ready instead of making the reader scroll to find out", () => {
    summary.list.data = rows();
    mount();

    expect(screen.getByText("已读 3 章 · 2 章有摘要")).toBeTruthy();
    expect(screen.getByRole("button", { name: "补齐 1 章" })).toBeTruthy();
  });

  it("marks the chapter the reader is in", () => {
    summary.list.data = rows();
    mount();

    // The position is what makes the list scannable: without it the reader has
    // to remember which number they were on.
    expect(screen.getByText("3. 第三章").closest("button")?.className).toContain("border-accent");
    expect(screen.getByText("1. 第一章").closest("button")?.className).toContain(
      "border-transparent",
    );
  });

  it("says a chapter has no summary rather than leaving the row blank", () => {
    summary.list.data = rows();
    mount();

    expect(screen.getByText("还没有摘要")).toBeTruthy();
  });

  it("tells a chapter with no prose apart from one not generated yet", () => {
    // Both rows are empty; only the second is work. Counting the cover page as
    // missing is what left the button offering to 补齐 a page that is a picture.
    summary.list.data = [
      { idx: 0, title: "第 1 章", summary: "", createdAt: 1, chars: 10 },
      { idx: 1, title: "第一章", summary: "", createdAt: 0, chars: 3000 },
    ];
    mount();

    // The count, not a guess about what the page is: 10 characters is a cover,
    // and the reader can see that for themselves.
    expect(screen.getByText("这一章只有 10 字，没有可摘要的正文")).toBeTruthy();
    expect(screen.getByText("还没有摘要")).toBeTruthy();
    expect(screen.getByRole("button", { name: "补齐 1 章" })).toBeTruthy();
    expect(screen.getByText(/1 章无正文/)).toBeTruthy();
  });

  it("jumps to a chapter when its row is clicked", async () => {
    const user = userEvent.setup();
    summary.list.data = rows();
    const onJump = mount();

    await user.click(screen.getByText("2. 第二章"));
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it("will not build when there is nothing missing", () => {
    summary.list.data = [
      { idx: 0, title: "第一章", summary: "林昭进了大殿。", createdAt: 1, chars: 3000 },
    ];
    mount();

    const button = screen.getByRole("button", { name: "已补齐" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("refuses a recap until at least one chapter has a summary", () => {
    // The backend would answer with an error; asking it would be a round trip
    // to learn something the panel already knows.
    summary.list.data = [{ idx: 0, title: "第一章", summary: "", createdAt: 0, chars: 3000 }];
    mount();

    const button = screen.getByRole("button", { name: "生成前情提要" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("asks for a recap up to the reader's position", async () => {
    const user = userEvent.setup();
    summary.list.data = rows();
    mount();

    await user.click(screen.getByRole("button", { name: "生成前情提要" }));
    expect(recap.sendRecap).toHaveBeenCalledWith("b1", 2);
  });

  it("shows the recap as it arrives", () => {
    summary.list.data = rows();
    recap.text = "前情：林昭刚进宗门。";
    mount();

    expect(screen.getByText("前情：林昭刚进宗门。")).toBeTruthy();
    // Once there is text the button regenerates rather than starting over.
    expect(screen.getByRole("button", { name: "重新生成前情提要" })).toBeTruthy();
    recap.text = "";
  });
});
