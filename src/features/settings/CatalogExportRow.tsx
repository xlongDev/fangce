import { useState } from "react";

import { GlassButton } from "@/components/glass/button";
import { Actions, Feedback, Row } from "@/features/settings/section";
import { useCatalogExport } from "@/hooks/useCatalogExport";
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
 * not because it is a backup: a CSV of metadata cannot restore a single book.
 * The hint says so rather than letting the two be confused.
 */
export function CatalogExportRow() {
  const { choose, error: dialogError } = useSavePath();
  const catalog = useCatalogExport();
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

  return (
    <>
      <Row
        label="导出书单"
        hint="把在架的书列成一张 CSV：书名、作者、ISBN、出版社、出版年、语言、标签、格式与阅读进度。只有清单，不含书文件，也不能用来恢复书库；回收站里的书不算在架。"
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
