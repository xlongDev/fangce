import type { TokenPrice, TokenUsage } from "@/types/ipc";

/** What a million tokens cost, with `null`/absent folded to zero. */
interface Price {
  cached: number;
  miss: number;
  output: number;
}

/**
 * Reads the three prices, filling the gaps the way the settings form describes
 * them: a single input price covers *all* input tokens, cached or not.
 */
export function priceOf(price: TokenPrice | null | undefined): Price {
  const cached = price?.inputCached ?? 0;
  const miss = price?.inputMiss ?? 0;
  const output = price?.output ?? 0;
  return {
    cached: cached || miss,
    miss: miss || cached,
    output,
  };
}

/**
 * What one answer cost, in yuan — or `null` when the reader has not priced it.
 *
 * Both an output price and at least one input price are required: a total
 * computed from half a price list is a number that looks authoritative and is
 * wrong, which is worse than showing tokens alone.
 */
export function costOf(
  usage: TokenUsage | null | undefined,
  price: TokenPrice | null | undefined,
): number | null {
  if (!usage) return null;
  const rates = priceOf(price);
  if (rates.output <= 0 || (rates.cached <= 0 && rates.miss <= 0)) return null;

  // `cached` is a subset of `input`, not an addition to it: the cache-hit rate
  // is cheaper, not extra.
  const cached = Math.min(usage.cached, usage.input);
  const missed = Math.max(usage.input - cached, 0);
  return (cached * rates.cached + missed * rates.miss + usage.output * rates.output) / 1_000_000;
}

/** `¥0.0034` for pocket change, `¥1.23` for the rest. */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `¥${cost.toFixed(4)}`;
  return `¥${cost.toFixed(2)}`;
}

/**
 * The one line under an answer: what went in, how much of it was cached, what
 * came out. The cached half is only mentioned when there is one — "(缓存命中 0)"
 * on every answer is noise.
 */
export function formatUsage(usage: TokenUsage): string {
  const parts = [`输入 ${usage.input}`];
  if (usage.cached > 0) parts.push(`缓存命中 ${usage.cached}`);
  parts.push(`输出 ${usage.output}`);
  return parts.join(" · ");
}
