import { expect, test, type Page } from "@playwright/test";

/**
 * Batch delete on the browser build's own shelf — the IndexedDB one.
 *
 * What is pinned here is the part that used to be quadratic. `bookDeleteMany`
 * read the whole `chapters` / `annotations` / `bookmarks` stores once *per
 * book* — no store carries an index on `bookId` — so a batch out of a library
 * with rows in those stores paid one full scan of each per book, and each full
 * scan deserializes on the main thread. Fifty books out of a shelf with ten
 * thousand highlights read those ten thousand rows fifty times; that, not the
 * deleting, is what a frozen page looked like from the outside. The batch now
 * reads the library once and deletes each book's rows in a transaction per
 * store.
 *
 * So the child rows are seeded straight into IndexedDB (no import writes
 * annotations), and the assertion is that they leave *with* the book: the cards
 * disappearing off the shelf is not enough on its own — an orphaned chapter row
 * would keep the book half alive, its search hits and its notes still there.
 */

const FIXTURES = ["public/demo/short-column.epub", "public/demo/sparse-opener.epub"] as const;
const TITLES = [/短列样书/, /开篇样书/];

/** Chapters, highlights, bookmarks and file bytes hanging off the two books —
 *  the rows a delete has to take with it.
 *
 *  The chapter keys sit at idx 900/901 on purpose: an import numbers a book's
 *  chapters from 0, so seeding there cannot overwrite a chapter the import
 *  really wrote — the delta assertion below measures the seed rather than a
 *  collision. (The first version seeded at 0/1 and read a delta of zero on
 *  both engines: the imports had already written exactly those keys.) */
async function seedChildRows(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(async (bookIds) => {
    const settled = <V>(input: IDBRequest<V>) =>
      new Promise<V>((resolve, reject) => {
        input.addEventListener("success", () => resolve(input.result));
        input.addEventListener("error", () => reject(input.error));
      });
    const database = await settled(indexedDB.open("fangce"));
    const transaction = database.transaction(
      ["files", "chapters", "annotations", "bookmarks"],
      "readwrite",
    );
    for (const id of bookIds) {
      transaction
        .objectStore("files")
        .put({ type: "application/epub+zip", bytes: new Uint8Array([1, 2, 3]).buffer }, id);
      transaction
        .objectStore("chapters")
        .put({ idx: 900, title: "播种章一", paragraphs: ["正文"] }, `${id}:900`);
      transaction
        .objectStore("chapters")
        .put({ idx: 901, title: "播种章二", paragraphs: ["更多正文"] }, `${id}:901`);
      transaction.objectStore("annotations").put(
        {
          id: `a-${id}`,
          bookId: id,
          chapterIdx: 0,
          startChar: 0,
          endChar: 2,
          text: "正文",
          createdAt: 1,
          updatedAt: 1,
        },
        `a-${id}`,
      );
      transaction.objectStore("bookmarks").put(
        {
          id: `m-${id}`,
          bookId: id,
          chapterIdx: 0,
          fraction: 0.5,
          label: "页签",
          createdAt: 1,
          updatedAt: 1,
        },
        `m-${id}`,
      );
    }
    // A write is settled by the transaction, not by its requests — the same
    // rule `lib/local/db.ts` learned the hard way.
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    database.close();
  }, ids);
}

/** Ids of the books on the shelf. */
async function shelfIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fangce");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const all = database.transaction("books", "readonly").objectStore("books").getAll();
    const rows = await new Promise<{ id: string }[]>((resolve, reject) => {
      all.addEventListener("success", () => resolve(all.result as { id: string }[]));
      all.addEventListener("error", () => reject(all.error));
    });
    database.close();
    return rows.map((row) => row.id);
  });
}

/** How many rows each store still holds for the given books: chapters and
 *  bytes by key, the marks by their `bookId`. */
interface StoreCounts {
  books: number;
  files: number;
  chapters: number;
  annotations: number;
  bookmarks: number;
}

async function rowsLeftFor(page: Page, ids: string[]): Promise<StoreCounts> {
  return page.evaluate(async (bookIds) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fangce");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const rows = async <T>(store: string) => {
      const all = database.transaction(store, "readonly").objectStore(store).getAll();
      return new Promise<T[]>((resolve, reject) => {
        all.addEventListener("success", () => resolve(all.result as T[]));
        all.addEventListener("error", () => reject(all.error));
      });
    };
    const keys = async (store: string) => {
      const all = database.transaction(store, "readonly").objectStore(store).getAllKeys();
      return new Promise<IDBValidKey[]>((resolve, reject) => {
        all.addEventListener("success", () => resolve(all.result));
        all.addEventListener("error", () => reject(all.error));
      });
    };
    const wanted = new Set(bookIds);
    const [books, files, chapters, annotations, bookmarks] = await Promise.all([
      rows<{ id: string }>("books"),
      keys("files"),
      keys("chapters"),
      rows<{ bookId: string }>("annotations"),
      rows<{ bookId: string }>("bookmarks"),
    ]);
    database.close();
    // Chapter and file keys are `<bookId>` / `<bookId>:<idx>` / `<bookId>:cover`
    // — the prefix test is the honest one, the same the delete path groups by.
    const belongs = (key: IDBValidKey) =>
      wanted.has(String(key)) || wanted.has(String(key).split(":")[0] ?? "");
    return {
      books: books.filter((row) => wanted.has(row.id)).length,
      files: files.filter(belongs).length,
      chapters: chapters.filter(belongs).length,
      annotations: annotations.filter((row) => wanted.has(row.bookId)).length,
      bookmarks: bookmarks.filter((row) => wanted.has(row.bookId)).length,
    };
  }, ids);
}

/** Imports the two fixtures through the shelf's own picker, the way a reader
 *  would — the browser import path is what writes the real rows. */
async function importFixtures(page: Page): Promise<void> {
  for (const [index, path] of FIXTURES.entries()) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "导入书籍" }).first().click(),
    ]);
    await chooser.setFiles(path);
    // This fixture's own card, not the first one's: the second import's wait
    // has to be on the book that is still being parsed.
    await expect(page.getByRole("button", { name: TITLES[index]! }).first()).toBeVisible({
      timeout: 15_000,
    });
    // The corner summary would otherwise sit over the shelf's next actions.
    const summary = page.getByRole("button", { name: "关闭" });
    if (await summary.isVisible()) await summary.click();
  }
}

test("a batch delete takes every book's rows with it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // No `?demo=1`: the real shelf, backed by IndexedDB.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  await importFixtures(page);
  const ids = await shelfIds(page);
  expect(ids.length, "两本导入的书都该在书架上").toBe(2);

  // The imports already wrote chapter rows of their own, so the seeds are
  // counted as a delta rather than against a fixed number.
  const before = await rowsLeftFor(page, ids);
  await seedChildRows(page, ids);
  const seeded = await rowsLeftFor(page, ids);
  expect(seeded.chapters - before.chapters, "播种的章节行").toBe(4);
  expect(seeded.annotations - before.annotations, "播种的高亮行").toBe(2);
  expect(seeded.bookmarks - before.bookmarks, "播种的书签行").toBe(2);

  await page.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.locator("[data-batch-bar]");
  await expect(bar).toContainText("已选 0 本");

  await bar.getByRole("button", { name: "全选" }).click();
  await expect(bar).toContainText("已选 2 本");

  await bar.getByRole("button", { name: "删除" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("删除选中的 2 本书？");
  await dialog.getByRole("button", { name: "删除", exact: true }).click();

  // Radix hides everything behind an open dialog: the content outside it goes
  // `aria-hidden`, and a role query skips that subtree. So while the confirm
  // dialog is up — its exit animation included — "the card is gone" is true
  // whether or not it ever left, and the loop below would pass over a shelf
  // that still holds both books. Waiting for the node to detach is what gives
  // that assertion its meaning back.
  await expect(dialog).toBeHidden();

  // The cards go, and the shelf comes back empty rather than half-deleted.
  for (const title of TITLES) {
    await expect(page.getByRole("button", { name: title })).toHaveCount(0);
  }

  // The rows go with them — this is the assertion the old per-book scan could
  // fail: an orphaned chapter, highlight or bookmark row would keep a deleted
  // book searchable and in the notes list.
  //
  // Polled, not read once: the confirm click only *starts* the batch.
  // `useShelfSelection.confirmDelete` fires the mutation and closes the dialog
  // without awaiting it, so a read taken the moment the cards vanish can beat
  // the transactions — on a loaded machine that read found every row still
  // there, twice in eight runs. A row that outlives its book never lands, so
  // the poll still times out on exactly the orphan this assertion exists to
  // catch.
  await expect
    .poll(() => rowsLeftFor(page, ids), {
      timeout: 15_000,
      message: "删除后仍有书的子行残留（章节 / 高亮 / 书签 / 文件）",
    })
    .toEqual({ books: 0, files: 0, chapters: 0, annotations: 0, bookmarks: 0 });

  // Selection was spent; the mode stays open for the next batch.
  await expect(bar).toContainText("已选 0 本");
});
