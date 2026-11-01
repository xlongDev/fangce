import { costOf, formatCost, formatUsage } from "@/lib/aiUsage";
import type { TokenPrice, TokenUsage } from "@/types/ipc";

/**
 * What one answer cost, under the answer.
 *
 * Tokens always; money only once the reader has priced the model, because a
 * total computed from half a price list looks authoritative and is wrong. The
 * switch that hides this row lives in the AI settings.
 */
export function TokenUsageBar({
  usage,
  price,
}: {
  usage: TokenUsage;
  price: TokenPrice | undefined;
}) {
  const cost = costOf(usage, price);
  return (
    <p data-token-usage className="text-text-3 mt-2 text-[11px] tabular-nums">
      {formatUsage(usage)}
      {cost === null ? "" : ` · 约 ${formatCost(cost)}`}
    </p>
  );
}
