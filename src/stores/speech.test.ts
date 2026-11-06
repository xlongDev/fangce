import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpeechUnit } from "@/features/reader/speech";

import { useSpeechSession } from "./speech";

const BOOK_UNITS: SpeechUnit[] = [{ text: "正文第一句。", source: 0, start: 0, end: 6 }];
const ANSWER_UNITS: SpeechUnit[] = [{ text: "导读第一句。", source: 0, start: 0, end: 6 }];

describe("useSpeechSession", () => {
  beforeEach(() =>
    useSpeechSession.setState({
      open: false,
      openAt: "main",
      origin: "book",
      activeId: null,
      units: [],
      bookId: null,
      coverUrl: null,
      controls: null,
    }),
  );

  it("opens where it is told, and forgets it on the next plain open", () => {
    useSpeechSession.getState().setOpen(true, "speed");
    expect(useSpeechSession.getState()).toMatchObject({ open: true, openAt: "speed" });

    // The capsule opens the card without naming a view, so it has to land on
    // the transport — not on wherever the reader's 倍速 button last left it.
    // Otherwise one shortcut quietly becomes where every reader starts.
    useSpeechSession.getState().setOpen(false);
    useSpeechSession.getState().setOpen(true);
    expect(useSpeechSession.getState().openAt).toBe("main");
  });

  it("puts the transport back when it is closed", () => {
    useSpeechSession.getState().setOpen(true, "voice");
    useSpeechSession.getState().setOpen(false);
    expect(useSpeechSession.getState()).toMatchObject({ open: false, openAt: "main" });
  });

  it("hands an answer the whole session, without facts that belong to a book", () => {
    const state = useSpeechSession.getState();
    state.publish({ bookId: "b1", title: "书名", chapterIdx: 3, coverUrl: "cover.png" });
    state.setControls({
      toggle: vi.fn(),
      step: vi.fn(),
      skip: vi.fn(),
      seek: vi.fn(),
      applySettings: vi.fn(),
      reveal: vi.fn(),
    });

    state.startAi({
      id: "guide:b1",
      title: "AI 导读",
      chapter: "全书",
      units: ANSWER_UNITS,
    });

    expect(useSpeechSession.getState()).toMatchObject({
      origin: "ai",
      activeId: "guide:b1",
      title: "AI 导读",
      chapter: "全书",
      units: ANSWER_UNITS,
      // 「回到阅读」 would otherwise jump to a chapter an answer has no
      // position in, and the reader's transport would scrub the book. The
      // cover stays: the answer belongs to the book on screen.
      bookId: null,
      coverUrl: "cover.png",
      chapterIdx: 0,
      bookLanguage: null,
      controls: null,
    });
  });

  it("ends only an answer's session, never a book's queue", () => {
    const state = useSpeechSession.getState();
    state.startAi({ id: "guide:b1", title: "AI 导读", chapter: "全书", units: ANSWER_UNITS });
    state.endAi();
    expect(useSpeechSession.getState()).toMatchObject({
      origin: "book",
      activeId: null,
      units: [],
    });

    state.publish({ units: BOOK_UNITS });
    state.endAi();
    // The idle-voice effect fires for a finished chapter too. It must not
    // clear the queue the reader is about to resume.
    expect(useSpeechSession.getState().units).toEqual(BOOK_UNITS);
  });
});
