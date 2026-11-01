import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { PortraitCard } from "./PortraitCard";
import type { GraphEntity } from "@/types/ipc";

// The two queries and the config are the seam. What matters here is that the
// card disappears when portraits are off, and that the button asks for the right
// thing when they are on.
const { hooks } = vi.hoisted(() => ({
  hooks: {
    config: { data: { imageBackend: "" } as { imageBackend: string } | undefined },
    portrait: { data: null as string | null },
    generate: {
      isPending: false,
      error: null as unknown,
      data: undefined as string | undefined,
      mutate: vi.fn(),
    },
  },
}));
vi.mock("@/hooks/useAi", () => ({ useAiConfig: () => hooks.config }));
vi.mock("@/hooks/useGraph", () => ({
  useCharacterPortrait: () => hooks.portrait,
  useGeneratePortrait: () => hooks.generate,
}));

const ENTITY: GraphEntity = { name: "林昭", kind: "人物", mentions: 42 };

function mount() {
  render(
    <MemoryRouter initialEntries={["/reader"]}>
      <PortraitCard bookId="b1" entity={ENTITY} />
    </MemoryRouter>,
  );
}

function reset(backend: string, portrait: string | null) {
  hooks.config.data = { imageBackend: backend };
  hooks.portrait.data = portrait;
  hooks.generate.data = undefined;
  hooks.generate.error = null;
  hooks.generate.isPending = false;
  hooks.generate.mutate.mockReset();
}

describe("PortraitCard", () => {
  it("stays out of the way when no image backend is configured", () => {
    // A button whose only outcome is "go to the settings page" is worse than no
    // button: the panel is where a reader looks someone up, not where they
    // configure a diffusion model.
    reset("", null);
    mount();

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("还没有")).toBeNull();
  });

  it("offers to draw one, and takes a description first", async () => {
    const user = userEvent.setup();
    reset("a1111", null);
    mount();

    await user.type(screen.getByLabelText("形象描述"), "青衫少年");
    await user.click(screen.getByRole("button", { name: /生成立绘/ }));

    expect(hooks.generate.mutate).toHaveBeenCalledWith(
      { name: "林昭", appearance: "青衫少年" },
      expect.anything(),
    );
  });

  it("shows the picture once one exists, and offers another take", () => {
    reset("a1111", "fangce://localhost/portrait/b1/林昭");
    mount();

    expect(screen.getByRole("img", { name: "林昭 的立绘" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /重画一张/ })).toBeTruthy();
    // The description field belongs to the first drawing; a redraw keeps the
    // prompt that produced the one on screen.
    expect(screen.queryByLabelText("形象描述")).toBeNull();
  });

  it("reports a failed drawing under the button that caused it", () => {
    reset("openai_compat", null);
    hooks.generate.error = new Error("文生图返回 404：model not found");
    mount();

    expect(screen.getByText(/model not found/)).toBeTruthy();
  });
});
