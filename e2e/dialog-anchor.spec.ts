import { expect, test } from "@playwright/test";

import { expandSidebar } from "./layout";

/**
 * A modal centres on the content pane, not on the window.
 *
 * The sidebar pushes the pane right of the window's centre — measured on a
 * 1280px window, pane centre 770 against the window's 640 — so a
 * window-centred dialog sits 130px left of the surface it is covering and
 * reads as off-centre to anyone looking at the shelf. That is the whole of
 * "导入摘录的ui侧边栏展开的时候没有居中", and it is the second time this
 * reference was wrong: the batch-manage bar was placed against the window too,
 * and `shelf-manage.spec.ts` pins it for the same reason.
 *
 * Both assertions matter and neither is enough alone. Centring on the pane
 * passes the first; the second fails if the pane and the window happen to have
 * drifted together, which is what would happen if `data-content-pane` were
 * ever moved onto the shell instead of the reading surface.
 *
 * The import dialog is the one the reader reported, and it is a fine stand-in
 * for all of them: `GlassDialog` is a single component, so every dialog in the
 * app is anchored by the same code path.
 */
test("a dialog centres on the content pane, not the window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  const centreOf = async (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left + box.width / 2;
    });

  for (const collapsed of [false, true]) {
    if (collapsed) {
      await page.getByRole("button", { name: "折叠侧边栏" }).click();
      await page.waitForTimeout(600);
    }

    await page.getByRole("button", { name: /导入摘录/ }).click();
    const dialog = page.locator("[role='dialog']");
    await expect(dialog).toBeVisible();
    // The placement runs in a layout effect, but the spring settles after it.
    await page.waitForTimeout(400);

    const dialogCentre = await centreOf("[role='dialog']");
    const paneCentre = await centreOf("[data-content-pane]");
    const state = collapsed ? "collapsed" : "expanded";

    // ±2px: the spring lands within a couple of pixels at this size.
    expect(
      Math.abs(dialogCentre - paneCentre),
      `dialog should sit on the pane's centre with the sidebar ${state} (dialog ${dialogCentre}, pane ${paneCentre})`,
    ).toBeLessThan(2);
    // And the pane is not the window — with the sidebar open they are 130px
    // apart, so this fails if both drifted to the same wrong reference.
    expect(
      Math.abs(dialogCentre - 1280 / 2),
      `the pane's centre is not the window's (dialog ${dialogCentre})`,
    ).toBeGreaterThan(20);

    await page.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toBeHidden();

    if (collapsed) {
      await expandSidebar(page);
    }
  }
});
