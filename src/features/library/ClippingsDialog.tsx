import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle, FileText, Warning } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { Reveal } from "@/components/motion/Reveal";
import { isDesktopRuntime } from "@/lib/ipc";
import { displayTitle } from "@/lib/title";
import { acceptOf, pickFiles as pickBrowserFiles } from "@/lib/pickFile";
import { useClippings } from "@/hooks/useClippings";
import type { ClippingsOutcome } from "@/types/ipc";

/**
 * Highlights in — from Kindle, and from this app's own exports.
 *
 * The file has to be found on disk, so the first step is a picker; the second
 * is the preview, which is the same run with the writes skipped. The reader
 * confirms against real numbers rather than a guess, and the third state is the
 * receipt for the run they just confirmed.
 *
 * Which of the three shapes the file is (Kindle's `My Clippings.txt`, this app's
 * Markdown, this app's CSV) is decided by the backend from the file's contents,
 * not its name — the picker offers all of them in one filter and the reader is
 * never asked to classify their own file.
 *
 * Copy is deliberately blunt about the two ways an import comes up short —
 * books the shelf never got, and highlights whose text the book no longer
 * contains — because both are silent failures otherwise.
 */

interface ClippingsDialogProps {
  /** `false` keeps it closed. */
  open: boolean;
  onClose: () => void;
}

/** The file's base name, for the line that confirms what was picked. */
function baseName(picked: string | File): string {
  if (typeof picked !== "string") return picked.name;
  const parts = picked.split(/[\\/]/);
  return parts[parts.length - 1] || picked;
}

export function ClippingsDialog({ open: isOpen, onClose }: ClippingsDialogProps) {
  const { preview, commit } = useClippings();
  /** What the reader picked: a path from the desktop's panel, or the file
   *  itself in the browser. */
  const [picked, setPicked] = useState<string | File | null>(null);
  const [done, setDone] = useState<ClippingsOutcome | null>(null);

  const close = () => {
    setPicked(null);
    setDone(null);
    preview.reset();
    commit.reset();
    onClose();
  };

  const pick = async () => {
    // The browser has no dialog of its own for this: it takes the file, which is
    // what the backend reads anyway.
    if (!isDesktopRuntime) {
      const [file] = await pickBrowserFiles(acceptOf(["txt", "md", "markdown", "csv"]));
      if (!file) return;
      setDone(null);
      commit.reset();
      preview.reset();
      setPicked(file);
      preview.mutate(file);
      return;
    }
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "摘录文件", extensions: ["txt", "md", "markdown", "csv"] }],
    });
    if (typeof path !== "string") return;
    const chosen: string | File = path;
    setDone(null);
    // Both sides reset: a previous run's numbers must not sit next to a new
    // file's error, and a failed pick must not leave the old report on screen.
    commit.reset();
    preview.reset();
    setPicked(chosen);
    preview.mutate(chosen);
  };

  const report = done ?? preview.data ?? null;
  const failure = done ? null : (preview.error ?? commit.error);
  const busy = preview.isPending || commit.isPending;

  // One live region, mounted for as long as the dialog is. Assistive tech
  // announces a change inside a region it already knows about reliably, but
  // often misses a region that is inserted already carrying text — so this
  // stays put and only its contents change. It carries the outcome alone;
  // announcing the whole report would read out the grid and the book list.
  const status = busy
    ? "正在读取与匹配…"
    : failure
      ? String(failure)
      : report
        ? done
          ? `已导入 ${report.imported} 条高亮。`
          : `匹配到 ${report.imported} 条高亮，共 ${report.total} 条。`
        : "";

  return (
    <GlassDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="导入摘录"
      description="读 Kindle 的 My Clippings.txt，或本应用导出的 .md / .csv，把里面的高亮落到书架上对应的书里。"
      widthClass="w-[min(92vw,560px)]"
    >
      {/* `<output>` rather than a `role="status"` div: it is the element the
          role belongs to, and it carries the polite live region implicitly. */}
      <output className="sr-only">{status}</output>

      {!picked ? (
        <div className="flex flex-col items-start gap-3">
          <GlassButton variant="primary" size="md" onClick={() => void pick()}>
            <FileText size={15} /> 选择摘录文件
          </GlassButton>
          <p className="text-text-3 text-xs leading-relaxed">
            Kindle 的文件在磁盘的 documents
            目录里；本应用自己的导出在书籍页和「笔记」页的导出按钮里。
            文件按内容识别，改过名字也认。导入只把高亮落到书架上对应的书里，不会改动原来的书籍文件。
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="glass flex items-center justify-between gap-3 rounded-2xl border px-3 py-2">
            <span
              className="text-text-2 min-w-0 truncate text-xs"
              title={typeof picked === "string" ? picked : picked.name}
            >
              {baseName(picked)}
            </span>
            <button
              type="button"
              className="press text-text-3 hover:text-text-1 focus-visible:focus-ring shrink-0 rounded-lg px-2 py-1 text-xs"
              onClick={() => void pick()}
            >
              换一个
            </button>
          </div>

          {busy && !report && <p className="text-text-2 text-sm">正在读取与匹配…</p>}

          {failure && (
            <p className="text-danger flex items-start gap-2 text-sm">
              <Warning size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{String(failure)}</span>
            </p>
          )}

          {report && (
            // The report lands after an async run, so it arrives rather than
            // replaces: the dialog is already on screen when the numbers come
            // back. `flex flex-col gap-3` carries the spacing the fragment
            // used to inherit as a direct child of the column.
            <Reveal className="flex flex-col gap-3">
              <div className="grid grid-cols-4 gap-2">
                <Number label="高亮条目" value={report.total} />
                <Number label="命中书籍" value={report.books.length} />
                <Number label="可定位" value={report.located} />
                <Number label="已存在" value={report.duplicates} />
              </div>

              {done ? (
                <p className="text-text-1 flex items-center gap-2 text-sm">
                  <CheckCircle size={15} weight="fill" className="text-accent shrink-0" />
                  已导入 {done.imported} 条高亮。
                </p>
              ) : (
                <p className="text-text-2 text-xs">
                  确认后会新增 {report.imported} 条高亮，已经导入过的不会重复。
                </p>
              )}

              {(report.notes > 0 || report.bookmarks > 0) && (
                <p className="text-text-3 text-xs">
                  跳过 {report.notes} 条笔记、{report.bookmarks} 个书签。
                </p>
              )}

              {report.books.length > 0 && (
                <ul className="border-hairline divide-hairline max-h-52 divide-y overflow-y-auto rounded-2xl border">
                  {report.books.map((book) => (
                    <li
                      key={book.bookId}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="text-text-1 min-w-0 truncate text-[13px]" title={book.title}>
                        {displayTitle(book.title)}
                      </span>
                      <span className="text-text-3 shrink-0 text-xs tabular-nums">
                        {book.imported} 条{book.duplicates > 0 && ` · 已有 ${book.duplicates}`}
                        {book.unlocated > 0 && ` · ${book.unlocated} 条未找到`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {report.unknownTitles.length > 0 && (
                <div className="text-xs leading-relaxed">
                  <p className="text-text-2">书架里没有这些书，它们的摘录被跳过了：</p>
                  <p className="text-text-3 mt-1">
                    {report.unknownTitles.join("、")}
                    {report.matched < report.total && " 等"}
                  </p>
                </div>
              )}
            </Reveal>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={close} disabled={busy}>
          {done ? "关闭" : "取消"}
        </GlassButton>
        {picked && !done && (
          <GlassButton
            variant="primary"
            onClick={() => commit.mutate(picked, { onSuccess: (outcome) => setDone(outcome) })}
            disabled={busy || !report || report.imported === 0}
          >
            {busy ? "正在导入…" : `导入 ${report?.imported ?? 0} 条`}
          </GlassButton>
        )}
      </div>
    </GlassDialog>
  );
}

/** One figure in the report grid. */
function Number({ label, value }: { label: string; value: number }) {
  return (
    <div className="glass rounded-2xl border px-3 py-2">
      <p className="text-text-1 text-lg leading-tight font-semibold tabular-nums">{value}</p>
      <p className="text-text-3 mt-0.5 text-[11px]">{label}</p>
    </div>
  );
}
