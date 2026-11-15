import { convertToPinyin, isSupported, parse } from "tiny-pinyin";

/**
 * Pinyin initials, for finding 「中国历史」 by typing `zg`.
 *
 * A reader who has named 281 labels knows what they are called, not how they
 * are spelled in Latin — but typing two letters beats scrolling 114 rows, and
 * the initials of a Chinese label are its keyboard shortcut. There is no input
 * method in the way: the shelf's search field is ASCII, and `zg` is faster to
 * type than any character.
 *
 * `tiny-pinyin` rather than `pinyin-pro`: 41 kB against 928 kB, and the only
 * thing needed here is 「which letter does this character start with」.
 */

/** Whether the dictionary loaded — it is a plain object, so this is really
 *  「does this build have it」, and it is false only in a broken bundle. */
export const initialsAvailable = isSupported();

const HAN = 2;
/** The dictionary's own name for 「not a character I know」. */
const UNKNOWN = 3;

/**
 * The platform's pinyin order, for the characters the dictionary cannot place.
 *
 * 🔴 `tiny-pinyin` decides 「is this in my table」 by comparing the character
 * with U+9FFF, and that comparison is the platform's zh collation. In WebKit 中
 * sorts *after* U+9FFF, so 中 comes back as unknown and 「美国文学」 reduces to
 * `mgw` — the label is then unfindable by the letters the reader typed, and
 * 「哲学」 reduces to nothing at all. Chromium and Node collate it the other way,
 * which is why only a browser test on the second engine caught this.
 *
 * So a character the dictionary skips is bucketed by the collation directly:
 * each pair is 「this letter's block starts at this character」, and the last
 * seed that does not sort after the character names its letter. Cruder than the
 * dictionary — no tones, and a polyphone gets the reading its collation uses —
 * but it is an answer instead of silence, and it runs only for characters the
 * dictionary already gave up on.
 */
const SENTINELS: readonly (readonly [letter: string, first: string])[] = [
  ["a", "阿"],
  ["b", "八"],
  ["c", "擦"],
  ["d", "搭"],
  // 俄 rather than 婀 or 鹅: within one syllable the collation falls back to
  // codepoint order, and 俄 (U+4FC4) is the lowest of the é characters — a seed
  // that sorted after another é character would push that character into `d`.
  ["e", "俄"],
  ["f", "发"],
  ["g", "嘎"],
  ["h", "哈"],
  ["j", "击"],
  ["k", "咖"],
  ["l", "拉"],
  ["m", "妈"],
  ["n", "拿"],
  ["o", "哦"],
  ["p", "趴"],
  ["q", "七"],
  ["r", "然"],
  ["s", "撒"],
  ["t", "他"],
  ["w", "挖"],
  ["x", "夕"],
  ["y", "丫"],
  ["z", "匝"],
];

const HAN_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

let collator: Intl.Collator | null | undefined;

/**
 * The first letter of a character, straight from the collation.
 *
 * Exported for its own test: in Node the dictionary knows every one of these, so
 * the fallback is unreachable through `initialsOf` there.
 */
export function letterOf(char: string): string {
  if (collator === undefined) {
    collator =
      typeof Intl !== "undefined" && Intl.Collator
        ? new Intl.Collator(["zh-Hans-CN", "zh-CN"])
        : null;
  }
  if (!collator) return "";
  let letter = "";
  for (const [candidate, seed] of SENTINELS) {
    if (collator.compare(seed, char) <= 0) letter = candidate;
    else break;
  }
  return letter;
}

/** One round of parsing per label, then reused: a keystroke asks about every
 *  label on the shelf, and the answer never changes. */
const cache = new Map<string, string>();

/**
 * The initials of a label, lowercase, with anything non-Han passed through.
 *
 * 「长篇小说」 → `cpxs`; 「iOS 开发」 → `ioskf`. A character outside the BMP or
 * from a block the dictionary does not cover is skipped rather than guessed: a
 * wrong letter is worse than a missing one, because it silently points the
 * reader at the wrong label. A *known* Han character the dictionary failed to
 * place is a different case — there the collation has an answer, and it is
 * taken (see `SENTINELS`).
 */
export function initialsOf(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;

  const out = parse(text)
    .map((token) => {
      if (token.type === HAN) return token.target[0] ?? "";
      // A Han character the dictionary could not place: ask the collation
      // instead of dropping the letter (see `SENTINELS`).
      if (token.type === UNKNOWN && HAN_CHAR.test(token.source)) return letterOf(token.source);
      return token.source;
    })
    .join("")
    .toLowerCase()
    // Spaces and punctuation are not initials: `iOS 开发` should read `ioskf`,
    // not `ios kf`, or the space would have to be typed.
    .replace(/[^a-z0-9]/g, "");

  cache.set(text, out);
  return out;
}

/** Full pinyin, cached the same way: 「中国历史」 → `zhongguolishi`. */
const full = new Map<string, string>();

export function fullPinyinOf(text: string): string {
  const hit = full.get(text);
  if (hit !== undefined) return hit;
  const out = convertToPinyin(text, "", true).replace(/[^a-z0-9]/g, "");
  full.set(text, out);
  return out;
}

/**
 * Whether `query` (already lowercased) matches `name` by initials.
 *
 * Only ASCII letters are treated as initials — otherwise every search would
 * also be an initials search, and `设计` would start matching labels whose
 * pinyin happens to contain those letters in that order.
 */
export function matchesInitials(name: string, query: string): boolean {
  if (!/^[a-z]+$/.test(query)) return false;
  return initialsOf(name).includes(query);
}
