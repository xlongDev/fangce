import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppRouter } from "@/app/router";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { MiniBar } from "@/features/reader/MiniBar";
import "@/styles/globals.css";
// 🔴 No CJK face is imported here, and none is imported anywhere else either.
// The app ships zero font bytes: a face the reader wants comes from the
// catalogue (one click, `src/lib/fontCatalog.ts`) or from a file they bring,
// and both are declared at runtime. That is what keeps 29 MB of subsets out of
// the bundle, and it is also why the font the reader picks is held back rather
// than swapped in — see `useAdoptedFontKey`.

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root not found");

/**
 * The floating read-aloud bar is this same bundle in a second window, told
 * apart by one query parameter (`commands::mini_bar::build_bar` sets it).
 *
 * It mounts its own root rather than a route because the shell is a memory
 * router: there is no URL a second window could be pointed at. It also has to
 * be its own root for a reason that matters more — the providers, and with them
 * the engine, hang off `AppRouter`, and a second engine would mean a second
 * voice.
 *
 * The cost is the whole app being parsed in that window. It is paid once, on
 * the first minimize of a session, and splitting it would mean a `lazy()` entry
 * for the app it belongs to — which is a bigger change to what the first paint
 * downloads than a small window is worth.
 */
const mini = new URLSearchParams(window.location.search).has("mini");
if (mini) {
  // Unlayered and before the first paint: the window is transparent, and the
  // app's own background would otherwise fill the rectangle around the capsule.
  document.documentElement.classList.add("mini-bar");
}

/**
 * Which input last moved the focus, marked on <html> for `globals.css` to read.
 *
 * The app draws its own focus ring (`focus-ring`) rather than trusting the
 * UA's, and `:focus-visible` alone was not enough to decide when to draw it:
 * under WKWebView, with macOS's "keyboard navigation: all controls" setting on,
 * a mouse click also matches `:focus-visible`. Every button therefore kept a
 * 2px accent ring after every press — the sidebar footer, the reader's top
 * bar, the whole settings page. The rule is the same one browsers use, just
 * stated from the event that actually caused it: a pointer press means the
 * reader knows where the focus went, a key press means they may not.
 *
 * Capture phase so a handler that stops propagation cannot hide the modality.
 */
const markInput = (kind: "pointer" | "key") => {
  document.documentElement.dataset.input = kind;
};
window.addEventListener("pointerdown", () => markInput("pointer"), true);
window.addEventListener("keydown", () => markInput("key"), true);

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary scope={mini ? "朗读悬浮条" : "应用"}>
      {mini ? <MiniBar /> : <AppRouter />}
    </ErrorBoundary>
  </StrictMode>,
);
