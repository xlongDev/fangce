import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    detail: { isPending: false, data: { entities: [], relations: [] } as GraphView },
    spoilerSafe: false as boolean,
    lastMaxChapter: null as number | null,
    build: { build: { isPending: false, mutate: vi.fn() }, progress: null as unknown },
  },
}));
vi.mock("@/hooks/useGraph", () => ({
  useGraphStatus: () => graph.status,
  // `null` is the entity list the panel opened on; a name is the selected
  // entity's neighbourhood. Both are always mounted, so the mock has to tell
  // them apart the way the query key does.
  useGraphQuery: (_bookId: string, entity: string | null, maxChapter: number | null) => {
    graph.lastMaxChapter = maxChapter;
    return entity === null ? graph.view : graph.detail;
  },
  useGraphBuild: () => graph.build,
}));
vi.mock("@/hooks/useAi", () => ({
  useAiConfig: () => ({ data: { spoilerSafe: graph.spoilerSafe } }),
}));
// The portrait card owns its own queries; this file is about the list and the
// card's header, and PortraitCard has a test of its own.
vi.mock("@/features/graph/PortraitCard", () => ({ PortraitCard: () => null }));

function Probe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.hash}</span>;
}

function mount(props: { onAskAbout?: (name: string) => void } = {}) {
  render(
    <MemoryRouter initialEntries={["/reader"]}>
      <GraphPanel bookId="b1" currentIdx={2} onOpenChapter={() => {}} {...props} />
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

  it("hands the character to the assistant", async () => {
    // The card knows what the book says about someone; the assistant is where a
    // reader can ask what that adds up to. Without this the character tool only
    // exists for readers who think to ask by name.
    const user = userEvent.setup();
    const onAskAbout = vi.fn();
    graph.status.data = { entities: 1, relations: 0, model: "m" };
    graph.view.data = {
      entities: [{ name: "林昭", kind: "人物", mentions: 4 }],
      relations: [],
    };
    mount({ onAskAbout });

    await user.click(screen.getByRole("button", { name: /林昭/ }));
    await user.click(screen.getByRole("button", { name: "问助手" }));

    expect(onAskAbout).toHaveBeenCalledWith("林昭");
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

  it("walks to the other end of a relation instead of back to the list", async () => {
    const user = userEvent.setup();
    graph.status.data = { entities: 3, relations: 3, model: "m" };
    graph.view.data = {
      entities: [
        { name: "林昭", kind: "人物", mentions: 4 },
        { name: "玄清道人", kind: "人物", mentions: 3 },
        { name: "青云山", kind: "地点", mentions: 9 },
      ],
      relations: [],
    };
    // Empty evidence: the row's speaker is not part of what this asserts, and
    // a bare fixture keeps the panel's own dependencies out of the test.
    graph.detail.data = {
      entities: [],
      relations: [
        { subject: "林昭", relation: "拜师", object: "玄清道人", evidence: "", chapterIdx: 2 },
        { subject: "林昭", relation: "拜师", object: "玄清道人", evidence: "", chapterIdx: 5 },
        { subject: "林昭", relation: "居于", object: "青云山", evidence: "", chapterIdx: 3 },
      ],
    };
    mount();

    await user.click(screen.getByRole("button", { name: /林昭/ }));
    expect(screen.getByText("相关 2 位")).toBeTruthy();
    // Two 拜师 edges fold into one destination rather than two identical rows.
    const strip = screen.getByRole("region", { name: "关系邻居" });
    expect(within(strip).getByRole("button", { name: /玄清道人/ })).toBeTruthy();

    await user.click(within(strip).getByRole("button", { name: /玄清道人/ }));
    // The centre changed: from 玄清道人's side only 林昭 remains, and the
    // reader is still in the detail view rather than back at the entity list.
    expect(screen.getByText("相关 1 位")).toBeTruthy();
    const next = screen.getByRole("region", { name: "关系邻居" });
    expect(within(next).getByRole("button", { name: /林昭/ })).toBeTruthy();
  });

  it("keeps the graph inside the reader's position when 防剧透 is on", async () => {
    const user = userEvent.setup();
    graph.spoilerSafe = true;
    graph.status.data = { entities: 1, relations: 1, model: "m" };
    graph.view.data = {
      entities: [{ name: "林昭", kind: "人物", mentions: 4 }],
      relations: [],
    };
    graph.detail.data = {
      entities: [],
      relations: [
        { subject: "林昭", relation: "拜师", object: "玄清道人", evidence: "", chapterIdx: 2 },
      ],
    };
    mount();

    // Both queries — the list and the selected entity — carry the limit, and
    // the limit belongs in their query keys so flipping the switch re-asks.
    expect(graph.lastMaxChapter).toBe(2);
    await user.click(screen.getByRole("button", { name: /林昭/ }));
    expect(screen.getByText(/防剧透已开启，只显示第 1–3 章的关系/)).toBeTruthy();
    graph.spoilerSafe = false;
  });
});
