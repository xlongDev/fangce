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
  await expect(sheet).toContainText("补全完成", { timeout: 10_000 });
  await expect(sheet).toContainText("60 / 60");
  // Two thirds of the demo rows have something to write.
  await expect(sheet).toContainText(/已补全 \d+ 本 · 跳过 \d+ 本/);
  await expect(sheet.getByRole("button", { name: "关闭" })).toBeVisible();
  // The shell keeps the same run in view after the dialog is gone.
  await expect(page.locator("[data-fill-run-pill]")).toContainText("60 / 60");
});

test("后台运行关掉弹窗后进度仍在", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 780 });
  await page.goto("/?demo=1&books=120");
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByRole("button", { name: "全选" }).click();
  await page.getByRole("button", { name: "补全信息" }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /开始补全 120 本/ }).click();
  await sheet.getByRole("button", { name: "后台运行" }).click();
  await expect(sheet).toBeHidden();

  // Closing the dialog is not stopping the loop: the shell pill finishes it.
  const pill = page.locator("[data-fill-run-pill]");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("120 / 120", { timeout: 10_000 });
  await pill.getByRole("button", { name: "展开补全进度" }).click();
  await expect(pill).toContainText("已补全");
});
