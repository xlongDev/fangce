import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  CaretLeft,
  Copy,
  Export,
  ImageSquare,
  Info,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { QueryError } from "@/components/common/QueryError";
import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { GlassPanel } from "@/components/glass/panel";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  useCleanupOrphanCovers,
  useCovers,
  useDedupeCovers,
  useExportCovers,
  usePurgeCovers,
  useRestoreCovers,
  useRetireCovers,
  useUndoOperation,
} from "@/hooks/useLibrary";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/features/library/format";
import { isDesktopRuntime } from "@/lib/ipc";
import { EASE_OUT, SPRING } from "@/lib/motion";
import { showToast } from "@/stores/toasts";
import type { CoverDuplicateGroup, CoverSource, ManagedCover } from "@/types/ipc";

/**
 * Cover manager — a standalone page reached from the stats card's 补充封面
 * slice (and from cover rows in the operation log).
 *
 * There is no extra table: what is in use and what is retired is encoded in the
 * file names under `covers/`, and the timeline is the cover slice of the
 * operation log. Retiring is reversible (the file stays as `.retired.` and the
 * book falls back to its own cover); purging is the only irreversible step.
 *
 * Thumbnails come from `/managed-cover/{key}`, a resource-protocol route that
 * reads the exact file by name — a retired cover is no longer referenced by a
 * book row, so the ordinary `/cover/{id}` would show the wrong picture.
 *
 * The 维护 tab is the disk-hygiene surface: `.dl.` files no book points at
 * (orphans an old undo left behind), and in-use covers that are byte-identical
 * (merged as hard links so both books keep their own undo anchor).
 */

type Tab = "active" | "retired" | "history" | "maintenance";

const TABS: { key: Tab; label: string }[] = [
  { key: "active", label: "在用" },
  { key: "retired", label: "回收站" },
  { key: "history", label: "历史" },
  { key: "maintenance", label: "维护" },
];

function clock(at: number): string {
  if (!at) return "";
  return new Date(at * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A real picture when it loads, a quiet placeholder when it does not. A
 *  missing thumbnail is never worth a toast — the card still works. */
function Thumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="bg-surface-1 border-hairline text-text-3 flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-lg border">
      {!url || failed ? (
        <ImageSquare size={22} weight="duotone" />
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  );
}

/** Where the log says this cover came from. Only real operation text is shown
 *  — the backend never guesses Douban vs NeoDB, and neither do we. */
function SourceLine({ source }: { source: CoverSource | null | undefined }) {
  if (!source) return <span className="text-text-3/70">来源未知</span>;
  return (
    <span title={source.label} className="truncate">
      {source.label}
    </span>
  );
}

/** The book's own cover next to the downloaded one, so the swap can be judged
 *  at a glance before taking a cover off or restoring it from the bin. */
function CoverCard({
  cover,
  selected,
  onToggle,
  readOnly = false,
}: {
  cover: ManagedCover;
  selected: boolean;
  onToggle: () => void;
  /** Orphans are swept as a batch, not picked one by one — show the picture
   *  and its labels, but no checkbox or "click to select" affordance. */
  readOnly?: boolean;
}) {
  const dimensions = cover.width && cover.height ? `${cover.width}×${cover.height}` : "";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={readOnly}
      aria-pressed={readOnly ? undefined : selected}
      aria-label={
        readOnly
          ? `${cover.bookTitle ?? "原书已删除"}：无主封面`
          : `${cover.bookTitle ?? "原书已删除"}：原文件与补充封面对比，点击${selected ? "取消选择" : "选择"}`
      }
      title={cover.bookTitle ?? "原书已删除"}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl p-2 text-left transition-colors",
        readOnly ? "cursor-default" : "focus-visible:focus-ring hover:bg-text-1/6",
        selected && "bg-accent-soft",
      )}
    >
      <span className="flex gap-1.5">
        <span className="min-w-0 flex-1">
          <Thumb url={cover.originalUrl ?? null} />
          <span className="text-text-3 mt-1 block truncate text-center text-[10px]">
            原文件{cover.originalBytes ? ` · ${formatBytes(cover.originalBytes)}` : ""}
          </span>
        </span>
        <span className="relative min-w-0 flex-1">
          <Thumb url={cover.url} />
          {cover.placeholder && (
            <span
              title="这张图很小，可能是占位图"
              className="text-danger absolute top-1.5 left-1.5 flex size-4 items-center justify-center rounded-full bg-black/45"
            >
              <Warning size={11} weight="bold" />
            </span>
          )}
          {!readOnly && (
            <span
              className={cn(
                "border-hairline absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full border-2 bg-black/10 transition-colors",
                selected ? "border-accent bg-accent" : "bg-surface-1/80",
              )}
            >
              {selected && <span className="size-1.5 rounded-full bg-white" />}
            </span>
          )}
          <span className="text-text-2 mt-1 block truncate text-center text-[10px]">
            补充封面 · {formatBytes(cover.bytes)}
          </span>
        </span>
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1">
          <span className="text-text-1 block min-w-0 flex-1 truncate text-[12.5px]">
            {cover.bookTitle ?? "原书已删除"}
          </span>
          {dimensions && (
            <span className="text-text-3 shrink-0 text-[9px] tabular-nums">{dimensions}</span>
          )}
        </span>
        <span className="text-text-3 mt-0.5 flex items-center gap-1 text-[10px] tabular-nums">
          <SourceLine source={cover.source} />
          {cover.at > 0 && <span className="ml-auto shrink-0">{clock(cover.at)}</span>}
        </span>
      </span>
    </button>
  );
}

function EmptyLine({ children }: { children: string }) {
  return <p className="text-text-3 px-3 py-12 text-center text-[13px]">{children}</p>;
}

/** One byte-identical group: keep one file, hard-link the rest to it. The
 *  keeper defaults to the first (oldest) key; a reader can pick another from
 *  the small list so the surviving file is the picture they prefer. */
function DuplicateRow({
  group,
  busy,
  onMerge,
}: {
  group: CoverDuplicateGroup;
  busy: boolean;
  onMerge: (keeper: string, keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keeper, setKeeper] = useState(group.keys[0] ?? "");
  const keys = group.keys;
  return (
    <div className="border-hairline rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-visible:focus-ring hover:bg-text-1/6 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors"
      >
        <RotatingCaret open={open} className="text-text-3" />
        <span className="text-text-2 min-w-0 flex-1 truncate text-[12px]">
          {group.titles.length ? group.titles.join("、") : group.hash}
        </span>
        <span className="text-text-3 shrink-0 text-[11px] tabular-nums">
          {keys.length} 张 · 可省 {formatBytes(group.reclaimable)}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2.5">
          <p className="text-text-3 mb-1.5 text-[10px]">保留哪一张（其余将共用它的文件）：</p>
          <div className="flex flex-wrap gap-1.5">
            {keys.map((key, index) => (
              <button
                key={key}
                type="button"
                onClick={() => setKeeper(key)}
                className={cn(
                  "focus-visible:focus-ring rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  key === keeper
                    ? "border-accent bg-accent text-on-accent"
                    : "border-hairline text-text-2 hover:bg-text-1/6",
                )}
              >
                {index + 1}. {group.titles[index] ?? key}
              </button>
            ))}
          </div>
          <GlassButton
            size="sm"
            className="mt-2"
            disabled={busy || keys.length < 2}
            leading={<Copy size={13} />}
            onClick={() => onMerge(keeper, keys)}
          >
            合并为一张
          </GlassButton>
        </div>
      )}
    </div>
  );
}

/** Tiny chevron that rotates with the disclosure, without dragging motion into
 *  a glass surface (it is a plain path, not a shadowed node). */
function RotatingCaret({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={cn("size-3 shrink-0 transition-transform", open && "rotate-90", className)}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
    >
      <path
        d="M4 2.5 8 6l-4 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CoversPage() {
  const navigate = useNavigate();
  const reduce = useReducedMotion() ?? false;
  const { data, isPending, isError, error, refetch } = useCovers();
  const retire = useRetireCovers();
  const restore = useRestoreCovers();
  const purge = usePurgeCovers();
  const undo = useUndoOperation();
  const cleanup = useCleanupOrphanCovers();
  const dedupe = useDedupeCovers();
  const exportCovers = useExportCovers();
  const [tab, setTab] = useState<Tab>("active");
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const busy =
    retire.isPending ||
    restore.isPending ||
    purge.isPending ||
    cleanup.isPending ||
    dedupe.isPending;

  const active = data?.active ?? [];
  const retired = data?.retired ?? [];
  const history = data?.history ?? [];
  const orphans = data?.orphans ?? [];
  const duplicateGroups = data?.duplicateGroups ?? [];
  const rows = tab === "active" ? active : tab === "retired" ? retired : orphans;
  const inTab = useMemo(() => new Set(rows.map((row) => row.key)), [rows]);
  const selectedInTab = picked.filter((key) => inTab.has(key));
  const allPicked = rows.length > 0 && selectedInTab.length === rows.length;

  const selectedBytes = useMemo(
    () =>
      rows.filter((row) => selectedInTab.includes(row.key)).reduce((n, row) => n + row.bytes, 0),
    [rows, selectedInTab],
  );

  const toggle = (key: string) =>
    setPicked((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  const toggleAll = () =>
    setPicked((current) =>
      allPicked
        ? current.filter((key) => !inTab.has(key))
        : [...new Set([...current, ...rows.map((row) => row.key)])],
    );
  const clearPicked = () => setPicked([]);
  const run = (fn: (keys: string[]) => void) => {
    fn(selectedInTab);
    clearPicked();
  };

  const exportSelected = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return;
    exportCovers.mutate(
      { keys: selectedInTab, dest: dir },
      {
        onSuccess: (count) => {
          showToast("success", `已导出 ${count} 张封面`);
          clearPicked();
        },
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="封面管理"
        subtitle="从目录补充下载的封面：取下、恢复、永久删除，也能清理无主文件与合并重复图。书自带的封面不受影响。"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pb-8">
        <button
          type="button"
          onClick={() => navigate("/stats")}
          className="focus-visible:focus-ring text-text-3 hover:text-text-1 -mx-1 flex w-fit items-center gap-1 rounded px-1 py-0.5 text-[12px]"
        >
          <CaretLeft size={13} /> 返回统计
        </button>

        {!isDesktopRuntime ? (
          <GlassPanel className="text-text-3 px-5 py-6 text-[13px]">
            封面管理只在桌面版里可用。
          </GlassPanel>
        ) : isPending ? (
          <GlassPanel className="h-64 animate-pulse" />
        ) : isError ? (
          <QueryError
            error={error}
            onRetry={() => void refetch()}
            icon={<ImageSquare size={26} weight="duotone" />}
            title="封面读不出来"
            description="这次没有读出来。重试一次；如果还是不行，多半是本地的文件出了问题。"
          />
        ) : (
          // `shrink-0`: this panel is the only child of an overflow-y-auto
          // flex column. Without it the panel is flex-shrink:1, so a tall
          // grid compresses it and `overflow-hidden` clips the bottom action
          // bar — which reads as "buttons hug the border". Let the outer
          // column scroll instead of squashing the panel.
          <GlassPanel className="shrink-0 overflow-hidden">
            <div className="border-hairline flex flex-wrap items-center gap-3 border-b px-5 py-2.5">
              {/* Each tab is its own liquid-glass capsule (`glass` is the same
                  material as the shelf layout switch), with one shared
                  accent-tinted pill sliding between them via layoutId. Only
                  text colour crossfades; no glass node is transformed. */}
              <div className="flex items-center gap-1.5">
                {TABS.map((entry) => {
                  const count =
                    entry.key === "active"
                      ? active.length
                      : entry.key === "retired"
                        ? retired.length
                        : entry.key === "history"
                          ? history.length
                          : orphans.length + duplicateGroups.length;
                  const on = entry.key === tab;
                  const alert =
                    entry.key === "maintenance" &&
                    (orphans.length > 0 || duplicateGroups.length > 0);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => {
                        setTab(entry.key);
                        clearPicked();
                      }}
                      aria-pressed={on}
                      className={cn(
                        "glass focus-visible:focus-ring relative flex h-7 items-center rounded-full px-3 text-[12px] transition-colors",
                        on ? "text-text-1" : "text-text-3 hover:text-text-2",
                      )}
                    >
                      {on && (
                        <motion.span
                          layoutId="covers-tab-pill"
                          className="bg-accent-soft absolute inset-0 rounded-full"
                          transition={reduce ? { duration: 0 } : SPRING.layout}
                        />
                      )}
                      <span className="relative flex items-center">
                        {entry.label}
                        <span className="ml-1 tabular-nums opacity-60">{count}</span>
                        {alert && <span className="text-danger ml-1">•</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <span className="text-text-3 ml-auto text-[11px] tabular-nums">
                在用 {formatBytes(data?.activeBytes ?? 0)} · 回收站{" "}
                {formatBytes(data?.retiredBytes ?? 0)}
              </span>
            </div>

            {/* One keyed view per tab, so switching crossfades instead of
                snapping. `mode="wait"` keeps the outgoing view until its exit
                finishes, avoiding two glass panels overlapping mid-swap. Only
                opacity + a tiny rise move — never a glass node's size. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduce ? 0 : -6 }}
                transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
              >
                {tab === "history" ? (
                  history.length === 0 ? (
                    <EmptyLine>还没有封面改动记录。</EmptyLine>
                  ) : (
                    <div className="divide-hairline max-h-[62vh] divide-y overflow-y-auto">
                      {history.map((row) => (
                        <div key={row.id} className="flex items-center gap-3 px-5 py-2.5">
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() =>
                                navigate("/settings#operations", {
                                  state: { focusOperation: row.callId },
                                })
                              }
                              title="在操作记录的时间线中查看"
                              className="focus-visible:focus-ring text-text-1 hover:text-accent group -mx-1 flex min-w-0 items-center gap-0.5 rounded px-1 text-left"
                            >
                              <span className="min-w-0 truncate text-[13px]">{row.summary}</span>
                              {row.bookTitle && (
                                <span className="text-text-3 shrink-0 text-[12px]">
                                  {" "}
                                  · {row.bookTitle}
                                </span>
                              )}
                              <ArrowSquareOut
                                size={11}
                                className="text-text-3 group-hover:text-accent shrink-0"
                              />
                            </button>
                            <p className="text-text-3 mt-0.5 text-[11px] tabular-nums">
                              {clock(row.at)}
                            </p>
                          </div>
                          {row.undoable && (
                            <GlassButton
                              size="sm"
                              variant="subtle"
                              disabled={undo.isPending}
                              leading={<ArrowCounterClockwise size={13} />}
                              onClick={() => undo.mutate(row.callId)}
                            >
                              撤销
                            </GlassButton>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                ) : tab === "maintenance" ? (
                  <MaintenanceTab
                    orphans={orphans}
                    orphansBytes={data?.orphanBytes ?? 0}
                    groups={duplicateGroups}
                    duplicateBytes={data?.duplicateBytes ?? 0}
                    busy={busy}
                    onConfirmCleanup={() => setConfirmCleanup(true)}
                    onMerge={(keeper, keys) => dedupe.mutate({ keeper, keys })}
                  />
                ) : rows.length === 0 ? (
                  <EmptyLine>
                    {tab === "active"
                      ? "没有在用补充封面。在「在线找书」里补全或换封面后会出现在这里。"
                      : "回收站是空的。从「在用」里取下的封面会放在这里，可随时恢复。"}
                  </EmptyLine>
                ) : (
                  <>
                    <div className="border-hairline flex items-center justify-between border-b px-5 py-2">
                      <button
                        type="button"
                        onClick={toggleAll}
                        className="focus-visible:focus-ring text-text-2 hover:text-text-1 text-[11px]"
                      >
                        {allPicked ? "取消全选" : "全选"}
                      </button>
                      <span className="text-text-3 text-[11px] tabular-nums">
                        已选 {selectedInTab.length} / {rows.length}
                        {selectedBytes > 0 && ` · ${formatBytes(selectedBytes)}`}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1 p-3 md:grid-cols-3 xl:grid-cols-4">
                      {rows.map((cover) => (
                        <CoverCard
                          key={cover.key}
                          cover={cover}
                          selected={picked.includes(cover.key)}
                          onToggle={() => toggle(cover.key)}
                        />
                      ))}
                    </div>
                  </>
                )}

                {tab !== "history" && tab !== "maintenance" && rows.length > 0 && (
                  <div className="border-hairline flex flex-wrap items-center gap-2 border-t px-5 pt-3 pb-4">
                    {tab === "active" ? (
                      <GlassButton
                        size="sm"
                        disabled={busy || selectedInTab.length === 0}
                        onClick={() => run((keys) => retire.mutate(keys))}
                      >
                        从书上取下
                      </GlassButton>
                    ) : (
                      <>
                        <GlassButton
                          size="sm"
                          disabled={busy || selectedInTab.length === 0}
                          leading={<ArrowCounterClockwise size={14} />}
                          onClick={() => run((keys) => restore.mutate(keys))}
                        >
                          恢复到书上
                        </GlassButton>
                        <GlassButton
                          size="sm"
                          variant="subtle"
                          disabled={busy || selectedInTab.length === 0}
                          leading={<Trash size={14} />}
                          className="text-danger"
                          onClick={() => setConfirmPurge(true)}
                        >
                          永久删除
                        </GlassButton>
                      </>
                    )}
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={exportCovers.isPending || selectedInTab.length === 0}
                      leading={<Export size={14} />}
                      onClick={() => void exportSelected()}
                    >
                      导出
                    </GlassButton>
                    {selectedInTab.length > 0 && (
                      <span className="text-text-3 text-[11px]">
                        已选 {selectedInTab.length} 张 · 可回收 {formatBytes(selectedBytes)}
                      </span>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </GlassPanel>
        )}
      </div>

      <GlassDialog
        open={confirmPurge}
        onOpenChange={setConfirmPurge}
        title="永久删除这些封面？"
        description={`将删除 ${selectedInTab.length} 张回收站里的封面文件，可回收 ${formatBytes(selectedBytes)}，无法撤销。书和书自带的封面不受影响。`}
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setConfirmPurge(false)}
            disabled={purge.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            disabled={purge.isPending}
            onClick={() => {
              purge.mutate(selectedInTab, { onSuccess: clearPicked });
              setConfirmPurge(false);
            }}
          >
            永久删除
          </GlassButton>
        </div>
      </GlassDialog>

      <GlassDialog
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        title="清理所有无主封面？"
        description={`将永久删除 ${orphans.length} 张没有任何书在用的下载封面，可回收 ${formatBytes(data?.orphanBytes ?? 0)}。清理前会再核对一次数据库，刚被重新用上的文件会被跳过。`}
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setConfirmCleanup(false)}
            disabled={cleanup.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            disabled={cleanup.isPending}
            onClick={() => {
              cleanup.mutate(orphans.map((cover) => cover.key));
              setConfirmCleanup(false);
            }}
          >
            一键清理
          </GlassButton>
        </div>
      </GlassDialog>
    </div>
  );
}

/** The disk-hygiene surface: an orphan sweep with a one-click cleanup, a list
 *  of byte-identical groups that can be merged into hard links, and an honest
 *  note on what the backup does and does not include. */
function MaintenanceTab({
  orphans,
  orphansBytes,
  groups,
  duplicateBytes,
  busy,
  onConfirmCleanup,
  onMerge,
}: {
  orphans: ManagedCover[];
  orphansBytes: number;
  groups: CoverDuplicateGroup[];
  duplicateBytes: number;
  busy: boolean;
  onConfirmCleanup: () => void;
  onMerge: (keeper: string, keys: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-5">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-text-1 text-[13px] font-medium">无主封面</h3>
            <p className="text-text-3 mt-0.5 text-[11px]">
              磁盘上有、却没有任何书在用的下载封面。通常是撤销换封面后留下的。
            </p>
          </div>
          {orphans.length > 0 && (
            <GlassButton
              size="sm"
              variant="subtle"
              className="text-danger shrink-0"
              disabled={busy}
              leading={<Trash size={13} />}
              onClick={onConfirmCleanup}
            >
              一键清理 {formatBytes(orphansBytes)}
            </GlassButton>
          )}
        </div>
        {orphans.length === 0 ? (
          <p className="text-text-3 border-hairline rounded-lg border px-3 py-3 text-[12px]">
            没有无主封面，磁盘很干净。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1 md:grid-cols-3 xl:grid-cols-4">
            {orphans.map((cover) => (
              <CoverCard
                key={cover.key}
                cover={cover}
                selected={false}
                onToggle={() => {}}
                readOnly
              />
            ))}
          </div>
        )}
      </section>

      <section className="border-hairline border-t pt-4">
        <div className="mb-2">
          <h3 className="text-text-1 text-[13px] font-medium">重复封面</h3>
          <p className="text-text-3 mt-0.5 text-[11px]">
            多本书用了完全相同的图片。合并后只留一份实体，其余共用它——每本书仍保留自己的撤销路径。
          </p>
        </div>
        {groups.length === 0 ? (
          <p className="text-text-3 border-hairline rounded-lg border px-3 py-3 text-[12px]">
            没有发现重复的封面。
          </p>
        ) : (
          <>
            <p className="text-text-2 mb-2 text-[11px]">
              共 {groups.length} 组，全部合并可省约{" "}
              <span className="tabular-nums">{formatBytes(duplicateBytes)}</span>
            </p>
            <div className="flex flex-col gap-1.5">
              {groups.map((group) => (
                <DuplicateRow key={group.hash} group={group} busy={busy} onMerge={onMerge} />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="border-hairline border-t pt-4">
        <h3 className="text-text-1 mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
          <Info size={14} /> 备份说明
        </h3>
        <p className="text-text-3 text-[11px] leading-relaxed">
          整库备份会把 <code className="text-text-2">covers/</code>{" "}
          目录一起打包，在用、退役和原书封面都在其中；
          恢复备份后这些图片会原样回来。无主与重复封面同样会被打包，所以清理它们既能省本机空间，也能让备份更小。
          要单独留一份，用「在用 / 回收站」里的「导出」把选中的封面存到任意文件夹。
        </p>
      </section>
    </div>
  );
}
