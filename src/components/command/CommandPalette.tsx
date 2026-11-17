import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUDownLeft, MagnifyingGlass } from "@phosphor-icons/react";

import { effectiveKeys, formatShortcut, scoreCommand, type Command } from "@/lib/commands";
import { useBookCommands } from "@/features/command/useBookCommands";
import { SearchPanel } from "@/features/search/SearchPanel";
import { readerPathForHit } from "@/features/search/snippet";
import { useCommandStore } from "@/stores/commands";
import { useCommandPalette } from "@/stores/command-palette";
import { useSettings } from "@/stores/settings";
import { GlassDialog } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";

interface Scored {
  command: Command;
  score: number;
}

/** The row highlight's glide, shared with the e2e that pins it. */
export const CURSOR_TRANSITION = "transform 340ms var(--ease-spring)";

/**
 * ⌘K and ⌘F open the same shell with different bodies.
 *
 * One dialog, not two: both are a centred field over a scrim, both are opened
 * by a global hotkey from wherever the reader is, and both hand the keyboard
 * back on Escape. A second dialog would have been a second centring rule, a
 * second entry animation and a second thing that can be open at the same time.
 */
export function CommandPalette() {
  const open = useCommandPalette((s) => s.open);
  const mode = useCommandPalette((s) => s.mode);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const session = useCommandPalette((s) => s.session);
  const searching = mode === "search";

  return (
    <GlassDialog
      open={open}
      onOpenChange={setOpen}
      title={searching ? "全局搜索" : "命令面板"}
      description={
        searching ? "在所有已导入的书籍正文里查找。" : "输入命令，或直接搜书名 / 作者打开一本书。"
      }
      widthClass="w-[min(94vw,620px)]"
    >
      {/* Remount per open *and* per mode: the query and the selection reset
          without a state-syncing effect. */}
      {searching ? (
        <GlobalSearchBody key={session} onClose={() => setOpen(false)} />
      ) : (
        <PaletteBody key={session} onClose={() => setOpen(false)} />
      )}
    </GlassDialog>
  );
}

/**
 * The library-wide search panel inside the palette shell.
 *
 * `SearchPanel` is the one on the 搜索 page — same debounce, same grouping,
 * same history, same hit rendering. `-mx-4` cancels the panel's own padding so
 * its field lines up with the palette's field; the page keeps that padding
 * because it sits in a wider pane.
 */
function GlobalSearchBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <div className="flex h-[min(60vh,420px)] flex-col">
      {/* `flex min-h-0` on this wrapper is load-bearing: `SearchPanel`'s own
          `flex-1` chain only works under a flex parent, and as a plain block
          it grew with its results and spilled past the dialog, with nothing
          left to scroll. */}
      <div className="-mx-4 flex min-h-0 flex-1 flex-col">
        <SearchPanel
          focusOnMount
          selectFirst
          onPick={(hit, needle) => {
            onClose();
            navigate(readerPathForHit(hit, needle));
          }}
        />
      </div>
      <footer className="text-text-3 mt-3 flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1">
          <ArrowUDownLeft size={12} /> 回车跳到书里
        </span>
        <span>↑↓ 选择 · Esc 关闭</span>
      </footer>
    </div>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const commands = useCommandStore((s) => s.commands);
  const overrides = useSettings((s) => s.keyOverrides);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const m = useMotion();

  // Focus after Radix has mounted the dialog content.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  // Arrowing past the fold has to bring the row with it — the cursor is the
  // only thing telling the reader where they are. The highlight lives inside
  // the scroller, so once it is placed this only moves them together.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /**
   * Point the single highlight at the active row.
   *
   * No dependency list on purpose — like the sidebar indicator, placement is
   * a pure function of the DOM and every input that matters (active index,
   * result set) has already re-rendered by the time this runs. Geometry is
   * measured, not assumed: rows differ in height (with and without a
   * description), and adding scrollTop keeps the highlight aligned after the
   * scroll-into-view below moves the list.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    const cursor = cursorRef.current;
    if (!list || !cursor) return;
    const row = list.querySelector<HTMLElement>(`[data-row="${active}"]`);
    if (!row) {
      cursor.style.opacity = "0";
      return;
    }
    cursor.style.opacity = "1";
    const box = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    cursor.style.width = `${box.width}px`;
    cursor.style.height = `${box.height}px`;
    cursor.style.transform = `translate(${box.left - listBox.left + list.scrollLeft}px, ${box.top - listBox.top + list.scrollTop}px)`;
  });

  /**
   * The highlight travels as one object from row to row.
   *
   * `--ease-spring` is the curve the tag rail already uses for the same job:
   * it runs past the target and settles, so the eye follows a pane arriving
   * rather than a tint repainting. The first attempt used `--ease-out` at
   * 120ms — measured over a 126px hop it covered 62% in 30ms and 94% in 60ms,
   * which read as a jump. 340ms on the spring keeps the whole hop visible.
   * One element never unmounting is what keeps that glide on the compositor;
   * a per-row `layoutId` re-measured and re-rasterised the glass on every
   * enter, which is what made hovering feel sticky.
   */
  const cursorMotion = m.reduce ? { transition: "none" } : { transition: CURSOR_TRANSITION };

  const bookCommands = useBookCommands(query);

  const results = useMemo<Scored[]>(() => {
    const scored: Scored[] = [];
    for (const list of [commands, bookCommands]) {
      for (const command of list) {
        // `hidden` commands are bound (⌘K) but not listed — see `Command`.
        if (command.hidden) continue;
        if (command.isEnabled && !command.isEnabled()) continue;
        const s = scoreCommand(query, command);
        if (s == null) continue;
        scored.push({ command, score: s });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
    return scored.slice(0, 24);
  }, [commands, bookCommands, query]);

  const groups = useMemo(() => {
    const buckets = new Map<string, Scored[]>();
    const indexOf = new Map<Scored, number>();
    results.forEach((entry, index) => {
      indexOf.set(entry, index);
      const bucket = buckets.get(entry.command.group) ?? [];
      bucket.push(entry);
      buckets.set(entry.command.group, bucket);
    });
    return Array.from(buckets, ([group, items]) => ({
      group,
      items: items.map((entry) => ({ entry, index: indexOf.get(entry) ?? 0 })),
    }));
  }, [results]);

  function updateQuery(next: string) {
    setQuery(next);
    setActive(0);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[active];
      if (!target) return;
      onClose();
      void target.command.run();
    }
  }

  return (
    <div>
      {/* One surface, not two: the wrapper is the pane the reader types into,
          so the field itself carries no material. `GlassInput` paints its own
          sheen gradient and `bg-transparent` does not remove a background
          *image* — nesting the two drew a second, lighter rounded rect inside
          this one. A bare input keeps the icon inline with the text. */}
      <div className="glass mb-3 flex h-9 items-center gap-2 rounded-md px-2.5">
        <MagnifyingGlass size={16} className="text-text-2 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={handleKey}
          placeholder="输入命令或书名..."
          className="text-text-1 placeholder:text-text-3 h-full w-full min-w-0 bg-transparent text-sm outline-none"
        />
      </div>
      <div ref={listRef} className="relative -mx-1 max-h-[60vh] overflow-y-auto px-1">
        {/* One highlight for the whole list, absolutely placed under the active
            row. It never unmounts, so a hover re-targets a CSS transform instead
            of tearing down a layout-animated element and re-rasterising the
            glass on every row — the sticky-hover this replaced. `top-0 left-0`
            plus the measured translate lands it on the row; will-change keeps
            the tween on the compositor. */}
        <span
          ref={cursorRef}
          aria-hidden
          data-palette-cursor
          style={cursorMotion}
          className="bg-accent-soft pointer-events-none absolute top-0 left-0 rounded-md opacity-0 will-change-transform"
        />
        {results.length === 0 && (
          <div className="text-text-2 px-2 py-6 text-center text-sm">没有匹配的命令或书籍</div>
        )}
        {groups.map(({ group, items }) => (
          <section key={group} className="mb-3">
            <h3 className="text-text-3 px-2 pb-1 text-[11px] tracking-[0.14em] uppercase">
              {group}
            </h3>
            <ul>
              {items.map(({ entry, index }) => {
                const on = index === active;
                // Rebound keys are shown as they are bound: the palette's job is
                // to say what to press, and a hint that named the default after
                // the reader changed it would be the one place that lied.
                const [bound] =
                  effectiveKeys(entry.command.id, entry.command.shortcut, overrides) ?? [];
                return (
                  <li key={entry.command.id} data-row={index} className="relative">
                    <button
                      type="button"
                      data-active={on || undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => {
                        onClose();
                        void entry.command.run();
                      }}
                      className={cn(
                        "press focus-visible:focus-ring relative flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left",
                        on ? "text-text-1" : "text-text-1 hover:bg-surface-1",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="text-text-2">{entry.command.icon}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{entry.command.title}</span>
                          {entry.command.description && (
                            <span className="text-text-2 block truncate text-[12px]">
                              {entry.command.description}
                            </span>
                          )}
                        </span>
                      </span>
                      {bound && (
                        <kbd className="text-text-3 font-mono text-[11px]">
                          {formatShortcut(bound)}
                        </kbd>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <footer className="text-text-3 mt-3 flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1">
          <ArrowUDownLeft size={12} /> 回车执行
        </span>
        <span>{results.length > 0 && `${results.length} 条 · `}↑↓ 选择 · Esc 关闭</span>
      </footer>
    </div>
  );
}
