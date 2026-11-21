import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tts } from "@/features/reader/tts";
import { useSpeechSession } from "@/stores/speech";

import { useAiSpeech } from "./useAiSpeech";

function fakeTts(overrides: Partial<Tts> = {}): Tts {
  return {
    status: "idle",
    unit: null,
    boundary: null,
    error: null,
    loading: false,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setRate: vi.fn(),
    setVoice: vi.fn(),
    boundaryAt: vi.fn(() => null),
    onBoundary: vi.fn(() => () => {}),
    ...overrides,
  };
}

const LABEL = { title: "AI 导读", chapter: "全书" };

describe("useAiSpeech", () => {
  beforeEach(() =>
    useSpeechSession.setState({
      origin: "book",
      activeId: null,
      units: [],
      controls: null,
      bookId: null,
    }),
  );

  it("starts the answer's session and speaks the cleaned sentences", () => {
    const tts = fakeTts();
    const { result } = renderHook(() => useAiSpeech("guide:b1", tts));

    act(() => result.current.toggle("## 标题\n\n**第一**句。第二句。", LABEL));

    // The same per-sentence queue the book hands the engine: no packing, no
    // invented clip size.
    expect(tts.play).toHaveBeenCalledWith(["标题", "第一句。", "第二句。"], 0);
    expect(useSpeechSession.getState()).toMatchObject({
      origin: "ai",
      activeId: "guide:b1",
      title: "AI 导读",
      chapter: "全书",
      bookId: null,
      controls: null,
    });
    expect(useSpeechSession.getState().units.map((unit) => unit.text)).toEqual([
      "标题",
      "第一句。",
      "第二句。",
    ]);
  });

  it("passes a cover from an answer that has no reader to inherit from", () => {
    const tts = fakeTts();
    const { result } = renderHook(() => useAiSpeech("notes-recap:b1", tts));

    act(() => result.current.toggle("回顾一段。", { title: "批注回顾", coverUrl: "cover.png" }));

    expect(useSpeechSession.getState().coverUrl).toBe("cover.png");
  });

  it("stops its own answer and hands the session back", () => {
    const tts = fakeTts({ status: "playing" });
    useSpeechSession.setState({ origin: "ai", activeId: "guide:b1" });
    const { result } = renderHook(() => useAiSpeech("guide:b1", tts));

    expect(result.current.playing).toBe(true);
    act(() => result.current.toggle("## 标题", LABEL));

    expect(tts.stop).toHaveBeenCalledTimes(1);
    expect(tts.play).not.toHaveBeenCalled();
    expect(useSpeechSession.getState()).toMatchObject({ origin: "book", activeId: null });
  });

  it("lets another answer take the voice instead of stopping it", () => {
    const tts = fakeTts({ status: "playing" });
    useSpeechSession.setState({ origin: "ai", activeId: "guide:b1" });
    const { result } = renderHook(() => useAiSpeech("turn:t2", tts));

    expect(result.current.playing).toBe(false);
    act(() => result.current.toggle("另一条回答。", { title: "AI 助手" }));

    expect(tts.stop).not.toHaveBeenCalled();
    expect(tts.play).toHaveBeenCalledWith(["另一条回答。"], 0);
    expect(useSpeechSession.getState().activeId).toBe("turn:t2");
  });

  it("starts nothing when there is nothing worth speaking", () => {
    const tts = fakeTts();
    const { result } = renderHook(() => useAiSpeech("guide:b1", tts));

    act(() => result.current.toggle("```\nconst a = 1;\n```", LABEL));

    expect(tts.play).not.toHaveBeenCalled();
    expect(useSpeechSession.getState().origin).toBe("book");
  });
});
