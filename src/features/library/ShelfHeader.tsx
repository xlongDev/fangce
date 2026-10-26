import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FilePlus, Globe, Highlighter } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";
import { greeting, type LibraryFilter } from "@/features/library/shelfQuery";

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
}: {
  filter: LibraryFilter;
  meta: { title: string; subtitle: string };
  importing: boolean;
  onClippings: () => void;
  onSource: () => void;
  onImport: () => void;
}) {
  const m = useMotion();
  const now = useNow();
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
          <GlassButton size="md" onClick={onClippings}>
            <Highlighter size={15} /> 导入摘录
          </GlassButton>
          <GlassButton size="md" onClick={onSource}>
            <Globe size={15} /> 在线找书
          </GlassButton>
          <GlassButton variant="primary" size="md" disabled={importing} onClick={onImport}>
            <FilePlus size={15} /> 导入书籍
          </GlassButton>
        </div>
      </div>
    </header>
  );
}
