import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TtsHost } from "@/features/reader/TtsHost";

const setVoice = vi.fn();

vi.mock("@/features/reader/tts", () => ({
  useTts: () => ({
    setVoice,
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setRate: vi.fn(),
    boundaryAt: vi.fn(),
    status: "idle",
    unit: null,
    boundary: null,
    error: null,
    loading: false,
  }),
  useSpeechVoices: () => ({
    voices: [
      {
        uri: "edge:zh-CN-YunjianNeural",
        name: "Yunjian",
        lang: "zh-CN",
        engine: "edge",
        categories: "Novel",
        gender: "male",
      },
    ],
    edgeError: null,
  }),
}));

vi.mock("@/hooks/useSleepTimer", () => ({ useSleepTimer: () => ({}) }));

/**
 * The regression this pins: AI answers read from a non-reader route (the notes
 * page's 整理成一段, say) used to start with a null voice uri, and `engineOf(null)`
 * is "system" — so the platform voice spoke instead of the Edge default.
 */
describe("TtsHost", () => {
  beforeEach(() => setVoice.mockClear());

  it("resolves the Edge default before any route mounts", () => {
    render(
      <TtsHost>
        <span>child</span>
      </TtsHost>,
    );
    expect(setVoice).toHaveBeenCalledWith("edge:zh-CN-YunjianNeural");
  });
});
