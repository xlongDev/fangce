import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToolRow } from "@/features/reader/ToolRow";
import type { ToolCallView } from "@/types/ipc";

const hit = {
  bookId: "b1",
  bookTitle: "书",
  chapterIdx: 2,
  startChar: 0,
  score: 0.9,
  text: "片段",
};

function view(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    name: "search_book",
    label: "检索「主角是谁」",
    detail: "3 段",
    ok: true,
    sources: [hit],
    ...overrides,
  };
}

describe("ToolRow", () => {
  it("says what was looked up and how much came back", () => {
    render(<ToolRow tool={view()} onJump={() => {}} />);
    expect(screen.getByText("检索「主角是谁」")).toBeInTheDocument();
    expect(screen.getByText(/3 段/)).toBeInTheDocument();
  });

  it("hands a source back so the reader can jump to it", async () => {
    const onJump = vi.fn();
    render(<ToolRow tool={view()} onJump={onJump} />);

    // Chapter numbers are shown 1-based; the hit is stored 0-based.
    await userEvent.click(screen.getByRole("button", { name: /第 3 章/ }));
    expect(onJump).toHaveBeenCalledWith(hit);
  });

  it("shows a failed call without pretending it found anything", () => {
    render(
      <ToolRow
        tool={view({ ok: false, detail: "还没有配置向量模型", sources: [] })}
        onJump={() => {}}
      />,
    );
    expect(screen.getByText(/还没有配置向量模型/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /第 .* 章/ })).not.toBeInTheDocument();
  });

  it("renders nothing extra for a call that returned no text", () => {
    render(
      <ToolRow
        tool={view({ name: "read_chapter", label: "读取第 2 章", detail: "3 千字", sources: [] })}
        onJump={() => {}}
      />,
    );
    expect(screen.getByText("读取第 2 章")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
