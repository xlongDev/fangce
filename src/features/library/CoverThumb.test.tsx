import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ metadataCoverPreview: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
  isDesktopRuntime: true,
  ipc: { metadataCoverPreview: mocks.metadataCoverPreview },
}));

import { CoverThumb } from "@/features/library/CoverThumb";

const URL = "https://img1.doubanio.com/view/subject/m/public/s1234567.jpg";
const PREVIEW = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function withQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mocks.metadataCoverPreview.mockReset();
});

describe("a catalogue cover in a row", () => {
  it("shows the picture the backend sent, not its address", async () => {
    mocks.metadataCoverPreview.mockResolvedValue(PREVIEW);
    const { container } = withQuery(<CoverThumb url={URL} />);

    await waitFor(() => expect(container.querySelector(`img[src="${PREVIEW}"]`)).not.toBeNull());
    expect(mocks.metadataCoverPreview).toHaveBeenCalledWith(URL);
  });

  /**
   * A cover that will not load is not a failure worth a toast — the row is
   * still usable, and picking it still downloads the file on 保存. The
   * placeholder is the whole answer.
   */
  it("keeps the placeholder when the picture will not load", async () => {
    mocks.metadataCoverPreview.mockRejectedValue(new Error("418"));
    const { container } = withQuery(<CoverThumb url={URL} />);

    await waitFor(() => expect(mocks.metadataCoverPreview).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
  });

  it("asks for nothing while the row is closed, or when there is no picture", () => {
    mocks.metadataCoverPreview.mockResolvedValue(PREVIEW);
    const { container } = withQuery(
      <>
        <CoverThumb url={URL} active={false} />
        <CoverThumb url={null} />
      </>,
    );

    expect(mocks.metadataCoverPreview).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });

  /** One picture, one request: the list and an expanded row share the cache. */
  it("asks once for the same picture, however many rows show it", async () => {
    mocks.metadataCoverPreview.mockResolvedValue(PREVIEW);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CoverThumb url={URL} />
        <CoverThumb url={URL} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(document.querySelectorAll(`img[src="${PREVIEW}"]`)).toHaveLength(2));
    expect(mocks.metadataCoverPreview).toHaveBeenCalledTimes(1);
  });
});
