import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AppRouter } from "./router";

/**
 * Boot smoke test. The shell is assembled from several providers, a memory
 * router and a command registry that only exists after effects run, so a
 * wiring mistake here is invisible to type checking.
 */
describe("AppRouter", () => {
  it("boots into the library view with the sidebar exposed", () => {
    render(<AppRouter />);

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("书库");
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "折叠侧边栏" })).toBeInTheDocument();
    // The hide toggle sits in the title bar rather than the footer: it has to
    // outlive the rail it hides, so it must render with the rail hidden too.
    expect(screen.getByRole("button", { name: "隐藏侧边栏" })).toBeInTheDocument();
  });
});
