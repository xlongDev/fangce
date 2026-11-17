import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The 封面管理 command, desktop half.
 *
 * A browser fixture cannot stand in for the shell here: `isDesktopRuntime` is
 * `isTauri()` at module load, and setting that flag switches the whole IPC
 * layer onto `invoke`, which has no backend in a test runner. So the desktop
 * gate is mocked at the module boundary and the command's own contract is
 * checked here — registered, searchable by 封面/cover, correctly grouped, no
 * shortcut, and navigating to /covers. The web half (gate closed, no dead
 * entry in the palette) is covered by e2e/covers-command.spec.ts.
 */

vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, isDesktopRuntime: true };
});

import { registerCoreCommands } from "@/features/command/registerCoreCommands";
import { scoreCommand } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";

const COVERS = "tool.covers";

function registered() {
  return useCommandStore.getState().commands.find((entry) => entry.id === COVERS);
}

describe("封面管理 command", () => {
  beforeAll(() => {
    registerCoreCommands({ openPalette: () => {}, openSearch: () => {} });
  });

  it("is registered as a 工具 command without a shortcut", () => {
    const command = registered();
    expect(command).toBeDefined();
    expect(command!.title).toBe("封面管理");
    expect(command!.group).toBe("工具");
    expect(command!.description).toBe("补充封面、合并重复图、清理无主文件");
    expect(command!.shortcut).toBeUndefined();
  });

  it("is enabled only in the desktop shell", () => {
    // The mock makes isDesktopRuntime true, so the gate is open here.
    expect(registered()!.isEnabled?.()).toBe(true);
  });

  it("is searchable by 封面, cover and its maintenance aliases", () => {
    const command = registered()!;
    for (const query of ["封面", "封面管理", "cover", "补充封面", "清理"]) {
      expect(scoreCommand(query, command), query).not.toBeNull();
    }
  });

  it("runs by navigating to the cover manager", () => {
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener("fangce:navigate", listen);
    try {
      registered()!.run();
      expect(seen).toEqual(["/covers"]);
    } finally {
      window.removeEventListener("fangce:navigate", listen);
    }
  });
});
