import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";

import { GraphPanel } from "./GraphPanel";
import type { GraphStatus, GraphView } from "@/types/ipc";

// The three queries are the seam: what the panel does with a status is the
// whole of it, and the two states below are what a reader can end up in.
const { graph } = vi.hoisted(() => ({
  graph: {
    status: {
      isPending: false,
      data: { entities: 0, relations: 0, model: "" } as GraphStatus,
    },
    view: { isPending: false, data: { entities: [], relations: [] } as GraphView },
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

  it("opens on the people, not on a flat list of places and things", () => {
    // Sorted by mentions alone, a place mentioned more often than any character
    // came first and pushed the people below the fold — on a panel that is
    // 320px wide and mostly opened to look someone up.
    graph.status.data = { entities: 3, relations: 4, model: "m" };
    graph.view.data = {
      entities: [
        { name: "青云山", kind: "地点", mentions: 9 },
        { name: "林昭", kind: "人物", mentions: 4 },
        { name: "断剑", kind: "物品", mentions: 2 },
      ],
      relations: [],
    };
    mount();

    expect(screen.getByRole("button", { name: /林昭/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /青云山/ })).toBeNull();
  });

  it("全部 brings the other kinds back, each under its own heading", async () => {
    const user = userEvent.setup();
    graph.status.data = { entities: 2, relations: 0, model: "m" };
    graph.view.data = {
      entities: [
        { name: "林昭", kind: "人物", mentions: 4 },
        { name: "青云山", kind: "地点", mentions: 9 },
      ],
      relations: [],
    };
    mount();

    await user.click(screen.getByRole("button", { name: /全部/ }));

    expect(screen.getByRole("button", { name: /青云山/ })).toBeTruthy();
    // Once as the filter chip, once as the section heading above the chips.
    expect(screen.getAllByText("地点").length).toBe(2);
  });

  it("keeps a kind the model invented instead of dropping the entity", () => {
    // The prompt asks for five kinds and the model may answer with a sixth.
    // Losing those entities would quietly shrink the graph.
    graph.status.data = { entities: 1, relations: 0, model: "m" };
    graph.view.data = {
      entities: [{ name: "雾隐楼", kind: "势力", mentions: 3 }],
      relations: [],
    };
    mount();

    expect(screen.getByRole("button", { name: /雾隐楼/ })).toBeTruthy();
    expect(screen.getAllByText("势力").length).toBeGreaterThanOrEqual(1);
  });
});
