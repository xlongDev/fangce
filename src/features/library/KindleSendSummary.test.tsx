import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KindleSendSummary } from "@/features/library/KindleSendSummary";
import type {
  KindleBatchOutcome_Serialize,
  KindleBatchSummary_Serialize,
  KindleOutcomeKind,
} from "@/lib/bindings";

function outcome(
  bookId: string,
  title: string,
  kind: KindleOutcomeKind,
  message: string | null = null,
  messageIndex: number | null = null,
): KindleBatchOutcome_Serialize {
  return { bookId, title, kind, message, messageIndex };
}

function makeSummary(
  outcomes: KindleBatchOutcome_Serialize[],
  configError: string | null = null,
): KindleBatchSummary_Serialize {
  const sent = outcomes.filter((o) => o.kind === "sent");
  return {
    total: outcomes.length,
    unique: outcomes.filter((o) => o.kind !== "duplicate").length,
    sent: sent.length,
    invalid: outcomes.filter((o) => o.kind === "invalid").length,
    failed: outcomes.filter((o) => o.kind === "failed").length,
    duplicate: outcomes.filter((o) => o.kind === "duplicate").length,
    messages: new Set(sent.map((o) => o.messageIndex)).size,
    configError,
    outcomes,
  };
}

afterEach(() => vi.useRealTimers());

describe("KindleSendSummary", () => {
  it("reports the whole batch and one line per book", () => {
    render(
      <KindleSendSummary
        summary={makeSummary([
          outcome("a", "甲", "sent", null, 1),
          outcome("b", "乙", "invalid", "发送到 Kindle 目前只支持 EPUB"),
          outcome("c", "丙", "failed", "发送失败，请检查授权码与信任邮箱设置"),
          outcome("d", "丁", "duplicate", "重复选择，已跳过"),
        ])}
        progress={null}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("1 本已发送，分 1 封，1 本无效，1 本失败，1 本重复"),
    ).toBeInTheDocument();
    expect(screen.getByText("《甲》：已发送（第 1 封）")).toBeInTheDocument();
    expect(screen.getByText("《乙》：发送到 Kindle 目前只支持 EPUB")).toBeInTheDocument();
    expect(screen.getByText("《丙》：发送失败，请检查授权码与信任邮箱设置")).toBeInTheDocument();
    expect(screen.getByText("《丁》：重复选择，已跳过")).toBeInTheDocument();
  });

  it("shows the live counter before the summary arrives", () => {
    render(
      <KindleSendSummary
        summary={null}
        progress={{ done: 3, total: 10, messages: 1 }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("正在发送到 Kindle…")).toBeInTheDocument();
    expect(screen.getByText("已处理 3/10，已发 1 封")).toBeInTheDocument();
  });

  it("holds a batch with a failure until the reader dismisses it", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <KindleSendSummary
        summary={makeSummary([
          outcome("a", "甲", "failed", "发送失败，请检查授权码与信任邮箱设置"),
        ])}
        progress={null}
        onClose={onClose}
      />,
    );

    act(() => vi.advanceTimersByTime(7_000));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/甲/)).toBeInTheDocument();
  });

  it("lets a clean batch close itself after a readable pause", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <KindleSendSummary
        summary={makeSummary([outcome("a", "甲", "sent", null, 1)])}
        progress={null}
        onClose={onClose}
      />,
    );

    act(() => vi.advanceTimersByTime(5_999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("prints a batch-wide config error and folds a long detail list", () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      outcome(`b${index}`, `书${index}`, "sent", null, 1),
    );
    render(
      <KindleSendSummary
        summary={makeSummary([], "请填写 SMTP 服务器、账号和授权码")}
        progress={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("请填写 SMTP 服务器、账号和授权码")).toBeInTheDocument();

    render(<KindleSendSummary summary={makeSummary(many)} progress={null} onClose={vi.fn()} />);
    expect(screen.getByText("另有 1 本")).toBeInTheDocument();
    expect(screen.queryByText("《书20》：已发送（第 1 封）")).not.toBeInTheDocument();
    // Long book titles must not push the card past the window: only the detail
    // list scrolls, the header and config banner stay put.
    expect(screen.getByRole("list").className).toContain("overflow-y-auto");
  });
});
