import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { inkOn, rgbBytes } from "@/lib/color";
import { isDesktopRuntime } from "@/lib/ipc";
import {
  accentHex,
  useSettings,
  type AccentChoice,
  type ThemeMode,
  type TransparencyMode,
} from "@/stores/settings";

const THEME_MEDIA = "(prefers-color-scheme: light)";

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(THEME_MEDIA).matches ? "light" : "dark";
}

function applyTransparency(mode: TransparencyMode): void {
  document.documentElement.setAttribute("data-transparency", mode);
}

function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

/**
 * One inherited source for every accent token. Written on <html> rather than a
 * data attribute on each theme pane: the reader wraps its surface in its own
 * `data-theme`, so a value written only for the outer theme would be redeclared
 * and lost the moment a book opened. The default preset removes the override,
 * leaving the light/dark fallbacks in globals.css in charge.
 */
function applyAccent(choice: AccentChoice, mode: ThemeMode): void {
  const root = document.documentElement;
  if (choice.kind === "preset" && choice.id === "amber") {
    root.style.removeProperty("--accent-rgb-custom");
    root.style.removeProperty("--on-accent-custom");
    return;
  }
  const hex = accentHex(choice, resolveTheme(mode));
  const bytes = rgbBytes(hex);
  if (!bytes) return;
  root.style.setProperty("--accent-rgb-custom", bytes.join(" "));
  root.style.setProperty("--on-accent-custom", inkOn(hex));
}

/** Sync the settings store to the document, including live system changes. */
export function useTheme(): void {
  const theme = useSettings((state) => state.theme);
  const accent = useSettings((state) => state.accent);
  const transparency = useSettings((state) => state.transparency);

  useEffect(() => {
    applyTheme(theme);
    applyAccent(accent, theme);
    const onSystem = () => {
      if (useSettings.getState().theme === "system") {
        applyTheme("system");
        applyAccent(useSettings.getState().accent, "system");
      }
    };
    const mql = window.matchMedia(THEME_MEDIA);
    mql.addEventListener("change", onSystem);
    return () => mql.removeEventListener("change", onSystem);
  }, [theme, accent]);

  useEffect(() => {
    applyTransparency(transparency);
  }, [transparency]);

  // The webview's own appearance must follow the app theme, not the OS. A book
  // can ship `@media (prefers-color-scheme: dark)` rules — the one that started
  // this set a dark callout background — and that media query follows the window
  // appearance, which on desktop defaults to the OS. CSS cannot retarget it, so
  // with macOS in dark mode and the app in light a light-theme read still got
  // the book's night styles. `null` hands it back to the OS, so `system` still
  // tracks; a no-op in the browser build.
  useEffect(() => {
    if (!isDesktopRuntime) return;
    void getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch((cause: unknown) => console.warn("窗口外观同步失败", cause));
  }, [theme]);
}

/** The resolved light/dark appearance, reactive to both setting and system. */
export function useResolvedTheme(): "light" | "dark" {
  const mode = useSettings((state) => state.theme);
  const [sysLight, setSysLight] = useState(
    () => typeof window !== "undefined" && window.matchMedia(THEME_MEDIA).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(THEME_MEDIA);
    const onSystem = () => setSysLight(mql.matches);
    mql.addEventListener("change", onSystem);
    return () => mql.removeEventListener("change", onSystem);
  }, []);
  if (mode === "light" || mode === "dark") return mode;
  return sysLight ? "light" : "dark";
}
