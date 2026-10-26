import { Suspense, useEffect, useMemo, type CSSProperties } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";

import { SidebarGlyph, TitleBar } from "@/components/layout/TitleBar";
import { NavList } from "@/components/layout/NavList";
import { UpdateBanner } from "@/components/layout/UpdateBanner";
import { CommandPalette } from "@/components/command/CommandPalette";
import { GlassSidebar } from "@/components/glass/sidebar";
import { GlassPanel } from "@/components/glass/panel";
import { GlassIconButton } from "@/components/glass/button";
import { Wordmark } from "@/components/brand/Wordmark";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { BookCoverFlight } from "@/components/motion/BookCoverFlight";
import { fontFaceCss, readerGlassVars } from "@/features/reader/theme";
import { TtsHost } from "@/features/reader/TtsHost";
import { TtsPlayer } from "@/features/reader/TtsPlayer";
import { useCommandPalette } from "@/stores/command-palette";
import { useSettings } from "@/stores/settings";
import { useChrome } from "@/stores/chrome";
import { useActiveReadingSurface } from "@/hooks/useReadingSurface";
import { useDeepLink } from "@/hooks/useDeepLink";
import { useFonts } from "@/hooks/useFonts";
import { useHotkeys } from "@/hooks/useHotkeys";
import { registerCoreCommands, useNavigationBridge } from "@/features/command/registerCoreCommands";
import { DURATION, EASE_OUT } from "@/lib/motion";

// Sidebar content, shared verbatim by the docked pane and the fullscreen edge
// overlay — the overlay is the same sidebar the user already has, just
// summoned over the reading area.
function sidebarBody(collapsed: boolean) {
  return (
    <>
      {/* `pl-[13px]` is 12 + 1: every nav row spends 1px on a transparent
          border before its own padding, and the mark only sits on the same
          centre line as the icons if this row spends the same one. Measured
          before: mark cx 48, first nav icon cx 49 — one pixel, visible
          because the spectrum is the highest-contrast thing up here. */}
      <div className="flex items-center pt-1 pr-3 pl-[13px]" data-tauri-drag-region>
        <Wordmark compact={collapsed} />
      </div>
      <NavList />
      <div className="mt-auto px-1">
        <NavList.Footer />
      </div>
    </>
  );
}

/**
 * The four shelf views — one page with four filters.
 *
 * Keyed together so the transition does not treat them as four pages. A change
 * of filter then keeps the same `LibraryPage`: the chrome is identical, so only
 * the content should move, and remounting the shelf meant **two** of them on
 * screen for the length of every swap — 168 covers for an 84-book library, on
 * the switches a reader makes most.
 */
const SHELF_VIEWS = new Set(["/", "/recent", "/favorites", "/tags"]);

/**
 * How far a page travels while being swapped for a sibling, in px.
 *
 * Longer than the vocabulary's `RISE` (10px) on purpose: this is the one motion
 * in the shell that is about *direction* rather than arrival, and 10px reads as
 * a settle rather than a step.
 */
const PAGE_SHIFT = 28;

/**
 * The direction the sidebar recorded on the link that was clicked: +1 for a step
 * down the list, -1 for a step up, 0 for everything that is not a step in that
 * list (the reader, 设置, the command palette, a deep link). See `NavList`.
 */
function stepOf(state: unknown): number {
  const step = (state as { step?: unknown } | null)?.step;
  return typeof step === "number" ? step : 0;
}

/**
 * The swap, as variants, because `custom` is how the direction reaches the
 * leaving page: `AnimatePresence` renders that one from the element it captured
 * before the route changed, so it cannot read the new location for itself.
 *
 * `enter` comes in from the side the reader moved toward and `exit` carries on
 * that way, so the two pages move as one surface stepping through the list.
 * Both collapse to a plain cross-fade at step 0.
 */
const swap: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: direction * PAGE_SHIFT }),
  center: { opacity: 1, y: 0 },
  exit: (direction: number) => ({
    opacity: 0,
    y: direction * -PAGE_SHIFT,
    transition: { duration: DURATION.fast, ease: EASE_OUT },
  }),
};

export function AppShell() {
  useHotkeys();
  useNavigationBridge();
  // Lives here rather than on the reader route: a link opens a book from
  // wherever the reader is, and /reader is not where it arrives.
  useDeepLink();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const sidebarHidden = useSettings((s) => s.sidebarHidden);
  const showSidebar = useSettings((s) => s.setSidebarHidden);
  const readerFullscreen = useChrome((s) => s.readerFullscreen);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const reduce = useReducedMotion();

  // While a book is open the whole window wears the reading surface: the
  // chrome palette (data-theme) pairs with the surface's light/dark mode and
  // the glass tokens re-root on its ink with the paper colour as the window
  // backdrop, so title bar, sidebar and panels read as one material with the
  // page. A manually picked night surface darkens the chrome even in a light
  // app theme, and vice versa.
  const { pathname, state } = useLocation();
  const reading = pathname.startsWith("/reader");

  /**
   * Which way the reader moved down the sidebar, for the swap this render is
   * about to start. Carried on the navigation (`NavList` writes it), so it is
   * available here without either reading a ref while rendering or holding the
   * previous route in state for a second render of a heavy page.
   */
  const step = stepOf(state);

  /**
   * The route element, resolved here rather than by an `<Outlet/>` in the tree.
   *
   * `AnimatePresence` keeps rendering the child it is sending out long after the
   * route has changed, and it renders *that element* again — so a nested
   * `<Outlet/>` re-resolves against the route that just arrived and the page on
   * its way out becomes a second copy of the page coming in. Measured: entering
   * the reader mounted two `ReaderPage`s in one commit, the spare unmounting
   * 229 ms later when the exit ended; the shelf did the same on the way back,
   * which is why a cover looked redrawn just after a flight landed — two copies
   * of the tile were cross-fading ten pixels apart.
   *
   * `useOutlet()` hands back the element already resolved, so the child
   * AnimatePresence holds on to keeps showing the page it is leaving.
   */
  const outlet = useOutlet();
  // The paper the reader is painting, which the shell re-roots its own glass
  // tokens from: one resolution for the whole app — see `useReadingSurface`.
  const surface = useActiveReadingSurface();
  const shellStyle = reading
    ? ({ ...readerGlassVars(surface), "--app-bg": surface.tint } as CSSProperties)
    : undefined;

  useEffect(() => {
    return registerCoreCommands({ openPalette: () => setOpen(true) });
  }, [setOpen]);

  const sidebarGone = sidebarHidden || readerFullscreen;

  // `@font-face` for the fonts the reader imported, declared once for the app
  // document. A book section is a document of its own and gets its own copy
  // with the injected sheet, but everything rendered *here* — the prose path,
  // the settings picker, the popup — needs this one. The empty list is inside
  // the memo so it cannot re-create the sheet on every render.
  const fonts = useFonts();
  const fontFaces = useMemo(() => fontFaceCss(fonts.data ?? []), [fonts.data]);

  // Navigating out of the reader ends the immersive chrome even if the OS
  // window is still fullscreen — the shell must never be left chrome-less.
  const setReaderFullscreen = useChrome((s) => s.setReaderFullscreen);
  useEffect(() => {
    if (!reading && readerFullscreen) setReaderFullscreen(false);
  }, [reading, readerFullscreen, setReaderFullscreen]);

  // Remember where a book was opened from, for the reader's 返回. Written from
  // the shell because every route lands here and the reader is not mounted
  // when the trip starts; `reading` is excluded so a reader-to-reader jump
  // (a citation in another book) cannot overwrite the real origin.
  const setReaderReturnPath = useChrome((s) => s.setReaderReturnPath);
  useEffect(() => {
    if (!reading) setReaderReturnPath(pathname);
  }, [reading, pathname, setReaderReturnPath]);

  return (
    // The read-aloud engine is hosted here rather than in the reader, so a
    // session outlives the page it started on — that is the whole of "keeps
    // playing in the background". It wraps the shell without adding an element.
    <TtsHost>
      <div
        className="relative flex h-[100dvh] flex-col"
        data-theme={reading ? surface.mode : undefined}
        style={shellStyle}
      >
        <style>{fontFaces}</style>
        <div className="app-backdrop" />
        <div className="app-grain" />
        {!readerFullscreen && <TitleBar />}
        {/* The one place an update can appear without being asked for: one
            delayed check per launch, and this bar is what it raises. Mounted
            always (the check runs while the reader is fullscreen too); it
            renders nothing in the immersive reader — see `UpdateBanner`. */}
        <UpdateBanner />
        <div
          className={
            readerFullscreen ? "flex min-h-0 flex-1" : "flex min-h-0 flex-1 gap-3 px-3 pb-3"
          }
        >
          <GlassSidebar hidden={sidebarGone}>{sidebarBody(collapsed)}</GlassSidebar>
          {readerFullscreen && !sidebarHidden && (
            // Fullscreen: the sidebar docks off-canvas and slides in while the
            // pointer rests on the top or bottom strip of the left edge — the
            // middle band stays dead so the flip arrows keep working. It floats
            // with the same rounded corners as the docked pane, in the opaque
            // overlay material so it stays readable over bright pages on dark
            // surfaces. Honours 隐藏侧边栏: hidden means hidden here too.
            <div className="group/edge pointer-events-none absolute inset-y-0 left-0 z-50">
              {/* Explicit width: an absolutely positioned container with only
                absolute children is zero-width, and inset-x-0 strips inside it
                would be zero-width too — the regression that killed the
                summon gesture. */}
              <div
                className="pointer-events-auto absolute top-0 left-0 h-[30%] w-1.5"
                aria-hidden
              />
              <div
                className="pointer-events-auto absolute bottom-0 left-0 h-[30%] w-1.5"
                aria-hidden
              />
              <div className="pointer-events-auto absolute inset-y-0 left-0 my-3 flex -translate-x-full opacity-0 transition-all duration-200 ease-out group-hover/edge:translate-x-0 group-hover/edge:opacity-100 motion-reduce:transition-none">
                <GlassSidebar overlay hidden={false}>
                  {sidebarBody(collapsed)}
                </GlassSidebar>
              </div>
            </div>
          )}
          {/* 隐藏侧边栏 has no docked restore button any more: the toggle in
              `TitleBar` is always there and always reachable, so a second one
              at the window's left edge only read as the rail failing to leave
              completely. Fullscreen still needs its own, because the title
              bar is not rendered then. */}
          {sidebarHidden && readerFullscreen && (
            // Docked into the quiet bottom-left corner rather than mid-edge,
            // where the flip arrow lives — clear of the footer hud too.
            <GlassIconButton
              label="显示侧边栏"
              size="sm"
              onClick={() => showSidebar(false)}
              className="glass-solid absolute bottom-10 left-3 z-30"
            >
              <SidebarGlyph expanded={false} />
            </GlassIconButton>
          )}
          <GlassPanel
            // The pane everything is read in, and the reference a modal centres
            // itself against. The sidebar pushes it ~130px right of the window's
            // centre, so a window-centred dialog reads as off-centre. See
            // `GlassDialog`.
            data-content-pane
            className={
              readerFullscreen
                ? "relative min-w-0 flex-1 overflow-hidden rounded-none"
                : "relative min-w-0 flex-1 overflow-hidden"
            }
          >
            {/* Per-route boundary: a crashing feature page keeps the sidebar and
              the command palette alive so the user can navigate away. */}
            <ErrorBoundary scope="页面" bare>
              {/* Lazy route chunks resolve on first navigation; local disk,
                so a plain fallback is enough. */}
              <Suspense fallback={null}>
                {/* Swapping pages: the page the reader left carries on in the
                  direction they moved down the sidebar, and the one they asked
                  for comes in from the other side, so the two read as one
                  surface stepping through the list. `popLayout` takes the
                  leaving page out of flow, so the arriving one is laid out at
                  its final place on the first frame rather than being pushed
                  around by a page that is already on its way out.

                  What this must not animate is anything that changes the
                  resolution of the page's raster, and both alternatives did:

                  1. It used to animate `filter: blur(6px)`, which re-rasterises
                     the whole layer every frame — the most expensive thing this
                     shell could animate, on every navigation. A `filter` — even
                     `blur(0px)` — also makes its element the containing block
                     for `position: fixed` descendants, and that resting value
                     is what put the reader's selection toolbar 273 px off and
                     sliced it at the pane edge.
                  2. It then carried the depth with `scale`, which has the same
                     cost for the same reason: a scaled subtree is rasterised at
                     the new resolution each frame. A reader page (composited
                     section iframes) and a shelf (a few hundred covers) are the
                     worst cases for it, and the reader -> shelf direction pays
                     it twice, on both pages at once.

                  A translate moves an already-rasterised layer. At rest motion
                  normalises the offset away, so the wrapper is neither a filter
                  nor a transform and fixed overlays inside a page keep the
                  viewport as their containing block. */}
                <AnimatePresence mode="popLayout" initial={false} custom={step}>
                  <motion.div
                    key={SHELF_VIEWS.has(pathname) ? "shelf" : pathname}
                    data-page-swap={pathname}
                    custom={step}
                    variants={swap}
                    initial={reduce ? false : "enter"}
                    animate="center"
                    exit={reduce ? undefined : "exit"}
                    // Leaving is quicker than arriving. Both pages are mounted for
                    // as long as the exit runs, and the page being left is the
                    // expensive one — the reader holds the whole book and its
                    // section iframes while the shelf mounts underneath it. A
                    // short exit cuts that overlap window roughly in half and
                    // reads as the new page taking over rather than two pages
                    // trading places; the arriving page keeps the house duration.
                    transition={{ duration: reduce ? 0 : DURATION.base, ease: EASE_OUT }}
                    className="h-full"
                  >
                    {outlet}
                  </motion.div>
                </AnimatePresence>
              </Suspense>
            </ErrorBoundary>
            {/* Read-aloud, anchored to the pane's own bottom edge: the pill
              follows the reader from route to route, and the card opens over
              whatever page is behind it. Inside the pane rather than in the
              window so it lines up with the content the sidebar leaves behind —
              the `relative` above is what gives it that origin.

              Two things the reader owns that this has to be told, because it is
              no longer inside the reader: whether to paint itself in the reading
              surface's ink (`onReadingSurface` — the same material as the page
              it is floating on), and whether the pane's bottom edge is already
              taken by the reader's own footer. */}
            <TtsPlayer onReadingSurface={reading} liftForFooter={reading && !readerFullscreen} />
          </GlassPanel>
        </div>
        {/* Where the reader's floating overlays are portalled: the selection
          toolbar and the 词典/翻译 popup.

          A `backdrop-filter` makes its element the containing block for
          `position: fixed` descendants (as does a `filter` or a `transform`).
          The pane above carries one for the glass, and it also has
          `overflow: hidden` — so an overlay rendered inside it was positioned
          from the pane's own origin and then sliced by the pane's edge. The
          selection toolbar landed 273px right and 37px low, and lost its right
          end to the page edge.

          This host sits inside the shell, so the reading surface's tokens and
          `data-theme` still reach the overlays; everything portalled into it
          is `position: fixed`, so it takes no room in the column. */}
        <div data-overlay-host>
          {/* The cover carried from the shelf into the reader lives here, not in
            the reader: a route change blurs and scales the page it leaves, and
            an element inside that page would be dragged along with it. */}
          <BookCoverFlight />
        </div>
        <CommandPalette />
      </div>
    </TtsHost>
  );
}
