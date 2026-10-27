/**
 * Routes other surfaces send the reader to.
 *
 * The hash is a settings group id (`[data-section]`), not a scroll anchor the
 * browser resolves: `SettingsPage` reads it on arrival and hands it to the same
 * jump its rail uses. A reader told their key was rejected should land on the
 * field that holds it, not at the top of a nine-group page.
 */
export const AI_SETTINGS = "/settings#ai";
