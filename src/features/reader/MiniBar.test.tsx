import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { BarFace, MiniBarState, MiniBarVoices } from "@/lib/ipc";

import { MiniBar } from "./MiniBar";

/**
 * The floating bar, driven the way the shell drives it.
 *
 * Everything this component knows arrives as an event and everything it does
 * leaves as one, so the test is the same conversation: hand it a payload, click
 * a control, and check what went back. `@/lib/ipc` is the whole boundary, and
 * it is mocked for exactly that reason — inside the real one, each helper
 * resolves to nothing at all outside the Tauri shell, which is what keeps the
 * bar out of the web build.
 *
 * The card is the interesting half of this file. It is the *app's* card in a
 * second window, so every control on it has to leave as a value the main window
 * can act on, and the two facts the bar is not allowed to work out for itself —
 * the window's frame and the catalogue's contents — have to arrive rather than
 * be reached for.
 */
const mocks = vi.hoisted(() => {
  const box = {
    deliver: null as ((state: unknown) => void) | null,
    deliverVoices: null as ((catalogue: unknown) => void) | null,
  };
  return {
    box,
    onMiniBarState: (handler: (state: unknown) => void) => {
      box.deliver = handler;
      return Promise.resolve(undefined);
    },
    onMiniBarVoices: (handler: (catalogue: unknown) => void) => {
      box.deliverVoices = handler;
      return Promise.resolve(undefined);
    },
    askMiniBarState: vi.fn(() => Promise.resolve()),
    // Typed, or `mock.calls` is a list of empty tuples and the assertions below
    // cannot read what was forwarded.
    sendSpeechControl: vi.fn<(control: unknown) => Promise<void>>(() => Promise.resolve()),
    miniBarExpand: vi.fn<(face: BarFace, minimal: boolean) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    miniBarDismiss: vi.fn(() => Promise.resolve()),
    // The capsule moves its own window, which is a different window API from
    // everything above; stubbed so a press can be watched without a shell.
    startDragging: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@/lib/ipc", () => ({
  // The bar only exists in the desktop app, and the drag guard reads this: with
  // it false a press would be judged "not our window" and do nothing.
  isDesktopRuntime: true,
  onMiniBarState: mocks.onMiniBarState,
  onMiniBarVoices: mocks.onMiniBarVoices,
  askMiniBarState: mocks.askMiniBarState,
  sendSpeechControl: mocks.sendSpeechControl,
  ipc: { miniBarExpand: mocks.miniBarExpand, miniBarDismiss: mocks.miniBarDismiss },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: mocks.startDragging }),
}));

// jsdom has neither layout nor the card's own scrolling.
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

/** A payload for a bar mid-sentence, with every field a caller can change. */
function barState(overrides: Partial<MiniBarState> = {}): MiniBarState {
  return {
    live: true,
    playing: true,
    loading: false,
    title: "追风筝的人",
    chapter: "第三章",
    coverUrl: null,
    elapsed: "1:05",
    remaining: "3:07",
    percent: 26,
    error: null,
    theme: "dark",
    units: [
      { text: "我成为今天的我，是在1975年某个阴云密布的寒冷冬日。", source: 0, start: 0, end: 26 },
      { text: "那年我十二岁。", source: 0, start: 26, end: 33 },
      { text: "我清楚地记得当时自己趴在一堵坍塌的泥墙后面。", source: 1, start: 0, end: 22 },
    ],
    index: 1,
    spoken: 33,
    total: 81,
    rate: 1,
    voice: "edge:zh-CN-YunjianNeural",
    bookLanguage: "zh-CN",
    sleep: null,
    minimal: false,
    ...overrides,
  };
}

const CATALOGUE: MiniBarVoices = {
  voices: [
    {
      uri: "edge:zh-CN-YunjianNeural",
      name: "Yunjian",
      lang: "zh-CN",
      engine: "edge",
      categories: "Novel",
      gender: "male",
    },
    {
      uri: "com.apple.voice.compact.zh-CN.Tingting",
      name: "Tingting",
      lang: "zh-CN",
      engine: "system",
      categories: "",
      gender: null,
    },
  ],
  edgeError: null,
};

/** Renders the bar, then hands it `payload` — what the shell's push does. */
function show(payload: MiniBarState = barState()) {
  render(<MiniBar />);
  act(() => mocks.box.deliver?.(payload));
  return payload;
}

/** The names and actions this bar sent back, in order. */
const sent = () => mocks.sendSpeechControl.mock.calls.map(([control]) => control);

/** Both ways into the player: the cover first in the DOM, then the title that
 *  fills the middle of the capsule. */
const opens = () => screen.getAllByRole("button", { name: "展开朗读播放器" });

/** The card's second child, which is the pane the sentence list lives in.
 *  Structural on purpose: the pane is not a landmark and carries no role, and
 *  the one rule it owns is asserted below. */
const pane = () => document.querySelector("[data-tts-card]")?.children[1];

/** Waits for the fold to finish drawing. Folding is a moment rather than a
 *  keystroke — the card fades at full height and the capsule only comes back
 *  once it has gone — so anything that folds and then looks has to wait for it.
 *
 *  Both halves of the condition matter: an exiting capsule is still in the DOM
 *  until its own fade is over, so "a capsule is somewhere in the document" is
 *  true from the moment the card opens. The card being *gone* is the honest
 *  signal, and the capsule being back is what makes it usable again. */
const folded = () =>
  waitFor(() => {
    expect(document.querySelector("[data-tts-card]")).toBeNull();
    expect(document.querySelector("[data-tts-pill]")).not.toBeNull();
  });

/** A press on `el`, and a pointer that then travels far enough to be a drag. */
const press = (el: Element) => fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
const travel = (by = 40) =>
  fireEvent.pointerMove(window, { clientX: 100 + by, clientY: 100 + by / 2 });

describe("MiniBar", () => {
  // `vi.restoreAllMocks` only undoes `vi.spyOn`; a plain `vi.fn` keeps its call
  // history across tests, and several of these assert on exactly how many times
  // a control was forwarded.
  beforeEach(() => vi.clearAllMocks());

  it("asks for a payload on mount instead of waiting for the next sentence", () => {
    show();
    expect(mocks.askMiniBarState).toHaveBeenCalled();
  });

  it("draws what it was told", () => {
    show();

    expect(screen.getByText(/追风筝的人/)).toBeInTheDocument();
    expect(screen.getByText(/第三章/)).toBeInTheDocument();
    expect(screen.getByText("1:05 · -3:07")).toBeInTheDocument();
    // The capsule is the same object the in-app pill is, so the anchor the
    // pill's own spec walks is here too.
    expect(document.querySelector("[data-tts-pill]")).not.toBeNull();
  });

  it("draws nothing at all once the session has ended", () => {
    show(barState({ live: false }));

    expect(screen.queryByRole("button", { name: "收起悬浮条" })).not.toBeInTheDocument();
    expect(screen.queryByText(/追风筝的人/)).not.toBeInTheDocument();
  });

  it("forwards each transport control as the name the tray already uses", async () => {
    const user = userEvent.setup();
    show();

    await user.click(screen.getByRole("button", { name: "上一句" }));
    await user.click(screen.getByRole("button", { name: "暂停" }));
    await user.click(screen.getByRole("button", { name: "下一句" }));
    await user.click(screen.getByRole("button", { name: "停止朗读" }));

    expect(sent()).toEqual(["prev", "toggle", "next", "stop"]);
  });

  it("goes back to the text from its own book button, and only from there", async () => {
    const user = userEvent.setup();
    show();

    await user.click(screen.getByRole("button", { name: "回到阅读" }));

    // The cover used to be the second way back. It is the way *into the player*
    // now, so the book is the only thing left that asks the main window to come
    // back up — which is the distinction a reader is meant to feel: the card is
    // this window, the book is the app.
    expect(sent()).toEqual(["focus"]);
  });

  it("opens the player in its own window, from the cover and from the title", async () => {
    const user = userEvent.setup();
    show();

    await user.click(opens()[0]!);
    expect(screen.getByRole("button", { name: "收起播放器" })).toBeInTheDocument();
    expect(document.querySelector("[data-tts-card]")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "收起播放器" }));
    await folded();

    await user.click(opens()[1]!);
    expect(document.querySelector("[data-tts-card]")).not.toBeNull();

    // Nothing was asked of the main window: the app is not what opened, and
    // this is the whole point of the card having two homes.
    expect(sent()).toEqual([]);
  });

  it("keeps the pane growing for the voice picker, which scrolls inside it", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);

    // The pane is the sentence list's room, and it takes it while that list is
    // the thing on screen.
    expect(pane()?.classList.contains("flex-1")).toBe(true);

    await user.click(screen.getByRole("button", { name: /语音$/ }));

    // …and it keeps taking it for the picker, which now lives *in* the pane
    // rather than below the transport. The picker used to stand the pane down
    // and sit under the transport instead, which cost the transport its place:
    // opening the list sent the play button a panel's height up the card, in a
    // window whose height is the card's. The pane's own height is what the list
    // scrolls in, so both grow — the list is the thing that gives.
    expect(pane()?.classList.contains("flex-1")).toBe(true);
    expect(pane()?.querySelector(".overflow-y-auto")).not.toBeNull();
  });

  it("has the way back on screen in the same frame a drill-down opens", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);

    // Synchronous on purpose, like the fold assertion above: what is being
    // pinned down is the *first* instant. `IconSwap` used to hold the outgoing
    // cover for its whole exit before the arrow was mounted at all — measured
    // in the card, 180ms of cover after 语速 was already open, and 200ms of
    // arrow after coming back — and the one control a reader is reaching for
    // must not arrive late. `user.click` would wait out the animation and let
    // the bug through.
    fireEvent.click(screen.getByRole("button", { name: /语速/ }));
    expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
  });

  it("tells the window which face it is drawing", async () => {
    const user = userEvent.setup();
    show();

    await user.click(opens()[0]!);
    await user.click(screen.getByRole("button", { name: "收起播放器" }));
    await folded();

    // The frame is the backend's to work out — a webview cannot see it — so the
    // only thing said about it is which face is up. The names are the card's
    // own, with the capsule in front, so nothing on either side translates.
    expect(mocks.miniBarExpand.mock.calls).toEqual([
      ["capsule", false],
      ["main", false],
      ["capsule", false],
    ]);
  });

  it("holds the frame open until the card has finished folding", async () => {
    show();
    fireEvent.click(opens()[0]!);
    // The capsule's own exit has to settle first, or the assertion below would
    // find the capsule that is still leaving rather than the one coming back.
    await waitFor(() => {
      expect(document.querySelector("[data-tts-pill]")).toBeNull();
    });
    mocks.miniBarExpand.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "收起播放器" }));

    // Synchronous on purpose: not one frame has been drawn since the click, so
    // this is the fold's first moment. The panel is fading at its own height,
    // the capsule is not back, and the window has not been asked to shrink out
    // from under it — which is the whole reason the frame waits.
    expect(document.querySelector("[data-tts-card]")).not.toBeNull();
    expect(document.querySelector("[data-tts-pill]")).toBeNull();
    expect(mocks.miniBarExpand).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.miniBarExpand).toHaveBeenLastCalledWith("capsule", false);
    });
  });

  it("names the drill-down it is on, so the window can close around it", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);

    await user.click(screen.getByRole("button", { name: /语速/ }));
    // `find`, not `get`: the header swaps its glyph through `AnimatePresence`,
    // so the way back is a frame behind the click that opened the drill-down.
    await user.click(await screen.findByRole("button", { name: "返回" }));
    await user.click(await screen.findByRole("button", { name: /定时关闭/ }));

    // Each view is a different height — 语速 is one row of chips, 定时关闭 two —
    // and a window still sized for the sentence list is the empty half of the
    // card. Reporting the view is the whole of what this side owes the backend.
    expect(mocks.miniBarExpand.mock.calls).toEqual([
      ["capsule", false],
      ["main", false],
      ["speed", false],
      ["main", false],
      ["timer", false],
    ]);
  });

  it("asks for the short card when the reader chose the minimal player", () => {
    show(barState({ minimal: true }));

    // Two calls, and the first one is the mount: a bar is built before the
    // payload it would have drawn arrives, so it states the capsule's size
    // first and corrects itself the moment it is told otherwise. The capsule is
    // the capsule either way — 简约 is a height for the *card*, and there is no
    // card up.
    expect(mocks.miniBarExpand.mock.calls).toEqual([
      ["capsule", false],
      ["capsule", true],
    ]);
  });

  it("forgets the view when the card is folded away", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);
    await user.click(screen.getByRole("button", { name: /语速/ }));

    await user.click(screen.getByRole("button", { name: "收起播放器" }));
    await folded();
    await user.click(opens()[0]!);

    // Not a cosmetic reset: the card is unmounted while it is folded, so a view
    // left behind here would have the window sized for a panel that is not on
    // screen for the one frame before the card reported its own.
    expect(mocks.miniBarExpand.mock.calls).toEqual([
      ["capsule", false],
      ["main", false],
      ["speed", false],
      ["capsule", false],
      ["main", false],
    ]);
  });

  it("folds the card again when the session ends", async () => {
    const user = userEvent.setup();
    const payload = show();
    await user.click(opens()[0]!);
    expect(document.querySelector("[data-tts-card]")).not.toBeNull();

    act(() => mocks.box.deliver?.({ ...payload, live: false }));
    act(() => mocks.box.deliver?.(payload));

    // The bar comes back as a capsule, not as the card the last session left
    // open: a voice starting is not a reason to cover the screen with a player.
    expect(document.querySelector("[data-tts-pill]")).not.toBeNull();
    expect(document.querySelector("[data-tts-card]")).toBeNull();
  });

  it("lists the queue and jumps to the sentence that is clicked", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);

    // The queue crossed the process in the payload, so the card lists the same
    // rows the reader would see in the app.
    await user.click(screen.getByText("我清楚地记得当时自己趴在一堵坍塌的泥墙后面。"));

    expect(sent()).toEqual([{ kind: "seek", index: 2 }]);
  });

  it("takes a chip's value with it, not just its name", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);

    await user.click(screen.getByRole("button", { name: /语速/ }));
    await user.click(screen.getByRole("button", { name: "1.25×" }));

    // A menu entry cannot say this; the card's objects are why the bar's half of
    // the control contract is not just more names.
    expect(sent()).toEqual([{ kind: "rate", value: 1.25 }]);
  });

  it("arms the sleep timer from the card, in the app's own vocabulary", async () => {
    const user = userEvent.setup();
    show();
    await user.click(opens()[0]!);

    await user.click(screen.getByRole("button", { name: /定时关闭/ }));
    await user.click(screen.getByRole("button", { name: "15 分钟" }));

    // The choice crosses as the value `useSleepTimer` takes, so the main window
    // reads the timer's state straight off the payload rather than translating.
    expect(sent()).toEqual([{ kind: "sleep", choice: 15 }]);
  });

  it("picks a voice out of the catalogue it was handed", async () => {
    const user = userEvent.setup();
    show();
    act(() => mocks.box.deliverVoices?.(CATALOGUE));
    await user.click(opens()[0]!);

    await user.click(screen.getByRole("button", { name: /在线语音/ }));
    await user.click(screen.getByRole("button", { name: /Tingting/ }));

    // The online catalogue lands asynchronously after the state does, which is
    // why the two travel on separate events: the picker is empty until it
    // arrives, and the bar cannot fetch it for itself.
    expect(sent()).toEqual([{ kind: "voice", uri: "com.apple.voice.compact.zh-CN.Tingting" }]);
  });

  it("folds itself away from the end, without touching the session", async () => {
    const user = userEvent.setup();
    show();

    await user.click(screen.getByRole("button", { name: "收起悬浮条" }));

    expect(mocks.miniBarDismiss).toHaveBeenCalled();
    expect(mocks.sendSpeechControl).not.toHaveBeenCalled();
  });

  it("moves the window from the capsule and from its own title", () => {
    show();

    press(document.querySelector("[data-tts-pill]")!);
    travel();
    press(screen.getByText(/追风筝的人/));
    travel();

    // Two presses, two drags: the whole capsule is the handle, the same way the
    // title bar of the main window is — this is a window with no frame, and the
    // title is a control *and* part of that handle.
    expect(mocks.startDragging).toHaveBeenCalledTimes(2);
  });

  it("leaves a press that does not travel to the click underneath it", () => {
    show();

    // Under the slop, then released: this is a click on the title, not a drag —
    // which is what lets one box be both the handle and the way in.
    press(screen.getByText(/追风筝的人/));
    travel(1);
    fireEvent.pointerUp(window);

    expect(mocks.startDragging).not.toHaveBeenCalled();
  });

  it("keeps the buttons out of the drag, so their clicks still land", () => {
    show();

    press(screen.getByRole("button", { name: "下一句" }));
    travel();

    expect(mocks.startDragging).not.toHaveBeenCalled();
  });

  it("says a paused voice is paused", () => {
    show(barState({ playing: false }));

    expect(screen.getByText("已暂停 · 1:05 · -3:07")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });

  it("puts the failure on the second line in place of the clock", () => {
    show(barState({ error: "在线语音暂时连不上" }));

    expect(screen.getByText("在线语音暂时连不上")).toBeInTheDocument();
    expect(screen.queryByText("1:05 · -3:07")).not.toBeInTheDocument();
  });

  it("shows the loading bars while the service is synthesising", () => {
    show(barState({ loading: true }));

    expect(screen.getByLabelText("正在加载语音")).toBeInTheDocument();
  });

  it("wears the appearance the payload carries", () => {
    show(barState({ theme: "light" }));

    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
