import { expect, test, type Page } from "@playwright/test";

/**
 * Batch metadata on the browser build's own shelf.
 *
 * The contract worth pinning is the empty field: a batch is a wide operation,
 * and a reader who fills in 出版社 must not have 语言 blanked on thirty books at
 * the same time. `null` means "leave it alone" and `""` means "clear it", and
 * the two are one keystroke apart in this form.
 *
 * The browser build has its own implementation of the command (IndexedDB), so
 * the Rust tests do not cover this path — and the assertion is on the stored
 * rows, not on the toast, because a toast that says "已改" over rows that did
 * not change is exactly the kind of lie a test should not accept.
 */

const FIXTURES = ["public/demo/short-column.epub", "public/demo/sparse-opener.epub"] as const;
const TITLES = [/短列样书/, /开篇样书/];

async function importFixtures(page: Page): Promise<void> {
  for (const [index, path] of FIXTURES.entries()) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "导入书籍" }).first().click(),
    ]);
    await chooser.setFiles(path);
    await expect(page.getByRole("button", { name: TITLES[index]! }).first()).toBeVisible({
      timeout: 15_000,
    });
    const summary = page.getByRole("button", { name: "关闭" });
    if (await summary.isVisible()) await summary.click();
  }
}

/** `publisher` / `language` as stored, per title. */
async function storedFields(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fangce");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const all = database.transaction("books", "readonly").objectStore("books").getAll();
    const rows = await new Promise<
      { title: string; publisher: string | null; language: string | null }[]
    >((resolve, reject) => {
      all.addEventListener("success", () => resolve(all.result as never));
      all.addEventListener("error", () => reject(all.error));
    });
    database.close();
    return Object.fromEntries(
      rows.map((row) => [row.title, `${row.publisher ?? "—"}|${row.language ?? "—"}`]),
    );
  });
}

test("a batch edit touches only the fields that were filled in", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();
  await importFixtures(page);

  const before = await storedFields(page);
  const titles = Object.keys(before);
  expect(titles.length, "两本导入的书都在").toBe(2);
  const languages = titles.map((title) => before[title]!.split("|")[1]);

  await page.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.locator("[data-batch-bar]").filter({ hasText: "打标签" });
  await bar.getByRole("button", { name: "全选" }).click();
  await bar.getByRole("button", { name: "编辑信息" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("修改选中的 2 本书");
  await dialog.getByLabel("出版社").fill("批量出版社");
  await dialog.getByRole("button", { name: "改这 2 本" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("已改 2 本的出版社")).toBeVisible();

  const after = await storedFields(page);
  for (const title of titles) {
    const [publisher, language] = after[title]!.split("|");
    expect(publisher, `${title} 的出版社`).toBe("批量出版社");
    // The field nobody filled in is the one that must not move.
    expect(language, `${title} 的语言不该被清空`).toBe(before[title]!.split("|")[1]);
  }
  expect(languages.some((language) => language !== "—")).toBe(true);

  // Reopening with only 语言 filled leaves the publisher alone.
  await bar.getByRole("button", { name: "编辑信息" }).click();
  await dialog.getByLabel("语言").fill("en");
  await dialog.getByRole("button", { name: "改这 2 本" }).click();
  await expect(dialog).toBeHidden();

  const last = await storedFields(page);
  for (const title of titles) {
    const [publisher, language] = last[title]!.split("|");
    expect(publisher, `${title} 的出版社不该被第二次编辑抹掉`).toBe("批量出版社");
    expect(language).toBe("en");
  }
});
