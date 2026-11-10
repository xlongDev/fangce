import { expect, test } from "@playwright/test";

/**
 * 整架补全 — the run over more books than a preview can hold.
 *
 * It is a loop in a store rather than a request, so what matters is what the
 * panel says while it runs: how far along, what was written, and a way to stop.
 * `?demo=1` serves canned proposals (see `demoProposals`), so the whole loop is
 * drivable in a browser.
 */
test("a whole-shelf run reports progress and finishes", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 780 });
  // More books than the preview cap, so the dialog offers the run instead of a
  // list.
  await page.goto("/?demo=1&books=60");
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByRole("button", { name: "全选" }).click();
  await page.getByRole("button", { name: "补全信息" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("整架补全 60 本");
  await expect(sheet).toContainText("分 2 批");

  await sheet.getByRole("button", { name: /开始补全 60 本/ }).click();

  // The panel replaces the list: a run has no preview, and the reader is
  // watching a count instead.
  await expect(sheet).toContainText("整架补全");
  await expect(sheet.getByRole("button", { name: "停止" })).toBeVisible();

  // Canned proposals are instant, so this is the finished state.
  await expect(sheet).toContainText("补完了", { timeout: 10_000 });
  await expect(sheet).toContainText("60 / 60");
  // Two thirds of the demo rows have something to write.
  await expect(sheet).toContainText(/已补 \d+ 本 · 跳过 \d+ 本/);
  await expect(sheet.getByRole("button", { name: "关闭" })).toBeVisible();
});
