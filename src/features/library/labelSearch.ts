import { fullPinyinOf, initialsOf } from "@/features/library/pinyin";
import type { TagSummary } from "@/types/ipc";

/**
 * Finding one label among 281.
 *
 * The old rule was a substring test, which is fine until the reader types two
 * things that are not adjacent — 「中国 历史」, or 「中历」, or the pinyin they
 * would say out loud. This is a scorer instead of a filter: every term has to
 * match somehow, and the strength of the match decides the order.
 *
 * Ordering matters as much as matching here. Once a search can be fuzzy, it
 * also returns noise, and the only thing that makes noise tolerable is putting
 * the label the reader meant first.
 */

const EXACT = 100;
const PREFIX = 85;
const CONTAINS = 70;
const PINYIN_FULL_PREFIX = 50;
const PINYIN_EXACT = 65;
const PINYIN_PREFIX = 58;
const PINYIN_CONTAINS = 45;
const PINYIN_FULL_CONTAINS = 38;
const SUBSEQUENCE = 20;

/** Letters only: anything else is read as characters the reader actually typed. */
const LETTERS = /^[a-z]+$/;

/**
 * How well one term matches one label. `0` means it does not.
 *
 * `name` is the label as written; `lower` is the same string lowercased, so the
 * Latin paths do not have to re-do it per term.
 */
function scoreTerm(name: string, lower: string, term: string): number {
  if (lower === term) return EXACT;
  if (lower.startsWith(term)) return PREFIX;
  if (lower.includes(term)) return CONTAINS;

  if (LETTERS.test(term)) {
    const initials = initialsOf(name);
    if (initials === term) return PINYIN_EXACT;
    if (initials.startsWith(term)) return PINYIN_PREFIX;
    if (initials.includes(term)) return PINYIN_CONTAINS;
    const pinyin = fullPinyinOf(name);
    if (pinyin.startsWith(term)) return PINYIN_FULL_PREFIX;
    if (pinyin.includes(term)) return PINYIN_FULL_CONTAINS;
    return 0;
  }

  // Last resort: the characters appear in order with others in between —
  // 「中历」 finds 「中国历史」. Deliberately the weakest score: on short labels
  // almost anything matches this way, so it can only ever break a tie, never
  // outrank a label that contains what was typed.
  return subsequence(lower, term);
}

function subsequence(name: string, term: string): number {
  let at = 0;
  let skipped = 0;
  for (const character of name) {
    if (at < term.length && character === term[at]) {
      at += 1;
      if (at === term.length) break;
    } else if (at > 0) {
      skipped += 1;
    }
  }
  if (at < term.length) return 0;
  return Math.max(5, SUBSEQUENCE - skipped);
}

/**
 * The labels matching `raw`, best first.
 *
 * Whitespace separates terms and all of them have to match, so 「美国 文学」 and
 * 「文学 美国」 are the same search — the reader should not have to remember the
 * order of words they are looking at.
 *
 * An empty query returns the list untouched: the caller is then showing
 * everything, in whatever order the shelf had it.
 */
export function searchTags(tags: TagSummary[], raw: string): TagSummary[] {
  const terms = raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) return tags;

  const scored: { tag: TagSummary; score: number }[] = [];
  for (const tag of tags) {
    const lower = tag.name.toLowerCase();
    let score = 0;
    let matched = true;
    for (const term of terms) {
      const part = scoreTerm(tag.name, lower, term);
      if (part === 0) {
        matched = false;
        break;
      }
      // Summed, so a label that matches several terms well beats one that
      // matches a single term perfectly.
      score += part;
    }
    if (matched) scored.push({ tag, score });
  }

  // Stable: equal scores keep the frequency order they arrived in.
  return scored.toSorted((a, b) => b.score - a.score).map((entry) => entry.tag);
}
