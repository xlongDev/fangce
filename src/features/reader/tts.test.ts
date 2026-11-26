import { act, renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The engine's one shared reset.
 *
 * The pill is drawn while the session is live *or* an error is showing, so
 * `stop` has to clear the error too — otherwise the close button is dead
 * exactly when the engine has failed, which is the state a reader presses it
 * in most. The Edge engine is replaced with one that hands back the callbacks
 * the real one calls, because reaching `fail` through the real one would mean
 * reaching the service.
 */
const { failRef, boundaryRef, edgePlay } = vi.hoisted(() => ({
  failRef: { current: null as ((message: string) => void) | null },
  boundaryRef: {
    current: null as
      ((spot: { unit: number; charIndex: number; charLength: number } | null) => void) | null,
  },
  edgePlay: vi.fn(),
}));

vi.mock("./edge", () => ({
  useEdgeVoices: () => ({ voices: [], error: null }),
  createEdgeEngine: (events: {
    fail: (message: string) => void;
    boundary: (spot: { unit: number; charIndex: number; charLength: number } | null) => void;
  }) => {
    failRef.current = events.fail;
    boundaryRef.current = events.boundary;
    return {
      play: edgePlay,
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      setRate: vi.fn(),
      setVoice: vi.fn(),
    };
  },
}));

import { useTts } from "./tts";

const EDGE_VOICE = "edge:zh-CN-YunjianNeural";
const REFUSED = "Edge 语音服务拒绝了握手，请稍后重试或切换到系统语音";

beforeAll(() => {
  // jsdom ships no speechSynthesis, and `stop` cancels the platform engine on
  // its way out whichever engine was playing.
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
});

describe("useTts", () => {
  it("hands the chapter roll-over to the Edge engine", () => {
    const { result } = renderHook(() => useTts());
    const finish = vi.fn();
    act(() => {
      result.current.setVoice(EDGE_VOICE);
      result.current.play(["第一句。"], 0, finish);
    });

    // The engine — not this hook — owns the callback: a ref kept here and
    // never handed over is why Edge sessions used to stop at a chapter end.
    expect(edgePlay).toHaveBeenCalledWith(
      ["第一句。"],
      0,
      expect.objectContaining({ onFinish: finish, voice: EDGE_VOICE }),
    );
  });

  it("announces every word to a watcher, even without the word-level wash", () => {
    const { result } = renderHook(() => useTts());
    const watch = vi.fn();
    act(() => {
      result.current.onBoundary(watch);
      result.current.setVoice(EDGE_VOICE);
      result.current.play(["第一句。", "第二句。"], 0);
    });

    act(() => boundaryRef.current?.({ unit: 0, charIndex: 2, charLength: 1 }));

    // The page follower needs words at sentence-level granularity too; only
    // React state is gated by the wash.
    expect(watch).toHaveBeenCalledWith({ unit: 0, charIndex: 2, charLength: 1 });
    expect(result.current.boundary).toBeNull();
  });

  it("clears the failure the player is showing", () => {
    const { result } = renderHook(() => useTts());

    // The Edge engine answers, so the voice picks it and the engine is built
    // on the first play — the mock keeps its callbacks from there.
    act(() => result.current.setVoice(EDGE_VOICE));
    act(() => result.current.play(["你好，世界。"], 0));
    act(() => failRef.current?.(REFUSED));
    expect(result.current.error).toBe(REFUSED);

    act(() => result.current.stop());

    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});
