import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FilePlus, Folder, FolderOpen, Globe, Highlighter, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { IconSwap } from "@/components/motion/IconSwap";
import { IMPORT_BOOKS_SHORTCUT } from "@/features/command/registerCoreCommands";
import { effectiveKeys, formatShortcut } from "@/lib/commands";
import { isDesktopRuntime } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { DURATION, EASE_LAND, EASE_OUT, useMotion } from "@/lib/motion";
import { greeting, type LibraryFilter } from "@/features/library/shelfQuery";

// Hover feedback for the shelf toolbar icons. Each nudge follows what its
// action reads as — the marker tips to write, the globe turns, the file lifts
// to be added, the folder opens — on top of a shared slight scale. `motion-safe`
// opts the whole thing out for reduced-motion users; the button itself never moves.
// The shared `--ease-spring` curve overshoots a touch and settles, so each
// nudge lands as an object instead of easing mechanically into place.
const TOOLBAR_ICON =
  "transition-transform duration-200 ease-[var(--ease-spring)] motion-safe:group-hover:scale-110";

/**
 * The shelf heading: greeting, the filter's own title, and the three ways a
 * book arrives.
 *
 * 书库 / 最近 / 收藏 / 标签 are one page with four filters — the shell keeps
 * them mounted, so changing filter has nowhere else to show itself. The heading
 * steps out and the new one rises into its place, while the grid reflows
 * underneath: the incoming cards glide, the outgoing ones shrink away.
 *
 * Only the heading moves. The buttons beside it are part of the same gesture
 * but are pinned right by `justify-between` and must not be re-mounted out
 * from under a click — which is also why `popLayout` (the leaving heading goes
 * out of flow) is safe here.
 */
/**
 * The clock the greeting reads.
 *
 * It lives here rather than on the page above, which owns the shelf: a `now`
 * held in `LibraryPage`'s state re-rendered the whole windowed grid once a
 * minute, for a string only this heading draws. React Compiler is not enabled
 * in this project, so that was a real render rather than a memo away.
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function ShelfHeader({
  filter,
  meta,
  importing,
  onClippings,
  onSource,
  onImport,
  onCalibre,
  trashEmpty = true,
  onEmptyTrash,
}: {
  filter: LibraryFilter;
  meta: { title: string; subtitle: string };
  importing: boolean;
  onClippings: () => void;
  onSource: () => void;
  onImport: () => void;
  /** Scan an external Calibre library. Labelled, and disabled in the web build
   *  where there is no directory to pick; the scan itself is read-only. */
  onCalibre: () => void;
  /** Whether the bin is empty — the only state in which 清空回收站 has nothing
   *  to do. Defaults to `true` so a caller that forgets cannot offer a button
   *  that empties a bin it never measured. */
  trashEmpty?: boolean;
  onEmptyTrash?: () => void;
}) {
  const m = useMotion();
  const now = useNow();
  const [calibreHover, setCalibreHover] = useState(false);
  const keyOverrides = useSettings((state) => state.keyOverrides);
  const [importKey] = effectiveKeys("book.import", [IMPORT_BOOKS_SHORTCUT], keyOverrides) ?? [];
  return (
    <header className="px-8 pt-8 pb-6">
      <p className="text-text-2 text-sm">{greeting(now)}</p>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={filter}
            initial={{ opacity: 0, y: m.reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.reduce ? 0 : -8 }}
            transition={{ duration: m.reduce ? 0 : DURATION.fast, ease: EASE_OUT }}
          >
            <h1 className="text-text-1 text-2xl font-semibold tracking-tight">{meta.title}</h1>
            {/* Same `mt-1.5` the shared `PageHeader` uses, so the shelf's
                heading and every other page's read as one thing. */}
            <p className="text-text-2 mt-1.5 text-sm leading-relaxed">{meta.subtitle}</p>
          </motion.div>
        </AnimatePresence>
        <div className="flex items-center gap-2">
          {/* The bin offers one action, and it is the one no other shelf has.
              The three import buttons would be answering "how do I get a book
              in here", which is the opposite question. */}
          {filter === "trash" ? (
            <GlassButton
              size="md"
              className="text-danger"
              // Only one thing can make this button useless, and it is an empty
              // bin — an import in flight has nothing to do with it.
              disabled={trashEmpty}
              onClick={onEmptyTrash}
            >
              <Trash size={15} /> 清空回收站
            </GlassButton>
          ) : (
            <>
              {/* The three slower paths read first, then a hairline, then the
                  one warm liquid-glass pane at the far right. Ending on the
                  primary keeps it away from the page title beside this row. */}
              <GlassButton
                size="md"
                variant="subtle"
                className="group"
                disabled={!isDesktopRuntime}
                title={
                  isDesktopRuntime ? "扫描 Calibre 书库（只读原库，可导入方册）" : "仅桌面版可用"
                }
                onClick={onCalibre}
                onHoverStart={() => setCalibreHover(true)}
                onHoverEnd={() => setCalibreHover(false)}
              >
                {m.reduce ? (
                  <FolderOpen size={15} />
                ) : (
                  <IconSwap
                    state={calibreHover ? "open" : "closed"}
                    className="h-4 w-4"
                    // The folder opening is the one glyph here with a real
                    // choreography, so it borrows the same landing bezier the
                    // cover and the import arrow use — a 0.22s settle instead
                    // of the IconSwap default's 0.15s expo flick.
                    transition={{ duration: DURATION.base, ease: EASE_LAND }}
                  >
                    {calibreHover ? (
                      <FolderOpen size={15} className={TOOLBAR_ICON} />
                    ) : (
                      <Folder size={15} className={TOOLBAR_ICON} />
                    )}
                  </IconSwap>
                )}{" "}
                Calibre
                {!isDesktopRuntime && <span className="text-text-3 text-[11px]">仅桌面</span>}
              </GlassButton>
              <GlassButton size="md" variant="subtle" className="group" onClick={onClippings}>
                <Highlighter
                  size={15}
                  className={`${TOOLBAR_ICON} motion-safe:group-hover:-rotate-12`}
                />{" "}
                导入摘录
              </GlassButton>
              <GlassButton size="md" variant="subtle" className="group" onClick={onSource}>
                <Globe size={15} className={`${TOOLBAR_ICON} motion-safe:group-hover:rotate-12`} />{" "}
                在线找书
              </GlassButton>
              <span
                data-shelf-header-divider
                aria-hidden="true"
                className="bg-hairline mx-1 h-5 w-px shrink-0"
              />
              <GlassButton
                size="md"
                variant="accent-glass"
                className="group"
                disabled={importing}
                onClick={onImport}
                trailing={
                  isDesktopRuntime ? (
                    // A real keycap, not faint text glued to the label: the
                    // border gives ⌘O a shape so the letter O cannot be read
                    // as a zero, and mono keeps the two glyphs distinct. The
                    // fill is deliberately faint — the border, not a tinted
                    // block, is what makes it read as a key. One keycap is one
                    // chord, so the space is dropped here; the settings panel
                    // keeps it, where the text is longer and needs the room.
                    importKey && (
                      <kbd className="border-accent/30 bg-accent/4 text-accent -ml-1 rounded border px-1.5 py-1 font-mono text-[11px] leading-none">
                        {formatShortcut(importKey).replace(/\s/g, "")}
                      </kbd>
                    )
                  ) : (
                    // The web build has no directory dialog, so the useful
                    // hint there is the one it can actually honour.
                    <span className="text-[11px] opacity-75">可拖入文件</span>
                  )
                }
              >
                <FilePlus
                  size={15}
                  className={`${TOOLBAR_ICON} motion-safe:group-hover:-translate-y-0.5`}
                />{" "}
                导入书籍
              </GlassButton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
