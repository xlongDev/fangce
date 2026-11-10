import { useState } from "react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { GlassInput } from "@/components/glass/input";
import type { BookFieldsPatch } from "@/types/ipc";

/**
 * The batch metadata sheet: two fields, because only two facts belong to a
 * shelf's worth of books at once.
 *
 * A title or a description is about one book. A publisher or a language is
 * about a run of them — 「这三十本是同一家出的，元数据里没写」 is the sentence this
 * exists for. Replacing fifty author lists at once is a different feature with
 * a different confirmation, and the batch bar should not be able to do it by
 * accident.
 *
 * **Empty means "leave it alone"**, not "clear it". A batch is a wide
 * operation: a reader who opens this sheet and types one field must not have
 * the other one blanked on thirty books. Clearing a field is still possible —
 * from the book's own sheet, where it is one book's business.
 */

/** Mirrors the ceilings the single-book sheet uses, so both agree. */
const LIMITS = { publisher: 200, language: 40 };

export function BatchMetaDialog({
  open,
  count,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean;
  count: number;
  busy?: boolean;
  onCancel: () => void;
  onSave: (patch: BookFieldsPatch) => void;
}) {
  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={`修改选中的 ${count} 本书`}
      description="只填你要改的那一项，留空的字段保持原样。"
      widthClass="w-[min(92vw,440px)]"
    >
      {/* Keyed by the count so reopening after a different selection starts
          from empty fields rather than the last batch's text. */}
      <BatchMetaForm key={count} count={count} busy={busy} onCancel={onCancel} onSave={onSave} />
    </GlassDialog>
  );
}

function BatchMetaForm({
  count,
  busy,
  onCancel,
  onSave,
}: {
  count: number;
  busy?: boolean;
  onCancel: () => void;
  onSave: (patch: BookFieldsPatch) => void;
}) {
  const [publisher, setPublisher] = useState("");
  const [language, setLanguage] = useState("");

  const nextPublisher = publisher.trim();
  const nextLanguage = language.trim();
  const dirty = nextPublisher !== "" || nextLanguage !== "";

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="batch-meta-publisher" className="text-text-2 mb-1.5 block text-xs">
          出版社
        </label>
        <GlassInput
          id="batch-meta-publisher"
          value={publisher}
          onChange={(event) => setPublisher(event.target.value)}
          maxLength={LIMITS.publisher}
          placeholder="不改"
        />
      </div>

      <div>
        <label htmlFor="batch-meta-language" className="text-text-2 mb-1.5 block text-xs">
          语言
        </label>
        <GlassInput
          id="batch-meta-language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          maxLength={LIMITS.language}
          placeholder="不改（如 zh、en）"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="primary"
          disabled={busy || !dirty}
          onClick={() =>
            onSave({
              // `null` is "leave it alone" — the backend distinguishes it from
              // an empty string, which clears the field.
              publisher: nextPublisher === "" ? null : nextPublisher,
              language: nextLanguage === "" ? null : nextLanguage,
            })
          }
        >
          改这 {count} 本
        </GlassButton>
      </div>
    </div>
  );
}
