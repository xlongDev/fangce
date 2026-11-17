import { expect, test } from "@playwright/test";

/**
 * The header used to offer four equally glassy pills, with the main action
 * marked only by coloured text. It now ends with one accent-tinted liquid-glass
 * primary; this pins the material difference, the far-right position, the
 * web-only drag hint and the divider that separates it from the slower paths.
 */
test("the shelf header ends with one accent-glass primary", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");

  const primary = page.getByRole("button", { name: /导入书籍/ });
  const secondary = page.getByRole("button", { name: /导入摘录/ });
  await expect(primary).toBeVisible();

  const material = await primary.evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    sheen: getComputedStyle(el).backgroundImage,
    last: el.parentElement?.lastElementChild === el,
  }));
  const secondaryBackground = await secondary.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );

  expect(material.sheen, "the primary catches light like every other pane").not.toBe("none");
  expect(material.background, "accent tint, not the neutral surface").not.toBe(secondaryBackground);
  expect(material.last, "the primary ends the row").toBe(true);

  await expect(primary).toContainText("可拖入文件");
  await expect(page.locator("[data-shelf-header-divider]")).toBeVisible();
});
