import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";

/**
 * Drag band above the content. On macOS the window uses an overlay title bar,
 * so the traffic lights sit inside this region; on Windows/Linux it is the
 * strip you grab to move the window.
 *
 * The sidebar toggle lives here because it has to outlive the sidebar. A
 * hidden rail persists across launches, so a toggle docked *inside* the rail
 * was the only way back into a thing that had just been removed — closing it
 * left a lone caret floating at the window's left edge. Up here it is always
 * reachable, and the left edge stays empty once the rail is gone.
 *
 * `data-tauri-drag-region` does not swallow this button: tauri's drag script
 * walks the event's composed path against a clickable-tag list (BUTTON among
 * them) and gives up on dragging when it finds one, so neither
 * `stopPropagation` nor a second drag attribute is needed — adding either
 * would only get in the way of double-click-to-zoom.
 */

/**
 * macOS is the only platform whose traffic lights are drawn into this strip,
 * and therefore the only one where the toggle has to dodge them. Read once at
 * module load: a renderer never migrates between platforms at runtime.
 */
const HAS_TRAFFIC_LIGHTS = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

export function TitleBar() {
  const hidden = useSettings((s) => s.sidebarHidden);
  const setHidden = useSettings((s) => s.setSidebarHidden);
  // The label names the action, not the state, so the button says what will
  // happen when it is pressed — a rail that is already hidden offers "显示".
  const label = hidden ? "显示侧边栏" : "隐藏侧边栏";

  return (
    <div data-tauri-drag-region className="relative h-9 shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={!hidden}
        title={label}
        onClick={() => setHidden(!hidden)}
        className={cn(
          // Measured off two screenshots rather than guessed: at `top-6` the
          // glyph's centre sat 3.5px below the red light's, at `top-4` it sat
          // 0.5px above (both at 1.92× scale, so ~1.8px and ~0.26px real).
          // The true centre is between them; 5 leans a hair low on purpose —
          // sitting slightly under reads as aligned, slightly over reads as
          // floating.
          // `rounded-xs` (10px) rather than `rounded-md`: the latter is 18px
          // here, which on a 30×28 button is a pill — the hover wash read as a
          // circle the glyph was sitting inside rather than as a key it lit up.
          // `text-text-3`, not `text-text-2`: at 0.7 ink the glyph read as a
          // control the reader had drawn on the title bar, darker than the
          // system lights beside it. DeepRead uses its secondary ink here and
          // it sits at the same weight as the window controls.
          "text-text-3 hover:text-text-1 hover:bg-surface-1 focus-visible:focus-ring absolute top-[5px] flex h-7 w-[30px] items-center justify-center rounded-xs transition-colors",
          // 90px clears the three lights (20 inset + 3×12 + 2×8 = 72) with a
          // little air. Elsewhere there is nothing to dodge, so it takes the
          // ordinary window inset rather than leaving a 90px hole.
          HAS_TRAFFIC_LIGHTS ? "left-[90px]" : "left-3",
        )}
      >
        <SidebarGlyph expanded={!hidden} />
      </button>
    </div>
  );
}

/**
 * The sidebar toggle glyph, borrowed from DeepRead's `SidebarToggleIcon`: a
 * rounded panel with one divider inside it.
 *
 * Expanded, the divider sits a third of the way in; hidden, it slides to the
 * panel's left edge and fades — the panel is collapsing, so the line that
 * marks its width goes with it. That one line moving says "the rail went that
 * way", where two swapped icons would only say "this is a different control
 * now".
 *
 * Plain CSS rather than motion: the whole animation is one transform on one
 * SVG `<line>`, and motion treats `x` on SVG nodes as a transform attribute —
 * the kind of detail that fails silently by two pixels.
 */
export function SidebarGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect
        x="2.4"
        y="3.4"
        width="15.2"
        height="13.2"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="7.6"
        y1="4.9"
        x2="7.6"
        y2="15.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="transition-[transform,opacity] duration-[220ms] ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none"
        style={{
          transform: expanded ? undefined : "translateX(-2.3px)",
          opacity: expanded ? 1 : 0.45,
        }}
      />
    </svg>
  );
}
