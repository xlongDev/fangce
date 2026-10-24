import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SliderRow } from "./SettingsPanel";

/**
 * 拖动只提交一次，松手一定提交。
 *
 * 一次 margin 写入是一次整节重排（整本挤在一个 section 的书上约 1 秒，左右
 * 还要写三条属性），所以每个 input 事件都提交等于把拖动冻住。拇指跟手靠的是
 * 组件里的草稿值，写入按窗口节流，松手补上最后一次。
 *
 * 这里用假时钟而不是 e2e：要测的是「窗口内没有落盘」这件事，真时钟上它只能
 * 靠等，而等出来的绿是运气。
 */
const row = (onChange: (value: number) => void) => (
  <SliderRow label="左右" readout="86 px" min={1} max={224} value={86} onChange={onChange} />
);

describe("SliderRow — 拖动节流", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("节流窗口内拖几次只写一次，写的是最后一次的值", () => {
    const onChange = vi.fn();
    render(row(onChange));
    const input = screen.getByRole("slider");

    for (const value of ["100", "120", "140"]) {
      fireEvent.change(input, { target: { value } });
    }
    expect(onChange, "窗口还没到就落盘了").not.toHaveBeenCalled();
    expect(input, "拇指没跟上指针").toHaveValue("140");

    act(() => vi.advanceTimersByTime(120));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(140);
  });

  it("松手立刻提交最后的值，不等窗口", () => {
    const onChange = vi.fn();
    render(row(onChange));
    const input = screen.getByRole("slider");

    fireEvent.change(input, { target: { value: "200" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(200);
  });

  it("面板在拖动中途关掉，欠下的那个值也要写进去", () => {
    const onChange = vi.fn();
    const { unmount } = render(row(onChange));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "90" } });
    expect(onChange).not.toHaveBeenCalled();

    unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(90);
  });
});
