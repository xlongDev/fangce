import { MARK_END, MARK_START, type SearchHit } from "@/types/ipc";

/**
 * Backend snippets carry the matched run wrapped in two control characters.
 * Splitting them into parts keeps the hit renderable as plain text, with no
 * markup ever reaching the DOM.
 */
export interface SnippetPart {
  text: string;
  matched: boolean;
}

export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let cursor = 0;
  while (cursor < snippet.length) {
    const open = snippet.indexOf(MARK_START, cursor);
    if (open < 0) break;
    const close = snippet.indexOf(MARK_END, open + 1);
    if (close < 0) break;
    if (open > cursor) parts.push({ text: snippet.slice(cursor, open), matched: false });
    parts.push({ text: snippet.slice(open + 1, close), matched: true });
    cursor = close + 1;
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), matched: false });
  return parts;
}

/** Same row text for a hit, whether the list is scoped to a book or not. */
export function hitLocation(hit: SearchHit, scoped: boolean): string {
  const chapter = `第 ${hit.chapterIdx + 1} 章`;
  return scoped ? chapter : `${hit.bookTitle} · ${chapter}`;
}

/**
 * The hit as a needle for locating it in another rendering of the same page
 * (the PDF text layer is the one consumer): the snippet's plain text with the
 * match run's span inside it.
 *
 * The truncation ellipses the backends hang off the edges are dropped — they
 * name cut text, not page text, and a needle carrying them can never be found
 * again. Only the edges are touched, so the match span stays put.
 */
export function searchHitNeedle(
  snippet: string,
): { text: string; from: number; to: number } | null {
  const parts = parseSnippet(snippet);
  const first = parts.findIndex((part) => part.matched);
  if (first < 0) return null;
  const texts = parts.map((part) => part.text);
  texts[0] = texts[0]!.replace(/^…+/, "");
  texts[texts.length - 1] = texts[texts.length - 1]!.replace(/…+$/, "");
  const text = texts.join("");
  const from = texts.slice(0, first).reduce((count, part) => count + part.length, 0);
  const to = from + texts[first]!.length;
  return text.length === 0 ? null : { text, from, to };
}

/**
 * The reader URL a hit opens.
 *
 * Both places that can pick a hit — the search page and the ⌘F dialog — write
 * the same parameters. `q` and `at` are what the prose reader uses to paint and
 * scroll to the match; a foliate book knows neither our chapter indices nor our
 * offsets (its sections are the container's own), so `s` carries the hit's
 * snippet and the foliate view matches it against its own search excerpts to
 * land on the very occurrence that was clicked.
 */
export function readerPathForHit(hit: SearchHit, needle: string): string {
  const params = new URLSearchParams({
    book: hit.bookId,
    chapter: String(hit.chapterIdx),
    q: needle,
    at: String(hit.offset),
    s: plainSnippet(hit.snippet),
  });
  return `/reader?${params.toString()}`;
}

/** Bound for the snippet carried in the URL: context for a match, not a payload. */
const SNIPPET_URL_LIMIT = 160;

/** The snippet for the URL, markers kept — the foliate side locates the match
 *  by them. Whitespace is squeezed and the tail is cut, but never through the
 *  marked run: a cut that swallows `MARK_END` turns the whole tail into one
 *  unmatched run and the match itself is lost. */
function plainSnippet(snippet: string): string {
  const squeezed = snippet.replace(/\s+/g, " ").trim();
  const close = squeezed.indexOf(MARK_END);
  const limit = close < 0 || close >= SNIPPET_URL_LIMIT ? SNIPPET_URL_LIMIT : close + 1;
  const cut = squeezed.length > limit ? `${squeezed.slice(0, limit)}…` : squeezed;
  return cut;
}

// Both excerpts sit against different page fonts and measures; only the
// characters carry, so whitespace goes entirely and case follows it.
const squeeze = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/**
 * Which of foliate's own search hits is the one a library-wide row pointed at.
 *
 * foliate cannot go to our (chapter, offset) pair, so the occurrence is
 * identified by its words: the text before and after the match survives both
 * pipelines (the extracted chapters and the container's XHTML come from the
 * same book), and the hit whose context overlaps the snippet's most is the one
 * to land on. No overlap at all returns `null`; the caller then opens the
 * first hit, which still puts the reader on a painted match.
 */
export function pickFoliateHit(
  snippet: string,
  hits: readonly { cfi: string; pre: string; post: string }[],
): string | null {
  const parts = parseSnippet(snippet);
  const first = parts.findIndex((part) => part.matched);
  if (first < 0) return null;
  let last = first;
  for (let i = parts.length - 1; i > first; i--) {
    if (parts[i]?.matched) {
      last = i;
      break;
    }
  }
  const before = squeeze(
    parts
      .slice(0, first)
      .map((part) => part.text)
      .join(""),
  );
  const after = squeeze(
    parts
      .slice(last + 1)
      .map((part) => part.text)
      .join(""),
  );
  let best: { cfi: string; score: number } | null = null;
  for (const hit of hits) {
    const pre = squeeze(hit.pre);
    const post = squeeze(hit.post);
    // Longest shared run touching the match: the snippet's text before the
    // match against the excerpt's (a suffix of both), then after (a prefix).
    let shared = 0;
    const back = Math.min(pre.length, before.length);
    while (shared < back && pre[pre.length - 1 - shared] === before[before.length - 1 - shared]) {
      shared++;
    }
    let ahead = 0;
    const forward = Math.min(post.length, after.length);
    while (ahead < forward && post[ahead] === after[ahead]) ahead++;
    const score = shared + ahead;
    if (score > 0 && (!best || score > best.score)) best = { cfi: hit.cfi, score };
  }
  return best?.cfi ?? null;
}
