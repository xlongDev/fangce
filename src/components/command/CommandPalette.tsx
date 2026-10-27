import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { ArrowUDownLeft, MagnifyingGlass } from "@phosphor-icons/react";

import { effectiveKeys, formatShortcut, scoreCommand, type Command } from "@/lib/commands";
import { useBookCommands } from "@/features/command/useBookCommands";
import { useCommandStore } from "@/stores/commands";
import { useCommandPalette } from "@/stores/command-palette";
import { useSettings } from "@/stores/settings";
import { GlassDialog } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import { EASE_OUT, useMotion } from "@/lib/motion";

interface Scored {
  command: Command;
  score: number;
}

/**
 * How the highlight follows the pointer.
 *
 * Not the spring: it trails the hand by ~250 ms, which reads as lag. Not a hard
 * cut either — a row-to-row jump with no transition at all reads as a flicker,
 * because the old row's tint vanishes in the same frame the new one appears.
 * A 120 ms ease-out is the middle: 80% of the travel is done in the first 40 ms
 * (below the threshold where a pointer feels disconnected), and the landing is
 * soft instead of a snap.
 */
const POINTER_CURSOR = { duration: 0.12, ease: EASE_OUT } as const;

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const session = useCommandPalette((s) => s.session);

  return (
    <GlassDialog
      open={open}
      onOpenChange={setOpen}
      title="命令面板"
      description="输入命令，或直接搜书名 / 作者打开一本书。"
      widthClass="w-[min(94vw,620px)]"
    >
      {/* Remount per open: the query and the selection reset without an effect. */}
      <PaletteBody key={session} onClose={() => setOpen(false)} />
    </GlassDialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const commands = useCommandStore((s) => s.commands);
  const overrides = useSettings((s) => s.keyOverrides);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /**
   * Whether the last move of the cursor came from the pointer.
   *
   * The row highlight is one element gliding between rows, which is right for
   * ↑↓ — a thing that moves is easier to follow than a class blinking on. Under
   * a mouse it is wrong: the spring takes ~250ms to arrive, so the highlight
   * trails the pointer down the list and reads as lag. Pointer-driven state has
   * to be where the pointer is, on the same frame.
   */
  const [pointerMoved, setPointerMoved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const m = useMotion();

  // Focus after Radix has mounted the dialog content.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  // Arrowing past the fold has to bring the row with it — the cursor is the
  // only thing telling the reader where they are. Queried by index rather than
  // by a boolean flag so the effect genuinely reads `active`.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

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
    for (const entry of results) {
      const bucket = buckets.get(entry.command.group) ?? [];
      bucket.push(entry);
      buckets.set(entry.command.group, bucket);
    }
    let cursor = 0;
    return Array.from(buckets, ([group, items]) => ({
      group,
      items: items.map((entry) => ({ entry, index: cursor++ })),
    }));
  }, [results]);

  function updateQuery(next: string) {
    setQuery(next);
    setActive(0);
    setPointerMoved(false);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPointerMoved(false);
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setPointerMoved(false);
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
      <div ref={listRef} className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
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
                    {/* One element gliding between rows, rather than a class
                        toggling on and off: ↑↓ is the primary way to move
                        here, and the eye can follow a thing that moves.
                        Pointer moves get a short tween instead — see
                        `POINTER_CURSOR`. */}
                    {on && (
                      <motion.span
                        layoutId="palette-cursor"
                        className="bg-accent-soft absolute inset-0 rounded-md"
                        transition={
                          pointerMoved ? (m.reduce ? { duration: 0 } : POINTER_CURSOR) : m.layout
                        }
                      />
                    )}
                    <button
                      type="button"
                      data-active={on || undefined}
                      onMouseEnter={() => {
                        setPointerMoved(true);
                        setActive(index);
                      }}
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
