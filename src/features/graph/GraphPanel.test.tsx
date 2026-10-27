import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

import { GraphPanel } from "./GraphPanel";

// The three queries are the seam: what the panel does with a status is the
// whole of it, and the two states below are what a reader can end up in.
const { graph } = vi.hoisted(() => ({
  graph: {
    status: { isPending: false, data: { entities: 0, relations: 0, model: "" } },
    view: { isPending: false, data: { entities: [], relations: [] } },
    build: { build: { isPending: false, mutate: vi.fn() }, progress: null as unknown },
  },
}));
vi.mock("@/hooks/useGraph", () => ({
  useGraphStatus: () => graph.status,
  useGraphQuery: () => graph.view,
  useGraphBuild: () => graph.build,
}));

function Probe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.hash}</span>;
}

function mount() {
  render(
    <MemoryRouter initialEntries={["/reader"]}>
      <GraphPanel bookId="b1" onOpenChapter={() => {}} />
      <Probe />
    </MemoryRouter>,
  );
}

describe("GraphPanel", () => {
  it("says a model is missing instead of offering a build that cannot run", () => {
    // The empty state used to name the problem in grey and hide the button, so
    // the panel looked broken rather than unconfigured.
    graph.status.data = { entities: 0, relations: 0, model: "" };
    mount();

    expect(screen.getByText("还没有配置 AI 模型")).toBeTruthy();
    expect(screen.getByText("先到设置里填写接口地址与模型名称")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "抽取全书" })).toBeNull();
  });

  it("takes the reader to the AI group from that card", async () => {
    const user = userEvent.setup();
    graph.status.data = { entities: 0, relations: 0, model: "" };
    mount();

    await user.click(screen.getByRole("button", { name: /去设置/ }));

    expect(screen.getByTestId("location").textContent).toBe("/settings#ai");
  });

  it("offers the build once a model is named", () => {
    graph.status.data = { entities: 0, relations: 0, model: "gpt-4o-mini" };
    mount();

    expect(screen.getByRole("button", { name: "抽取全书" })).toBeTruthy();
    expect(screen.queryByText("还没有配置 AI 模型")).toBeNull();
  });
});
