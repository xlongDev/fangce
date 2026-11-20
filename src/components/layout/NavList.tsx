import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import type { Icon } from "@phosphor-icons/react";
import {
  Books,
  ClockCounterClockwise,
  ChartLine,
  MagnifyingGlass,
  Star,
  Tag,
  GearSix,
  CaretLeft,
  CaretRight,
  Monitor,
  Moon,
  Notebook,
  PuzzlePiece,
  Sun,
  Trash,
} from "@phosphor-icons/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { useSettings, type ThemeMode } from "@/stores/settings";
import { GlassIconButton } from "@/components/glass/button";
import { useCommandPalette } from "@/stores/command-palette";
import { DURATION, SPRING } from "@/lib/motion";

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
}

const ITEMS: NavItem[] = [
  { to: "/", label: "书库", icon: Books, end: true },
  { to: "/recent", label: "最近", icon: ClockCounterClockwise },
  { to: "/favorites", label: "收藏", icon: Star },
  { to: "/tags", label: "标签", icon: Tag },
  { to: "/notes", label: "笔记", icon: Notebook },
  { to: "/stats", label: "统计", icon: ChartLine },
  { to: "/search", label: "搜索", icon: MagnifyingGlass },
  { to: "/plugins", label: "插件", icon: PuzzlePiece },
  // Last, and after 搜索 rather than beside 书库: the bin is a place you go on
  // purpose, not a shelf you browse. Nothing in this list is hidden when it is
  // empty — a 回收站 that appears only after a delete would be a menu that
  // moves under the cursor.
  { to: "/trash", label: "回收站", icon: Trash },
];

/**
 * Which way a click moves down this list, for the page transition to travel in.
 *
 * It is carried on the navigation itself (`state`) rather than remembered by the
 * shell, because "which way did we come from" is the one thing a route change
 * cannot tell you about itself — and the alternative, holding the previous route
 * in a ref or state, means either reading a ref while rendering or paying a
 * second full render of a heavy page on every navigation.
 *
 * `Link` ignores `state` it does not use, and navigations that are not this
 * list (the command palette, a deep link, the reader) simply do not set it —
 * which reads as 0, a plain cross-fade.
 */
function stepFrom(from: string, to: string): number {
  const here = ITEMS.findIndex((item) => item.to === from);
  const there = ITEMS.findIndex((item) => item.to === to);
  return here < 0 || there < 0 ? 0 : Math.sign(there - here);
}

const ROW = cn(
  // No `relative`: the indicator is a sibling of the rows now (see `NavList`),
  // so nothing in a row has to establish a containing block for it. Rows are
  // in flow and paint under the indicator; the icon and label carry their own
  // `relative` to paint above it.
  //
  // The gap between icon and label is not here: it is `gap-2.5` when the rail
  // is open and absent when it is a 42px column, where the label has no width
  // and the icon has to sit centred (see the label below).
  "flex items-center rounded-md px-2.5 py-2 text-[13.5px]",
  // Active and inactive are both transparent (the active row's fill is the
  // sliding indicator underneath), so the only thing the row itself animates
  // is the text colour — a longer curve keeps the icon and label reading as
  // part of the same gesture as the indicator.
  "border border-transparent transition-colors duration-200 ease-[cubic-bezier(0.33,1,0.68,1)]",
  "press focus-visible:focus-ring",
);

/** Indicator — text colour only. Background is the one indicator element that
 *  slides between rows; the row itself stays transparent in both states so a
 *  row that has never been hovered never paints a stale fill under the
 *  indicator as it lands. */
function rowState(isActive: boolean): string {
  return isActive ? "text-text-1" : "text-text-2 hover:bg-surface-1 hover:text-text-1";
}

export function NavList() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const reduce = useReducedMotion();
  const { pathname } = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  // Remounting on activation gives the fill/outline swap a soft pop. `tap`
  // (stiffness 560) used to feel like a button press; `enter` is the same
  // settle without the urgency — a sidebar selection is unhurried, and the
  // icon should land with the rest of the page rather than outrun it.
  const iconSpring = {
    initial: reduce ? false : { scale: 0.6, opacity: 0.4 },
    animate: { scale: 1, opacity: 1 },
    transition: SPRING.enter,
  } as const;

  /**
   * Put the indicator under the active row.
   *
   * It used to be a `layoutId` pill rendered *inside* the active row, FLIPped
   * across rows on every navigation. That cost a per-frame inline `transform`
   * written by motion, a re-measure each switch, and a fresh raster of the
   * glass material every time it mounted somewhere else — and it was starved
   * exactly when it mattered: measured on the way into 书库, the spring only
   * produced a new value every third frame (~20fps) because the arriving page
   * was mounting on the same thread. A CSS transition on one element that
   * never unmounts is driven by the animation timeline instead, so the same
   * jank cannot reach it.
   *
   * Geometry is read, not assumed: the row's own box is the answer, not a
   * track constant. `aria-current` is the router's own verdict on which row is
   * active, so its matching rule is not repeated here.
   *
   * No dependency list on purpose: the placement is a pure function of the
   * DOM, and everything it depends on (`pathname`, the rail's width) is read
   * through that DOM rather than from this render. NavList only re-renders on
   * a route or rail change anyway, and writing the same transform twice is a
   * no-op for the browser — so this costs one rect read per render, never per
   * frame.
   */
  useLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const row = nav.querySelector<HTMLElement>('a[aria-current="page"]');
    // No row (the reader, 设置, a deep link): nothing to point at.
    indicator.style.opacity = row ? "1" : "0";
    if (!row) return;
    const box = row.getBoundingClientRect();
    // Width as well as height, so the rail's own collapse is a stretch rather
    // than a swap: the inner column is pinned to its *final* width the moment
    // the state flips (see `GlassSidebar`), so `left-1 right-1` would snap this
    // pane from 218px to 42px in one frame — a small square sitting inside a
    // rail that is still wide, then the rail closing around it.
    indicator.style.width = `${box.width}px`;
    indicator.style.height = `${box.height}px`;
    indicator.style.transform = `translateY(${box.top - nav.getBoundingClientRect().top}px)`;
  });

  return (
    <nav ref={navRef} className="relative flex flex-col gap-0.5 px-1" aria-label="主导航">
      {/* One indicator for the whole list, absolutely placed under whichever
          row is active. `pointer-events-none` because it now paints over the
          rows' own hit areas; `left-1` mirrors the nav's `px-1`, and the width
          comes from the row's box in the effect above — it has to be a value on
          this element (not `right-1`) for the rail's collapse to be able to
          stretch it.

          Same motion as the tag rail's highlight (`TagIndex`), down to the
          token: `--ease-spring` at 420ms. It is the one glide in the app the
          reader already calls smooth, and it carries the same job — one pane
          travelling between rows of a list. A no-overshoot bezier at 340ms was
          the first attempt here and read as a snap rather than a glide.
          `will-change` because this element lives under the rail's
          `backdrop-filter` (`glass-2`): without a layer of its own the
          compositor cannot carry it, and the pane's raster is repainted on
          every frame of the move. */}
      <span
        ref={indicatorRef}
        aria-hidden
        data-nav-indicator
        className="glass pointer-events-none absolute top-0 left-1 rounded-md opacity-0 transition-[transform,width,opacity] duration-[420ms] ease-[var(--ease-spring)] will-change-transform motion-reduce:transition-none"
      />
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          state={{ step: stepFrom(pathname, item.to) }}
          // Collapsed rail keeps the label for assistive tech and as a native
          // tooltip; dropping the node entirely left the icon with no name.
          title={collapsed ? item.label : undefined}
          className={({ isActive }) =>
            cn(ROW, rowState(isActive), collapsed ? "justify-center" : "gap-2.5")
          }
        >
          {({ isActive }) => (
            <>
              {/* shrink-0: the always-in-layout nowrap label no longer fits
                  the collapsed rail, and flex would otherwise squeeze the
                  icon (svg min-width:auto = 0) down to nothing. `relative`
                  keeps the icon (and the label) above the indicator's
                  stacking context — the indicator is `absolute`, so without
                  the `relative` the icon would paint *under* its fill. */}
              <motion.span
                key={String(isActive)}
                className="relative flex shrink-0"
                {...iconSpring}
              >
                <item.icon size={18} weight={isActive ? "fill" : "regular"} />
              </motion.span>
              {/* In layout in both states, but the rail drives its *width*, not
                  just its opacity: the label is 27px of text and the collapsed
                  rail is 42px wide, so a label left in layout pushed the icon
                  4px off centre inside the highlight (measured 11px left, 15px
                  right). Squeezing it shut — with the fade and with the row
                  losing its gap — is what leaves the icon centred, and the text
                  stays in the accessibility tree either way (`title` on the
                  link is the other name).
                  `relative` mirrors the icon: above the indicator, not under
                  it. */}
              <motion.span
                initial={false}
                animate={{ opacity: collapsed ? 0 : 1 }}
                transition={{
                  duration: collapsed ? DURATION.fast : DURATION.base,
                  delay: collapsed ? 0 : 0.15,
                }}
                className={cn(
                  "relative overflow-hidden whitespace-nowrap transition-[width,opacity] duration-150 ease-out",
                  collapsed ? "w-0" : "w-auto",
                )}
              >
                {item.label}
              </motion.span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

const THEME_OPTIONS: readonly { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  // Ordered light → system → dark, so the row reads as a scale rather than as
  // two opposite modes with a third wedged between them.
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "dark", label: "深色", icon: Moon },
];

/**
 * Stable ids that let motion FLIP the footer's icons between the collapsed
 * rail and the expanded two-row layout.
 *
 * Every control in the footer now exists in both layouts, so each carries its
 * own `layoutId` and there is nothing left to fade in and out. `LayoutGroup`
 * in `Footer` makes the id a global scope inside the footer, so a `layoutId`
 * can sit in the column in one render and in the row in the next and still
 * animate between them.
 */
const ID = {
  settings: "footer-settings",
  themeIcon: "footer-theme-icon",
  toggle: "chrome-toggle",
  palette: "chrome-palette",
} as const;

/** `layoutId` per chrome action, keyed by `key` rather than by position — the
 *  row's order is a design decision, and indexing it meant a reorder would
 *  hand two buttons each other's identity mid-FLIP. */
const CHROME_ID: Record<string, string> = {
  toggle: ID.toggle,
  palette: ID.palette,
  settings: ID.settings,
};

/** Quick appearance switcher for the sidebar footer.
 *
 * Expanded: three theme segments whose circular highlight springs between
 * them (shared layoutId). Collapsed: the rail is too narrow for the pill, so
 * a single button cycles the modes with an icon crossfade instead.
 *
 * 设置 used to lead this pill behind a hairline. It moved down into the
 * chrome row: three appearance segments over three tool buttons is a column
 * that lines up, where four-over-two never did. */
function ThemeSwitch({ collapsed }: { collapsed: boolean }) {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const reduce = useReducedMotion();

  if (collapsed) {
    const current = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0]!;
    const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(current) + 1) % THEME_OPTIONS.length]!;
    return (
      <div className="flex justify-center">
        <button
          type="button"
          title={`主题：${current.label}（点击切换为${next.label}）`}
          aria-label={`主题：${current.label}，点击切换为${next.label}`}
          onClick={() => setTheme(next.value)}
          // Same material as the chrome buttons below it — `glass`, not a flat
          // tint. The column holds four buttons and they have to look like one
          // family; a hairline fill beside three lit panes reads as disabled.
          className="glass text-text-1 hover:bg-surface-2 flex h-8 w-8 items-center justify-center rounded-md transition-colors"
        >
          {/* The active theme icon also carries the shared theme-icon
              layoutId, so when the rail expands it glides from the centre
              of this button to the centre of its radio cell in the pill. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={current.value}
              layoutId={ID.themeIcon}
              initial={reduce ? false : { opacity: 0, scale: 0.5, rotate: -30 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.5, rotate: 30 }}
              transition={SPRING.tap}
              className="flex"
            >
              <current.icon size={16} />
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      {/* The pill carries no padding: its 1px border sits inside its own box,
          so the glass outline and the row of buttons below start and end on
          the same two pixels. Padding would have inset the segments by 2px
          and made the pill read 4px wider than the row it sits above — which
          is exactly what it did before. The selected stadium is drawn with
          `inset-[2px]` instead, so it still floats clear of the rim.
          Both rows use `grid-cols-3 gap-1.5`; the row below carries a
          transparent 1px border to match this one's real border. */}
      <div className="glass w-full rounded-full">
        <div className="grid grid-cols-3 gap-1.5">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              <label
                key={value}
                title={label}
                className={cn(
                  "relative flex h-8 cursor-pointer items-center justify-center rounded-full transition-colors duration-200",
                  // `has-[:focus-visible]`, not `focus-within`: the radio is
                  // sr-only, so clicking the label focuses it too and left a
                  // 2px accent ring around the segment after every mouse press.
                  "has-[:focus-visible]:focus-ring",
                  active ? "text-text-1" : "text-text-3 hover:text-text-2",
                )}
              >
                <input
                  type="radio"
                  name="sidebar-theme"
                  value={value}
                  checked={active}
                  onChange={() => setTheme(value)}
                  className="sr-only"
                />
                {/* Shared-layout highlight: one stadium springs between the
                    three theme cells instead of each rendering its own. */}
                {active && (
                  <motion.span
                    layoutId="sidebar-theme-pill"
                    className="bg-surface-3 shadow-glass absolute inset-[2px] rounded-full"
                    transition={reduce ? { duration: 0 } : SPRING.layout}
                  />
                )}
                {/* Only the *active* theme icon carries the theme-icon
                    layoutId — the other two are decorative and stay put.
                    Collapsed, the single button renders the same icon under
                    this id, so a rail ⇄ pill toggle glides it between the
                    centre of the button and the centre of its radio cell. */}
                {active ? (
                  <motion.span
                    layoutId={ID.themeIcon}
                    transition={reduce ? { duration: 0 } : SPRING.layout}
                    className="relative flex"
                  >
                    <Icon size={15} weight="fill" />
                  </motion.span>
                ) : (
                  <Icon size={15} weight="regular" className="relative" />
                )}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface FooterAction {
  key: string;
  label: string;
  icon: ReactNode;
  on: () => void;
}

/** Sidebar footer, two rows with distinct jobs:
 *
 * 1. The theme pill (appearance), three equal segments.
 * 2. 设置 / 折叠 / ⌘K (chrome actions), three equal buttons lined up with
 *    the segments above.
 * Collapsed rail: centered vertical stack of the same controls.
 *
 * 隐藏侧边栏 used to sit in row 2. It moved to the title bar, and the reason
 * is structural rather than cosmetic: the state it produces is "this rail is
 * gone", and this footer is *inside* the rail — closing it left the only way
 * back floating at the window's edge. GitHub left too (it is a link, not a
 * chrome action; it lives in 设置 › 关于 now), and ⌘K stayed because it is the
 * one control here that also works when the rail is a 76px column.
 *
 * The shared `LayoutGroup` lets every one of these keep a stable `layoutId`
 * across the toggle and FLIP between their column and row positions. Nothing
 * comes and goes any more, so there is no `AnimatePresence` layer to fade. */
function Footer({ compact }: { compact?: boolean } = {}) {
  const storeCollapsed = useSettings((s) => s.sidebarCollapsed);
  const collapsed = compact ?? storeCollapsed;
  const toggle = useSettings((s) => s.toggleSidebar);
  const openPalette = useCommandPalette((s) => s.openWith);
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  /**
   * The toggle's glyph, animated in the direction the rail is about to move.
   *
   * A rotation said "this icon changed"; a slide says "the panel went that
   * way", which is what the button actually does. The glyph itself is a single
   * caret — a double chevron reads as "jump to the end" (or, at this size, as
   * a typographic « that says nothing at all), and the button neither jumps
   * nor goes anywhere but sideways.
   *
   * Both directions fall out of one expression. `initial` is read from the
   * render that *mounts* a glyph and `exit` from the render that unmounts it,
   * so with `collapsed` on both sides the arriving caret enters from the side
   * the rail is leaving and the departing one follows it out.
   */
  const toggleIcon = (
    <span className="relative flex h-4 w-4 items-center justify-center">
      <AnimatePresence initial={false}>
        <motion.span
          key={String(collapsed)}
          initial={reduce ? false : { x: collapsed ? 7 : -7, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reduce ? undefined : { x: collapsed ? 7 : -7, opacity: 0 }}
          transition={reduce ? { duration: 0 } : SPRING.tap}
          className="absolute flex"
        >
          {collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}
        </motion.span>
      </AnimatePresence>
    </span>
  );

  // Order is render order. 设置 goes last: it is the one control here that
  // leaves the page, and it sits where macOS puts the equivalent.
  const chromeActions: FooterAction[] = [
    // Both states. Collapsed, the mark in the header also expands the rail on
    // hover, but that is a hover affordance on something that looks like a
    // logo — the rail still needs a control that says what it does.
    {
      key: "toggle",
      label: collapsed ? "展开侧边栏" : "折叠侧边栏",
      icon: toggleIcon,
      on: toggle,
    },
    {
      key: "palette",
      label: "打开命令面板",
      icon: <span className="font-mono text-[11px]">⌘K</span>,
      on: () => openPalette("command"),
    },
    {
      key: "settings",
      label: "设置",
      icon: <GearSix size={16} />,
      on: () => navigate("/settings"),
    },
  ];

  // Wraps a chrome button so it FLIPs between its collapsed column slot
  // and its expanded row slot. `layoutId` makes motion see one element that
  // changed parents rather than two unrelated renders. The helpers are
  // defined at module scope so React keeps the same component identity
  // across renders — defining them inside `Footer` would re-create them
  // every render and make oxlint flag the file.
  //
  // All three exist in both layouts, so all three are `ChromeButton`s: there
  // is nothing to mount or unmount, and giving each a `layoutId` means the
  // gear glides down from the pill into this row on collapse instead of
  // being swapped for a second, separate gear that happens to sit lower.
  //
  // Keyed by `action.key`, not by index: the row's order is a design decision
  // and the `layoutId`s have to survive it — indexing was how a reorder used
  // to silently swap two buttons' identities.
  const chrome = chromeActions.map((action) => (
    <ChromeButton
      key={action.key}
      id={CHROME_ID[action.key]!}
      button={action}
      collapsed={collapsed}
      reduce={reduce}
    />
  ));

  return (
    // `LayoutGroup` is what makes the layoutIds above a shared scope:
    // without it, a `layoutId` only animates inside one parent, and a
    // column→row move would just snap because the parents are different.
    <LayoutGroup id="sidebar-footer">
      <motion.div
        layout
        transition={reduce ? { duration: 0 } : SPRING.layout}
        className={cn(collapsed ? "flex flex-col items-center gap-1" : "flex flex-col gap-1.5")}
      >
        <ThemeSwitch collapsed={collapsed} />
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">{chrome}</div>
        ) : (
          // Same three-column grid as the pill above, with a transparent 1px
          // border standing in for the pill's real one — without it this row's
          // content box would be 2px wider and the two grids would drift apart
          // by a pixel at each end.
          <div className="grid grid-cols-3 gap-1.5 border border-transparent">{chrome}</div>
        )}
      </motion.div>
    </LayoutGroup>
  );
}

/** Wraps a chrome button so it FLIPs between its collapsed column slot and
 *  its expanded row slot. Stable identity at module scope — see `Footer`.
 *
 *  `flex-1` on the wrapper is what makes the row's three buttons equal width.
 *  It used to sit on the button itself, which did nothing once the wrapper
 *  became the flex item: the wrapped buttons then measured 32px while their
 *  neighbours grew, and the row read as unevenly spaced (measured: gaps of
 *  6 / 41 / 41px against the theme pill's even cells above it). Column layout
 *  gets no `flex-1` — there it would stretch the button vertically instead. */
function ChromeButton({
  id,
  button,
  collapsed,
  reduce,
}: {
  id: string;
  button: FooterAction;
  collapsed: boolean;
  reduce: boolean | null;
}) {
  return (
    <motion.div
      layoutId={id}
      transition={reduce ? { duration: 0 } : SPRING.layout}
      className={cn("flex", !collapsed && "flex-1")}
    >
      <GlassIconButton
        label={button.label}
        size="sm"
        onClick={button.on}
        title={button.label}
        className={collapsed ? undefined : "flex-1"}
      >
        {button.icon}
      </GlassIconButton>
    </motion.div>
  );
}

NavList.Footer = Footer;
