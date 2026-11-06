import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { aiSpeechLayout } from "@/features/reader/aiSpeech";
import { useReaderSettings } from "@/stores/reader";
import { useSpeechSession } from "@/stores/speech";

import { AiSpeechText } from "./AiSpeechText";

const GUIDE = "## 一句话概括\n\n本书讲的是什么。\n\n- 第一个要点\n- 第二个要点";

const mocks = vi.hoisted(() => ({
  tts: {
    status: "playing",
    unit: 0,
    boundary: null as unknown,
    error: null,
    loading: false,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setRate: vi.fn(),
    setVoice: vi.fn(),
    boundaryAt: vi.fn(() => null as unknown),
  },
}));
vi.mock("@/features/reader/TtsHost", () => ({
  useTtsHostOptional: () => ({ tts: mocks.tts, sleep: {} }),
}));

const marksOf = (container: HTMLElement) =>
  [...container.querySelectorAll("mark")].map((mark) => mark.textContent).join("");

describe("AiSpeechText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSpeechSession.setState({ origin: "ai", activeId: "guide:b1", units: [], controls: null });
    useReaderSettings.setState({
      aiSpeechHighlight: true,
      speechGranularity: "paragraph",
      speechWashStyle: "highlight",
      speechWashColor: null,
    });
    mocks.tts.unit = 0;
    mocks.tts.boundary = null;
  });

  it("draws the answer's heading, prose and bullets", () => {
    const { container } = render(<AiSpeechText id="guide:b1" text={GUIDE} />);

    expect(container.textContent).toContain("一句话概括");
    expect(container.textContent).toContain("本书讲的是什么。");
    expect(container.textContent).toContain("第一个要点");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("washes the whole display block at paragraph level", () => {
    // Unit 0 is the heading's sentence; the paragraph level covers the whole
    // block it belongs to, not just that one clip.
    const { container } = render(<AiSpeechText id="guide:b1" text={GUIDE} />);

    expect(marksOf(container)).toBe("一句话概括");
  });

  it("paints nothing when the highlight switch is off", () => {
    useReaderSettings.setState({ aiSpeechHighlight: false });
    const { container } = render(<AiSpeechText id="guide:b1" text={GUIDE} />);

    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toContain("一句话概括");
  });

  it("paints nothing while a different answer is speaking", () => {
    useSpeechSession.setState({ activeId: "turn:other" });
    const { container } = render(<AiSpeechText id="guide:b1" text={GUIDE} />);

    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("washes only the word the engine reported", () => {
    useReaderSettings.setState({ speechGranularity: "word" });
    const layout = aiSpeechLayout(GUIDE);
    const unit = layout.units.findIndex((part) => part.text.includes("要点"));
    const at = layout.units[unit]!.text.indexOf("要点");
    mocks.tts.unit = unit;
    mocks.tts.boundary = { unit, charIndex: at, charLength: 2 };

    const { container } = render(<AiSpeechText id="guide:b1" text={GUIDE} />);

    expect(marksOf(container)).toBe("要点");
  });
});
