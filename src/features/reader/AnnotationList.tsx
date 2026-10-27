import { useState } from "react";
import { DownloadSimple, ShareNetwork, Trash } from "@phosphor-icons/react";

import { NoteCell } from "@/features/reader/AnnotationNote";
import type { Annotation } from "@/types/ipc";

export function AnnotationList({
  annotations,
  busy,
  onDelete,
  onNote,
  onExport,
  onJump,
  onShare,
}: {
  annotations: Annotation[];
  busy: boolean;
  onDelete: (id: string) => void;
  /** Writes (or clears, with `null`) the reader's note on one highlight. */
  onNote: (id: string, note: string | null) => void;
  /** Opens the export dialog for this book's highlights and notes. */
  onExport: () => void;
  /**
   * Makes a row navigate to its highlight. foliate books need it: their
   * sections are the container's own spine items, so a row has to ask the view
   * to go somewhere rather than scroll a chapter the surrounding list drives.
   * A highlight with no anchor is still reachable — the text and its chapter
   * are enough (see `FoliateHandle::goToHighlight`).
   */
  onJump?: (annotation: Annotation) => void;
  /** Opens the share card for one highlight, drawn on the reader's own paper. */
  onShare?: (annotation: Annotation) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The count and the way out of the app, on the list's own header: the
          drawer's title bar is shared with every other panel. */}
      <div className="border-hairline flex items-center justify-between gap-2 border-b px-4 py-2">
        <p className="text-text-3 text-xs">{annotations.length} 条标注</p>
        {/* The same pill as 重新生成 in the guide's footer: this header is a
            band of the drawer, and the one control on it was the only piece of
            chrome in the reader that sat flat on the glass instead of on it. */}
        <button
          type="button"
          disabled={annotations.length === 0}
          onClick={onExport}
          className="glass-liquid text-text-2 hover:text-text-1 focus-visible:focus-ring inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40"
        >
          <DownloadSimple size={12} />
          导出
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {annotations.length === 0 ? (
          <p className="text-text-3 text-[13px] leading-relaxed">
            选中正文即可添加标注，标注会按章节归类在这里。
          </p>
        ) : (
          <ul className="space-y-3">
            {annotations.map((annotation) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                busy={busy}
                onDelete={onDelete}
                onNote={onNote}
                onJump={onJump}
                onShare={onShare}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One highlight. Its own component so it can hold the one piece of state the
 * note needs: whether the field is open. `NoteCell` is controlled, so the flag
 * has to live somewhere, and a row is the smallest thing that can own it.
 */
function AnnotationRow({
  annotation,
  busy,
  onDelete,
  onNote,
  onJump,
  onShare,
}: {
  annotation: Annotation;
  busy: boolean;
  onDelete: (id: string) => void;
  onNote: (id: string, note: string | null) => void;
  onJump?: (annotation: Annotation) => void;
  onShare?: (annotation: Annotation) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <li className="border-hairline border-b pb-3 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-2">
        {/* foliate sections are the container's own, so the index this
            list groups by is a section, not an imported chapter. */}
        <p className="text-text-3 text-xs">
          第 {annotation.chapterIdx + 1}
          {onJump ? " 节" : " 章"}
        </p>
        <div className="flex items-center gap-2">
          {/* Share sits next to delete rather than in a menu: it is the one
              action here that makes something new rather than changing or
              removing what is there. */}
          {onShare && (
            <button
              type="button"
              aria-label="分享这一句"
              disabled={busy}
              onClick={() => onShare(annotation)}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors disabled:opacity-50"
            >
              <ShareNetwork size={14} />
            </button>
          )}
          <button
            type="button"
            aria-label="删除标注"
            disabled={busy}
            onClick={() => onDelete(annotation.id)}
            className="focus-visible:focus-ring text-text-3 hover:text-danger transition-colors disabled:opacity-50"
          >
            <Trash size={14} />
          </button>
        </div>
      </div>
      {onJump ? (
        <button
          type="button"
          onClick={() => onJump(annotation)}
          className="focus-visible:focus-ring hover:bg-surface-1 -mx-1 mt-1 block w-full rounded-md px-1 py-0.5 text-left transition-colors"
        >
          <p className="text-text-1 text-[13px] leading-relaxed">{annotation.text}</p>
        </button>
      ) : (
        <p className="text-text-1 mt-1 text-[13px] leading-relaxed">{annotation.text}</p>
      )}
      <div className="mt-1.5">
        <NoteCell
          note={annotation.note}
          disabled={busy}
          editing={editing}
          onEditingChange={setEditing}
          onSave={(note) => onNote(annotation.id, note)}
        />
      </div>
    </li>
  );
}
