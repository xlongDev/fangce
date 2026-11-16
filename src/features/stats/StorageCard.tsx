import { CaretDown, CaretRight, HardDrives } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { GlassPanel } from "@/components/glass/panel";
import { QueryError } from "@/components/common/QueryError";
import { useStorage } from "@/hooks/useLibrary";
import { displayTitle } from "@/lib/title";
import type { StorageFormat, StorageSummary, StorageTopBook } from "@/types/ipc";

/**
 * Whole-library footprint: how much disk the shelf actually uses, and what it
 * is made of. One total up top, three contributing parts beneath it, then the
 * format split and the few books taking the most room.
 *
 * The three parts are measured independently (source files, cover images, the
 * SQLite database) and the total is their sum — so the numbers always agree.
 * The database is one file for the *whole* library; it is never apportioned to
 * individual books, which is why it only appears in this library-wide view.
 */

/** Bytes to a human size, with GB once it earns one. The shelf's own
 *  `formatFileSize` stops at MB, which is right for one book, not a library. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const FORMAT_LABELS: Record<string, string> = {
  epub: "EPUB",
  pdf: "PDF",
  mobi: "MOBI",
  azw: "AZW",
  azw3: "AZW3",
  prc: "PRC",
  fb2: "FB2",
  cbz: "CBZ",
  markdown: "MD",
  txt: "TXT",
};

function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

/** One of the three contributing parts, as a labelled share of the whole.
 *  A part may carry a click action (补充封面 opens the cover manager). */
function Part({
  label,
  bytes,
  total,
  color,
  hint,
  onClick,
}: {
  label: string;
  bytes: number;
  total: number;
  color: string;
  hint?: string;
  onClick?: () => void;
}) {
  const percent = total > 0 ? Math.round((bytes / total) * 100) : 0;
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
        <span className="text-text-3 text-[11px]">{label}</span>
      </div>
      <p className="text-text-1 mt-1 text-sm font-medium tabular-nums">{formatBytes(bytes)}</p>
      <p className="text-text-3 mt-0.5 text-[11px] tabular-nums">{percent}%</p>
      {hint && <p className="text-accent mt-0.5 text-[10px]">{hint}</p>}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="打开封面管理"
        className="focus-visible:focus-ring hover:bg-text-1/8 glass group -mx-0.5 min-w-0 cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors"
      >
        {inner}
      </button>
    );
  }
  return <div className="glass min-w-0 rounded-lg px-3 py-2.5">{inner}</div>;
}

function FormatRow({
  row,
  max,
  onFilter,
}: {
  row: StorageFormat;
  max: number;
  onFilter: (format: string) => void;
}) {
  const width = max > 0 ? Math.max(2, Math.round((row.bytes / max) * 100)) : 0;
  return (
    <button
      type="button"
      onClick={() => onFilter(row.format)}
      title={`在书架上只看 ${formatLabel(row.format)}`}
      className="focus-visible:focus-ring hover:bg-text-1/8 group -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-lg px-1.5 py-0.5 text-left transition-colors"
    >
      <div className="text-text-3 w-11 shrink-0">
        <p className="text-[11px]">{formatLabel(row.format)}</p>
        <p className="text-text-3/70 mt-0.5 text-[10px] tabular-nums">{row.count} 本</p>
      </div>
      <div className="bg-surface-2 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
        <div className="bg-accent h-full rounded-full" style={{ width: `${width}%` }} />
      </div>
      <span className="text-text-2 w-16 shrink-0 text-right text-[11px] tabular-nums">
        {formatBytes(row.bytes)}
      </span>
      <CaretRight
        size={11}
        weight="bold"
        className="text-text-3/60 group-hover:text-text-1 shrink-0 transition-colors"
      />
    </button>
  );
}

export function StorageCard({
  onLocateBook,
  onSortBySize,
  onFilterByFormat,
  onOpenCovers,
}: {
  onLocateBook: (title: string) => void;
  onSortBySize: () => void;
  onFilterByFormat: (format: string) => void;
  onOpenCovers: () => void;
}) {
  const { data, error, refetch } = useStorage();

  return (
    <GlassPanel className="px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-text-1 flex items-center gap-2 text-sm font-medium">
          <HardDrives size={15} /> 书架占用
        </h2>
        <span className="text-text-3 text-[11px]">书籍文件 + 补充封面 + 数据库</span>
      </div>

      {error ? (
        <QueryError
          error={error}
          onRetry={() => void refetch()}
          icon={<HardDrives size={24} />}
          title="占用统计读不出来"
          description="这次没有量出书架占用，重试一次就好。"
        />
      ) : (
        <StorageBody
          data={data}
          onLocateBook={onLocateBook}
          onSortBySize={onSortBySize}
          onFilterByFormat={onFilterByFormat}
          onOpenCovers={onOpenCovers}
        />
      )}
    </GlassPanel>
  );
}

function StorageBody({
  data,
  onLocateBook,
  onSortBySize,
  onFilterByFormat,
  onOpenCovers,
}: {
  data: StorageSummary | undefined;
  onLocateBook: (title: string) => void;
  onSortBySize: () => void;
  onFilterByFormat: (format: string) => void;
  onOpenCovers: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = data?.totalBytes ?? 0;
  const orphans = data?.orphanCoversCount ?? 0;
  const parts: {
    label: string;
    bytes: number;
    color: string;
    hint?: string;
    onClick?: () => void;
  }[] = [
    { label: "书籍文件", bytes: data?.booksBytes ?? 0, color: "var(--color-accent)" },
    {
      label: "补充封面",
      bytes: data?.coversBytes ?? 0,
      color: "#1D9E75",
      hint: orphans > 0 ? `发现 ${orphans} 张无主封面 ›` : undefined,
      onClick: onOpenCovers,
    },
    { label: "数据库", bytes: data?.databaseBytes ?? 0, color: "#BA7517" },
  ];
  const byFormat = data?.byFormat ?? [];
  const maxFormat = byFormat.reduce((max, row) => Math.max(max, row.bytes), 0);
  const topBooks = data?.topBooks ?? [];

  return (
    <>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-text-1 text-3xl font-medium tabular-nums">{formatBytes(total)}</p>
        <p className="text-text-3 text-[11px]">数据库为全库共用，不分摊到单本</p>
      </div>

      <div className="mb-4 flex gap-1.5">
        {parts.map((part) => (
          <div
            key={part.label}
            className="h-2 overflow-hidden rounded-full"
            style={{ flex: total > 0 ? part.bytes : 1, background: "var(--color-surface-2)" }}
            title={`${part.label} ${formatBytes(part.bytes)}`}
          >
            <div className="h-full w-full rounded-full" style={{ background: part.color }} />
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2.5">
        {parts.map((part) => (
          <Part key={part.label} {...part} total={total} />
        ))}
      </div>

      {byFormat.length > 0 && (
        <div className="border-hairline border-t pt-3">
          <h3 className="text-text-1 mb-2.5 text-xs font-medium">按格式</h3>
          <div className="space-y-2">
            {byFormat.map((row) => (
              <FormatRow key={row.format} row={row} max={maxFormat} onFilter={onFilterByFormat} />
            ))}
          </div>
        </div>
      )}

      {topBooks.length > 0 && (
        <div className="border-hairline mt-3 border-t pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onSortBySize}
              title="在书架上按文件大小查看全部书籍"
              className="focus-visible:focus-ring hover:bg-text-1/8 group -mx-1 flex min-w-0 items-center gap-1 rounded px-1 text-left transition-colors"
            >
              <span className="text-text-1 text-xs font-medium">最占空间</span>
              <CaretRight
                size={12}
                weight="bold"
                className="text-text-3 group-hover:text-text-1 transition-colors"
              />
            </button>
            {topBooks.length > 5 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? "收起" : "展开前 10 名"}
                title={expanded ? "收起" : "展开前 10 名"}
                className="text-text-3 hover:text-text-1 focus-visible:focus-ring -mr-1 shrink-0 rounded p-1 transition-colors"
              >
                <motion.span
                  className="flex"
                  animate={{ rotate: expanded ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <CaretDown size={13} weight="bold" />
                </motion.span>
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-1.5">
            {topBooks.slice(0, 5).map((book, index) => (
              <li key={book.id}>
                <TopBookRow book={book} index={index} onLocate={onLocateBook} />
              </li>
            ))}
            <AnimatePresence initial={false}>
              {expanded &&
                topBooks.slice(5).map((book, index) => (
                  <motion.li
                    key={book.id}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <TopBookRow book={book} index={index + 5} onLocate={onLocateBook} />
                  </motion.li>
                ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </>
  );
}

/** One ranked book in the 最占空间 list — shared by the fixed five and the
 *  animated extra five so their rows stay identical. */
function TopBookRow({
  book,
  index,
  onLocate,
}: {
  book: StorageTopBook;
  index: number;
  onLocate: (title: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onLocate(book.title)}
      title={`在书架上找到《${book.title}》`}
      className="text-text-2 hover:bg-text-1/8 hover:text-text-1 focus-visible:focus-ring group -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 text-left text-[11px] transition-colors"
    >
      <span className="text-text-3 w-4 shrink-0 tabular-nums">{index + 1}</span>
      <span className="min-w-0 flex-1 truncate">{displayTitle(book.title)}</span>
      <span className="shrink-0 tabular-nums">{formatBytes(book.fileSize)}</span>
      <CaretRight
        size={11}
        weight="bold"
        className="text-text-3/60 group-hover:text-text-1 shrink-0 transition-colors"
      />
    </button>
  );
}
