import { describe, expect, it, vi } from "vitest";

const { speak } = vi.hoisted(() => ({ speak: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    ttsEdgeSpeak: speak,
  },
}));

import { createEdgeEngine } from "./edge";

class FakeSource {
  listeners = new Map<string, () => void>();
  buffer: unknown = null;
  connect() {}
  disconnect() {}
  addEventListener(type: string, cb: () => void) {
    this.listeners.set(type, cb);
  }
  start() {
    setTimeout(() => this.listeners.get("ended")?.(), 0);
  }
  stop() {}
}

function fakeContext() {
  const sources: FakeSource[] = [];
  return {
    sources,
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
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    createBuffer() {
      return { numberOfChannels: 1, copyToChannel() {} };
    },
  };
}

describe("Edge engine", () => {
  it("calls onFinish once the last clip ends", async () => {
    const ctx = fakeContext();
    vi.stubGlobal("AudioContext", function () {
      return ctx;
    });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("atob", (s: string) => s);
    speak.mockImplementation(async () => ({ audio: "x", words: [] }));

    const done = vi.fn();
    const engine = createEdgeEngine({
      status: vi.fn(),
      unit: vi.fn(),
      boundary: vi.fn(),
      loading: vi.fn(),
      fail: vi.fn(),
    });
    engine.play(["第一句。", "第二句。"], 0, {
      voice: "zh-CN-YunjianNeural",
      rate: 1,
      onFinish: done,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toHaveBeenCalledTimes(1);
    expect(ctx.sources).toHaveLength(2);
  });
});
