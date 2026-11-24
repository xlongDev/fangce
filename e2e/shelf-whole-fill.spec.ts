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
  // Watching the run in its dialog never pops up the background pill.
  await expect(page.locator("[data-fill-run-pill]")).toHaveCount(0);
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
  // The shell strip is one line: status + count + buttons. The written/skipped
  // breakdown belongs to the dialog, not to a second copy under the strip.
  await expect(pill).not.toContainText("已补全");

  // 「返回界面」 brings back the full run dialog (with the breakdown and its
  // retry control) even though the run was started from a dialog we closed.
  await pill.getByRole("button", { name: "返回界面" }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(/已补全 \d+ 本 · 跳过 \d+ 本/);
});

test("折叠徽章默认只有图标，hover 才弹出计数", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 780 });
  await page.goto("/?demo=1&books=120");
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByRole("button", { name: "全选" }).click();
  await page.getByRole("button", { name: "补全信息" }).click();

  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /开始补全 120 本/ }).click();
  await sheet.getByRole("button", { name: "后台运行" }).click();

  const pill = page.locator("[data-fill-run-pill]");
  await expect(pill).toContainText("120 / 120", { timeout: 10_000 });
  await pill.getByRole("button", { name: "折叠补全进度" }).click();
  const badge = page.locator("[data-fill-run-surface]");
  await expect(badge).toHaveAttribute("aria-label", "展开补全进度");

  const countWidth = () =>
    page
      .locator("[data-fill-run-count]")
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
  // 折起来时指针还在徽章上，计数保持弹出；移开后收成纯图标。
  await page.mouse.move(0, 0);
  await expect.poll(countWidth).toBe(0);
  await badge.hover();
  await expect.poll(countWidth).toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await expect.poll(countWidth).toBe(0);

  // hover 只改可见性，不改变「点徽章展开完整条」的语义。
  await badge.hover();
  await expect.poll(countWidth).toBeGreaterThan(0);
  await badge.click();
  await expect(pill.getByRole("button", { name: "折叠补全进度" })).toBeVisible();
});
