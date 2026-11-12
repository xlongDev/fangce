import { useQuery } from "@tanstack/react-query";
import { Copy } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { isDesktopRuntime, ipc } from "@/lib/ipc";
import type { DuplicateBook, DuplicateGroup } from "@/types/ipc";

/**
 * 「疑似重复」: read-only, and deliberately so.
 *
 * Two files of the same novel are two rows, two covers and two tiles, and
 * import-time dedupe cannot see them — it compares bytes, not identity. But a
 * "duplicate" may be another translation, another volume, or an annotated
 * copy. So this sheet names the evidence and stops there: no merge, no delete,
 * no silent judgement about which copy matters.
 */
export function DuplicateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const report = useQuery({
    queryKey: ["duplicates"],
    queryFn: () => ipc.libraryDuplicates(),
    // The browser build's books live in IndexedDB; the report is a SQL scan of
    // the desktop library. Say so rather than answering with an empty list.
    enabled: open && isDesktopRuntime,
  });

  const groups = report.data ?? [];
  const books = groups.reduce((sum, group) => sum + group.books.length, 0);

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="疑似重复"
      description="按 ISBN 精确匹配，其余按书名归一化比较。只做提示，不会自动合并或删除。"
      widthClass="w-[min(92vw,600px)]"
    >
      {!isDesktopRuntime ? (
        <p className="text-text-2 py-4 text-[13px] leading-relaxed">
          重复检测只在桌面版可用；浏览器版的书存在 IndexedDB 里，没有这张 SQL 表。
        </p>
      ) : report.isPending ? (
        <p className="text-text-2 py-4 text-[13px]">正在扫描书库…</p>
      ) : report.isError ? (
        <p className="text-danger py-4 text-[13px] leading-relaxed">{report.error.message}</p>
      ) : groups.length === 0 ? (
        <p className="text-text-2 py-4 text-[13px] leading-relaxed">
          没找到疑似重复的书。同名不同卷、不同译本也不会被误判成重复。
        </p>
      ) : (
        <>
          <p className="text-text-3 mb-3 text-xs">
            {groups.length} 组 · 共 {books} 本。组内按加入时间排序，最早的那本在最上面。
          </p>
          <ul className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {groups.map((group) => (
              <Group key={`${group.reason}|${group.books[0]?.id ?? ""}`} group={group} />
            ))}
          </ul>
        </>
      )}

      <div className="mt-4 flex justify-end">
        <GlassButton variant="subtle" onClick={onClose}>
          关闭
        </GlassButton>
      </div>
    </GlassDialog>
  );
}

function Group({ group }: { group: DuplicateGroup }) {
  const oldest = group.books[0];
  return (
    <li className="glass space-y-2 rounded-md p-3">
      <div className="flex items-center gap-2">
        <Copy size={14} className="text-text-3 shrink-0" />
        <h3 className="text-text-1 min-w-0 flex-1 truncate text-[13px] font-medium">
          《{oldest?.title ?? "—"}》 · {group.books.length} 本
        </h3>
        <span className="border-hairline text-text-3 shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]">
          {group.reason}
        </span>
      </div>
      <ul className="divide-hairline divide-y">
        {group.books.map((book) => (
          <Book key={book.id} book={book} />
        ))}
      </ul>
    </li>
  );
}

function Book({ book }: { book: DuplicateBook }) {
  return (
    <li className="flex items-start gap-2 py-1.5 text-[12px]">
      <span className="text-text-1 min-w-0 flex-1 truncate" title={book.title}>
        {book.title}
      </span>
      <span className="text-text-3 shrink-0 uppercase tabular-nums">{book.format}</span>
      <span className="text-text-3 w-16 shrink-0 text-right tabular-nums">
        {readableSize(book.fileSize)}
      </span>
      <span className="text-text-3 w-20 shrink-0 text-right tabular-nums">
        {dateOf(book.addedAt)}
      </span>
    </li>
  );
}

function readableSize(bytes: number): string {
  return bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const DAY = new Intl.DateTimeFormat("zh-CN", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
});

function dateOf(seconds: number): string {
  return DAY.format(new Date(seconds * 1000));
}
