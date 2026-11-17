import { expect, test } from "@playwright/test";

/**
 * 封面管理 as a command, not another nav row.
 *
 * The page used to live only behind a small 补充封面 slice on 统计, with no
 * sidebar entry — findable if you knew it was there, unreachable if you did
 * not. The palette is where a remembered-but-unfindable destination belongs.
 *
 * It is gated on `isDesktopRuntime`: the web build renders nothing but a
 * "desktop only" note on that page, so the command must not offer a dead entry
 * there. This pins the web half. The desktop half (registered, searchable,
 * navigates to /covers) lives in `registerCoreCommands.test.ts` — flipping
 * `isTauri` in a browser fixture activates the real Tauri IPC layer, which has
 * no backend here and takes the whole app down before the palette can open.
 */

test("the web build does not offer a cover-manager command", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("封面");
  await expect(dialog.getByText("没有匹配的命令或书籍")).toBeVisible();
});
