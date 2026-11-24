import { ArrowsLeftRight } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { editionSummary, type Edition } from "@/features/library/migrate";
import { useAnnotations } from "@/hooks/useAnnotations";
import { useBookmarks } from "@/hooks/useBookmarks";

/**
 * The question a re-import has to ask before it is allowed to delete anything.
 *
 * Two editions of one book on the shelf is not a state a reader asked for, and
 * merging them is not reversible — so this is a question, never a decision made
 * for them. Skipping drops the edition this import just added and leaves the
 * original untouched; keeping both costs a duplicate tile, migrating and being
 * wrong costs the highlights.
 */
export function MigrateEditionDialog({
  edition,
  busy = false,
  error = null,
  onMigrate,
  onKeepBoth,
  onSkip,
}: {
  edition: Edition | null;
  busy?: boolean;
  error?: string | null;
  onMigrate: (edition: Edition) => void;
  onKeepBoth: (edition: Edition) => void;
  onSkip: (edition: Edition) => void;
}) {
  const oldId = edition?.from.id ?? null;
  const annotations = useAnnotations(oldId);
  const bookmarks = useBookmarks(oldId);
  if (!edition) return null;

  const count = annotations.data?.length ?? 0;
  const pins = bookmarks.data?.length ?? 0;

  return (
    <GlassDialog
      open
      onOpenChange={(next) => {
        if (!next) onKeepBoth(edition);
      }}
      title="这本书已经在书架上了"
      description="文件内容变了，所以它是作为新的一本进来的 —— 标注、书签和阅读进度还留在原来那本上。"
    >
      <div className="mt-1 space-y-4">
        <div className="glass rounded-2xl p-3">
          <p className="text-text-1 text-sm font-medium">{edition.from.title}</p>
          <p className="text-text-3 mt-1 text-xs">{editionSummary(edition, count)}</p>
        </div>
        <div className="flex items-center gap-2">
          <ArrowsLeftRight size={16} className="text-text-3 shrink-0" />
          <p className="text-text-2 text-xs">
            迁移会把{count > 0 ? ` ${count} 条标注` : "标注"}
            {pins > 0 ? ` 与 ${pins} 个书签` : ""}
            按原文重新定位到新版本上，然后移除旧的那一本。新版本里改过的段落会找不到原文，迁移完会报出来。
          </p>
        </div>
        <p className="text-text-3 text-xs">
          跳过会撤销这次导入、删掉刚导入的这一本，保留原来的，标注和进度都不动。
        </p>
        {error && <p className="text-danger text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <GlassButton variant="ghost" disabled={busy} onClick={() => onSkip(edition)}>
            跳过
          </GlassButton>
          <GlassButton variant="ghost" disabled={busy} onClick={() => onKeepBoth(edition)}>
            两本都留
          </GlassButton>
          <GlassButton variant="primary" disabled={busy} onClick={() => onMigrate(edition)}>
            {busy ? "正在处理…" : "迁移并移除旧的"}
          </GlassButton>
        </div>
      </div>
    </GlassDialog>
  );
}
