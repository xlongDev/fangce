import { Clock, Fire, CalendarBlank, TrendUp, BookOpen, ChartLineUp } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/common/EmptyState";
import { QueryError } from "@/components/common/QueryError";
import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { GlassPanel } from "@/components/glass/panel";
import { PageHeader } from "@/components/layout/PageHeader";
import { Reveal } from "@/components/motion/Reveal";
import { useLibraryStats } from "@/hooks/useLibrary";
import { useClearReadingStats, useReadingStats } from "@/hooks/useReading";
import { StorageCard } from "@/features/stats/StorageCard";
import { useToasts } from "@/stores/toasts";
import { useSettings } from "@/stores/settings";
import type { DayTotal, TopBook } from "@/types/ipc";
import { staggerDelay, useMotion } from "@/lib/motion";
import { displayTitle } from "@/lib/title";

/**
 * Reading stats: how much time went into reading, and where it went.
 *
 * The heat map is the anchor — half a year of squares shows the rhythm that
 * brings a reader back tomorrow. Around it: the same rhythm at day scale
 * (trailing month as bars) and at book scale (the trailing-month ranking),
 * so the page answers "how am I doing" and "what was I reading" together.
 */

/** Gap between heat-map cells, in px. There is no cell *size* constant any
 *  more: the grid divides the width it is given by its own column count, and
 *  the legend's swatches are sized by the same expression (see `Heatmap`). */
const GAP = 3;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** Human reading time. Below an hour it is minutes; above it, hours. */
function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)} 月 ${Number(date)} 日`;
}

function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
}

interface MetricProps {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
  /** Entrance offset inside the row of four; see `staggerDelay`. */
  delay?: number;
}

function Metric({ icon, label, value, hint, delay = 0 }: MetricProps) {
  const m = useMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...m.enter, delay }}
      className="flex items-start gap-3 px-5 py-4"
    >
      <span className="text-text-3 mt-0.5 flex">{icon}</span>
      <div className="min-w-0">
        <p className="text-text-2 text-xs">{label}</p>
        <p className="text-text-1 mt-0.5 text-lg font-semibold tabular-nums md:text-xl">{value}</p>
        {hint && <p className="text-text-3 mt-0.5 text-[11px]">{hint}</p>}
      </div>
    </motion.div>
  );
}

/**
 * Squares for the trailing days, one column per week, oldest first.
 *
 * Leading blanks pad the first column so every row is one weekday; without
 * them the Sunday-to-Saturday labels would drift against the data.
 *
 * The grid sizes its own cells from the width it is handed, and the legend
 * under it is sized by the very same expression — see `cell`.
 */
function Heatmap({ days }: { days: DayTotal[] }) {
  const first = days[0] ? new Date(`${days[0].day}T00:00:00`).getDay() : 0;
  const cells: (DayTotal | null)[] = [...Array<null>(first).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (DayTotal | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }

  /**
   * One cell, as an expression over the grid's own width.
   *
   * A swatch and a cell are the same square, so a grid that resizes itself
   * cannot be read against a fixed-size legend: at the two-column width the
   * squares are ~10px against 11px swatches and nobody notices, but drop to
   * one column and the same squares are ~22px beside swatches that stayed
   * 11px, which everybody does.
   */
  const cellSize = `calc((100% - ${(weeks.length - 1) * GAP}px) / ${weeks.length})`;

  // Four shades over the reader's own busiest day: the scale means nothing
  // absolute, so it is relative rather than a fixed minutes ladder.
  const busiest = Math.max(...days.map((day) => day.seconds), 1);
  const shade = (seconds: number) => {
    const ratio = seconds / busiest;
    if (ratio > 0.66) return 1;
    if (ratio > 0.33) return 0.72;
    if (ratio > 0.08) return 0.44;
    return 0.22;
  };

  let lastMonth = -1;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-full gap-2">
        {/* Weekday labels share the grid's own row height: they stretch with it
            (and `pt-[15px]` clears the month row) instead of being pinned to a
            fixed cell size that only matches one panel width. `w-3` so the
            legend below knows exactly how far in the grid starts. */}
        <div
          className="flex w-3 shrink-0 flex-col pt-[15px]"
          style={{ gap: GAP }}
          aria-hidden="true"
        >
          {WEEKDAYS.map((label, index) => (
            <span
              key={label}
              className="text-text-3 flex flex-1 items-center text-[9px] leading-none"
            >
              {index % 2 === 1 ? label : ""}
            </span>
          ))}
        </div>

        {/* Weeks divide the panel's own width instead of sitting at a fixed size
          against its left edge. A half year is 26 columns, and at a hard 11px
          they filled a third of the card and left the rest blank; each cell is
          square for whatever width it lands on, so the grid still reads as a
          grid when the window narrows to one column. */}
        <div className="flex min-w-0 flex-1" style={{ gap: GAP }}>
          {weeks.map((week, column) => {
            const anchor = week.find((cell) => cell !== null);
            const month = anchor ? Number(anchor.day.split("-")[1]) : lastMonth;
            const showMonth = month !== lastMonth;
            lastMonth = month;
            return (
              <div
                key={anchor?.day ?? `lead-${column}`}
                className="flex min-w-0 flex-1 flex-col"
                style={{ gap: GAP }}
              >
                <span className="text-text-3 relative h-[11px] text-[9px] leading-none">
                  {showMonth && (
                    <span className="absolute top-0 left-0 whitespace-nowrap">{month} 月</span>
                  )}
                </span>
                {week.map((cell, row) => (
                  <span
                    key={cell?.day ?? `pad-${column}-${row}`}
                    className="heat-cell block w-full"
                    style={{ animationDelay: `${column * 14}ms` }}
                  >
                    <span
                      className="bg-accent block aspect-square w-full rounded-[3px]"
                      style={{ opacity: cell ? (cell.seconds > 0 ? shade(cell.seconds) : 0.1) : 0 }}
                      title={cell ? `${dayLabel(cell.day)}：${duration(cell.seconds)}` : undefined}
                    />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* The legend sits under the grid rather than in the heading, because
          `cellSize` resolves against the width it is given — and the width the
          grid gets is this row's, not the heading's. `pl-5` skips the weekday
          column (12px) and its gap (8px), so the swatches start where the grid
          does and the scale reads as belonging to it. */}
      <div className="text-text-3 flex w-full items-center justify-end gap-1.5 pl-5 text-[11px]">
        <span>少</span>
        {[0.1, 0.22, 0.44, 0.72, 1].map((opacity) => (
          <span
            key={opacity}
            className="bg-accent block aspect-square shrink-0 rounded-[3px]"
            // Width from the grid, height from `aspect-square`: a percentage
            // height would resolve against a parent whose height is `auto`,
            // which is zero, and the swatches come out as invisible slivers.
            style={{ width: cellSize, opacity }}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}

/**
 * One bar per day for the trailing month, oldest left.
 *
 * Height is relative to the month's own busiest day, and that peak is where
 * the top guide sits — between the two dashed lines and the solid zero line
 * the chart says what a bar is worth without carrying a y axis.
 *
 * Quiet days draw nothing. They used to be a 3%-tall stub so "a gap reads as
 * a gap", but thirty of them side by side *are* a dashed rule across the
 * card, and the real bars then appeared to float above it rather than rise
 * from it. The gap between bars is the gap; the card says which day was which
 * underneath.
 */
function TrendBars({ days }: { days: DayTotal[] }) {
  const peak = Math.max(...days.map((day) => day.seconds), 1);
  return (
    <div>
      <div className="relative h-28">
        <div className="border-hairline absolute inset-x-0 top-0 border-t border-dashed" />
        <div className="border-hairline absolute inset-x-0 top-1/2 border-t border-dashed" />
        <div className="border-hairline absolute inset-x-0 bottom-0 border-t" />
        {/* `relative` so the bars paint over the guides rather than under
            them — an absolutely positioned sibling wins against static
            content, guides and all. */}
        <div className="relative flex h-full items-end gap-[3px]">
          {days.map((day, index) => (
            <span
              key={day.day}
              className="group relative flex h-full min-w-0 flex-1 items-end"
              // On the column, not the bar: the whole height is then the hit
              // area, so a day that drew no bar can still be read.
              title={`${dayLabel(day.day)}：${duration(day.seconds)}`}
            >
              {day.seconds > 0 && (
                <span
                  className="bg-accent w-full rounded-t-[3px] transition-opacity group-hover:opacity-100!"
                  style={{
                    height: `${Math.max((day.seconds / peak) * 100, 6)}%`,
                    opacity: 0.7,
                    animationDelay: `${index * 10}ms`,
                  }}
                />
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Ends and the middle only: one label a day is thirty collisions at
          this width. */}
      <div className="text-text-3 mt-1.5 flex justify-between text-[10px] tabular-nums">
        <span>{shortDay(days[0]?.day ?? "")}</span>
        <span>{shortDay(days[Math.floor(days.length / 2)]?.day ?? "")}</span>
        <span>{shortDay(days.at(-1)?.day ?? "")}</span>
      </div>
    </div>
  );
}

/**
 * The trailing-month ranking. Tapping a row opens that book.
 *
 * The bar is this book's share of the month's total — not how far into it the
 * reader is. It used to be scaled against the busiest book *and* faded by
 * rank, which is a progress bar's geometry and a progress bar's shading: on a
 * page next to a shelf where the same track means how much of the book is
 * left, every row below the first read as a book barely begun.
 */
function TopBooks({ books, onOpen }: { books: TopBook[]; onOpen: (bookId: string) => void }) {
  const total = books.reduce((sum, book) => sum + book.seconds, 0) || 1;
  return (
    <ul className="-mx-2 flex flex-col">
      {books.map((book, index) => (
        <li key={book.bookId}>
          <button
            type="button"
            onClick={() => onOpen(book.bookId)}
            className="focus-visible:focus-ring hover:bg-surface-1 group w-full rounded-xl px-2 py-2 text-left transition-colors"
            aria-label={`打开《${book.title}》`}
          >
            <span className="flex items-baseline gap-2">
              <span className="text-text-3 w-4 text-xs tabular-nums">{index + 1}</span>
              <span className="text-text-1 min-w-0 flex-1 truncate text-sm" title={book.title}>
                {displayTitle(book.title)}
              </span>
              <span className="text-text-2 text-xs tabular-nums">{duration(book.seconds)}</span>
            </span>
            <span className="bg-surface-1 mt-1.5 ml-6 flex h-[3px] overflow-hidden rounded-full">
              {/* `min-w` rather than a percentage floor: a real 2% share is
                  allowed to be 2%, it just must not disappear. */}
              <span
                className="bg-accent block h-full min-w-[3px] rounded-full transition-[width]"
                style={{ width: `${Math.min((book.seconds / total) * 100, 100)}%` }}
              />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function StatsPage() {
  const m = useMotion();
  const navigate = useNavigate();
  const { data, isPending, error: readingError, refetch: refetchReading } = useReadingStats();
  const library = useLibraryStats();
  // The read failure, surfaced the same way the shelf does. A first-open with
  // no reading yet is NOT an error and must never become a toast.
  const readError = readingError ?? library.error;
  const retryStats = () => {
    void refetchReading();
    void library.refetch();
  };
  const clear = useClearReadingStats();
  const toast = useToasts((state) => state.push);
  const [clearOpen, setClearOpen] = useState(false);

  const stats = data;
  const tracked = (stats?.totalSeconds ?? 0) > 0;
  const days = stats?.days ?? [];
  const yesterday = days.at(-2);
  const month = days.slice(-30);
  const bestDay = month.reduce<DayTotal | null>(
    (top, day) => (!top || day.seconds > top.seconds ? day : top),
    null,
  );
  const openBook = (bookId: string) => navigate(`/reader?book=${bookId}`);
  const setShelfView = useSettings((s) => s.setShelfView);
  /** From the footprint card, find the book on the shelf rather than open it.
   *  The shelf's own search is the locator: hand it the full stored title (not
   *  the truncated label) and clear any tag narrowing that would hide the book.
   *  That reuses the existing query path and leaves the reader's other shelf
   *  preferences alone. */
  const locateBook = (title: string) => {
    setShelfView("all", { search: title, tag: null });
    navigate("/");
  };

  /** 从占用卡片点「最占空间」：到书架按文件大小降序看全部书，而不是只把
   *  Top N 摊在这里。清掉 search / tag，免得上一次的定位或标签筛选把书藏了。 */
  const sortBySize = () => {
    setShelfView("all", { sort: "sizeDesc", descending: true, search: "", tag: null });
    navigate("/");
  };

  /** 点某个格式：书架按该格式筛选。格式是「当下这一眼」的筛选而非偏好，
   *  走一次性 location.state，不写进持久化的 shelfViews（那是搜索/排序的家）。
   *  但要清掉视图里残留的 search/tag —— 那是 locateBook 留下的，叠加成
   *  「搜这个书名又只看这个格式」会把人领到一片空白。排序则保留读者的偏好。 */
  const filterByFormat = (format: string) => {
    setShelfView("all", { search: "", tag: null });
    navigate("/", { state: { shelfFormat: format } });
  };

  /** Irreversible, so it asks; the toast is the only feedback after the fact
   *  because what it wiped is no longer on screen to show. */
  const confirmClear = () => {
    clear.mutate(undefined, {
      onSuccess: () => {
        setClearOpen(false);
        toast({ tone: "success", message: "阅读时长已清除，书和笔记都还在" });
      },
    });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="阅读统计"
        subtitle="打开书的时间会被记下来，一半是给自己的交代，一半是明天再打开的理由。"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pb-8">
        {readError ? (
          <QueryError
            error={readError}
            onRetry={retryStats}
            icon={<ChartLineUp size={26} weight="duotone" />}
            title="统计读不出来"
            description="阅读记录这次没有读出来。先重试一次；如果还是不行，多半是本地的数据库文件出了问题。"
            className="min-h-[40vh]"
          />
        ) : isPending ? (
          <GlassPanel className="h-[92px] animate-pulse" />
        ) : (
          // `lg`, not `md`: at 768px the pane is ~500px and four columns are
          // ~125px each, which folds 「42 小时 13 分」 onto three lines. The 2×2
          // it falls back to below 1024px is the same four numbers at a width
          // they fit in.
          <GlassPanel className="divide-hairline grid grid-cols-2 divide-y lg:grid-cols-4 lg:divide-x lg:divide-y-0">
            <Metric
              icon={<Clock size={18} />}
              label="今日阅读"
              value={duration(stats?.todaySeconds ?? 0)}
              hint={yesterday ? `昨天 ${duration(yesterday.seconds)}` : undefined}
              delay={staggerDelay(0, m.stagger)}
            />
            <Metric
              icon={<Fire size={18} />}
              label="连续天数"
              value={`${stats?.streak ?? 0} 天`}
              hint={stats?.streak ? `历史最长 ${stats.bestStreak} 天` : "今天开一本就续上"}
              delay={staggerDelay(1, m.stagger)}
            />
            <Metric
              icon={<TrendUp size={18} />}
              label="最近七天"
              value={duration(stats?.weekSeconds ?? 0)}
              hint={
                (stats?.weekSeconds ?? 0) > 0
                  ? `日均 ${duration(Math.round((stats?.weekSeconds ?? 0) / 7))}`
                  : undefined
              }
              delay={staggerDelay(2, m.stagger)}
            />
            <Metric
              icon={<CalendarBlank size={18} />}
              label="累计阅读"
              value={duration(stats?.totalSeconds ?? 0)}
              hint={`${stats?.daysRead ?? 0} 天有过阅读`}
              delay={staggerDelay(3, m.stagger)}
            />
          </GlassPanel>
        )}

        <Reveal delay={staggerDelay(4, m.stagger)}>
          {/* 2 + 3, mirroring the row below it. The heat map gets the two
              narrow columns: 26 weeks divide that width into ~10px cells,
              which is the size the legend's swatches are drawn at — give it
              the wide side instead and the squares double while the legend
              stays put. The shelf summary takes the rest. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <GlassPanel className="px-5 py-4 lg:col-span-2">
              {tracked && stats ? (
                <>
                  {/* No legend in the heading: it is part of the grid now, so
                      the swatches can be sized from the grid's own width. */}
                  <h2 className="text-text-1 mb-3 text-sm font-medium">过去半年</h2>
                  <Heatmap days={stats.days} />
                </>
              ) : (
                <EmptyState
                  className="py-10"
                  icon={<Clock size={24} />}
                  title="还没有阅读记录"
                  description="打开一本书读一会儿，这里会按天记下你花了多少时间，半年之后就是一张图。"
                />
              )}
            </GlassPanel>

            {/* The same four numbers the shelf's own footer counts, on the
                page where time is the subject: what the half year happened
                to, in books rather than minutes. */}
            <GlassPanel className="flex flex-col justify-center px-5 py-4 lg:col-span-3">
              <ul className="grid grid-cols-2 gap-x-6 gap-y-3">
                {[
                  { label: "书架共", value: `${library.data?.total ?? 0} 本` },
                  { label: "在读", value: `${library.data?.reading ?? 0} 本` },
                  { label: "读完", value: `${library.data?.finished ?? 0} 本` },
                  { label: "最长连续", value: `${stats?.bestStreak ?? 0} 天` },
                ].map((item) => (
                  <li key={item.label} className="min-w-0">
                    <p className="text-text-1 truncate text-xl font-semibold tabular-nums">
                      {item.value}
                    </p>
                    <p className="text-text-3 text-[11px]">{item.label}</p>
                  </li>
                ))}
              </ul>
            </GlassPanel>
          </div>
        </Reveal>

        {tracked && stats && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <Reveal delay={staggerDelay(5, m.stagger)} className="lg:col-span-2">
              <GlassPanel className="h-full px-5 py-4">
                {/* No date range in the heading: the axis under the bars now
                    carries the same two dates, and saying them twice left the
                    header competing with the chart it was describing. */}
                <h2 className="text-text-1 mb-3 text-sm font-medium">最近 30 天</h2>
                <TrendBars days={month} />
                {bestDay && bestDay.seconds > 0 && (
                  <p className="text-text-3 mt-3 text-[11px]">
                    最投入的一天：{dayLabel(bestDay.day)} · {duration(bestDay.seconds)}
                  </p>
                )}
              </GlassPanel>
            </Reveal>

            <Reveal delay={staggerDelay(6, m.stagger)} className="lg:col-span-3">
              <GlassPanel className="h-full px-5 py-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-text-1 text-sm font-medium">最近在读</h2>
                  <span className="text-text-3 text-[11px]">
                    条形为近 30 天的时长占比 · 点击回到书里
                  </span>
                </div>
                {stats.topBooks.length > 0 ? (
                  <TopBooks books={stats.topBooks} onOpen={openBook} />
                ) : (
                  <p className="text-text-3 flex items-center gap-2 py-6 text-xs">
                    <BookOpen size={14} className="shrink-0" />
                    最近 30 天还没有翻开过书。
                  </p>
                )}
              </GlassPanel>
            </Reveal>
          </div>
        )}

        {tracked && (
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => setClearOpen(true)}
              className="focus-visible:focus-ring text-text-3 hover:text-danger rounded-lg px-2 py-1 text-[11px] transition-colors"
            >
              清除阅读数据
            </button>
          </div>
        )}

        <Reveal delay={staggerDelay(7, m.stagger)}>
          <StorageCard
            onLocateBook={locateBook}
            onSortBySize={sortBySize}
            onFilterByFormat={filterByFormat}
          />
        </Reveal>
      </div>

      <GlassDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清除全部阅读时长？"
        description="热力图、连续天数和最近在读都会归零，此操作无法撤销。书籍、进度、标注和笔记不受影响。"
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setClearOpen(false)}
            disabled={clear.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            onClick={confirmClear}
            disabled={clear.isPending}
          >
            清除
          </GlassButton>
        </div>
      </GlassDialog>
    </div>
  );
}
