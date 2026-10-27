import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

import { GuidePanel } from "./GuidePanel";

// The hook is the seam: the panel's whole job is what it does with the state it
// is handed, and the three states are what the reader sees.
const { chat } = vi.hoisted(() => ({
  chat: {
    text: "",
    streaming: false,
    error: null as string | null,
    citations: [],
    sendDigest: vi.fn(),
  },
}));
vi.mock("@/hooks/useAi", () => ({ useAiChat: () => chat }));

/** Where the reader ended up, hash included — the hash is the whole point. */
function Probe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.hash}</span>;
}

function mount() {
  render(
    <MemoryRouter initialEntries={["/reader"]}>
      <GuidePanel bookId="b1" />
      <Probe />
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent;

describe("GuidePanel", () => {
  it("separates the provider's verdict from its advice", () => {
    // The backend writes failures as "结论，建议"; a red paragraph of both at
    // once is what the reader was squinting at.
    chat.error = "API Key 被拒绝，检查 Key 是否正确或已过期（HTTP 401）";
    mount();

    expect(screen.getByText("API Key 被拒绝")).toBeTruthy();
    expect(screen.getByText("检查 Key 是否正确或已过期（HTTP 401）")).toBeTruthy();
  });

  it("sends the reader to the AI group rather than the top of settings", async () => {
    // A key error that lands on 外观 is a link that only half works: the field
    // it is about is four groups down.
    const user = userEvent.setup();
    chat.error = "还没有配置 AI 模型，先到设置里填写接口地址与模型名称";
    mount();

    await user.click(screen.getByRole("button", { name: /去设置/ }));

    expect(location()).toBe("/settings#ai");
  });

  it("keeps a failure with no advice in one piece", () => {
    chat.error = "接口地址或模型名称不存在";
    mount();

    expect(screen.getByText("接口地址或模型名称不存在")).toBeTruthy();
  });
});
