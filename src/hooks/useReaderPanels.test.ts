import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useReaderPanels } from "@/hooks/useReaderPanels";

/**
 * The reason this hook exists is `close`, so that is what is pinned here.
 * The drawer leaves two things behind — its query and the painted match
 * highlights — and closing keeps both: a reader who closes the drawer to
 * read the page the hits are on must not watch the ink vanish with the
 * panel. What retires them is emptying the field, a new search, or the book
 * itself closing — none of which is this hook's business.
 */
describe("useReaderPanels", () => {
  it("opens on nothing, with the query it was seeded with", () => {
    const { result } = renderHook(() => useReaderPanels("三体"));
    expect(result.current.panel).toBe("none");
    expect(result.current.search).toBe("三体");
  });

  it("toggle opens the panel it names, and the same id closes it", () => {
    const { result } = renderHook(() => useReaderPanels(""));

    act(() => result.current.toggle("toc"));
    expect(result.current.panel).toBe("toc");

    act(() => result.current.toggle("toc"));
    expect(result.current.panel).toBe("none");

    // A different id moves the drawer rather than closing it: only one panel
    // is ever open.
    act(() => result.current.toggle("toc"));
    act(() => result.current.toggle("annotations"));
    expect(result.current.panel).toBe("annotations");
  });

  it("close keeps the query and the painted matches", () => {
    const { result } = renderHook(() => useReaderPanels(""));

    act(() => result.current.setPanel("search"));
    act(() => result.current.setSearch("kittens"));

    let closed = false;
    act(() => {
      closed = result.current.close();
    });

    expect(closed).toBe(true);
    expect(result.current.panel).toBe("none");
    expect(result.current.search).toBe("kittens");
  });

  it("close on another panel closes just the panel", () => {
    const { result } = renderHook(() => useReaderPanels(""));

    act(() => result.current.setPanel("toc"));
    act(() => {
      result.current.close();
    });

    expect(result.current.panel).toBe("none");
  });

  it("close with nothing open reports that it consumed nothing", () => {
    const { result } = renderHook(() => useReaderPanels(""));

    let closed = true;
    act(() => {
      closed = result.current.close();
    });

    // The key handler uses this to decide whether Escape belongs to the panel
    // or should fall through to the fullscreen toggle.
    expect(closed).toBe(false);
  });

  it("a second close is a no-op", () => {
    const { result } = renderHook(() => useReaderPanels(""));

    act(() => result.current.setPanel("search"));
    act(() => {
      result.current.close();
    });
    act(() => {
      result.current.close();
    });

    expect(result.current.panel).toBe("none");
    expect(result.current.search).toBe("");
  });

  it("setPanel leaves the query alone, like close now does", () => {
    const { result } = renderHook(() => useReaderPanels(""));

    act(() => result.current.setPanel("search"));
    act(() => result.current.setSearch("kittens"));
    act(() => result.current.setPanel("none"));

    expect(result.current.search).toBe("kittens");
  });

  /**
   * `close` goes into the reader's key handler dependency list, and a fresh
   * identity there re-registers the listener on every render.
   */
  it("close keeps its identity across renders", () => {
    const { result, rerender } = renderHook(() => useReaderPanels(""));
    const first = result.current.close;

    rerender();

    expect(result.current.close).toBe(first);
  });
});
