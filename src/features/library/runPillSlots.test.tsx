import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRunPillSlot } from "@/features/library/runPillSlots";

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
