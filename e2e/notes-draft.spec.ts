/**
 * AI 补笔记 on the browser build's own notes page.
 *
 * The sample shelf carries five highlights, three of which already have a note.
 * The contract worth pinning is that a draft only ever fills an empty note:
 * selecting all five must produce two drafts, and applying them must leave the
 * reader's own three notes alone.
 *
 * `?demo=1` answers the two commands from `lib/demo.ts` instead of the model,
 * so this walks the whole review → confirm → write round trip without a key.
 */
import { expect, test } from "@playwright/test";

test("a draft is reviewed before it is written, and never overwrites a note", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await page.getByRole("link", { name: "笔记" }).click();
  await expect(page.getByRole("heading", { name: "笔记", level: 1 })).toBeVisible();

  const notes = page.locator("[data-notes-page]");
  const own = page.getByText(/全书的主线/);
  await expect(own).toBeVisible();

  await notes.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.locator("[data-batch-bar]");
  await bar.getByRole("button", { name: "全选" }).click();
  await bar.getByRole("button", { name: /AI 补笔记/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("AI 补笔记");
  await dialog.getByRole("button", { name: /开始建议/ }).click();

  // Two of the five highlights have no note; the other three are not offered.
  await expect(dialog.getByRole("button", { name: "应用：2 条" })).toBeVisible();
  await dialog.getByRole("button", { name: "应用：2 条" }).click();

  await expect(dialog.getByText(/已给 2 条补上笔记/)).toBeVisible();
  await dialog.getByRole("button", { name: "完成" }).click();

  // The drafts are in the same table the page reads, and the reader's own
  // words are still there.
  await expect(page.getByText("防御本身，而不是疾病：值得回头看")).toBeVisible();
  await expect(own).toBeVisible();
});
