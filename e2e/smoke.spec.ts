import { expect, test } from "@playwright/test";

// Smoke E2E over the production build (`pnpm build` output, served by
// `vite preview`). Outside the Tauri shell the data layer is empty, so every
// page must render its empty state; the point is that each route chunk loads
// and nothing throws.

test("all routes render without console errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  // Lazy route chunks: first navigation triggers the network fetch. The
  // outgoing page stays mounted for the cross-fade, and it carries a search
  // field of its own, so the assertion has to pick the incoming one.
  await page.getByRole("link", { name: "搜索" }).click();
  await expect(page.getByPlaceholder("搜索正文").first()).toBeVisible();

  // The plugin page is the second lazy route that carries its own data hooks.
  await page.getByRole("link", { name: "插件" }).click();
  await expect(page.getByRole("heading", { name: "插件", level: 1 })).toBeVisible();

  // 设置 is the sidebar footer's gear button, not a nav link. The route
  // cross-fade keeps the outgoing page mounted for a beat — and the incoming
  // one can sit in the tree more than once while it settles — so assert on the
  // settled state rather than on the first paint.
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("navigation", { name: "设置分类" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "外观" })).toHaveCount(1);

  await page.getByRole("link", { name: "书库" }).click();
  await expect(page.getByRole("button", { name: "导入书籍" }).first()).toBeVisible();

  expect(pageErrors, "console/page errors must stay empty").toEqual([]);
});

/**
 * A setting the reader chose survives a reload.
 *
 * The routes above only prove the chunks load; this is the one test that
 * follows data end to end — control → store → localStorage → back onto the
 * document — which is also the only round trip the web preview can do without
 * the Tauri backend. Regression bait: the persistence key or the store's
 * rehydration can break while every page still renders fine.
 */
test("a theme change survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "外观" })).toHaveCount(1);

  // Playwright's default is a light OS preference, so the initial attribute is
  // whatever "跟随系统" resolves to — assert the change, not the starting value.
  const before = await page.locator("html").getAttribute("data-theme");
  await page.locator("label").filter({ hasText: "深色" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(before).not.toBe("dark");
});
