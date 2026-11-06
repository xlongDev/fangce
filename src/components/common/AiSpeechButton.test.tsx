import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useReaderSettings } from "@/stores/reader";
import { useSpeechSession } from "@/stores/speech";

import { AiSpeechButton } from "./AiSpeechButton";

// The engine host is the seam: a real one needs an AudioContext and the Edge
// catalogue, neither of which belongs in a button test.
const mocks = vi.hoisted(() => ({
  tts: {
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
  },
}));
vi.mock("@/features/reader/TtsHost", () => ({
  useTtsHostOptional: () => ({ tts: mocks.tts, sleep: {} }),
}));

const button = (props: { id?: string; text?: string; disabled?: boolean; streaming?: boolean }) => (
  <AiSpeechButton
    id={props.id ?? "guide:b1"}
    text={props.text ?? ""}
    title="AI 导读"
    disabled={props.disabled ?? false}
    streaming={props.streaming ?? false}
  />
);

describe("AiSpeechButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSpeechSession.setState({
      origin: "book",
      activeId: null,
      units: [],
      controls: null,
      bookId: null,
      coverUrl: null,
    });
    useReaderSettings.setState({
      aiSpeechEnabled: true,
      aiSpeechAutoPlay: false,
      aiSpeechHighlight: true,
    });
  });

  it("disappears entirely when AI read-aloud is switched off", () => {
    useReaderSettings.setState({ aiSpeechEnabled: false });

    render(button({ text: "一段回答。" }));

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("starts the voice on the stream's falling edge when auto-play is on", () => {
    useReaderSettings.setState({ aiSpeechAutoPlay: true });

    const { rerender } = render(button({ disabled: true, streaming: true }));
    rerender(button({ text: "一段回答。", streaming: false }));

    expect(mocks.tts.play).toHaveBeenCalledWith(["一段回答。"], 0);
    expect(useSpeechSession.getState().activeId).toBe("guide:b1");
  });

  it("stays silent for a cached answer that was never streamed", () => {
    useReaderSettings.setState({ aiSpeechAutoPlay: true });

    render(button({ text: "缓存的导读。" }));

    expect(mocks.tts.play).not.toHaveBeenCalled();
  });

  it("does not start itself with auto-play off", () => {
    const { rerender } = render(button({ disabled: true, streaming: true }));
    rerender(button({ text: "一段回答。", streaming: false }));

    expect(mocks.tts.play).not.toHaveBeenCalled();
  });

  it("only the answer that was just written auto-plays", () => {
    useReaderSettings.setState({ aiSpeechAutoPlay: true });

    const { rerender } = render(
      <>
        <AiSpeechButton id="turn:old" text="旧回答。" title="AI 助手" />
        <AiSpeechButton id="turn:new" text="" title="AI 助手" disabled streaming />
      </>,
    );
    rerender(
      <>
        <AiSpeechButton id="turn:old" text="旧回答。" title="AI 助手" />
        <AiSpeechButton id="turn:new" text="新回答。" title="AI 助手" streaming={false} />
      </>,
    );

    // One `done` event is not ten voices: the older turn never saw a rising
    // edge, so its falling edge cannot start anything.
    expect(mocks.tts.play).toHaveBeenCalledTimes(1);
    expect(useSpeechSession.getState().activeId).toBe("turn:new");
  });
});
