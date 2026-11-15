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

/** One round of parsing per label, then reused: a keystroke asks about every
 *  label on the shelf, and the answer never changes. */
const cache = new Map<string, string>();

/**
 * The initials of a label, lowercase, with anything non-Han passed through.
 *
 * 「长篇小说」 → `cpxs`; 「iOS 开发」 → `ioskf`. A character the dictionary does
 * not know is skipped rather than guessed: a wrong letter is worse than a
 * missing one, because it silently points the reader at the wrong label.
 */
export function initialsOf(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;

  const out = parse(text)
    .map((token) => (token.type === HAN ? (token.target[0] ?? "") : token.source))
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
