import { useState } from "react";
import { Lock, Package } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { Reveal } from "@/components/motion/Reveal";
import { useSavePath } from "@/hooks/useSavePath";
import { navigateTo } from "@/features/command/registerCoreCommands";
import { filename } from "@/lib/filename";
import type { BookSummary } from "@/types/ipc";

/** What a reader can save, and what each one is good for.
 *
 * `original` is the book as it was imported — the only one another reader can
 * open. The two packs also carry the reading progress, the favourite flag and
 * every highlight; the second is the same archive under a password, for when it
 * travels through somewhere it should not be readable. `catalog` is not a book
 * at all but one row of the shelf CSV: the enriched metadata, labels, progress
 * and favourite that live in the library, recoverable from Settings.
 */
const KINDS = [
  {
    key: "original",
    label: "原文件",
    hint: "导出导入时的原始文件，保留原格式，兼容其他阅读器。",
  },
  { key: "pack", label: "书档", hint: "带上阅读进度、收藏和全部标注，只有本应用认得" },
  { key: "encrypted", label: "加密书档", hint: "同上，再加一个密码" },
  {
    key: "catalog",
    label: "书目 CSV",
    hint: "书单里的一行：补全后的书名、作者、标签、进度与收藏；不含正文，可在设置页导入恢复。",
  },
] as const;

export type ExportKind = (typeof KINDS)[number]["key"];

interface ExportDialogProps {
  book: BookSummary | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Receives the path chosen by the native save dialog. */
  onConfirm: (request: {
    book: BookSummary;
    path: string;
    kind: ExportKind;
    password?: string;
    includeAi: boolean;
  }) => void;
}

/**
 * Export one book: as its own file, as a pack, or as one row of the shelf CSV.
 *
 * The shape is picked here rather than by the save dialog's filter — switching
 * a native panel's format dropdown is not something a reader should have to
 * discover — and the extension the file lands with is the one picked here.
 */
export function ExportPackDialog({ book, busy, error, onCancel, onConfirm }: ExportDialogProps) {
  const [kind, setKind] = useState<ExportKind>("original");
  const [password, setPassword] = useState("");
  // A plaintext pack is readable by anyone who gets the file, so carrying
  // private questions has to be an explicit choice. An encrypted pack is the
  // migration path and starts with the records included.
  const [includeAi, setIncludeAi] = useState(false);
  const { choose: choosePath, error: panelError } = useSavePath();

  if (!book) return null;
  const pickKind = (next: ExportKind) => {
    setKind(next);
    setIncludeAi(next === "encrypted");
  };
  const catalog = kind === "catalog";
  const encrypted = kind === "encrypted";
  const packsAi = kind === "pack" || encrypted;
  const extension =
    kind === "catalog"
      ? "csv"
      : kind === "original"
        ? book.format === "markdown"
          ? "md"
          : book.format
        : encrypted
          ? "ctzx"
          : "ctz";
  const chosen = KINDS.find((entry) => entry.key === kind)!;
  const ready = !encrypted || password.length > 0;

  /** The panel's own failure outranks the write's: it happens first. */
  const message = error ?? panelError;

  const choose = async () => {
    const path = await choosePath({
      title: catalog ? "导出书目 CSV" : kind === "original" ? "导出书籍文件" : "导出书档",
      defaultPath: `${filename(book.title, catalog ? "书目" : chosen.label)}.${extension}`,
      filters: [{ name: chosen.label, extensions: [extension] }],
    });
    if (path === null) return;
    onConfirm({
      book,
      path,
      kind,
      password: encrypted ? password : undefined,
      includeAi: packsAi && includeAi,
    });
  };

  return (
    <GlassDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        <span className="flex items-center gap-2">
          <Package size={16} weight="duotone" />
          导出《{book.title}》
        </span>
      }
      description={chosen.hint}
      widthClass="w-[min(92vw,440px)]"
    >
      <div className="space-y-3">
        {/* No `role="group"`: each button carries its own `aria-pressed`, which
            is what a screen reader needs — and the linter is right that a
            grouping role here would want a real `fieldset`. */}
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={kind === key}
              onClick={() => pickKind(key)}
              className={cn(
                "border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                kind === key && "border-accent text-accent",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* The password field appears under a choice that was just made; without
            an entrance the dialog simply grows a row halfway down. */}
        {encrypted && (
          <Reveal>
            <GlassInput
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="设置一个打开书档的密码"
              aria-label="书档密码"
            />
            <p className="text-text-3 mt-1.5 text-xs">
              密码不会存进书库，忘了就无法恢复书档里的原文件。
            </p>
          </Reveal>
        )}

        {packsAi && (
          <label className="flex w-full cursor-pointer items-start gap-2 text-left">
            <input
              type="checkbox"
              checked={includeAi}
              onChange={(event) => setIncludeAi(event.target.checked)}
              className="border-hairline accent-accent focus-visible:focus-ring mt-0.5 h-4 w-4 shrink-0 rounded"
            />
            <span className="text-text-2 text-xs leading-relaxed">
              包含 AI 导读与对话
              <span className="text-text-3 block">
                {encrypted
                  ? "和书档一起加密。导入后落在新书上，生成时间与脑图等工具产物一并保留。"
                  : "明文书档会带上对话原文（可能含私人提问）；默认不带，只在迁移记录时勾选。"}
              </span>
            </span>
          </label>
        )}

        {message && <p className="text-danger text-xs">{message}</p>}

        <p className="text-text-3 text-xs">
          整库迁移请用{" "}
          <button
            type="button"
            onClick={() => {
              onCancel();
              navigateTo("/settings#backup");
            }}
            className="text-accent focus-visible:focus-ring rounded hover:underline"
          >
            设置 › 书库备份
          </button>
          。
        </p>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton variant="primary" disabled={busy || !ready} onClick={() => void choose()}>
          {busy ? "正在导出…" : "选择保存位置"}
        </GlassButton>
      </div>
    </GlassDialog>
  );
}

interface PasswordDialogProps {
  /** Files waiting to be imported; only used for the count in the copy. */
  count: number;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}

/** One password for the whole batch: a wrong one fails only its own file. */
export function PackPasswordDialog({
  count,
  busy,
  error,
  onCancel,
  onConfirm,
}: PasswordDialogProps) {
  const [password, setPassword] = useState("");

  return (
    <GlassDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        <span className="flex items-center gap-2">
          <Lock size={16} weight="duotone" />
          输入书档密码
        </span>
      }
      description={`这次导入的 ${count} 个文件里有加密书档，需要密码才能解开。`}
      widthClass="w-[min(92vw,400px)]"
    >
      <GlassInput
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && password) onConfirm(password);
        }}
        placeholder="书档密码"
        aria-label="书档密码"
      />
      {error && <p className="text-danger mt-2 text-xs">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="primary"
          disabled={busy || password.length === 0}
          onClick={() => onConfirm(password)}
        >
          导入
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
