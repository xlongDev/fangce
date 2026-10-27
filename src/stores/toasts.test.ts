import { beforeEach, describe, expect, it, vi } from "vitest";

import { showToast, useToasts } from "./toasts";

/** The last message pushed, which is the one the reader would be looking at. */
const latest = () => useToasts.getState().toasts.at(-1);

describe("useToasts", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("keeps one copy of a message that keeps arriving", () => {
    useToasts.getState().push({ tone: "error", message: "保存失败" });
    useToasts.getState().push({ tone: "error", message: "保存失败" });

    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("clears a toast once its timer runs out", () => {
    vi.useFakeTimers();
    try {
      useToasts.getState().push({ tone: "success", message: "已保存" });
      expect(useToasts.getState().toasts).toHaveLength(1);

      vi.runAllTimers();
      expect(useToasts.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("showToast", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("offers the AI settings to an error that names a missing key", () => {
    // The field the message is about is four groups down the settings page, so
    // the link has to name the group and not just the page.
    showToast("error", "API Key 被拒绝，检查 Key 是否正确或已过期（HTTP 401）");

    expect(latest()?.action).toEqual({ label: "去设置", to: "/settings#ai" });
  });

  it("leaves a WebDAV 401 alone", () => {
    // Same status, different group. Matching a bare `401` sent sync failures to
    // the AI form, which is worse than offering no link at all.
    showToast("error", "读取云端状态失败：HTTP 401");

    expect(latest()?.action).toBeUndefined();
  });

  it("does not attach an action to good news", () => {
    showToast("success", "已保存模型名称");

    expect(latest()?.action).toBeUndefined();
  });
});
