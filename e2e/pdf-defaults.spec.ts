import { expect, test, type Page } from "@playwright/test";

/** The reader store, exactly as Zustand persists it. */
type ReaderStore = {
  state: {
    layoutMode: string;
    pageTransition: string;
    byBook: Record<string, { layoutMode?: string; pageTransition?: string }>;
  };
};

function readerStore(page: Page): Promise<ReaderStore | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("fangce.reader");
    return raw ? (JSON.parse(raw) as ReaderStore) : null;
  });
}

async function openDemo(page: Page, query: string, title: RegExp) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(query);
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
}

test("a freshly opened PDF is seeded to a spread with no page turn", async ({ page }) => {
  await openDemo(page, "/?demo=1&pdf=1", /PDF 样书/);

  const store = await readerStore(page);
  expect(store?.state.byBook["demo-pdf"]).toMatchObject({
    layoutMode: "double",
    pageTransition: "none",
  });
  // The app-wide defaults are untouched — only this book carries the override.
  expect(store?.state.layoutMode).toBe("single");
  expect(store?.state.pageTransition).toBe("pan");

  // The panel reads the same per-book slot: it shows the seeded values, not
  // the shared defaults.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await expect(page.getByRole("button", { name: "双页", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the PDF seed never touches other formats", async ({ page }) => {
  await openDemo(page, "/?demo=1&epub=1", /页码样书/);

  const store = await readerStore(page);
  // No format other than PDF seeds a per-book slot, so the whole map stays
  // empty — no need to know the EPUB demo's id.
  expect(store?.state.byBook).toEqual({});
  expect(store?.state.layoutMode).toBe("single");
  expect(store?.state.pageTransition).toBe("pan");
});

test("reopening a PDF keeps a value the reader changed", async ({ page }) => {
  await openDemo(page, "/?demo=1&pdf=1", /PDF 样书/);

  // The reader sets 单页 back through the panel — the one key they touched must
  // win over the seed on every subsequent open.
  await page.getByRole("button", { name: "阅读设置" }).first().click();
  await page.getByRole("button", { name: "单页", exact: true }).click();
  await page.keyboard.press("Escape");

  const changed = await readerStore(page);
  expect(changed?.state.byBook["demo-pdf"]?.layoutMode).toBe("single");
  expect(changed?.state.byBook["demo-pdf"]?.pageTransition).toBe("none");

  // Reopen in the same context (localStorage survives navigation).
  await openDemo(page, "/?demo=1&pdf=1", /PDF 样书/);

  const reopened = await readerStore(page);
  expect(reopened?.state.byBook["demo-pdf"]).toMatchObject({
    layoutMode: "single",
    pageTransition: "none",
  });
});
