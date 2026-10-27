import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ClockCounterClockwise, MagnifyingGlass, X } from "@phosphor-icons/react";

import { GlassInput } from "@/components/glass/input";
import { QueryError } from "@/components/common/QueryError";
import { hitLocation, parseSnippet } from "@/features/search/snippet";
import { useSearch } from "@/hooks/useSearch";
import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";
import type { SearchHit } from "@/types/ipc";

interface SearchPanelProps {
  /** `null` searches every book; an id scopes the search to one book. */
  bookId?: string | null;
  /** `needle` is handed back so the reader can highlight what was searched. */
  onPick: (hit: SearchHit, needle: string) => void;
  /** Query the panel opens with (the toolbar's 搜索 action). */
  initialQuery?: string;
}

/** Query history, most recent first. Local on purpose: a reading history is
 *  the reader's own business and there is nothing to sync it with. */
const HISTORY_KEY = "fangce.search-history";
const HISTORY_MAX = 5;

function readHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberQuery(query: string): string[] {
  const next = [query, ...readHistory().filter((entry) => entry !== query)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // A blocked store costs the history, not the search.
  }
  return next;
}

/** Input plus hit list. Fills whatever container it is placed in. */
export function SearchPanel({ bookId = null, onPick, initialQuery = "" }: SearchPanelProps) {
  const [needle, setNeedle] = useState(initialQuery);
  const [history, setHistory] = useState<string[]>(readHistory);
  /** Cursor over the flat hit list, shared by ↑/↓ and the mouse. */
  const [active, setActive] = useState(-1);
  const m = useMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const query = useSearch(needle, bookId);
  const trimmed = needle.trim();

  // Keys are built here rather than in the JSX so no list uses a raw index.
  const rows = useMemo(
    () =>
      (query.data ?? []).map((hit, index) => ({
        hit,
        at: index,
        key: `${hit.bookId}:${hit.chapterIdx}:${hit.offset}:${index}`,
        parts: parseSnippet(hit.snippet).map((part, partIndex) => ({
          text: part.text,
          matched: part.matched,
          key: `${index}:${partIndex}`,
        })),
      })),
    [query.data],
  );

  /**
   * Hits grouped by book when the search spans the library.
   *
   * A flat list of twenty snippets drawn from six books is a wall; a per-book
   * heading with its own count is a table of contents, and it is the only
   * thing that tells the reader *where* the noise is coming from. Scoped to
   * one book the heading would just repeat the title, so it is dropped.
   */
  const groups = useMemo(() => {
    if (bookId !== null) return [{ id: "scoped", title: null as string | null, rows }];
    const byBook = new Map<string, { id: string; title: string | null; rows: typeof rows }>();
    for (const row of rows) {
      let group = byBook.get(row.hit.bookId);
      if (!group) {
        group = { id: row.hit.bookId, title: row.hit.bookTitle, rows: [] };
        byBook.set(row.hit.bookId, group);
      }
      group.rows.push(row);
    }
    return [...byBook.values()];
  }, [rows, bookId]);

  // A new query invalidates the cursor, and a shorter list can leave it past
  // the end — either way it starts over at "nothing picked". Reset from the
  // event that changes the query rather than from an effect on it.
  const retype = (next: string) => {
    setNeedle(next);
    setActive(-1);
  };

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (hit: SearchHit) => {
    setHistory(rememberQuery(trimmed));
    onPick(hit, trimmed);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      retype("");
      return;
    }
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // The caret must not move: the arrows belong to the list, not the field.
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((prev) => {
        const next = prev + step;
        if (next < 0) return rows.length - 1;
        if (next >= rows.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pick(rows[active]!.hit);
    }
  };

  const field = (
    <div className="relative">
      <MagnifyingGlass
        size={14}
        className="text-text-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
      />
      <GlassInput
        value={needle}
        onChange={(event) => retype(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索正文"
        aria-label="搜索正文"
        className="pr-8 pl-8"
      />
      {needle.length > 0 && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => retype("")}
          className="press text-text-3 hover:text-text-1 focus-visible:focus-ring absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 py-3">{field}</div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {trimmed.length === 0 ? (
          <div className="space-y-3">
            {/* The scope is the search page's own subtitle (`SearchPage`), so
                repeating it here said nothing — what the empty state has to
                teach is the keyboard, which no other surface mentions. */}
            <p className="text-text-3 text-[13px] leading-relaxed">
              {bookId === null ? "输入即搜" : "在这本书里输入即搜"}，用 ↑ ↓
              选择，回车跳到书里命中的那一段。
            </p>
            {history.length > 0 && (
              <div>
                <p className="text-text-3 flex items-center gap-1.5 text-[11.5px]">
                  <ClockCounterClockwise size={12} /> 最近搜过
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {history.map((entry) => (
                    <button
                      key={entry}
                      type="button"
                      onClick={() => retype(entry)}
                      className="glass press focus-visible:focus-ring text-text-2 hover:text-text-1 max-w-full truncate rounded-full px-2.5 py-1 text-[12px]"
                    >
                      {entry}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : query.isPending ? (
          // Same shape as a hit, so the list does not jump when it lands.
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index}>
                <div className="skeleton h-3 w-24 rounded-full" />
                <div className="skeleton mt-2 h-3.5 w-full rounded-full" />
                <div className="skeleton mt-1.5 h-3.5 w-2/3 rounded-full" />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <QueryError
            error={query.error}
            onRetry={() => void query.refetch()}
            icon={<MagnifyingGlass size={26} weight="duotone" />}
            title="检索失败"
            description="这次检索没有返回结果。可以重试一次，或换个关键词再试。"
          />
        ) : rows.length === 0 ? (
          <p className="text-text-3 text-[13px] leading-relaxed">没有找到「{trimmed}」。</p>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.id}>
                {group.title && (
                  <p className="text-text-3 mb-1 flex items-baseline gap-2 text-[11.5px] font-medium">
                    <span className="truncate">{group.title}</span>
                    <span className="shrink-0 tabular-nums opacity-70">{group.rows.length}</span>
                  </p>
                )}
                <ul>
                  {group.rows.map(({ hit, at, key, parts }) => {
                    const on = at === active;
                    // No entrance animation on these rows, on purpose. A row's
                    // key carries its index, so any reorder remounts it — a
                    // stagger here would re-run on each query and read as
                    // flicker rather than polish. Instant is what fast feels
                    // like.
                    return (
                      <li key={key} className="relative">
                        {/* The cursor is one element that glides between rows,
                            rather than a class toggling on and off — the eye
                            can follow it. */}
                        {on && (
                          <motion.span
                            layoutId="search-cursor"
                            className="bg-surface-2 absolute inset-0 rounded-md"
                            transition={m.layout}
                          />
                        )}
                        <button
                          type="button"
                          data-active={on || undefined}
                          onMouseEnter={() => setActive(at)}
                          onClick={() => pick(hit)}
                          className={cn(
                            // `press` carries the colour transition; adding
                            // `transition-colors` on top would drop the
                            // transform from the list and kill the press.
                            "press focus-visible:focus-ring relative w-full rounded-md px-2 py-1.5 text-left",
                            !on && "hover:bg-surface-1",
                          )}
                        >
                          <p className="text-text-3 text-xs">{hitLocation(hit, bookId !== null)}</p>
                          <p className="text-text-1 mt-1 text-[13px] leading-relaxed">
                            {parts.map((part) =>
                              part.matched ? (
                                <mark
                                  key={part.key}
                                  className="bg-accent-soft rounded-[2px] text-inherit"
                                >
                                  {part.text}
                                </mark>
                              ) : (
                                <span key={part.key}>{part.text}</span>
                              ),
                            )}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
