import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";

import { OverlayPortal } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import { summarizeKindleBatch } from "@/features/library/format";
import type { KindleBatchOutcome, KindleBatchSummary, KindleSendProgress } from "@/lib/bindings";

const AUTO_DISMISS_MS = 6_000;
const MAX_ROWS = 20;

function outcomeLine(outcome: KindleBatchOutcome): string {
  if (outcome.kind === "sent") return `已发送（第 ${outcome.messageIndex ?? "?"} 封）`;
  return outcome.message ?? "已跳过";
}

/** Progress while a batch runs, then a receipt the reader can actually read.
 *  A successful batch is a receipt and goes away; anything skipped or failed
 *  stays until dismissed, because that is the part someone has to act on. */
export function KindleSendSummary({
  summary,
  progress,
  onClose,
}: {
  summary: KindleBatchSummary | null;
  progress: KindleSendProgress | null;
  onClose: () => void;
}) {
  const clean =
    summary !== null &&
    summary.sent === summary.total &&
    summary.invalid === 0 &&
    summary.failed === 0 &&
    summary.duplicate === 0;

  // The caller passes an inline arrow; depending on it directly would restart
  // the timer on every render of the shelf behind this card.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!summary || !clean) return;
    const timer = setTimeout(() => close.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [summary, clean]);

  const rows = summary?.outcomes.slice(0, MAX_ROWS) ?? [];
  const hidden = (summary?.outcomes.length ?? 0) - rows.length;

  return (
    <OverlayPortal>
      <div className="glass-2 shadow-panel fixed right-6 bottom-24 z-40 flex max-h-[70vh] w-80 flex-col rounded-2xl p-4">
        <div className="flex shrink-0 items-start justify-between gap-2">
          <p className="text-text-1 text-sm font-medium">
            {summary ? summarizeKindleBatch(summary) : "正在发送到 Kindle…"}
          </p>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="text-text-3 hover:text-text-1 shrink-0"
          >
            <X size={13} />
          </button>
        </div>

        {summary === null && progress && (
          <p className="text-text-3 mt-2 text-xs tabular-nums">
            已处理 {progress.done}/{progress.total}，已发 {progress.messages} 封
          </p>
        )}

        {summary?.configError && (
          <p className="text-danger mt-2 shrink-0 text-xs break-words">{summary.configError}</p>
        )}

        {rows.length > 0 && (
          <ul className="mt-2 min-h-0 space-y-2 overflow-y-auto">
            {rows.map((outcome) => (
              <li
                key={outcome.bookId}
                className={cn(
                  "text-text-3 text-xs break-words",
                  (outcome.kind === "invalid" || outcome.kind === "failed") && "text-danger",
                )}
              >
                《{outcome.title}》：{outcomeLine(outcome)}
              </li>
            ))}
            {hidden > 0 && <li className="text-text-3 text-xs">另有 {hidden} 本</li>}
          </ul>
        )}
      </div>
    </OverlayPortal>
  );
}
