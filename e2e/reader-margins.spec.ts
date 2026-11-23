import { expect, test, type Page } from "@playwright/test";

/**
 * 页边距的方向：越宽，正文越窄。
 *
 * foliate 的 `--_margin-*` 是页面盒子**外面**的网格轨道，而盒子宽度被
 * `--_max-inline-size` 封顶 —— 只加 margin 会把容器（跨了 margin 轨道）
 * 撑宽，正文反而变宽，读者看到的正是「窄更宽、宽更窄」。修法是把封顶按
 * 边距反向收窄（`pageWidthFor`）。
 *
 * 断言的是**正文那一列的宽度**，不是盒子：盒子在宽窗下恒为 842px（封顶 +
 * 两侧 margin 之和不变），量它看不出方向。两个引擎的绝对像素不同，所以只
 * 钉顺序和幅度。
 */

/**
 * 分页器里那一节的正文列宽（CSS px）。
 *
 * 🔴 读 `documentElement` 的 `column-width`，不读 `body.getBoundingClientRect().width`：
 * 后者是**整章宽长条 iframe** 的总宽（本机量到 4841→4585），随章内分栏数
 * 和字体回退漂移 —— CI WebKit 就量出过「特宽 3826 → 上限 4585」的反向，
 * 一列变窄但总条反而变宽。`column-width` 是 paginator 为每一页算出的列宽，
 * 两引擎实测 728→674→600→536→472 单调，才是「正文有多宽」。
 */
const TEXT_WIDTH = `(() => {
  const pager = document.querySelector("foliate-view")?.shadowRoot
    ?.querySelector("foliate-paginator");
  const frame = pager?.shadowRoot?.querySelector("#container iframe");
  const doc = frame?.contentDocument;
  return doc ? Math.round(parseFloat(getComputedStyle(doc.documentElement).columnWidth) || 0) : 0;
})()`;

/** 按顺序点一遍页边距预设，读回每一次的正文宽度。 */
async function sweep(page: Page): Promise<number[]> {
  const widths: number[] = [];
  for (const chip of ["窄", "标准", "宽松", "特宽"]) {
    await page.getByRole("button", { name: chip, exact: true }).first().click();
    await page.waitForTimeout(900);
    widths.push(await page.evaluate(TEXT_WIDTH));
  }
  return widths;
}

/** 开一本 foliate 样书并打开阅读设置。 */
async function openSettings(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&epub=1");
  await page
    .getByRole("button", { name: /页码样书/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
}

test("页边距越宽，正文越窄", async ({ page }) => {
  await openSettings(page);
  const widths = await sweep(page);

  const [narrow, , , wide] = widths as [number, number, number, number];
  // 四档必须一路变窄 —— 反了就是回归。
  for (let i = 1; i < widths.length; i += 1) {
    expect(widths[i], `第 ${i + 1} 档没有比上一档更窄：${widths.join(" → ")}`).toBeLessThan(
      widths[i - 1]!,
    );
  }
  // 而且幅度得是真的：两端至少差出一行的几分之一，不是浮点噪声。
  expect(narrow - wide, `两端只差 ${narrow - wide}px：${widths.join(" → ")}`).toBeGreaterThan(60);

  // 滑块越过最宽预设（224）后还得继续收窄正文：若被 240px 页宽地板吃掉，
  // 放宽上限就只是读数变大、排版没动。
  const horizontal = page.locator('input[type="range"]').first();
  await horizontal.focus();
  await page.keyboard.press("End");
  await expect(horizontal).toHaveValue("288");
  await page.waitForTimeout(900);
  const atMax = await page.evaluate(TEXT_WIDTH);
  expect(atMax, `上限没有比「特宽」更窄：${wide} → ${atMax}`).toBeLessThan(wide);
});

/**
 * 「窄」和「标准」是整条边距的默认值，不只是左右那一半。
 *
 * 读者把上下拖走之后，除了拖滑块没有别的回头路；预设芯片上写着「窄」/「标准」，
 * 点下去却只还原左右，是一个说不通的状态。宽的那两档只代表左右，不动上下。
 * 这条钉住两档都把上下带回 54。
 */
test("点「窄」或「标准」把上下页边距也带回默认", async ({ page }) => {
  await openSettings(page);
  const vertical = page.locator('input[type="range"]').nth(1);
  for (const chip of ["窄", "标准"]) {
    // 每次重新聚焦：点过芯片之后焦点在按钮上。
    await vertical.focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowRight");
    await expect(vertical, "上下先被拖离默认值").not.toHaveValue("54");

    await page.getByRole("button", { name: chip, exact: true }).first().click();
    await expect(vertical, `${chip} 只还原了左右`).toHaveValue("54");
  }
});
