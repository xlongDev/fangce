import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BookSummary } from "@/types/ipc";

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
  doubanUrl: null,
  authors: ["张三"],
  tags: [],
};

function renderCard(book: Partial<BookSummary> = {}) {
  return render(
    <BookCard
      book={{ ...baseBook, ...book } as BookSummary}
      onOpen={() => {}}
      onToggleFavorite={() => {}}
      onAskDelete={() => {}}
      onAskExport={() => {}}
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
    const authorSlot = container.querySelector("[data-marquee]");
    const sizeSpan = container.querySelector("span.shrink-0");
    expect(authorSlot).not.toBeNull();
    expect(authorSlot!.className).toContain("flex-1");
    expect(authorSlot!.className).toContain("min-w-0");
    expect(sizeSpan).not.toBeNull();
    expect(sizeSpan!.textContent).toMatch(/4\.3 MB/);
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
});
