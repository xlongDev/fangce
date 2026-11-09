import type { Annotation } from "@/types/ipc";

import { inkWash } from "./selection";
import type { TextRange } from "./selection";

/**
 * Selection and highlight bookkeeping for the pdf.js text layer.
 *
 * The layer renders each text item as an absolutely positioned `<span>`.
 * Annotation offsets are UTF-16 counts into the layer's joined span text in
 * DOM order — the same coordinate style the prose path uses, with the page's
 * layer standing in for the chapter's paragraphs. DOM order follows the
 * content stream, so the mapping is stable across sessions on one pdf.js
 * version; only `annotation.text` is consumed elsewhere, so a pdf.js upgrade
 * re-bases offsets at worst and nothing desyncs.
 */

interface NodeStart {
  node: Text;
  start: number;
}

interface LayerWalk {
  text: string;
  nodes: NodeStart[];
}

function walkLayer(container: HTMLElement): LayerWalk {
  // Visual order, not DOM order: the content stream regularly paints text out
  // of reading order (Word/LaTeX exports move floats, footers, whole runs),
  // and a visually downward drag must resolve to the text below — not to
  // whatever the stream happened to emit first. Spans are bucketed by top
  // (8px, absorbs per-font ascent jitter) then read left to right; annotation
  // offsets share this walk, so paint and resolve stay consistent.
  const spans = Array.from(container.querySelectorAll<HTMLElement>("span")).filter(
    (span) => !span.classList.contains("markedContent") && (span.textContent?.length ?? 0) > 0,
  );
  const ordered = spans
    .map((span) => {
      const rect = span.getBoundingClientRect();
      return { span, top: Math.round(rect.top / 8), left: rect.left };
    })
    .toSorted((a, b) => a.top - b.top || a.left - b.left);

  const nodes: NodeStart[] = [];
  let text = "";
  for (const { span } of ordered) {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node: node as Text, start: text.length });
      text += node.textContent ?? "";
    }
  }
  return { text, nodes };
}

function joinedOffset(nodes: NodeStart[], container: Node, offset: number): number | null {
  // Linear scan: layers hold a few hundred nodes and selections are rare.
  const at = nodes.findIndex((entry) => entry.node === container);
  return at < 0 ? null : nodes[at]!.start + offset;
}

function nodeAndOffset(nodes: NodeStart[], offset: number): { node: Text; at: number } | null {
  let lo = 0;
  let hi = nodes.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid]!.start <= offset) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const entry = nodes[at];
  return entry ? { node: entry.node, at: offset - entry.start } : null;
}

/** Resolves a DOM selection inside one page's text layer into a range of the
 *  layer's joined text, or `null` when collapsed or outside the layer. */
export function resolveLayerSelection(
  container: HTMLElement,
  selection: Selection,
): TextRange | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const { text, nodes } = walkLayer(container);
  const start = joinedOffset(nodes, range.startContainer, range.startOffset);
  const end = joinedOffset(nodes, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end, text: text.slice(start, end) };
}

/** UTF-16 offset in the layer's joined text under a viewport point, or `null`
 *  when the point misses the layer. */
export function layerOffsetAtPoint(x: number, y: number, container: HTMLElement): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    if (!position) return null;
    node = position.offsetNode;
    offset = position.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  } else {
    return null;
  }
  if (!node || !container.contains(node)) return null;
  const { nodes } = walkLayer(container);
  return joinedOffset(nodes, node, offset);
}

/**
 * Paints the page's annotations with the CSS Custom Highlight API. Mounted
 * pages share a set of highlight names — one per ink — and every repaint
 * rebuilds the unions. Pages without Highlight support (none today, but the
 * API is young) skip painting silently — the annotation drawer stays the
 * source of truth.
 *
 * ponytail: every style paints as a colour wash here — WebKit's `::highlight`
 * styling of `text-decoration` is not dependable, and an underline that
 * renders as nothing is worse than one that renders as a wash. The foliate
 * and prose paths own the real shapes.
 */
const HIGHLIGHT_NAME = "pdf-notes";
/** Static CSS rule for the legacy (uncoloured) ink; custom inks get their own
 *  names generated below. */
const painted = new Map<number, { ranges: Range[]; names: string[] }>();

/** One dynamic rule per ink; ids are colour-derived so repeated repaints of
 *  the same highlight reuse the rule instead of growing the sheet. */
const styleSheetId = "pdf-notes-inks";
function inkName(color: string): string {
  return `pdf-notes-${color.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
}

function ensureInkRule(color: string): string {
  const name = inkName(color);
  let sheet = document.getElementById(styleSheetId) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = styleSheetId;
    document.head.append(sheet);
  }
  const rule = `::highlight(${name}) { background-color: ${inkWash(color, 0.35)} }`;
  if (!sheet.textContent?.includes(rule)) sheet.append(rule);
  return name;
}

function repaint() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const byName = new Map<string, Range[]>();
  for (const { ranges, names } of painted.values()) {
    ranges.forEach((range, index) => {
      const name = names[index] ?? HIGHLIGHT_NAME;
      const list = byName.get(name) ?? [];
      list.push(range);
      byName.set(name, list);
    });
  }
  for (const [name, ranges] of byName) {
    CSS.highlights.set(name, new Highlight(...ranges));
  }
  // Drop the names this repaint no longer covers.
  for (const name of Array.from(CSS.highlights.keys())) {
    if (name.startsWith(HIGHLIGHT_NAME) && !byName.has(name)) CSS.highlights.delete(name);
  }
}

export function paintPageHighlights(
  pageNumber: number,
  container: HTMLElement,
  annotations: Annotation[],
): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const { nodes } = walkLayer(container);
  const ranges: Range[] = [];
  const names: string[] = [];
  for (const annotation of annotations) {
    if (annotation.endChar <= annotation.startChar) continue;
    const from = nodeAndOffset(nodes, annotation.startChar);
    const to = nodeAndOffset(nodes, annotation.endChar);
    if (!from || !to) continue;
    const range = new Range();
    range.setStart(from.node, from.at);
    range.setEnd(to.node, to.at);
    ranges.push(range);
    names.push(annotation.color ? ensureInkRule(annotation.color) : HIGHLIGHT_NAME);
  }
  painted.set(pageNumber, { ranges, names });
  repaint();
}

export function clearPageHighlights(pageNumber: number): void {
  if (!painted.delete(pageNumber)) return;
  repaint();
}

/**
 * The read-aloud wash. One range at a time across every mounted page, in its
 * own highlight name so it never mixes with saved annotations — the prose
 * path's wash and this one are the same colour by intent: the line being
 * read looks the same whichever format is speaking it.
 */
const TTS_NAME = "pdf-tts";
let ttsRange: Range | null = null;

const TTS_STYLE_ID = "pdf-tts-wash";

/**
 * The wash's shape and ink, as the one rule that paints it.
 *
 * It lives here rather than in the stylesheet because it is a setting the
 * reader can change at any moment, and `::highlight` has no element to hang an
 * inline style on. One element, rewritten in place: a rule per change would
 * leave the earlier ones matching alongside it.
 */
export function setTtsWashRule(body: string): void {
  let sheet = document.getElementById(TTS_STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = TTS_STYLE_ID;
    document.head.append(sheet);
  }
  const rule = `::highlight(${TTS_NAME}) { ${body} }`;
  if (sheet.textContent !== rule) sheet.textContent = rule;
}

function repaintTts() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (ttsRange === null) {
    CSS.highlights.delete(TTS_NAME);
  } else {
    CSS.highlights.set(TTS_NAME, new Highlight(ttsRange));
  }
}

/** Non-whitespace characters before `raw`, i.e. the offset's position in the
 *  whitespace-collapsed string. */
function compactAt(value: string, raw: number): number {
  let count = 0;
  for (let at = 0; at < raw && at < value.length; at += 1) {
    if (!/\s/.test(value[at]!)) count += 1;
  }
  return count;
}

/** The value with every whitespace run removed, plus a map from each
 *  surviving character back to its raw offset. */
function collapse(value: string): { compact: string; map: number[] } {
  const map: number[] = [];
  let compact = "";
  for (let at = 0; at < value.length; at += 1) {
    const ch = value[at]!;
    if (!/\s/.test(ch)) {
      map.push(at);
      compact += ch;
    }
  }
  return { compact, map };
}

/** Locates `needle` in the layer's joined text and resolves the span
 *  `from..to` (offsets inside the needle) to real layer offsets.
 *
 *  The spoken text comes from the extraction pipeline, the layer from pdf.js's
 *  own: the two disagree on whitespace (pdf.js emits one space per text item)
 *  and occasionally on reading order. An exact match is tried first; the
 *  fallback compares with every whitespace run collapsed, carrying `from..to`
 *  across the collapse on both sides. */
export function locateLayerText(
  container: HTMLElement,
  needle: string,
  from: number,
  to: number,
): { start: number; end: number } | null {
  if (needle.length === 0 || from < 0 || to > needle.length || to <= from) return null;
  const { text } = walkLayer(container);
  const direct = text.indexOf(needle);
  if (direct >= 0) return { start: direct + from, end: direct + to };
  const layer = collapse(text);
  const mark = collapse(needle);
  if (mark.compact.length === 0) return null;
  const hit = layer.compact.indexOf(mark.compact);
  if (hit < 0) return null;
  const start = layer.map[hit + compactAt(needle, from)];
  const lastChar = layer.map[hit + compactAt(needle, to) - 1];
  if (start === undefined || lastChar === undefined) return null;
  return { start, end: lastChar + 1 };
}

/** Paints the read-aloud wash over real layer offsets and brings the line
 *  into view. `nearest` never yanks a visible line, matching the prose
 *  path's follow behaviour; word-level repaints therefore don't jitter. */
export function paintTtsWash(container: HTMLElement, start: number, end: number): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const { nodes, text } = walkLayer(container);
  const from = nodeAndOffset(nodes, Math.max(0, Math.min(start, text.length)));
  const to = nodeAndOffset(nodes, Math.max(0, Math.min(end, text.length)));
  if (!from || !to) return;
  const range = new Range();
  range.setStart(from.node, Math.min(from.at, from.node.length));
  range.setEnd(to.node, Math.min(to.at, to.node.length));
  ttsRange = range;
  repaintTts();
  range.startContainer.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Drops the read-aloud wash — the voice stopped, or its page unmounted. */
export function clearTtsWash(): void {
  if (ttsRange === null) return;
  ttsRange = null;
  repaintTts();
}

/**
 * Search-hit markers: the same idea as the read-aloud wash, one page at a
 * time and many ranges at once. The layer is located per hit from the hit's
 * own snippet (`searchHitNeedle`), because the offset the backend stores
 * counts the extraction pipeline's text, not the layer's — the words are the
 * only shared coordinates.
 *
 * One dynamic rule when the reader picked a custom ink, a static accent rule
 * otherwise; the ranges live per page like the annotations above, so a scroll
 * layout paints every mounted page without them fighting over one name.
 */
const SEARCH_NAME = "pdf-search";
const SEARCH_STYLE_ID = "pdf-search-ink";
const searchPainted = new Map<number, Range[]>();
let searchInk: string | null = null;

function ensureSearchRule(color: string): string {
  const name = `pdf-search-${color.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
  let sheet = document.getElementById(SEARCH_STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = SEARCH_STYLE_ID;
    document.head.append(sheet);
  }
  const rule = `::highlight(${name}) { background-color: ${inkWash(color, 0.25)} }`;
  if (!sheet.textContent?.includes(rule)) sheet.append(rule);
  return name;
}

function repaintSearch() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const name = searchInk ? ensureSearchRule(searchInk) : SEARCH_NAME;
  CSS.highlights.set(name, new Highlight(...[...searchPainted.values()].flat()));
  // One ink at a time: a name this repaint no longer uses would keep painting
  // the ranges it was built with, in the ink the reader just left.
  for (const key of Array.from(CSS.highlights.keys())) {
    if (key.startsWith("pdf-search") && key !== name) CSS.highlights.delete(key);
  }
}

/** One hit to paint: `text`/`from`/`to` come from `searchHitNeedle`; `key` is
 *  what a focus request names (`chapterIdx:offset`). */
export interface PdfSearchMark {
  key: string;
  text: string;
  from: number;
  to: number;
}

/**
 * Paints the page's search hits; the one whose key matches `focusKey` — a
 * result the reader just clicked — is also brought into view. Returns whether
 * that happened, so the caller can consume the request: a zoom re-render
 * would otherwise yank the reader back to the hit over and over.
 */
export function paintPageSearchHits(
  pageNumber: number,
  container: HTMLElement,
  marks: PdfSearchMark[],
  focusKey: string | null,
  ink: string | null,
): boolean {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return false;
  const { nodes } = walkLayer(container);
  const ranges: Range[] = [];
  let focused = false;
  for (const mark of marks) {
    const at = locateLayerText(container, mark.text, mark.from, mark.to);
    if (!at) continue;
    const from = nodeAndOffset(nodes, at.start);
    const to = nodeAndOffset(nodes, at.end);
    if (!from || !to) continue;
    const range = new Range();
    range.setStart(from.node, Math.min(from.at, from.node.length));
    range.setEnd(to.node, Math.min(to.at, to.node.length));
    ranges.push(range);
    if (!focused && focusKey !== null && mark.key === focusKey) {
      focused = true;
      range.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }
  searchPainted.set(pageNumber, ranges);
  searchInk = ink;
  repaintSearch();
  return focused;
}

/** Clears one page's markers — it unmounted, or the query moved on. */
export function clearPageSearchHits(pageNumber: number): void {
  if (!searchPainted.delete(pageNumber)) return;
  repaintSearch();
}

/** Clears every page's markers — the drawer closed, or the query emptied. */
export function clearAllSearchHits(): void {
  if (searchPainted.size === 0) return;
  searchPainted.clear();
  repaintSearch();
}
