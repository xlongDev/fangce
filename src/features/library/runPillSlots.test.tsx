import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRunPillPeek, useRunPillSlot } from "@/features/library/runPillSlots";

describe("后台通知条的共用栈位", () => {
  it("只剩一条时贴最低位，消失后其余条自动下移", () => {
    const guide = renderHook(() => useRunPillSlot("guide", true));
    const fill = renderHook(() => useRunPillSlot("fill", true));

    expect(guide.result.current).toBe(0);
    expect(fill.result.current).toBe(1);

    guide.unmount();
    expect(fill.result.current).toBe(0);
  });
});

describe("折叠徽章的探头", () => {
  it("默认收起计数，hover / focus 弹出，离开收回", () => {
    const { result } = renderHook(() => useRunPillPeek(true));
    expect(result.current.countHidden).toBe(true);

    act(() => result.current.peekHandlers.onMouseEnter());
    expect(result.current.countHidden).toBe(false);
    act(() => result.current.peekHandlers.onMouseLeave());
    expect(result.current.countHidden).toBe(true);

    act(() => result.current.peekHandlers.onFocus());
    expect(result.current.countHidden).toBe(false);
    act(() => result.current.peekHandlers.onBlur());
    expect(result.current.countHidden).toBe(true);
  });

  it("展开态忽略探头；折起来时先保持弹出，避免闪一下空徽章", () => {
    const { result, rerender } = renderHook(({ collapsed }) => useRunPillPeek(collapsed), {
      initialProps: { collapsed: false },
    });
    expect(result.current.countHidden).toBe(false);
    act(() => result.current.peekHandlers.onMouseEnter());
    expect(result.current.countHidden).toBe(false);

    rerender({ collapsed: true });
    expect(result.current.countHidden).toBe(false);
    act(() => result.current.peekHandlers.onMouseLeave());
    expect(result.current.countHidden).toBe(true);
    act(() => result.current.keepPeek());
    expect(result.current.countHidden).toBe(false);
  });
});
