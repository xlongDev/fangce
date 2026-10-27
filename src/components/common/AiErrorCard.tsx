import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";

import { AI_SETTINGS } from "@/lib/routes";

/**
 * A failure about the AI configuration, as something the reader can act on
 * rather than a red sentence.
 *
 * The backend writes its failures as "结论，建议" — "API Key 被拒绝，检查 Key
 * 是否正确或已过期（HTTP 401）" — so the comma is a real seam and the two
 * halves want different weights: the verdict at reading size, the advice under
 * it. Every one of these is about the configured endpoint, so the way out is
 * always the same one field: 设置 › AI 助手, which the route lands on directly.
 *
 * Shared by the two reader panels that cannot work without a model — the guide
 * and the knowledge graph — so the same failure cannot grow two different
 * shapes a panel apart.
 */
export function AiErrorCard({ message }: { message: string }) {
  const navigate = useNavigate();
  const { headline, detail } = splitReason(message);

  return (
    <div role="alert" className="border-danger/20 bg-danger/8 rounded-xl border p-3">
      <div className="flex items-start gap-2">
        {/* The bare glyph rather than a tinted disc: at this width a 24px disc
            is a sixth of the card, and a filled one reads as a red dot with
            nothing in it. Same mark as the toast uses for the same news. */}
        <WarningCircle size={16} weight="fill" className="text-danger mt-px shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-text-1 text-[12.5px] leading-snug font-medium">{headline}</p>
          {detail && <p className="text-text-2 mt-1 text-[12px] leading-relaxed">{detail}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate(AI_SETTINGS)}
        className="glass-liquid text-accent focus-visible:focus-ring mt-2.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition-opacity hover:opacity-90"
      >
        去设置 AI 助手
        <ArrowRight size={12} aria-hidden />
      </button>
    </div>
  );
}

/**
 * Splits "结论，建议" into its two halves.
 *
 * Only the first comma: a provider message quoted after it may well have
 * commas of its own, and they belong to the advice, not to a third line.
 * A message with no comma is all verdict, which is what the one-word failures
 * ("接口地址或模型名称不存在") are.
 */
function splitReason(message: string): { headline: string; detail: string } {
  const at = message.indexOf("，");
  if (at < 0) return { headline: message, detail: "" };
  return { headline: message.slice(0, at), detail: message.slice(at + 1) };
}
