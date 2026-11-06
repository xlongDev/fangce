/**
 * AI answers as read-aloud units.
 *
 * The engine only ever asked for `string[]` (`useTts::play`), and an AI answer
 * is fed exactly like a chapter: **one unit per sentence, cut by
 * `speechUnits`**. Three attempts to be cleverer than that — one clip per
 * heading/bullet, then a whole answer in one 900-character clip, then 120-
 * character clips — each made Edge slower than the book's own sentences and
 * ran long requests into `tts.rs`'s 30-second timeout. Reuse the book's cutter
 * and stop tuning the size.
 *
 * What *is* special is the text: Markdown markers, fenced code, citation
 * indices and mind-map trees are fine on screen and nonsense spoken aloud.
 * The block parser is `Markdown.tsx::parseBlocks`, the reader's only AI
 * Markdown parser, already written to survive half-finished input.
 *
 * The map from a clip's character offsets back to display blocks exists only
 * for `AiSpeechText`'s wash; nothing here knows about React.
 */

import { parseBlocks, type Block } from "@/components/common/Markdown";

import { speechUnits, type SpeechUnit } from "./speech";

/** Mirrors `src-tauri/src/tts.rs::MAX_TEXT_CHARS`. A sentence longer than this
 *  would be refused outright, so cut it here instead of sending it. */
export const AI_SPEECH_MAX_CHARS = 1_000;

const FENCE = /^\s*```/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_RULE = /^\s*\|?[\s:|-]+\|?\s*$/;

const IMAGES = /!\[[^\]]*\]\([^)]*\)/g;
const LINKS = /\[([^\]]+)\]\([^)]*\)/g;
const BOLD = /\*\*([^*]+)\*\*/g;
const CODE = /`([^`]+)`/g;
const CITATIONS = /\[(?:citation:)?\d+\]/gi;
const TAGS = /<\/?[A-Za-z][^>]*>/g;

/**
 * Drops what would be read as punctuation: fenced code, horizontal rules and
 * table separators. Structure markers (`##`, `- `, `> `) are kept — the block
 * parser still needs them to know where one display run ends and the next
 * begins.
 */
function readableLines(source: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of source.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || RULE.test(line) || TABLE_RULE.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

/** Inline markup the eye skips and a voice would spell out. */
function cleanInline(text: string): string {
  return text
    .replace(IMAGES, "")
    .replace(LINKS, "$1")
    .replace(BOLD, "$1")
    .replace(CODE, "$1")
    .replace(CITATIONS, "")
    .replace(TAGS, "")
    .trim();
}

/** One display block of an answer, cleaned of markup and ready to show. */
export interface AiSpeechRun {
  kind: Block["kind"];
  /** Heading depth; 0 for every other kind. */
  level: number;
  /** One-based list position, or `null` when this run is not a list item. */
  order: number | null;
  /** Whether the list this item came from was numbered. */
  ordered: boolean;
  /** What the panel draws and the voice says — the same string, so a spoken
   *  character offset can be laid straight back onto the displayed text. */
  text: string;
}

/** Where one piece of a display block sits inside a spoken clip. */
export interface AiSpeechSegment {
  /** Index into `AiSpeechLayout.runs`. */
  run: number;
  /** Half-open range inside that run's text. */
  from: number;
  to: number;
  /** Start of this piece inside `units[i].text`. Zero: one sentence per clip. */
  at: number;
}

export interface AiSpeechLayout {
  runs: readonly AiSpeechRun[];
  units: SpeechUnit[];
  /** `segments[i]` maps character offsets inside `units[i].text` back to runs. */
  segments: readonly (readonly AiSpeechSegment[])[];
}

/**
 * The answer as display blocks. Bold and inline code lose their styling here
 * (their markers do), which is the price of one string serving both the eye
 * and the voice: a wash measured against spoken characters would drift by
 * every `**` the panel kept.
 */
export function aiSpeechRuns(source: string): AiSpeechRun[] {
  const runs: AiSpeechRun[] = [];
  for (const block of parseBlocks(readableLines(source).join("\n"))) {
    const push = (
      kind: Block["kind"],
      text: string,
      level = 0,
      order: number | null = null,
      ordered = false,
    ) => {
      const clean = cleanInline(text);
      if (clean !== "") runs.push({ kind, level, order, ordered, text: clean });
    };
    if (block.kind === "list") {
      for (const item of block.items) push("list", item.text, 0, item.order + 1, block.ordered);
    } else if (block.kind === "heading") {
      push("heading", block.text, block.level);
    } else {
      push(block.kind, block.text);
    }
  }
  return runs;
}

/** A piece of one run, cut at a sentence boundary and small enough to speak. */
interface Part {
  run: number;
  from: number;
  to: number;
  text: string;
}

/** Only the service's hard cap can force a cut mid-sentence. */
function cutLong(text: string, from: number, run: number): Part[] {
  if (text.length <= AI_SPEECH_MAX_CHARS) return [{ run, from, to: from + text.length, text }];
  const parts: Part[] = [];
  let rest = text;
  let cursor = from;
  while (rest.length > 0) {
    let take = Math.min(rest.length, AI_SPEECH_MAX_CHARS);
    if (rest.length > AI_SPEECH_MAX_CHARS) {
      const head = rest.slice(0, take);
      const boundary = Math.max(
        ...["。", "！", "？", "，", "；", "、", " ", ".", ",", ";"].map((mark) =>
          head.lastIndexOf(mark),
        ),
      );
      if (boundary > Math.floor(AI_SPEECH_MAX_CHARS * 0.6)) take = boundary + 1;
    }
    const piece = rest.slice(0, take);
    parts.push({ run, from: cursor, to: cursor + piece.length, text: piece });
    cursor += take;
    rest = rest.slice(take);
  }
  return parts;
}

/** Every run, split by the same sentence cutter the book uses. */
function partsOf(runs: readonly AiSpeechRun[]): Part[] {
  const parts: Part[] = [];
  runs.forEach((run, index) => {
    for (const unit of speechUnits([{ index, text: run.text }])) {
      parts.push(...cutLong(unit.text, unit.start, index));
    }
  });
  return parts;
}

/**
 * One unit per sentence — byte for byte the shape `useReadAloud` hands the
 * engine for a chapter. `segments` is kept so the wash can map a spoken
 * offset back onto the displayed block; with one sentence per clip it is a
 * one-element list.
 */
export function aiSpeechLayout(source: string): AiSpeechLayout {
  const runs = aiSpeechRuns(source);
  const units: SpeechUnit[] = [];
  const segments: AiSpeechSegment[][] = [];
  for (const part of partsOf(runs)) {
    units.push({ text: part.text, source: part.run, start: part.from, end: part.to });
    segments.push([{ run: part.run, from: part.from, to: part.to, at: 0 }]);
  }
  return { runs, units, segments };
}

/** The queue for one answer. Empty when there is nothing worth speaking. */
export function aiSpeechUnits(source: string): SpeechUnit[] {
  return aiSpeechLayout(source).units;
}

export interface AiSpeechSpan {
  run: number;
  start: number;
  end: number;
}

/**
 * A range of one clip's text, expressed as ranges inside the display runs.
 */
export function aiSpeechSpans(
  layout: AiSpeechLayout,
  unit: number,
  from: number,
  to: number,
): AiSpeechSpan[] {
  const pieces = layout.segments[unit];
  if (!pieces || to <= from) return [];
  const spans: AiSpeechSpan[] = [];
  for (const piece of pieces) {
    const a = Math.max(from, piece.at);
    const b = Math.min(to, piece.at + piece.to - piece.from);
    if (b <= a) continue;
    spans.push({
      run: piece.run,
      start: piece.from + (a - piece.at),
      end: piece.from + (b - piece.at),
    });
  }
  return spans;
}
