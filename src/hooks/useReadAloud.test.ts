import { act, renderHook } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoliateHandle } from "@/features/reader/FoliateBookView";
import type { SpeechUnit } from "@/features/reader/speech";
import type { Tts } from "@/features/reader/tts";
import { useReadAloud, type ReadAloudOptions } from "@/hooks/useReadAloud";
import { useSpeechSession } from "@/stores/speech";

/**
 * The voice list is the one thing here that reaches outside the hook — it
 * subscribes to `speechSynthesis` and asks the Edge service for a catalogue —
 * so it is replaced rather than exercised. Everything else is the real thing,
 * including `speechUnits` and `washSpan`: a stub queue would make these tests
 * agree with themselves about offsets the page actually paints.
 */
vi.mock("@/features/reader/tts", () => {
  const voices: never[] = [];
  return { useSpeechVoices: () => ({ voices, edgeError: null }) };
});

/** Three units over two paragraphs: 第一句。 第二句。 | 第三句。 */
const PARAGRAPHS = ["第一句。第二句。", "第三句。"];
const QUEUE = ["第一句。", "第二句。", "第三句。"];

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
    ...overrides,
  };
}

/**
 * The foliate side of the bridge. Only the members this layer reaches for are
 * here; a finished section calls back into the reader, so the stub answers with
 * an empty queue unless a case says otherwise.
 */
function fakeHandle(overrides: Partial<Record<string, unknown>> = {}): FoliateHandle {
  return {
    readFrom: vi.fn(() => Promise.resolve([] as SpeechUnit[])),
    readFromSelection: vi.fn(() => Promise.resolve([] as SpeechUnit[])),
    bookEnd: () => false,
    section: vi.fn(),
    clearTts: vi.fn(),
    focusUnit: vi.fn(),
    paintSpan: vi.fn(),
    ...overrides,
  } as unknown as FoliateHandle;
}

/**
 * `reveal` moves the page with `Element.scrollIntoView`, which jsdom does not
 * implement at all. The stub doubles as the assertion surface: which node the
 * reader was sent to, and how it was asked to sit there.
 */
const scrollCalls: { node: Element; options?: ScrollIntoViewOptions }[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element, options?: boolean | object) {
    scrollCalls.push({
      node: this,
      options: typeof options === "object" ? (options as ScrollIntoViewOptions) : undefined,
    });
  };
});

function setup(overrides: Partial<ReadAloudOptions> = {}) {
  const tts = overrides.tts ?? fakeTts();
  const options: ReadAloudOptions = {
    tts,
    useFoliate: false,
    isPdf: false,
    paragraphs: PARAGRAPHS,
    scrollRef: { current: null },
    foliateRef: { current: null },
    storedVoice: null,
    rate: 1,
    granularity: "sentence",
    updateSettings: vi.fn(),
    onChapterEnd: vi.fn(),
    ...overrides,
  };
  const view = renderHook((props: ReadAloudOptions) => useReadAloud(props), {
    initialProps: options,
  });
  return { ...view, tts, options };
}

describe("useReadAloud", () => {
  // The session is module state and outlives a single render, which is the
  // point of it — but not across tests, where a leftover queue would answer the
  // next case before it publishes one of its own.
  beforeEach(() => {
    useSpeechSession.setState({
      units: [],
      controls: null,
      origin: "book",
      activeId: null,
    });
    scrollCalls.length = 0;
  });

  /**
   * The one direction the follow effect does not cover: the page went away
   * while the voice walked on, and has to be told where it went. `reveal` is
   * what the shell's player asks across the transport in that case.
   */
  it("brings the paragraph being read back into the middle of the page", () => {
    const scroller = document.createElement("div");
    for (const index of [0, 1]) {
      const paragraph = document.createElement("p");
      paragraph.dataset.paraIdx = String(index);
      scroller.append(paragraph);
    }
    const { result } = setup({
      scrollRef: { current: scroller },
      tts: fakeTts({ status: "playing", unit: 2 }),
    });
    // Mounting scrolls too — the voice is already on, so the follow effect
    // nudges the paragraph into view. That is the other direction, and it is
    // not what this is about.
    scrollCalls.length = 0;

    act(() => result.current.reveal());

    // 第三句。 is the second paragraph, and it is centred — a jump back to a
    // place, not the follow effect's nudge that only moves at the edge.
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0]!.node).toBe(scroller.children[1]);
    expect(scrollCalls[0]!.options).toEqual({ block: "center" });
  });

  it("has nothing to bring into view before the voice has started", () => {
    const scroller = document.createElement("div");
    const { result } = setup({ scrollRef: { current: scroller } });

    act(() => result.current.reveal());

    expect(scrollCalls).toHaveLength(0);
  });

  /**
   * The case the published copy of the queue exists for: this page mounted
   * *after* the voice started, so the section's blocks — which `focusUnit`
   * resolves the unit's block through — were never collected here, and the
   * queue being walked belongs to a page that is gone.
   */
  it("re-collects a Kindle section's blocks before going back to the unit", async () => {
    const units: SpeechUnit[] = [
      { text: "A", source: 0, start: 0, end: 1 },
      { text: "B", source: 1, start: 0, end: 1 },
    ];
    const focusUnit = vi.fn();
    const readFrom = vi.fn(() => Promise.resolve(units));
    useSpeechSession.setState({ units });
    const { result } = setup({
      useFoliate: true,
      foliateRef: { current: fakeHandle({ readFrom, focusUnit }) },
      tts: fakeTts({ status: "playing", unit: 1 }),
    });

    await act(async () => result.current.reveal());

    expect(readFrom).toHaveBeenCalledTimes(1);
    // `source` is the section's block index, which is what survives the trip
    // through the store — the offsets come from the same block either way.
    expect(focusUnit).toHaveBeenCalledWith(units[1], { start: 0, end: 1 });
  });

  it("keeps the published queue when a fresh page has none of its own", () => {
    const units: SpeechUnit[] = [{ text: "A", source: 0, start: 0, end: 1 }];
    useSpeechSession.setState({ units });

    setup({ useFoliate: true, foliateRef: { current: fakeHandle() } });

    // The Kindle page publishes nothing until it has collected its blocks;
    // overwriting here would blank the clock the bar is drawing from.
    expect(useSpeechSession.getState().units).toEqual(units);
  });

  it("starts the chapter from the top when nothing is on screen", () => {
    const { result, tts, options } = setup();

    act(() => result.current.toggle());

    // `unitAtView` answers zero with no scrollport to hit-test, which is the
    // PDF case too: its chapter *is* the page on screen.
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd);
  });

  it("hands pause and resume straight to the engine", () => {
    const playing = setup({ tts: fakeTts({ status: "playing", unit: 0 }) });
    act(() => playing.result.current.toggle());
    expect(playing.tts.pause).toHaveBeenCalledTimes(1);
    expect(playing.tts.play).not.toHaveBeenCalled();

    const paused = setup({ tts: fakeTts({ status: "paused", unit: 0 }) });
    act(() => paused.result.current.toggle());
    expect(paused.tts.resume).toHaveBeenCalledTimes(1);
    expect(paused.tts.play).not.toHaveBeenCalled();
  });

  /** A rate costs nothing and buys nothing from a restart: the engine stretches
   *  on its way to the speaker, so the next utterance simply carries it — while
   *  a restart would drop every clip already decoded, which is the stall this
   *  whole design exists to remove. */
  it("hands a new rate to the engine and waits for the next utterance", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 1 }),
    });

    act(() => result.current.applySettings({ rate: 1.5 }));

    expect(options.updateSettings).toHaveBeenCalledWith({ speechRate: 1.5 });
    expect(tts.setRate).toHaveBeenCalledWith(1.5);
    expect(tts.play).not.toHaveBeenCalled();
  });

  /**
   * A voice does need a fresh utterance: both engines commit the clip they are
   * speaking. While the voice is on hold the restart is deferred to the resume
   * instead — restarting now would speak in the new voice to nobody.
   */
  it("defers a settings change made while the voice is on hold", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "paused", unit: 1 }),
      storedVoice: "edge:zh-CN-YunjianNeural",
    });

    act(() => result.current.applySettings({ voice: "edge:zh-CN-XiaoxiaoNeural" }));

    expect(options.updateSettings).toHaveBeenCalledWith({
      speechVoiceURI: "edge:zh-CN-XiaoxiaoNeural",
    });
    expect(tts.setVoice).toHaveBeenCalledWith("edge:zh-CN-XiaoxiaoNeural");
    expect(tts.play).not.toHaveBeenCalled();

    act(() => result.current.toggle());

    expect(tts.resume).not.toHaveBeenCalled();
    // Restarted, not resumed: from the unit it holds, and with the head trim
    // that keeps it there rather than at the top of the sentence.
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 1, options.onChapterEnd, 0);
  });

  it("restarts the held utterance from the position the engine reported", () => {
    const boundaryAt = vi.fn(() => ({ unit: 1, charIndex: 3, charLength: 2 }));
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 1, boundaryAt }),
      storedVoice: "edge:zh-CN-YunjianNeural",
    });

    act(() => result.current.applySettings({ voice: "edge:zh-CN-XiaoxiaoNeural" }));

    expect(tts.play).toHaveBeenCalledWith(QUEUE, 1, options.onChapterEnd, 3);
  });

  it("ends the session instead of restarting it when the voice crosses engines", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 0 }),
      storedVoice: "edge:zh-CN-YunjianNeural",
    });

    act(() => result.current.applySettings({ voice: "com.apple.voice.zh" }));

    expect(options.updateSettings).toHaveBeenCalledWith({ speechVoiceURI: "com.apple.voice.zh" });
    expect(tts.setVoice).toHaveBeenCalledWith("com.apple.voice.zh");
    // `useTts` already tore the queue down; a restart would speak into a
    // session the reader just replaced.
    expect(tts.play).not.toHaveBeenCalled();
  });

  it("restarts when the new voice stays on the same engine", () => {
    const { result, tts, options } = setup({
      tts: fakeTts({ status: "playing", unit: 0 }),
      storedVoice: "com.apple.voice.a",
    });

    act(() => result.current.applySettings({ voice: "com.apple.voice.b" }));

    expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd, 0);
  });

  it("clamps the scrubber to the queue and drops the head trim", () => {
    const { result, tts, options } = setup({ tts: fakeTts({ status: "playing", unit: 0 }) });

    act(() => result.current.seek(99));
    expect(tts.play).toHaveBeenLastCalledWith(QUEUE, 2, options.onChapterEnd);

    act(() => result.current.seek(-5));
    expect(tts.play).toHaveBeenLastCalledWith(QUEUE, 0, options.onChapterEnd);
  });

  it("steps one utterance at a time", () => {
    const { result, tts, options } = setup({ tts: fakeTts({ status: "playing", unit: 2 }) });

    act(() => result.current.step(-1));
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 1, options.onChapterEnd);

    act(() => result.current.step(1));
    expect(tts.play).toHaveBeenLastCalledWith(QUEUE, 2, options.onChapterEnd);
  });

  it("skips to the next paragraph's first unit, and back to the previous one's", () => {
    const forward = setup({ tts: fakeTts({ status: "playing", unit: 0 }) });
    act(() => forward.result.current.skip(1));
    // Unit 1 is still 第一句's paragraph; 第三句。 is the next block.
    expect(forward.tts.play).toHaveBeenCalledWith(QUEUE, 2, forward.options.onChapterEnd);

    const back = setup({ tts: fakeTts({ status: "playing", unit: 2 }) });
    act(() => back.result.current.skip(-1));
    // Rewinds to this block's own first unit, then to the start of the one
    // before it — the usual "previous track" behaviour.
    expect(back.tts.play).toHaveBeenCalledWith(QUEUE, 0, back.options.onChapterEnd);
  });

  it("has nowhere to skip back to from the first paragraph", () => {
    const { result, tts } = setup({ tts: fakeTts({ status: "playing", unit: 1 }) });
    act(() => result.current.skip(-1));
    expect(tts.play).not.toHaveBeenCalled();
  });

  it("washes the sentence, the reported word, or the whole block", () => {
    const sentence = setup({ tts: fakeTts({ status: "playing", unit: 1 }) });
    // Sentence level: the whole utterance, in its block's coordinates.
    expect(sentence.result.current.span).toEqual({ source: 0, start: 4, end: 8 });

    // Word level paints nothing until the engine says where the voice is: a
    // sentence-wide wash that snaps down onto a word reads as a flash.
    const waiting = setup({
      granularity: "word",
      tts: fakeTts({ status: "playing", unit: 1 }),
    });
    expect(waiting.result.current.span).toBeNull();

    const word = setup({
      granularity: "word",
      tts: fakeTts({
        status: "playing",
        unit: 1,
        boundary: { unit: 1, charIndex: 2, charLength: 2 },
      }),
    });
    expect(word.result.current.span).toEqual({ source: 0, start: 6, end: 8 });

    // Paragraph level: the whole block the utterance sits in.
    const block = setup({
      granularity: "paragraph",
      tts: fakeTts({ status: "playing", unit: 1 }),
    });
    expect(block.result.current.span).toEqual({ source: 0, start: 0, end: 8 });
  });

  it("expresses the same wash as a needle into a PDF page", () => {
    const { result } = setup({
      isPdf: true,
      tts: fakeTts({
        status: "playing",
        unit: 1,
        boundary: { unit: 1, charIndex: 0, charLength: 0 },
      }),
    });

    // The page anchors on the sentence, so the offsets restart at its own zero.
    expect(result.current.pdfWash).toEqual({ text: "第二句。", from: 0, to: 4 });
  });

  it("keeps the engine in step with the stored rate and the resolved voice", () => {
    const { tts } = setup({ rate: 1.25 });

    expect(tts.setRate).toHaveBeenCalledWith(1.25);
    // No stored voice and no catalogue to resolve one from: `null` is "the
    // engine's own default", not a missing value.
    expect(tts.setVoice).toHaveBeenCalledWith(null);
  });

  it("lends its transport to the shell's player, and takes it back on the way out", () => {
    const { tts, options, unmount } = setup({ tts: fakeTts({ status: "playing", unit: 1 }) });

    // What the bar and the card drive: they live above the routes, so the only
    // way they can reach this reader is through the store.
    expect(useSpeechSession.getState().units.map((unit) => unit.text)).toEqual(QUEUE);
    const controls = useSpeechSession.getState().controls;
    expect(controls).not.toBeNull();

    // One utterance along — and through the wrapper, which has to reach *this*
    // render's closure rather than the one it happened to be published with.
    act(() => controls!.step(1));
    expect(tts.play).toHaveBeenCalledWith(QUEUE, 2, options.onChapterEnd);

    // Gone means "the voice plays on alone": the player behind the bar still
    // drives the engine, it just cannot roll into the next chapter.
    unmount();
    expect(useSpeechSession.getState().controls).toBeNull();
  });

  it("cuts the speed-reading tokens only while the overlay is open", () => {
    const { result } = setup();

    // One shared empty array while closed, so the overlay's run-reset effect
    // never reads a closed overlay as a new chapter.
    const closed = result.current.rsvpWords;
    expect(closed).toEqual([]);

    act(() => result.current.toggleRsvp());
    expect(result.current.rsvpOpen).toBe(true);
    // What the cut produces is `rsvpTokens`'s business; this layer's is *when*
    // it happens at all.
    expect(result.current.rsvpWords).not.toBe(closed);
    expect(result.current.rsvpWords.length).toBeGreaterThan(0);

    act(() => result.current.closeRsvp());
    expect(result.current.rsvpOpen).toBe(false);
    expect(result.current.rsvpWords).toBe(closed);
  });

  it("asks the reader for the section's blocks on the Kindle path", async () => {
    const units: SpeechUnit[] = [
      { text: "A", source: 0, start: 0, end: 1 },
      { text: "B", source: 1, start: 0, end: 1 },
    ];
    const readFrom = vi.fn(() => Promise.resolve(units));
    const { result, tts, options } = setup({
      useFoliate: true,
      foliateRef: { current: fakeHandle({ readFrom }) },
    });

    await act(async () => result.current.toggle());

    expect(readFrom).toHaveBeenCalledTimes(1);
    // The roll-over, not `onChapterEnd`: a finished section hands the voice to
    // the next one rather than walking a chapter that foliate does not have.
    const [, , onFinish] = (tts.play as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(onFinish).not.toBe(options.onChapterEnd);
    expect(tts.play).toHaveBeenCalledWith(["A", "B"], 0, onFinish);
    expect(result.current.units).toEqual(units);
  });

  it("stops the voice when the section it asked for came back empty", async () => {
    const { result, tts } = setup({
      useFoliate: true,
      foliateRef: { current: fakeHandle() },
    });

    await act(async () => result.current.toggle());

    expect(tts.stop).toHaveBeenCalledTimes(1);
    expect(tts.play).not.toHaveBeenCalled();
  });

  it("restarts the prose queue from its first unit for a chapter roll-over", () => {
    const { result, tts, options } = setup();

    act(() => result.current.playFromStart());

    expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd);
  });

  /**
   * `playFromStart` goes into the reader's position effect, and a fresh
   * identity there re-applies the pending scroll — which yanks the page back to
   * the top of the chapter. The reader builds its options object anew on every
   * render, so this is the real case, not a synthetic one.
   */
  it("keeps playFromStart stable across renders of an unchanged chapter", () => {
    const { result, rerender, options } = setup();
    const first = result.current.playFromStart;

    rerender({ ...options });

    expect(result.current.playFromStart).toBe(first);
  });

  /** Stable is not frozen: it closes over the queue and the roll-over, so a
   *  chapter change — or a new roll-over — has to produce a new one. */
  it("rebuilds playFromStart when its continuation changes", () => {
    const { result, rerender, options } = setup();
    const first = result.current.playFromStart;

    rerender({ ...options, onChapterEnd: vi.fn() });

    expect(result.current.playFromStart).not.toBe(first);
  });

  /**
   * An answer and a book share one engine, so they share one `unit` index.
   * These three pin the reason the session carries an origin at all: without
   * it, the reader reads the answer's third sentence as the book's third
   * sentence and paints it on the page.
   */
  describe("while an answer owns the voice", () => {
    const ANSWER_UNITS: SpeechUnit[] = [{ text: "导读第一句。", source: 0, start: 0, end: 6 }];
    const startAnswer = () =>
      useSpeechSession.getState().startAi({
        id: "guide:b1",
        title: "AI 导读",
        chapter: "全书",
        units: ANSWER_UNITS,
      });

    it("does not follow the voice into the book or wash a sentence", () => {
      const scroller = document.createElement("div");
      for (const index of [0, 1]) {
        const paragraph = document.createElement("p");
        paragraph.dataset.paraIdx = String(index);
        scroller.append(paragraph);
      }
      startAnswer();
      const { result } = setup({
        isPdf: true,
        scrollRef: { current: scroller },
        tts: fakeTts({ status: "playing", unit: 0 }),
      });

      expect(result.current.span).toBeNull();
      expect(result.current.pdfWash).toBeNull();
      expect(scrollCalls).toHaveLength(0);
    });

    it("keeps the answer's queue and lends no transport", () => {
      startAnswer();
      setup({ tts: fakeTts({ status: "playing", unit: 0 }) });

      expect(useSpeechSession.getState().units).toEqual(ANSWER_UNITS);
      expect(useSpeechSession.getState().controls).toBeNull();
    });

    it("takes the session back when the reader starts the book", () => {
      startAnswer();
      const { result, tts, options } = setup();

      act(() => result.current.toggle());

      expect(useSpeechSession.getState().origin).toBe("book");
      expect(useSpeechSession.getState().activeId).toBeNull();
      expect(tts.play).toHaveBeenCalledWith(QUEUE, 0, options.onChapterEnd);
    });
  });
});
