/**
 * Routes that show a shelf.
 *
 * Shared by the page-swap key in `AppShell` and by the import command: a
 * command leaving a non-shelf page must navigate before asking a shelf to
 * answer, and the two places must agree on what counts as one. `trash` is
 * deliberately not here — it is the bin, not the library an import lands in.
 */
export const SHELF_VIEWS: ReadonlySet<string> = new Set(["/", "/recent", "/favorites", "/tags"]);

/**
 * Routes other surfaces send the reader to.
 *
 * The hash is a settings group id (`[data-section]`), not a scroll anchor the
 * browser resolves: `SettingsPage` reads it on arrival and hands it to the same
 * jump its rail uses. A reader told their key was rejected should land on the
 * field that holds it, not at the top of a nine-group page.
 */
export const AI_SETTINGS = "/settings#ai";
