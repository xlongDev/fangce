import { expect, test, type Page } from "@playwright/test";

/**
 * 两处默认值：自定义排版下的段首缩进，和朗读高亮的粒度。
 *
 * 都在 `DEFAULT_READER_SETTINGS` 里，也都在 v14 的 migrate 里 —— 只改前者的话
 * 只有「从没跑过这个构建的机器」看得到，装过的人读的是自己那份 persisted store。
 * 这条钉的是读者看得见的那一面：新书第一次点开 自定义，段首缩进就是开着的；
 * 第一次开朗读，高亮落在「词语」上。
 */

/** 打开样书并拉开阅读设置。 */
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
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.waitForTimeout(700);
}

test("自定义排版下段首缩进默认开着", async ({ page }) => {
  await openSettings(page);

  // 这一组只在 自定义 下存在 —— 跟随书籍时书里自己排，缩进轮不到我们管。
  await page.getByRole("button", { name: "自定义", exact: true }).first().click();
  await page.waitForTimeout(400);

  await expect(
    page.getByRole("button", { name: "缩进两字", exact: true }).first(),
    "段首缩进没有默认打开",
  ).toHaveAttribute("aria-pressed", "true");
});

test("朗读高亮默认是词语", async ({ page }) => {
  await openSettings(page);

  await expect(
    page.getByRole("button", { name: "词语", exact: true }).first(),
    "朗读高亮的默认不是词语",
  ).toHaveAttribute("aria-pressed", "true");
});
