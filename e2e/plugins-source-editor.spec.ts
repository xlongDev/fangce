import { expect, test } from "@playwright/test";

/**
 * The source editor must keep its own height inside the dialog's scroll area.
 *
 * The first fit fix used `flex flex-col` for the form; because a textarea is a
 * shrinkable flex item, the h-80 editor collapsed to two lines and dragging its
 * native resize handle was undone by the flex algorithm. Measure the height in
 * both engines; Chromium also drives a real drag. Playwright's WebKit runner
 * does not deliver that native handle gesture, so there we check the resize
 * style instead. JSDOM cannot see any of this.
 */
test("the source editor keeps its height and can be stretched", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto("/");
  // The lazy route is reached through the nav; opening /plugins directly
  // falls back to the shelf in the preview build (see the route guard).
  await page.getByRole("link", { name: "插件" }).click();
  await expect(page.getByRole("heading", { name: "插件", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /新建书源/ }).click();
  await page.getByText("怎么填？先看说明和示例").click();

  const dialog = page.getByRole("dialog");
  const editor = dialog.getByRole("textbox", { name: "书源规则" });
  await editor.scrollIntoViewIfNeeded();

  const before = await editor.boundingBox();
  expect(before, "editor has a box").not.toBeNull();
  expect(before!.height, "the editor is not shrunk to a strip").toBeGreaterThan(200);

  if (browserName === "webkit") {
    expect(await editor.evaluate((el) => getComputedStyle(el).resize)).toBe("vertical");
  } else {
    // The native handle lives in the last few pixels of the textarea.
    const box = before!;
    const x = box.x + box.width - 3;
    const y = box.y + box.height - 3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 120, { steps: 6 });
    await page.mouse.up();

    const after = await editor.boundingBox();
    expect(after!.height, "dragging the handle grows the editor").toBeGreaterThan(
      before!.height + 60,
    );
  }

  const save = await dialog.getByRole("button", { name: "保存" }).boundingBox();
  expect(save!.y + save!.height, "the actions stay inside the window").toBeLessThanOrEqual(700);
});
