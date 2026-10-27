/**
 * Voices for read-aloud, presented the way readest presents them.
 *
 * Two engines feed the picker, and the reader is never asked to care which one
 * a voice comes from — except where it matters, which is that one of them needs
 * the network:
 *
 * * **system** — the platform's own `speechSynthesis` list. macOS alone ships
 *   forty-odd languages, so "readest 的全部语言" means *every* language the
 *   system reports, not a hand-picked shortlist. The only filtering is readest's
 *   novelty-voice blacklist: Fred, Bubbles and Zarvox are joke voices nobody
 *   wants in a reading picker.
 * * **edge** — Microsoft's read-aloud service, reached over the network. This is
 *   where Yunjian lives: no operating system ships it, and it is the reader's
 *   default.
 *
 * Flattened to `{ uri, name, lang, engine }` so a choice is a storable string
 * and the sorting/grouping rules are pure functions with a test beside them.
 */

import type { EdgeVoice } from "@/types/ipc";

/** Which engine speaks a voice. */
export type SpeechEngine = "system" | "edge";

/** What the picker marks beside a name. `null` for the platform's own voices,
 *  which publish nothing of the sort — the mark is a hint, and a guess is not
 *  a hint. */
export type VoiceGender = "female" | "male";

/** One selectable voice. */
export interface Voice {
  /** `SpeechSynthesisVoice.voiceURI` for a system voice, `<prefix><shortName>`
   *  for an Edge voice. The stable id we persist, and the thing that says which
   *  engine to use. */
  uri: string;
  name: string;
  /** BCP-47 tag, e.g. `zh-CN`. */
  lang: string;
  engine: SpeechEngine;
  /** What an Edge voice is styled for (`Novel`, `Dialect`). Empty for system
   *  voices, which carry no such label — and it is the only thing telling
   *  Yunjian, Yunxi, Yunxia and Yunyang apart at a glance. */
  categories: string;
  /** From the service's catalogue; see `VoiceGender`. */
  gender: VoiceGender | null;
}

/**
 * Edge ids are stored with this prefix.
 *
 * The platform's `voiceURI` (`com.apple.voice.compact.zh-CN.Tingting`) and the
 * service's `ShortName` (`zh-CN-YunjianNeural`) are two namespaces that must
 * not be confused, because picking the wrong engine for an id fails silently:
 * the server answers `403` or the platform picks a default. A prefix makes the
 * engine a property of the stored value instead of a second thing to keep in
 * sync.
 */
export const EDGE_PREFIX = "edge:";

/** The stored id for an Edge voice. */
export function edgeUri(shortName: string): string {
  return `${EDGE_PREFIX}${shortName}`;
}

/** Which engine a stored pick belongs to. */
export function engineOf(uri: string | null): SpeechEngine {
  return uri?.startsWith(EDGE_PREFIX) === true ? "edge" : "system";
}

/** The id to send back to the service, without the prefix. */
export function edgeVoiceId(uri: string): string {
  return uri.startsWith(EDGE_PREFIX) ? uri.slice(EDGE_PREFIX.length) : uri;
}

/** Voices readest hides (its `WEB_SPEECH_BLACKLISTED_VOICES`). */
const NOVELTY_VOICES = new Set([
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Eddy",
  "Flo",
  "Fred",
  "Good News",
  "Grandma",
  "Grandpa",
  "Jester",
  "Junior",
  "Kathy",
  "Organ",
  "Ralph",
  "Reed",
  "Rocko",
  "Sandy",
  "Shelley",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
]);

/** The voice read-aloud starts on when the reader never picked one. */
export const DEFAULT_VOICE_NAME = "Yunjian";

/** Matching key for the default pick. Matched against the URI as well as the
 *  name: macOS localises a voice's *name* to the system language ("云间") while
 *  its identifier keeps the romanised form, and the identifier is the half
 *  that never moves. */
const DEFAULT_VOICE_KEY = DEFAULT_VOICE_NAME.toLowerCase();

const isDefaultVoice = (voice: { name: string; uri: string }): boolean =>
  voice.name.toLowerCase().includes(DEFAULT_VOICE_KEY) ||
  voice.uri.toLowerCase().includes(DEFAULT_VOICE_KEY);

/** Sort by language then name — plain `<` so the order never depends on the
 *  browser's collation (a picker that reshuffles between machines is a bug). */
const byLangThenName = (a: Voice, b: Voice) =>
  a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Locales the picker keeps from the service's catalogue.
 *
 *  The service ships voices for ~140 locales, and almost all of them are noise
 *  in a reading picker — sixteen flavours of Arabic ahead of the Chinese the
 *  reader actually wants is that list at its worst. What is kept is the major
 *  written languages plus every Chinese variant; it is one array, and a reader
 *  who misses a language only has to add its locale here. The platform's own
 *  list is left complete: forty-odd languages of real speech is a reasonable
 *  thing to show in full, a hundred and forty is not. */
const EDGE_LOCALES = new Set([
  "zh-CN",
  "zh-CN-liaoning",
  "zh-CN-shaanxi",
  "zh-TW",
  "zh-HK",
  "yue-HK",
  "en-US",
  "en-GB",
  "en-AU",
  "en-IN",
  "ja-JP",
  "ko-KR",
  "de-DE",
  "de-AT",
  "de-CH",
  "fr-FR",
  "fr-CA",
  "es-ES",
  "es-MX",
  "it-IT",
  "ru-RU",
  "pt-BR",
  "pt-PT",
  "nl-NL",
  "pl-PL",
  "tr-TR",
  "ar-SA",
  "hi-IN",
  "th-TH",
  "vi-VN",
  "id-ID",
]);

/** The picker's language order: the languages a reader of this app is likeliest
 *  to open first, everything else alphabetical behind them. Dialect locales
 *  ride with their parent (`zh-CN-liaoning` ranks as `zh-CN`). */
const PREFERRED_LANGS = [
  "zh-CN",
  "yue-HK",
  "zh-TW",
  "zh-HK",
  "en-US",
  "en-GB",
  "en-AU",
  "en-IN",
  "ja-JP",
  "ko-KR",
];

const langRank = (lang: string): number => {
  for (let at = 0; at < PREFERRED_LANGS.length; at += 1) {
    const preferred = PREFERRED_LANGS[at];
    if (preferred !== undefined && (lang === preferred || lang.startsWith(`${preferred}-`))) {
      return at;
    }
  }
  return PREFERRED_LANGS.length;
};

/** Section order: preferred languages first, then alphabetical. */
const byLangOrder = (a: string, b: string): number =>
  langRank(a) - langRank(b) || (a < b ? -1 : a > b ? 1 : 0);

const bySectionOrder = (a: Voice, b: Voice) => byLangOrder(a.lang, b.lang) || byLangThenName(a, b);

/** The platform's voices, cleaned and ordered for the picker.
 *
 *  Duplicate labels are collapsed: a platform can publish two voices under one
 *  name and locale (macOS lists "Tingting" twice), and two identical rows give
 *  the reader no way to tell them apart. The first in the platform's own order
 *  wins, so the pick survives a restart. */
export function systemVoices(system: readonly SpeechSynthesisVoice[]): Voice[] {
  const seen = new Set<string>();
  const out: Voice[] = [];
  for (const voice of system) {
    if (voice.name === "" || NOVELTY_VOICES.has(voice.name)) continue;
    const key = `${voice.lang}:${voice.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      uri: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      engine: "system",
      categories: "",
      gender: null,
    });
  }
  return out.toSorted(byLangThenName);
}

/** The service's own spelling → the picker's two states. */
const normalizeGender = (raw: string): VoiceGender | null =>
  raw === "Female" ? "female" : raw === "Male" ? "male" : null;

/** The service's voices, as the picker wants them.
 *
 *  Beyond tagging the engine, two rules apply: the catalogue is trimmed to
 *  `EDGE_LOCALES` (a hundred and forty locales is not a picker, it is a phone
 *  book), and the survivors are ordered by `bySectionOrder` so Chinese sits at
 *  the top instead of wherever the locale code sorts. */
export function edgeVoices(system: readonly EdgeVoice[]): Voice[] {
  return system
    .filter((voice) => EDGE_LOCALES.has(voice.locale))
    .map((voice) => ({
      uri: edgeUri(voice.shortName),
      name: voice.name,
      lang: voice.locale,
      engine: "edge" as const,
      categories: voice.categories,
      // The service says "Female" / "Male"; anything else (a voice it did not
      // tag) draws no mark rather than a wrong one.
      gender: normalizeGender(voice.gender),
    }))
    .toSorted(bySectionOrder);
}

/** Base language subtag, lowercased and normalised (`zh-CN-liaoning` → `zh`;
 *  macOS locales may use `_` instead of `-`). */
const baseLang = (tag: string): string => {
  // Coerced, not assumed: a container's language is not always a string (a MOBI
  // handed over `["zh"]`), and a book imported before that was normalised still
  // carries one. One `toLowerCase` on a list took the whole reading page down,
  // which is a poor trade for a voice picker.
  const text = typeof tag === "string" ? tag : String(tag ?? "");
  return text.toLowerCase().replace(/_/g, "-").split("-")[0] ?? text;
};

/** True when a voice's locale can read a book of `bookLang`: the base subtags
 *  must agree (`zh` covers `zh-CN` and `zh-TW`, but not `yue`; `en` covers
 *  `en-US` and `en-GB`). */
export function matchesBookLang(voiceLang: string, bookLang: string): boolean {
  return baseLang(voiceLang) === baseLang(bookLang);
}

/** The voices that speak the book's own language, or `null` when the book's
 *  language is unknown or the catalogue has nothing for it — in both cases the
 *  picker shows every voice rather than an empty list. */
export function bookLangVoices(voices: readonly Voice[], bookLang: string | null): Voice[] | null {
  if (!bookLang) return null;
  const hit = voices.filter((voice) => matchesBookLang(voice.lang, bookLang));
  return hit.length > 0 ? hit : null;
}

/** The voices of one language, so the picker can page by language. */
export function voicesInLang(voices: readonly Voice[], lang: string): Voice[] {
  return voices.filter((voice) => voice.lang === lang);
}

/** Every language the given voices cover, in the picker's order. */
export function voiceLanguages(voices: readonly Voice[]): string[] {
  return [...new Set(voices.map((voice) => voice.lang))];
}

/** One section of the picker: a language and the voices under it. */
export interface VoiceSection {
  lang: string;
  label: string;
  voices: Voice[];
}

/** One engine's worth of sections. */
export interface VoiceGroup {
  engine: SpeechEngine;
  label: string;
  sections: VoiceSection[];
}

/** How the picker names the two engines. */
const ENGINE_LABELS: Record<SpeechEngine, string> = {
  edge: "Edge 在线语音",
  system: "系统语音",
};

/** Engine order: the service first, because that is where the default lives. */
const ENGINE_ORDER: SpeechEngine[] = ["edge", "system"];

/**
 * The picker's rows: every voice, grouped by engine and then by language, each
 * language headed by its display name.
 *
 * A flat list is unusable on a platform that ships forty-odd languages, and a
 * horizontal strip of language chips hides the one you are actually on as soon
 * as the row scrolls — the reader sees Arabic and Bulgarian while the list
 * below them is Chinese. The engine heading is the one thing the two sources
 * cannot be mixed on, because only one of them needs a connection.
 */
export function voiceGroups(voices: readonly Voice[]): VoiceGroup[] {
  const groups: VoiceGroup[] = [];
  for (const engine of ENGINE_ORDER) {
    const owned = voices.filter((voice) => voice.engine === engine);
    if (owned.length === 0) continue;
    const sections: VoiceSection[] = [];
    for (const lang of voiceLanguages(owned)) {
      const inLang = voicesInLang(owned, lang);
      if (inLang.length === 0) continue;
      sections.push({ lang, label: languageName(lang), voices: inLang });
    }
    // Insertion order is the catalogue's, not the reader's — the service lists
    // Arabic first, the platform sorts by code. Both get reordered here.
    sections.sort((a, b) => byLangOrder(a.lang, b.lang));
    groups.push({ engine, label: ENGINE_LABELS[engine], sections });
  }
  return groups;
}

/** True when the default voice is missing from the platform's list — the
 *  picker says so rather than silently reading in a different voice. */
export function defaultVoiceMissing(voices: readonly Voice[]): boolean {
  return !voices.some(isDefaultVoice);
}

/** The dialect locales the platform's name table cannot answer for.
 *
 *  `Intl.DisplayNames` knows languages and regions, not variants: asked for
 *  `zh-CN-liaoning` it returns `null`, and the picker printed the raw tag as a
 *  section heading — "zh-CN-liaoning" sitting over Xiaobei, which reads as a
 *  bug rather than as a language. These are the two the service files under a
 *  variant subtag, named the way a reader would say them. */
const VARIANT_LANGUAGES: Record<string, string> = {
  "zh-CN-liaoning": "东北话",
  "zh-CN-shaanxi": "陕西话",
};

/** Human name for a tag (`zh-CN` → 中文（中国）); the raw tag when the browser
 *  has no display names, or the tag is malformed. */
export function languageName(tag: string): string {
  const variant = VARIANT_LANGUAGES[tag];
  if (variant !== undefined) return variant;
  const Names = (Intl as unknown as { DisplayNames?: typeof Intl.DisplayNames }).DisplayNames;
  if (!Names) return tag;
  try {
    return new Names(undefined, { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The Chinese name of a Chinese voice.
 *
 * The service names every voice in pinyin only — "Xiaoxiao" tells a reader
 * nothing about who is speaking, 晓晓 does. Keyed by the display name the
 * service itself uses (see `display_name` on the Rust side), which is stable
 * per voice; a voice this table does not know keeps its Latin name, which is
 * what the rest of the catalogue shows anyway. Adding one is a line here.
 */
const VOICE_ZH_NAMES: Record<string, string> = {
  // 中文（中国大陆）
  Xiaoxiao: "晓晓",
  Xiaoyi: "晓伊",
  Yunjian: "云健",
  Yunxi: "云希",
  Yunxia: "云夏",
  Yunyang: "云扬",
  // 方言
  Xiaobei: "晓北",
  Xiaoni: "晓妮",
  // 中文（台湾）
  HsiaoChen: "曉臻",
  HsiaoYu: "曉雨",
  YunJhe: "雲哲",
  // 中文（香港）
  HiuGaai: "曉佳",
  HiuMaan: "曉曼",
  WanLung: "雲龍",
};

/** `null` for a voice with no Chinese name — the picker then shows the name it
 *  already has, rather than an empty cell. */
export function voiceZhName(name: string): string | null {
  return VOICE_ZH_NAMES[name] ?? null;
}

/**
 * The voice read-aloud starts on: the saved pick, else Yunjian, else something
 * that speaks the reader's own language, else whatever the platform lists
 * first. Resolved against the live list rather than stored, so a saved voice
 * that a macOS update removed degrades instead of going silent.
 */
export function defaultVoice(voices: readonly Voice[], preferred: string | null): Voice | null {
  if (preferred) {
    const saved = voices.find((voice) => voice.uri === preferred);
    if (saved) return saved;
  }
  const yunjian = voices.find(isDefaultVoice);
  if (yunjian) return yunjian;
  const ui = (globalThis.navigator?.language ?? "en").toLowerCase();
  return (
    voices.find((voice) => voice.lang.toLowerCase() === ui) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(ui.slice(0, 2))) ??
    voices[0] ??
    null
  );
}

/**
 * The platform object to hand to an utterance. `setVoice` stores a URI, and
 * the system list is what the engine actually accepts, so the URI is resolved
 * at speak time; with nothing saved, the default pick applies.
 */
export function resolveVoice(
  system: readonly SpeechSynthesisVoice[],
  uri: string | null,
): SpeechSynthesisVoice | null {
  if (uri) {
    const hit = system.find((voice) => voice.voiceURI === uri);
    if (hit) return hit;
  }
  return (
    system.find((voice) => {
      const lower = `${voice.name} ${voice.voiceURI}`.toLowerCase();
      return lower.includes(DEFAULT_VOICE_KEY);
    }) ?? null
  );
}
