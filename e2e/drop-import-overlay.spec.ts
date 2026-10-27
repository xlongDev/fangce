import { expect, test, type Page } from "@playwright/test";

import { expandSidebar } from "./layout";

/**
 * The drop invitation covers the content pane, and centres on it.
 *
 * The overlay used to be `fixed` over the whole window: the panel landed on the
 * window's centre, 130px left of the shelf it was inviting a drop onto, and the
 * scrim dimmed the sidebar as though a file could be dropped on the nav. The
 * drop zone is the shelf — the browser build's own handlers sit on it — so the
 * overlay now takes the pane's box: `absolute` inside the pane's `relative`,
 * no measuring and nothing to drift when the sidebar is toggled. This pins
 * both halves of that, the same way `dialog-anchor.spec.ts` pins the modals.
 *
 * Both assertions matter and neither is enough alone. The panel's centre
 * matching the pane's passes a window-centred overlay only when the pane and
 * the window happen to agree; the second half fails then, which is the whole
 * point of measuring the pane rather than trusting it.
 */

/** The browser build's drop path: the shelf root listens for HTML5 drags, so a
 *  synthetic one is the real gesture — the desktop build takes the same state
 *  from Tauri's own drag events instead. */
async function dragOverShelf(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector("[data-shelf-scroller]")!.parentElement!;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["x"], "a.epub"));
    for (const type of ["dragenter", "dragover"]) {
      root.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    }
  });
}

/** Ends the gesture without importing anything: the pointer left the shelf. */
async function leaveShelf(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector("[data-shelf-scroller]")!.parentElement!;
    root.dispatchEvent(
      new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: document.body }),
    );
  });
}

test("the drop overlay is the pane, centred on it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?demo=1");
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();

  for (const collapsed of [false, true]) {
    if (collapsed) {
      await page.getByRole("button", { name: "折叠侧边栏" }).click();
      await page.waitForTimeout(600);
    }

    await dragOverShelf(page);
    const overlay = page.locator("[data-drop-overlay]");
    await expect(overlay).toBeVisible();
    await expect(page.getByText("松开即可导入")).toBeVisible();
    // The panel scales in on the panel spring; measure it settled.
    await page.waitForTimeout(500);

    const overlayBox = (await overlay.boundingBox())!;
    const paneBox = (await page.locator("[data-content-pane]").boundingBox())!;
    const panelBox = (await page.getByText("松开即可导入").boundingBox())!;
    const state = collapsed ? "collapsed" : "expanded";

    // The pane wears a hairline, and `absolute inset-0` lands on the padding
    // box — inside it. That is the right side of the line: the pane's frame
    // stays drawn over the scrim instead of being dimmed under it, and the
    // scrim follows the pane's rounded corners. So the expected offset is the
    // border width, not zero.
    const border = await page
      .locator("[data-content-pane]")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).borderLeftWidth) || 0);

    expect(
      Math.abs(overlayBox.x - paneBox.x - border) + Math.abs(overlayBox.y - paneBox.y - border),
      `the scrim should start inside the pane's hairline with the sidebar ${state} (overlay ${overlayBox.x},${overlayBox.y} vs pane ${paneBox.x},${paneBox.y}, border ${border})`,
    ).toBeLessThan(1);
    expect(
      Math.abs(overlayBox.width - (paneBox.width - 2 * border)) +
        Math.abs(overlayBox.height - (paneBox.height - 2 * border)),
      `the scrim should fill the pane's padding box with the sidebar ${state} (overlay ${overlayBox.width}x${overlayBox.height} vs pane ${paneBox.width}x${paneBox.height})`,
    ).toBeLessThan(1);

    // And the panel sits on the pane's centre, not the window's.
    const panelCentre = panelBox.x + panelBox.width / 2;
    const paneCentre = paneBox.x + paneBox.width / 2;
    expect(
      Math.abs(panelCentre - paneCentre),
      `the panel should sit on the pane's centre with the sidebar ${state} (panel ${panelCentre}, pane ${paneCentre})`,
    ).toBeLessThan(2);

    if (!collapsed) {
      // The pane is not the window: with the sidebar open they are 130px
      // apart, so this fails if the overlay ever goes back to the window.
      expect(
        Math.abs(paneCentre - 1280 / 2),
        `the pane's centre is not the window's (pane ${paneCentre})`,
      ).toBeGreaterThan(20);
      // The sidebar is left out of it entirely — a file dropped on the nav is
      // not a book imported, so the nav keeps its own appearance.
      const sidebarBox = await page
        .locator("[data-content-pane]")
        .evaluate((el) => el.previousElementSibling!.getBoundingClientRect().toJSON());
      expect(overlayBox.x, "the scrim should start right of the sidebar").toBeGreaterThan(
        sidebarBox.right - 1,
      );
    }

    await leaveShelf(page);
    await expect(overlay).toBeHidden();

    if (collapsed) {
      await expandSidebar(page);
    }
  }
});
