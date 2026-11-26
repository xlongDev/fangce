import { act, renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The Edge engine and the chapter roll-over, wired together for real.
 *
 * A mocked `Tts` cannot catch the bug this file is here for: the reader handed
 * its roll-over to `play`, and the Edge path kept it in a ref the engine never
 * read, so the last clip ended and nothing rolled. Only the platform path had
 * a test — and it passed, which is why the reader still went silent on the
 * default Yunjian voice. Here the queue ends through a real `AudioContext`
 * source's `ended`, and the assertion is that the *next* chapter is asked for.
 */

const { speak, voices } = vi.hoisted(() => ({
  speak: vi.fn(),
  voices: vi.fn(async () => []),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    ttsEdgeSpeak: speak,
    ttsEdgeVoices: voices,
  },
}));

import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import type { SpeechUnit } from "@/features/reader/speech";
import { useTts } from "@/features/reader/tts";
import { useReadAloud, type ReadAloudOptions } from "@/hooks/useReadAloud";

class FakeSource {
  listeners = new Map<string, () => void>();
  connect() {}
  disconnect() {}
  addEventListener(type: string, cb: () => void) {
    this.listeners.set(type, cb);
  }
  start() {
    // The browser fires `ended` on the source node when the clip runs out.
    setTimeout(() => this.listeners.get("ended")?.(), 0);
  }
  stop() {}
}

function fakeContext() {
  return {
    state: "running",
    currentTime: 0,
    destination: {},
    async resume() {
      this.state = "running";
    },
    async suspend() {
      this.state = "suspended";
    },
    async decodeAudioData() {
      return {
        numberOfChannels: 1,
        sampleRate: 24000,
        getChannelData: () => new Float32Array(1),
      };
    },
    createBufferSource() {
      return new FakeSource();
    },
    createBuffer() {
      return { numberOfChannels: 1, copyToChannel() {} };
    },
  };
}

beforeAll(() => {
  Object.defineProperty(window, "speechSynthesis", {
    writable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const ctx = fakeContext();
  vi.stubGlobal("AudioContext", function () {
    return ctx;
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("atob", (s: string) => s);
});

describe("read-aloud with the Edge engine", () => {
  it("reads the next chapter after the last Edge clip", async () => {
    speak.mockImplementation(async () => ({ audio: "x", words: [] }));
    let section = 0;
    const units: SpeechUnit[] = [{ text: "第一章句。", source: 0, start: 0, end: 5 }];
    const next: SpeechUnit[] = [{ text: "第二章句。", source: 0, start: 0, end: 5 }];
    const handle = {
      readFrom: vi.fn(async () => (section === 0 ? units : next)),
      readFromSelection: vi.fn(async () => []),
      bookEnd: () => false,
      ttsSection: () => section,
      sectionCount: () => 2,
      goToSection: vi.fn(),
      goToNextChapter: vi.fn(async (from: number) => {
        section = from + 1;
        return section;
      }),
      section: vi.fn(),
      clearTts: vi.fn(),
      focusUnit: vi.fn(),
      paintSpan: vi.fn(),
      followUnit: vi.fn(),
    } as unknown as FoliateHandle;
    const options: Omit<ReadAloudOptions, "tts"> = {
      useFoliate: true,
      isPdf: false,
      paragraphs: null,
      scrollRef: { current: null },
      foliateRef: { current: handle },
      storedVoice: "edge:zh-CN-YunjianNeural",
      rate: 1,
      granularity: "sentence",
      updateSettings: vi.fn(),
      onChapterEnd: vi.fn(),
    };
    const view = renderHook(
      (props: Omit<ReadAloudOptions, "tts">) => useReadAloud({ ...props, tts: useTts() }),
      { initialProps: options },
    );
    await act(async () => {
      view.result.current.toggle();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(speak.mock.calls.map((c) => c[0])).toContain("第二章句。");
    expect(handle.goToNextChapter).toHaveBeenCalledWith(0);
  });
});
