import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

import { GlassInput } from "@/components/glass/input";
import type { FoliateSearchHit } from "./FoliateBookView";

interface FoliateSearchPanelProps {
  /** Runs the query inside the live book; resolves to its hits. */
  onSearch: (query: string) => Promise<FoliateSearchHit[]>;
  /** Jump to one hit; the engine highlights it in the page already. */
  onPick: (cfi: string) => void;
  /** Query the panel opens with (the toolbar's 搜索 action); runs at once. */
  initialQuery?: string;
}

/** Debounce before a keystroke hits the book, in ms. */
const SEARCH_DELAY_MS = 260;

/**
 * In-book full-text search for foliate-rendered books (MOBI/AZW3).
 *
 * The library's SQLite FTS index cannot serve these: it stores the chapters
 * our importer extracted, and foliate's sections are the container's own, so
 * a hit's (chapter, offset) pair points somewhere the reader cannot go. The
 * query therefore runs inside the reading engine, which returns a CFI per hit
 * and paints every match in the page as it goes.
 */
export function FoliateSearchPanel({
  onSearch,
  onPick,
  initialQuery = "",
}: FoliateSearchPanelProps) {
  const [needle, setNeedle] = useState(initialQuery);
  // One state, not three: the query rides along with its result, so a stale
  // run is simply "not about this query any more" instead of something the
  // effect has to reset on every keystroke.
  const [outcome, setOutcome] = useState<{
    query: string;
    hits: FoliateSearchHit[];
    error: string | null;
  } | null>(null);
  // Searching is async and every keystroke starts a new run; the token keeps
  // a slow earlier run from overwriting a newer result set.
  const generation = useRef(0);
  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  }, [onSearch]);

  const trimmed = needle.trim();
  const settled = outcome !== null && outcome.query === trimmed;
  const pending = trimmed.length > 0 && !settled;
  const failed = settled ? outcome.error : null;
  const hits = settled ? outcome.hits : [];

  useEffect(() => {
    if (trimmed.length === 0) return;
    const token = generation.current + 1;
    generation.current = token;
    const timer = window.setTimeout(() => {
      void search.current(trimmed).then(
        (found) => {
          if (generation.current !== token) return;
          setOutcome({ query: trimmed, hits: found, error: null });
        },
        (cause: unknown) => {
          if (generation.current !== token) return;
          setOutcome({
            query: trimmed,
            hits: [],
            error: cause instanceof Error ? cause.message : String(cause),
          });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed]);

  const rows = hits.map((hit, index) => ({ hit, key: `${hit.cfi}:${index}` }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* `py-3`, not `pb-3`: the field sits directly under the drawer's hairline,
          and with no top inset its rim ran into the rule. Same on the shelf's
          search page, where the gap only reads as more air under the header. */}
      <div className="px-4 py-3">
        <div className="relative">
          <MagnifyingGlass
            size={14}
            className="text-text-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
          <GlassInput
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder="搜索正文"
            aria-label="搜索正文"
            className="pr-8 pl-8"
          />
          {needle.length > 0 && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setNeedle("")}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {trimmed.length === 0 ? (
          <p className="text-text-3 text-[13px] leading-relaxed">
            输入关键词，在整本书里查找。命中会在正文里高亮，点击结果直接跳到那一页。
          </p>
        ) : pending ? (
          <p className="text-text-3 text-[13px]">正在检索…</p>
        ) : failed !== null ? (
          <p className="text-danger text-[13px] leading-relaxed">检索失败：{failed}</p>
        ) : rows.length === 0 ? (
          <p className="text-text-3 text-[13px]">没有找到「{trimmed}」。</p>
        ) : (
          <ul className="space-y-3">
            {rows.map(({ hit, key }) => (
              <li key={key} className="border-hairline border-b pb-3 last:border-0 last:pb-0">
                <button
                  type="button"
                  onClick={() => onPick(hit.cfi)}
                  className="focus-visible:focus-ring hover:bg-surface-1 -mx-1 w-full rounded-md px-1 py-0.5 text-left transition-colors"
                >
                  {hit.label !== "" && <p className="text-text-3 text-xs">{hit.label}</p>}
                  <p className="text-text-1 mt-1 text-[13px] leading-relaxed">
                    {hit.pre}
                    <mark className="bg-accent-soft rounded-[2px] text-inherit">{hit.match}</mark>
                    {hit.post}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
