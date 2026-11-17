import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { GlassButton } from "@/components/glass/button";
import { Actions, Feedback, Row } from "@/features/settings/section";
import { useCatalogExport, useCatalogImport } from "@/hooks/useCatalogExport";
import { useSavePath } from "@/hooks/useSavePath";
import { isDesktopRuntime } from "@/lib/ipc";

/**
 * The shelf's book list as a file the reader keeps.
 *
 * Desktop only: the command takes a path from the native save panel and the
 * web build has no local implementation of it. A browser download would mean
 * a second renderer for the same columns, and the browser's own backup archive
 * already carries everything this list describes.
 *
 * It sits in the backup group because both answer 「如果应用不在了，我还剩什么」,
 * not because it is a backup: the CSV carries the shelf's facts, not its books.
 * Restore needs a book already on this shelf and writes only what the table
 * carries — the hint says so rather than promising a full recovery.
 */
export function CatalogExportRow() {
  const { choose, error: dialogError } = useSavePath();
  const catalog = useCatalogExport();
  const restore = useCatalogImport();
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Hooks above the guard: this renders in both builds, and only the desktop
  // build has a filesystem to write to.
  if (!isDesktopRuntime) return null;

  const onExport = async () => {
    setStatus(null);
    const path = await choose({
      defaultPath: `fangce-books-${stamp()}.csv`,
      filters: [{ name: "书单 CSV", extensions: ["csv"] }],
    });
    // Cancelling the panel is not a failed export; `useSavePath` has already
    // kept the reason for a panel that *could not* open.
    if (!path) return;
    catalog.mutate(path, {
      onSuccess: (count) =>
        setStatus({
          tone: "ok",
          text: count === 0 ? "书架是空的，已写出一张只有表头的 CSV。" : `已导出 ${count} 本书。`,
        }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onRestore = async () => {
    setStatus(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "书单 CSV", extensions: ["csv"] }],
      });
      if (typeof picked !== "string") return;
      const result = await restore.mutateAsync(picked);
      const skipped =
        result.missing.length > 0 ? `，${result.missing.length} 本不在书架，已跳过` : "";
      const undo = result.restored > 0 ? "。可在操作记录里撤销" : "";
      setStatus({
        tone: "ok",
        text: `已从 CSV 恢复 ${result.restored} 本书${skipped}${undo}。`,
      });
    } catch (error) {
      setStatus({ tone: "bad", text: String(error) });
    }
  };

  return (
    <>
      <Row
        label="导出书单"
        hint="把在架的书列成一张 CSV：书名、作者、ISBN、出版社、出版年、语言、标签、格式与阅读进度。单本书也可以用书卡上的「导出 → 书目 CSV」存成一行；回收站里的书不算在架。"
      >
        <GlassButton
          variant="subtle"
          size="sm"
          onClick={() => void onExport()}
          disabled={catalog.isPending}
        >
          {catalog.isPending ? "正在导出…" : "导出书单 CSV"}
        </GlassButton>
      </Row>
      <Row
        label="从 CSV 恢复"
        hint="按 CSV 末列的书籍ID找回书名、作者、副标题、ISBN、出版社、出版年、语言、标签、阅读进度与收藏；一次导入一条记录，可撤销。简介、评分、封面与书籍文件不在表里，保持原样。"
      >
        <GlassButton
          variant="subtle"
          size="sm"
          onClick={() => void onRestore()}
          disabled={restore.isPending}
        >
          {restore.isPending ? "正在恢复…" : "选择 CSV 恢复"}
        </GlassButton>
      </Row>
      {(status || dialogError) && (
        <Actions>
          <Feedback status={status} />
          {dialogError && <Feedback status={{ tone: "bad", text: dialogError }} />}
        </Actions>
      )}
    </>
  );
}

/** Local date for the default file name: `2026-11-14`. */
function stamp(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
