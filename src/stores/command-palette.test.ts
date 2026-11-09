import { beforeEach, describe, expect, it } from "vitest";

import { useCommandPalette } from "@/stores/command-palette";

describe("useCommandPalette", () => {
  beforeEach(() => {
    useCommandPalette.setState({ open: false, mode: "command", session: 0 });
  });

  it("opens the mode its hotkey names", () => {
    useCommandPalette.getState().openWith("search");
    expect(useCommandPalette.getState()).toMatchObject({ open: true, mode: "search" });
  });

  it("remounts on a new open, but a repeated press keeps the query", () => {
    const { openWith, setOpen } = useCommandPalette.getState();
    openWith("search");
    const first = useCommandPalette.getState().session;
    openWith("search");
    expect(useCommandPalette.getState().session).toBe(first);
    setOpen(false);
    openWith("search");
    expect(useCommandPalette.getState().session).toBe(first + 1);
  });

  it("switching modes in place starts a fresh body", () => {
    useCommandPalette.getState().openWith("search");
    const first = useCommandPalette.getState().session;
    useCommandPalette.getState().openWith("command");
    expect(useCommandPalette.getState()).toMatchObject({
      open: true,
      mode: "command",
      session: first + 1,
    });
  });
});
