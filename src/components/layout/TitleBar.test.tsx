import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useSettings } from "@/stores/settings";

import { TitleBar } from "./TitleBar";

/**
 * The sidebar toggle, which lives in the drag band rather than the footer.
 *
 * It is the only control that can bring a hidden rail back — the footer is
 * inside the rail — so what matters here is that it flips the store and
 * relabels itself to name the *action* rather than the state.
 */
describe("TitleBar", () => {
  beforeEach(() => {
    useSettings.setState({ sidebarHidden: false });
  });

  it("hides the rail and offers to bring it back", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);

    await user.click(screen.getByRole("button", { name: "隐藏侧边栏" }));

    expect(useSettings.getState().sidebarHidden).toBe(true);
    expect(screen.getByRole("button", { name: "显示侧边栏" })).toBeInTheDocument();
  });

  it("brings it back on the second press", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);

    await user.click(screen.getByRole("button", { name: "隐藏侧边栏" }));
    await user.click(screen.getByRole("button", { name: "显示侧边栏" }));

    expect(useSettings.getState().sidebarHidden).toBe(false);
    expect(screen.getByRole("button", { name: "隐藏侧边栏" })).toBeInTheDocument();
  });
});
