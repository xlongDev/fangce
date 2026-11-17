import { expect, test } from "@playwright/test";

/**
 * 导入书籍 as a first-class command.
 *
 * Three surfaces share one registry entry: the palette lists it, 设置 › 快捷键
 * lists its key, and ⌘O runs it. The bridge behind the last one matters more
 * than the badge: the picker and every import mutation live inside
 * `LibraryPage`, while a hotkey can fire from settings with no shelf mounted.
 * A request has to survive that gap, and a second shelf taking it must not
 * open a second picker.
 */

const IMPORT = "导入书籍";

test("the import command is listed in the palette with its key", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill(IMPORT);

  const row = dialog.getByRole("button", { name: new RegExp(IMPORT) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("⌘ O");
});

test("the import command has a row in 设置 › 快捷键", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "快捷键", exact: true }).click();

  const section = page.locator('[data-section="keys"]');
  await expect(section.getByText(IMPORT, { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: `修改 ${IMPORT} 的按键` })).toBeVisible();
  // The label, its keycaps and the rebind button are one Row; checking the
  // section keeps the assertion off the panel's DOM shape.
  await expect(section).toContainText("⌘ O");
});

test("⌘O opens the picker while a shelf is mounted", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Control+o"),
  ]);
  expect(chooser).toBeTruthy();
  await chooser.setFiles([]);
});

test("⌘O from a non-shelf page lands on the shelf and opens the picker", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Control+o"),
  ]);
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  expect(chooser).toBeTruthy();
  await chooser.setFiles([]);
});

test("⌘O reaches the command while focus is inside a book", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/?demo=1&kindle=1");
  await page
    .getByRole("button", { name: /Kindle 样书/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(async () => {
      const frames = page.frames().filter((frame) => frame.url().startsWith("blob:"));
      const parts = await Promise.all(
        frames.map((frame) =>
          frame
            .locator("body")
            .innerText()
            .catch(() => ""),
        ),
      );
      return parts.join("\n");
    })
    .toContain("AZW3 与 MOBI 是同一个容器");

  // foliate attaches its section keydown listener as the section is set up;
  // the words can be painted a beat before the forwarder is listening.
  await page.waitForTimeout(300);
  const section = page.frames().find((frame) => frame.url().startsWith("blob:"))!;
  const box = (await section.locator("body").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe("FOLIATE-VIEW");

  // foliate's sections are blob: iframes, so a keydown there never bubbles to
  // the window hotkey listener. The reader forwards only keys the command
  // registry binds — this press proves 导入书籍 is in that set.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Control+o"),
  ]);
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  expect(chooser).toBeTruthy();
  await chooser.setFiles([]);
});

test("the palette's import row runs the same command", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(IMPORT);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: new RegExp(IMPORT) }).click(),
  ]);
  expect(chooser).toBeTruthy();
  await chooser.setFiles([]);
});
