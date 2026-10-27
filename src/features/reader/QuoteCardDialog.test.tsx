import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QuoteCardDialog } from "./QuoteCardDialog";
import { useReaderSettings } from "@/stores/reader";
import type { Annotation, BookSummary } from "@/lib/bindings";

// The save panel is a shell permission, not a DOM element: the dialog asks
// through the same seam the component asks through, and both the happy path
// and the refusal are exercised through it.
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));

// The write itself: the card's bytes are the frontend's, and this is the
// command that puts them where the reader pointed.
const { cardSave } = vi.hoisted(() => ({ cardSave: vi.fn() }));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as { ipc: Record<string, unknown> };
  return {
    ...actual,
    // A getter, so one file can drive both runtimes: the desktop branch
    // (panel + command) and the browser one (download) are the same dialog.
    get isDesktopRuntime() {
      return runtime.desktop;
    },
    ipc: { ...actual.ipc, cardSave },
  };
});
const runtime = { desktop: true };

// The browser branch's own seam.
const { downloadBytes } = vi.hoisted(() => ({ downloadBytes: vi.fn() }));
vi.mock("@/lib/local/save", () => ({ downloadBytes }));

// The card is drawn on the reader's own book; there is no library in a test,
// so the hook answers with one directly. The dialog is its only consumer in
// this file's graph, so the whole module is replaced rather than spread — and
// through a ref, because the cover case needs a book that has one.
const { bookRef } = vi.hoisted(() => ({ bookRef: { current: null as BookSummary | null } }));
vi.mock("@/hooks/useReader", () => ({ useBook: () => ({ data: bookRef.current }) }));

const BOOK: BookSummary = {
  id: "book-1",
  title: "三体",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 1024,
  coverUrl: null,
  addedAt: 1,
  updatedAt: 2,
  lastReadAt: 3,
  progress: 0.37,
  location: null,
  favorite: false,
  authors: ["刘慈欣"],
  tags: [],
};

const ANNOTATION: Annotation = {
  id: "note-1",
  bookId: "book-1",
  chapterIdx: 4,
  startChar: 0,
  endChar: 18,
  text: "弱小和无知不是生存的障碍，傲慢才是。",
  cfi: null,
  color: "#ffd12e",
  style: null,
  note: null,
  createdAt: 0,
};

/** Every paint call, with the style it painted with.
 *
 *  jsdom has no 2d context; the renderer only needs its calls to land. The
 *  widths mirror the pure-layout test's map (CJK 10, Latin 6, space 3) so the
 *  same quote fits the same zone here as it does there — and the styles are
 *  kept because the paper colour *is* the claim this file makes about the
 *  surface, and `fillStyle` is set once and read by everything after it. */
interface Paint {
  op: "fillRect" | "fillText" | "fill" | "stroke" | "drawImage";
  style: string;
  alpha: number;
  args: unknown[];
}
const paints: Paint[] = [];

/** jsdom has no 2d context; the renderer only needs its calls to land. The
 *  widths mirror the pure-layout test's map (CJK 10, Latin 6, space 3) so the
 *  same quote fits the same zone here as it does there. */
const wide = (char: string) => /[\u4e00-\u9fff]/.test(char);
const measure = (text: string) => {
  let width = 0;
  for (const char of text) width += char === " " ? 3 : wide(char) ? 10 : 6;
  return { width } as TextMetrics;
};
function fakeContext(): CanvasRenderingContext2D {
  const raw: Record<string, unknown> = {
    measureText: measure,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    globalAlpha: 1,
    font: "",
    lineWidth: 1,
    textAlign: "",
    textBaseline: "",
    fillRect: vi.fn(),
    fillText: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
  };
  for (const op of ["fillRect", "fillText", "fill", "stroke", "drawImage"] as const) {
    (raw[op] as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
      paints.push({
        op,
        style: String(raw.fillStyle),
        alpha: Number(raw.globalAlpha),
        args,
      });
    });
  }
  return raw as unknown as CanvasRenderingContext2D;
}

/** A PNG's magic bytes — the canvas stub hands back bytes, the save command
 *  is asserted on bytes, and nothing between them cares what they encode. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

HTMLCanvasElement.prototype.getContext = function getContext() {
  return fakeContext();
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
  callback(new Blob([new Uint8Array(PNG)], { type: "image/png" }));
} as typeof HTMLCanvasElement.prototype.toBlob;

function setup(annotation: Annotation | null = ANNOTATION) {
  const onOpenChange = vi.fn();
  render(<QuoteCardDialog annotation={annotation} open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

/** The 保存图片 button exists from the first render, disabled while the card
 *  draws; a click before it enables would be a click on a dead control. */
const saveButton = async () => {
  const button = await screen.findByRole("button", { name: "保存图片" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
};

/** The one paint that covers the whole canvas: the paper. */
const paperFill = () =>
  paints.find(
    (paint) =>
      paint.op === "fillRect" &&
      paint.args[0] === 0 &&
      paint.args[1] === 0 &&
      paint.args[2] === 1080 &&
      paint.args[3] === 1440,
  );

beforeEach(() => {
  paints.length = 0;
  save.mockReset();
  cardSave.mockReset();
  downloadBytes.mockReset();
  runtime.desktop = true;
  bookRef.current = { ...BOOK, coverUrl: null };
  // The card is the reader's own paper; the store's defaults are that paper.
  // `pageTheme: "day"` pins the *day* branch so the day cases below are not
  // at the mercy of the app theme jsdom resolves to.
  useReaderSettings.setState({
    surface: "standard",
    nightSurface: "night",
    pageTheme: "day",
    customSurface: null,
    fontFamily: "book",
  });
});

describe("QuoteCardDialog", () => {
  it("draws the card at its own pixel size", async () => {
    setup();
    await saveButton();
    const canvas = screen.getByLabelText("金句卡片预览") as HTMLCanvasElement;
    // 1080x1440 — the fixed 3:4 the share surfaces ask for, regardless of
    // the 300px the preview shows it at.
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1440);
    // And on the day surface the store names. 标准's page colour is
    // translucent (it lets the shell's ground through), which a PNG cannot
    // wear — the card takes that colour's opaque tint instead.
    expect(paperFill()?.style).toBe("#f4f5f8");
  });

  it("paints the night surface's paper on a night page", async () => {
    // The bug this pins: the dialog once resolved the surface itself, reading
    // the day setting unconditionally — so a night page shared day paper no
    // matter which surface was picked, and the reader saw one colour forever.
    // Sepia on the day side, pine on the night side: only one may appear.
    useReaderSettings.setState({ surface: "sepia", nightSurface: "pine", pageTheme: "night" });
    setup();
    await saveButton();

    expect(paperFill()?.style).toBe("#1b231e");
  });

  it("keeps the coverless card's single metadata line", async () => {
    // A book with no cover draws exactly the card it drew before the cover
    // existed: one muted line at the top-left, and nothing else up there.
    setup();
    await saveButton();

    const meta = paints.find(
      (paint) => paint.op === "fillText" && paint.args[0] === "三体 · 刘慈欣",
    );
    expect(meta).toBeDefined();
    expect(meta!.args[1]).toBe(88);
    expect(meta!.args[2]).toBe(110);
    expect(paints.some((paint) => paint.op === "drawImage")).toBe(false);
  });

  it("draws the book's cover, centre-cropped into its box", async () => {
    bookRef.current = { ...BOOK, coverUrl: "blob:cover-1" };
    setup();
    // The dialog is portalled, so the cover element lives on the body.
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    // jsdom decodes nothing: give the element the size the renderer asks for,
    // then let it "load".
    Object.defineProperty(img, "naturalWidth", { value: 600, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 900, configurable: true });
    fireEvent.load(img!);

    // Two draws: the composite into the offscreen bitmap, then the crop onto
    // the card. The second carries the crop — and the first has to exist,
    // because a nine-argument draw straight off an SVG mis-samples on a
    // canvas this size (Chromium measured it: the crop selected the image's
    // top-left corner and the whole box came out one flat colour).
    await waitFor(() =>
      expect(
        paints.filter((paint) => paint.op === "drawImage" && paint.args.length === 9),
      ).toHaveLength(1),
    );
    expect(
      paints.filter((paint) => paint.op === "drawImage" && paint.args.length === 3),
    ).toHaveLength(1);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = paints.find(
      (p) => p.op === "drawImage" && p.args.length === 9,
    )!.args;
    // Into the box at the margin, and cropped the way a 2:3 cover is cropped:
    // full width, an equal band off the top and bottom.
    expect([dx, dy, dw, dh]).toEqual([88, 88, 168, 236]);
    expect(sw).toBe(600);
    expect(sh).toBeCloseTo(600 / (168 / 236));
    expect(sx).toBe(0);
    expect(sy).toBeCloseTo((900 - 600 / (168 / 236)) / 2);
  });

  it("writes the bytes through the save command on the desktop", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue("/tmp/三体.png");
    const { onOpenChange } = setup();

    await user.click(await saveButton());

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      title: "保存金句卡片",
      defaultPath: "三体.png",
    });
    expect(cardSave).toHaveBeenCalledWith("/tmp/三体.png", PNG);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("writes nothing when the reader cancels the save panel", async () => {
    const user = userEvent.setup();
    save.mockResolvedValue(null);
    const { onOpenChange } = setup();

    await user.click(await saveButton());

    expect(cardSave).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("downloads the card where there is no save panel", async () => {
    // The browser build: no shell, no filesystem. The download takes the
    // name the panel would have offered, the same fallback the notes
    // export uses.
    const user = userEvent.setup();
    runtime.desktop = false;
    const { onOpenChange } = setup();

    await user.click(await saveButton());

    expect(save).not.toHaveBeenCalled();
    expect(downloadBytes).toHaveBeenCalledTimes(1);
    const [blob, name] = downloadBytes.mock.calls[0]!;
    expect(name).toBe("三体.png");
    expect(blob).toBeInstanceOf(Blob);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("refuses a quote the card cannot hold, and offers nothing else to press", async () => {
    // 1400 CJK characters: ten wrapped lines at every size on the scale, and
    // ten lines at the floor overflows the quote zone. The card's one
    // refusal — reported as a count, with the save control still dead.
    const long: Annotation = { ...ANNOTATION, text: "一".repeat(1400) };
    setup(long);

    expect(await screen.findByText(/卡片装不下/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存图片" })).toBeDisabled();
  });
});
