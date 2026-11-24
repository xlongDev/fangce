import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BookSummary } from "@/types/ipc";

// The unified export dialog is the desktop face of the card; the browser only
// gets a direct download. Keeping the desktop branch real pins which one renders.
vi.mock("@/lib/ipc", () => ({ isDesktopRuntime: true }));

// `useBookHandoff` is module-scoped state the component reads but the tests
// never trigger. The empty stub keeps the import real without opening a
// zustand store that would interfere between cases.
vi.mock("@/stores/book-handoff", () => ({
  useBookHandoff: (
    selector: (s: { begin: () => void; id: string | null; end: () => void }) => unknown,
  ) => selector({ begin: () => {}, end: () => {}, id: null }),
  boxOf: () => ({ x: 0, y: 0, w: 0, h: 0, radius: 0 }),
}));

// `useLandingBox` registers an effect for the cover handoff; we do not need
// it firing during a render test.
vi.mock("@/hooks/useLandingBox", () => ({
  useLandingBox: () => {},
}));

import { BookCard } from "@/features/library/BookCard";

const baseBook: BookSummary = {
  id: "test-1",
  title: "测试书",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 4_500_000,
  coverUrl: null,
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: null,
  location: null,
  favorite: false,
  isbn: null,
  publishedYear: null,
  rating: null,
  ratingCount: null,
  ratingSource: null,
  doubanUrl: null,
  authors: ["张三"],
  tags: [],
};

function renderCard(
  book: Partial<BookSummary> = {},
  onAskExport: (book: BookSummary) => void = () => {},
  onSendToKindle?: (book: BookSummary) => void,
  kindlePhase?: "sending" | "success" | "error",
  variant: "grid" | "list" = "grid",
) {
  return render(
    <BookCard
      book={{ ...baseBook, ...book } as BookSummary}
      onOpen={() => {}}
      onToggleFavorite={() => {}}
      onAskDelete={() => {}}
      onAskExport={onAskExport}
      onSendToKindle={onSendToKindle}
      kindlePhase={kindlePhase}
      variant={variant}
      onExportFile={() => {}}
      onEditTags={() => {}}
      onEditMeta={() => {}}
    />,
  );
}

describe("BookCard — format / file size row (T2/T3)", () => {
  it("always shows the format, uppercased", () => {
    renderCard({ format: "epub" });
    expect(screen.getByText(/EPUB/)).toBeInTheDocument();
  });

  it("shows the file size when it is positive", () => {
    renderCard({ fileSize: 4_500_000 });
    // 4_500_000 / 1024 / 1024 ≈ 4.29 → "4.3 MB"
    expect(screen.getByText(/4\.3 MB/)).toBeInTheDocument();
  });

  it("omits the file size when it is zero or unknown, but keeps the format", () => {
    renderCard({ fileSize: 0 });
    expect(screen.getByText(/EPUB/)).toBeInTheDocument();
    expect(screen.queryByText(/\b\d+(?:\.\d+)? (?:MB|KB|B)\b/)).toBeNull();
  });

  it("truncates long authors instead of pushing the format/size off the line", () => {
    const { container } = renderCard({
      authors: [
        "一个非常非常非常非常长的作者名用来测试截断是否会破坏文件大小显示一个非常非常非常长的作者名",
      ],
      fileSize: 4_500_000,
    });

    // The author occupies a `[data-marquee]` slot that the flex line can
    // shrink; the size span carries `shrink-0`. If a future refactor drops
    // either, the size disappears from the row on WebKit — see the "WebKit
    // measures Chinese ~15% wider" note in MEMORY.
    //
    // What this cannot decide is `truncate` vs `w-max` on the slot's inner
    // span: jsdom reports every `scrollWidth` and `clientWidth` as 0, so
    // `MarqueeText` always measures zero overflow here and always takes the
    // `truncate` branch. Whether a long name really scrolls is a real-engine
    // question, and `e2e/shelf-marquee.spec.ts` is where it is asked.
    const authorSlot = container.querySelector('[data-marquee-kind="author"]');
    const sizeSpan = container.querySelector("span.shrink-0");
    expect(authorSlot).not.toBeNull();
    expect(authorSlot!.className).toContain("flex-1");
    expect(authorSlot!.className).toContain("min-w-0");
    expect(sizeSpan).not.toBeNull();
    expect(sizeSpan!.textContent).toMatch(/4\.3 MB/);
  });

  it("paints the full title for hover scrolling and names the subtitle in the tooltip", () => {
    const { container } = renderCard({
      title: "国家构建",
      subtitle: "21世纪的国家治理与世界秩序",
    });
    const slot = container.querySelector('[data-marquee-kind="title"]');
    expect(slot?.textContent).toBe("国家构建");
    expect(slot?.getAttribute("title")).toBe("国家构建：21世纪的国家治理与世界秩序");
  });

  it("list view gives the subtitle its own line, including one embedded in the title", () => {
    const { container } = renderCard(
      { title: "国家构建：21世纪的国家治理与世界秩序" },
      () => {},
      undefined,
      undefined,
      "list",
    );
    expect(container.querySelector('[data-marquee-kind="title"]')?.textContent).toBe("国家构建");
    expect(container.querySelector('[data-marquee-kind="subtitle"]')?.textContent).toBe(
      "21世纪的国家治理与世界秩序",
    );
  });

  it("list view uses the subtitle field when the title has none", () => {
    const { container } = renderCard(
      { title: "国家构建", subtitle: "21世纪的国家治理与世界秩序" },
      () => {},
      undefined,
      undefined,
      "list",
    );
    expect(container.querySelector('[data-marquee-kind="subtitle"]')?.textContent).toBe(
      "21世纪的国家治理与世界秩序",
    );
  });

  it("grid keeps the subtitle out of its own line", () => {
    const { container } = renderCard({ title: "国家构建", subtitle: "21世纪的国家治理与世界秩序" });
    expect(container.querySelector('[data-marquee-kind="subtitle"]')).toBeNull();
  });

  it("keeps the whole label run in one marquee slot, with a full-text tooltip", () => {
    const { container } = renderCard({ tags: ["悬疑惊悚", "推理小说", "犯罪"] });
    const slot = container.querySelector('[data-marquee-kind="tags"]');
    expect(slot?.textContent).toBe("#悬疑惊悚  #推理小说  #犯罪");
    expect(slot?.getAttribute("title")).toBe("#悬疑惊悚  #推理小说  #犯罪");
  });

  it("reserves the label line without adding an empty marquee on an untagged shelf", () => {
    const { container } = renderCard({ tags: [] });
    expect(container.querySelector('[data-marquee-kind="tags"]')).toBeNull();
  });

  it("renders the format even when there are no authors", () => {
    renderCard({ authors: [] });
    expect(screen.getByText(/EPUB/)).toBeInTheDocument();
  });

  it("keeps the format/size block against the right edge when there is no author", () => {
    renderCard({ authors: [], fileSize: 4_500_000 });

    // The author slot is `flex-1`, so it is what pushes the format/size block
    // to the tile's right edge. Rendering nothing in its place put the block at
    // the *left* edge for a book with no author while the tile beside it in the
    // same row kept it at the right one — two alignments on one line, measured
    // on the 6-column shelf. The slot has to exist even when it is empty.
    const row = screen.getByText(/EPUB/).closest("p");
    expect(row).not.toBeNull();
    const slot = row!.firstElementChild as HTMLElement;
    expect(slot.className).toContain("flex-1");
    expect(slot.className).toContain("min-w-0");
    // And the block it holds right is still the last thing on the line.
    expect(row!.lastElementChild!.textContent).toMatch(/4\.3 MB/);
  });

  it("opens the one export dialog from the card's single export button", async () => {
    const onAskExport = vi.fn();
    renderCard({}, onAskExport);

    await userEvent.click(screen.getByRole("button", { name: "导出" }));

    // No hover menu in front of another panel: the dialog itself offers the
    // original file, both packs and the catalogue CSV as peer choices.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onAskExport).toHaveBeenCalledWith(expect.objectContaining({ id: "test-1" }));
  });

  it("offers Send to Kindle only for EPUB books that have a handler", async () => {
    const onSend = vi.fn();
    renderCard({ format: "epub" }, () => {}, onSend);
    expect(screen.getByRole("button", { name: "发送到 Kindle" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "发送到 Kindle" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ id: "test-1" }));
  });

  it("does not show Send to Kindle for non-EPUB formats", () => {
    renderCard({ format: "pdf" }, () => {}, vi.fn());
    expect(screen.queryByRole("button", { name: "发送到 Kindle" })).not.toBeInTheDocument();
  });

  it("tints the send button to the result while the phase is held", () => {
    // The glyph crossfade is motion; the durable signal is the button's own
    // colour, which is what remains readable after the swap settles.
    const { unmount } = renderCard({}, () => {}, vi.fn(), "success");
    const send = screen.getByRole("button", { name: "发送到 Kindle" });
    expect(send.className).toContain("text-accent");
    unmount();

    renderCard({}, () => {}, vi.fn(), "error");
    expect(screen.getByRole("button", { name: "发送到 Kindle" }).className).toContain(
      "text-danger",
    );
  });
});
