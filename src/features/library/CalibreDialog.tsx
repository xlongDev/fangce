import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { CaretDown, FolderOpen, Warning } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { failedMessage, summarizeOutcomes } from "@/features/library/format";
import { useImportBooks } from "@/hooks/useLibrary";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { isDesktopRuntime, ipc, onImportProgress } from "@/lib/ipc";
import type { CalibreBook, CalibreFile, CalibreScan, ImportOutcome } from "@/types/ipc";

/** A page of a 1,500-book library is still a page. Rendering all of it into a
 *  640px sheet would cost more than the selection is worth. */
const PAGE_SIZE = 100;

/** Empty means "automatic": Rust's EPUB-first order. */
const AUTO_FORMAT = "";

/** Every field `calibre.rs::read_optional` can report. The strings are the
 *  labels that function pushes into `metadataFields`, so adding a probe there
 *  means adding its label here. What a library *lacks* is as useful to show as
 *  what it has — that is the diagnosis a real library brings back. */
const OPTIONAL_FIELDS = ["ISBN", "出版日期", "出版社", "标签", "系列", "评分", "语言", "简介"];

/**
 * 「Calibre 书库扫描」 — read-only scan, then an opt-in import.
 *
 * One file per book: a Calibre title often has both EPUB and AZW3, and
 * importing both would put the same novel on the shelf twice (different bytes,
 * so hash-dedupe cannot see them). Rust orders `files` with EPUB first; the
 * reader may pick a preferred format for the whole batch, and books that lack
 * it fall back to their own first file (the sheet says how many).
 *
 * The browser build has no filesystem, so it says so instead of answering
 * with an empty list — the same rule the duplicate report follows.
 */
export function CalibreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [root, setRoot] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [preferredFormat, setPreferredFormat] = useState(AUTO_FORMAT);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const importing = useRef(false);
  const importBooks = useImportBooks();

  // `book://import-progress` is global. Only count it while our own batch is
  // in flight, so an unrelated import cannot paint a number in this sheet.
  useTauriEvent(onImportProgress, (payload) => {
    if (importing.current) setProgress({ done: payload.done, total: payload.total });
  });

  const report = useQuery({
    queryKey: ["calibre-scan", root],
    queryFn: () => ipc.calibreScan(root as string),
    // A picked path is the whole question; nothing to ask until there is one.
    enabled: open && isDesktopRuntime && root !== null,
    retry: false,
  });

  const choose = async () => {
    setPickError(null);
    setPicking(true);
    try {
      const picked = await pickDirectory({
        directory: true,
        multiple: false,
        title: "选择 Calibre 书库根目录",
      });
      // `null` is a cancelled dialog, not a failed one: leave the last report
      // on screen rather than wiping it for a change of mind.
      if (typeof picked === "string") {
        setRoot(picked);
        setSelected(new Set());
        setOutcomes(null);
        setImportError(null);
        setQuery("");
        setPage(0);
        setPreferredFormat(AUTO_FORMAT);
      }
    } catch (error) {
      setPickError(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const scan = report.data;
  const needle = query.trim().toLocaleLowerCase();
  const filtered =
    scan?.books.filter(
      (book) =>
        !needle ||
        book.title.toLocaleLowerCase().includes(needle) ||
        book.authors.some((author) => author.toLocaleLowerCase().includes(needle)),
    ) ?? [];
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  // Selection is over the whole *filtered* library, not just the visible page.
  const importable = filtered.filter((book) => book.files.length > 0);
  const chosen = importable.filter((book) => selected.has(book.id));

  // Offer only formats that actually exist in this library. An option for a
  // format no book has would be a promise this sheet cannot keep.
  const availableFormats = [
    ...new Set(scan?.books.flatMap((book) => book.files.map((file) => file.format)) ?? []),
  ].toSorted();
  const fileFor = (book: CalibreBook): CalibreFile | undefined =>
    preferredFormat === AUTO_FORMAT
      ? book.files[0]
      : (book.files.find((file) => file.format === preferredFormat) ?? book.files[0]);
  // One path per book — never both formats of the same novel.
  const paths = chosen.flatMap((book) => fileFor(book)?.path ?? []);
  const fallbackCount =
    preferredFormat === AUTO_FORMAT
      ? 0
      : importable.filter((book) => !book.files.some((file) => file.format === preferredFormat))
          .length;
  const allSelected = importable.length > 0 && chosen.length === importable.length;

  const toggle = (id: number) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(importable.map((book) => book.id)));

  const run = async () => {
    if (paths.length === 0) return;
    setImportError(null);
    importing.current = true;
    setProgress({ done: 0, total: paths.length });
    try {
      const result = await importBooks.mutateAsync({ paths });
      setOutcomes(result);
      // A second click must not import the same batch again. Hash-dedupe
      // would catch it, but "N 本已在书架上" is a confusing answer to a
      // button the reader believes they pressed once.
      setSelected(new Set());
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      importing.current = false;
      setProgress(null);
    }
  };

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Calibre 书库扫描"
      description="只读扫描，不会修改 Calibre 的 metadata.db。每本只导入一个格式；可指定优先格式，默认 EPUB 优先。"
      widthClass="w-[min(92vw,640px)]"
    >
      {!isDesktopRuntime ? (
        <p className="text-text-2 py-4 text-[13px] leading-relaxed">
          扫描 Calibre 书库只在桌面版可用；浏览器版没有访问本地目录的权限。
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <GlassButton size="md" disabled={picking} onClick={choose}>
              <FolderOpen size={15} /> {root ? "换一个目录" : "选择书库目录"}
            </GlassButton>
            {root && (
              <p className="text-text-3 min-w-0 flex-1 truncate text-xs" title={root}>
                {root}
              </p>
            )}
          </div>

          {pickError && <p className="text-danger mt-3 text-[13px] leading-relaxed">{pickError}</p>}
          {importError && (
            <p className="text-danger mt-3 text-[13px] leading-relaxed">{importError}</p>
          )}
          {!root && !pickError && (
            <p className="text-text-2 mt-3 text-[13px] leading-relaxed">
              选一个包含 metadata.db 的书库根目录——不是某本书的子目录。
            </p>
          )}
          {root && report.isPending && <p className="text-text-2 mt-3 text-[13px]">正在扫描…</p>}
          {report.isError && (
            <p className="text-danger mt-3 text-[13px] leading-relaxed">{report.error.message}</p>
          )}

          {scan && scan.books.length > 0 && (
            <div className="mt-3 flex items-center gap-2">
              <GlassInput
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder="按书名或作者筛选"
                aria-label="按书名或作者筛选"
                className="min-w-0 flex-1"
              />
              <div className="glass focus-within:focus-ring relative inline-flex h-9 shrink-0 items-center rounded-md">
                <select
                  aria-label="优先导入格式"
                  value={preferredFormat}
                  onChange={(event) => setPreferredFormat(event.target.value)}
                  className="text-text-1 appearance-none bg-transparent pr-7 pl-3 text-sm outline-none [&>option]:text-black"
                >
                  <option value={AUTO_FORMAT}>自动（EPUB 优先）</option>
                  {availableFormats.map((format) => (
                    <option key={format} value={format}>
                      {format.toUpperCase()}
                    </option>
                  ))}
                </select>
                <CaretDown
                  size={12}
                  className="text-text-3 pointer-events-none absolute right-2.5"
                />
              </div>
            </div>
          )}

          {scan && (
            <Report
              scan={scan}
              shown={shown}
              filteredCount={filtered.length}
              importableCount={importable.length}
              query={query}
              selected={selected}
              allSelected={allSelected}
              outcomes={outcomes}
              preferredFormat={preferredFormat}
              fallbackCount={fallbackCount}
              fileFor={fileFor}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          )}

          {scan && pageCount > 1 && (
            <div className="text-text-2 mt-3 flex items-center justify-between gap-2 text-xs">
              <PageButton
                label="上一页"
                disabled={currentPage === 0}
                onClick={() => setPage((previous) => Math.max(0, previous - 1))}
              />
              <span className="text-text-3">
                第 {currentPage + 1} / {pageCount} 页 · 筛选结果 {filtered.length} 本
              </span>
              <PageButton
                label="下一页"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage((previous) => previous + 1)}
              />
            </div>
          )}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {progress && (
          <p className="text-text-2 mr-auto text-[13px]">
            正在导入 {progress.done} / {progress.total}…
          </p>
        )}
        {!progress && outcomes && (
          <p className="text-text-2 mr-auto text-[13px]">{summarizeOutcomes(outcomes)}</p>
        )}
        {isDesktopRuntime && scan && (
          <GlassButton
            variant="primary"
            size="md"
            disabled={chosen.length === 0 || importBooks.isPending}
            onClick={run}
          >
            {importBooks.isPending ? "导入中…" : `导入选中的 ${chosen.length} 本`}
          </GlassButton>
        )}
        <GlassButton variant="subtle" onClick={onClose}>
          关闭
        </GlassButton>
      </div>
    </GlassDialog>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="press focus-visible:focus-ring hover:text-text-1 disabled:text-text-3 rounded px-2 py-1"
    >
      {label}
    </button>
  );
}

/** The values behind the field list. A real-library check needs to see not
 *  just "ISBN found" but whether the number itself came through correctly;
 *  the book title's tooltip is the cheapest place to show them. */
function metadataSummary(book: CalibreBook): string {
  const m = book.metadata;
  return [
    m.isbn && `ISBN ${m.isbn}`,
    m.series && `系列 ${m.series}`,
    m.publisher && `出版社 ${m.publisher}`,
    m.published && `出版 ${m.published}`,
    m.rating && `评分 ${m.rating}`,
    m.language && `语言 ${m.language}`,
    m.tags.length > 0 && `标签 ${m.tags.join("、")}`,
    m.description && `简介 ${m.description}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function Report({
  scan,
  shown,
  filteredCount,
  importableCount,
  query,
  selected,
  allSelected,
  outcomes,
  preferredFormat,
  fallbackCount,
  fileFor,
  onToggle,
  onToggleAll,
}: {
  scan: CalibreScan;
  shown: CalibreBook[];
  filteredCount: number;
  importableCount: number;
  query: string;
  selected: Set<number>;
  allSelected: boolean;
  outcomes: ImportOutcome[] | null;
  preferredFormat: string;
  fallbackCount: number;
  fileFor: (book: CalibreBook) => CalibreFile | undefined;
  onToggle: (id: number) => void;
  onToggleAll: () => void;
}) {
  const formats = new Map<string, number>();
  for (const book of scan.books) {
    for (const format of book.formats) {
      formats.set(format, (formats.get(format) ?? 0) + 1);
    }
  }
  const tally = [...formats]
    .toSorted((a, b) => b[1] - a[1])
    .map(([format, count]) => `${format} ${count}`)
    .join(" · ");
  const failures =
    outcomes?.filter(
      (outcome): outcome is Extract<ImportOutcome, { kind: "failed" }> => outcome.kind === "failed",
    ) ?? [];
  // The backend probes optional tables one at a time; an absent one is a
  // version difference, not a broken library. Say which fields were found and
  // which were skipped so a real library's schema is legible from this sheet.
  const found = scan.metadataFields;
  const absent = OPTIONAL_FIELDS.filter((field) => !found.includes(field));

  return (
    // One scroll area for the whole report. `GlassDialog` only centres; a
    // second nested scroller would strand the warnings above the book list.
    <div className="mt-4 max-h-[58vh] space-y-3 overflow-y-auto pr-1">
      <p className="text-text-2 text-[13px]">
        共 {scan.books.length} 本{tally && ` · ${tally}`}
        {!tally && " · 没有可识别的格式"}
      </p>

      <p className="text-text-3 text-xs leading-relaxed">
        扩展元数据：
        {found.length > 0 ? `读到 ${found.join("、")}` : "这个库没有可识别的扩展字段"}
        {absent.length > 0 && ` · 没有 ${absent.join("、")}（表或列名不同，已跳过）`}
        。这里只预览，还没有写进方册。
      </p>

      {scan.warnings.length > 0 && (
        <ul className="space-y-1">
          {scan.warnings.map((warning) => (
            <li key={warning} className="text-text-2 flex items-start gap-1.5 text-xs">
              <Warning size={13} className="mt-0.5 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {failures.length > 0 && (
        <ul className="text-danger space-y-1 text-xs">
          {failures.map((failure) => (
            <li key={failure.path}>{failedMessage(failure)}</li>
          ))}
        </ul>
      )}

      {shown.length === 0 ? (
        <p className="text-text-2 py-4 text-[13px] leading-relaxed">
          {scan.books.length === 0
            ? "这是一个有效的 Calibre 书库，但里面一本书都没有。"
            : `没有匹配「${query}」的书。`}
        </p>
      ) : (
        <>
          <label className="text-text-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={importableCount === 0}
              onChange={onToggleAll}
            />
            选中筛选结果中可导入的 {importableCount} 本（跨页保留）
          </label>

          {preferredFormat !== AUTO_FORMAT && fallbackCount > 0 && (
            <p className="text-text-3 text-xs">
              可导入的书里有 {fallbackCount} 本没有 {preferredFormat.toUpperCase()}
              ，将改用各自的第一个格式。
            </p>
          )}

          <ul className="divide-hairline divide-y">
            {shown.map((book) => {
              const file = fileFor(book);
              return (
                <li key={book.id} className="flex items-center gap-2 py-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    aria-label={`选择《${book.title || "无标题"}》`}
                    checked={selected.has(book.id)}
                    disabled={book.files.length === 0}
                    onChange={() => onToggle(book.id)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <span
                    className="text-text-1 min-w-0 flex-[2] truncate"
                    title={[book.title || "（无标题）", metadataSummary(book)]
                      .filter(Boolean)
                      .join("\n")}
                  >
                    {book.title || "（无标题）"}
                  </span>
                  <span className="text-text-3 min-w-0 flex-1 truncate">
                    {book.authors.join("、") || "—"}
                  </span>
                  <span
                    className="text-text-3 w-20 shrink-0 text-right uppercase tabular-nums"
                    title={
                      file
                        ? `将导入 ${file.format.toUpperCase()}；另有 ${book.files.length - 1} 个格式`
                        : "目录里没有可导入的文件"
                    }
                  >
                    {file?.format.toUpperCase() ?? "—"}
                    {book.files.length > 1 && ` +${book.files.length - 1}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {filteredCount > PAGE_SIZE && (
        <p className="text-text-3 text-xs">
          每页 {PAGE_SIZE} 本；勾选跨页保留，全选作用于当前筛选结果的全部 {filteredCount} 本。
        </p>
      )}
    </div>
  );
}
