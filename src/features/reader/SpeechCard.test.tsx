import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpeechCard, type SpeechCardProps } from "./SpeechCard";

// The sentence list scrolls the active row to the middle on mount, and jsdom
// implements `scrollIntoView` but not `scrollTo`. Nothing here is about it.
Element.prototype.scrollTo = () => {};

/**
 * The card opens on a view its host names, and the reader's 倍速 button is a
 * shortcut past the tiles. The card mounts fresh on every open, so the prop is
 * read once — which is the whole mechanism, and the thing a refactor of the
 * view state would quietly take away.
 */
function card(overrides: Partial<SpeechCardProps> = {}): SpeechCardProps {
  return {
    title: "追风筝的人",
    chapter: "第三章",
    coverUrl: null,
    units: [
      { source: 0, start: 0, end: 9, text: "风筝终于飞起来了。" },
      { source: 1, start: 0, end: 9, text: "他跑过空旷的广场。" },
    ],
    index: 0,
    status: "playing",
    loading: false,
    error: null,
    elapsed: "1:05",
    remaining: "3:07",
    percent: 25,
    spoken: 1,
    total: 2,
    rate: 1,
    voice: null,
    voices: [],
    bookLanguage: "zh-CN",
    edgeError: null,
    sleep: null,
    minimal: false,
    onClose: () => {},
    onToggle: () => {},
    onStep: () => {},
    onSkip: () => {},
    onSeek: () => {},
    onRate: () => {},
    onVoice: () => {},
    onSleep: () => {},
    ...overrides,
  };
}

describe("SpeechCard", () => {
  it("opens straight onto the speed view when the host asks for it", () => {
    render(<SpeechCard {...card()} initialView="speed" />);

    // The rates, not the three tiles it would otherwise take a second tap to
    // reach.
    expect(screen.getByRole("button", { name: "1.5×" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /语速/ })).toBeNull();
    // And the way back, which only a view other than the transport has.
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  });

  it("opens on the transport view by default", () => {
    render(<SpeechCard {...card()} />);

    expect(screen.getByRole("button", { name: /语速/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1.5×" })).toBeNull();
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
  });

  it("has no tiles to skip in the minimal player, so it stays on the transport", () => {
    render(<SpeechCard {...card({ minimal: true })} initialView="speed" />);

    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1.5×" })).toBeNull();
  });

  it("keeps the voice list above the transport, where the sentences are", () => {
    // The picker used to live below the transport, so opening it sent the play
    // button a panel's height up the card — and the transport is the one
    // control a reader is listening through while they pick a voice.
    const voices = [
      {
        uri: "edge-yunjian",
        name: "Yunjian",
        lang: "zh-CN",
        engine: "edge" as const,
        categories: "News",
        gender: "female" as const,
      },
      {
        uri: "edge-xiaoxiao",
        name: "Xiaoxiao",
        lang: "zh-CN",
        engine: "edge" as const,
        categories: "News",
        gender: "female" as const,
      },
    ];
    render(<SpeechCard {...card({ voices })} initialView="voice" />);

    const play = screen.getByRole("button", { name: "暂停" });
    const row = screen.getByRole("button", { name: /Yunjian/ });
    expect(row.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
