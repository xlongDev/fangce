import { useEffect, useRef, useState } from "react";
import CloudLayout, { type PlacedSprite } from "d3-cloud";
import { ArrowsOut } from "@phosphor-icons/react";

import { GlassIconButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";
import type { WordCount } from "@/types/ipc";

/** Data carried through d3-cloud's sprite pipeline: the source word and its count. */
interface CloudDatum {
  text: string;
  count: number;
}

/** A placed word as d3-cloud 2 returns it, carrying our datum back out. */
type CloudWord = PlacedSprite<CloudDatum, never>;

/**
 * A word cloud: d3-cloud lays it out, a canvas paints it.
 *
 * The layout is seeded rather than random. d3-cloud picks its spiral start from
 * `Math.random`, so an unseeded layout reshuffles the same book into a different
 * picture every time the panel reopens — which reads as the numbers having
 * changed. Same words in, same picture out.
 *
 * Colour is the inherited text colour with weight-mapped alpha, so it is legible
 * on both themes without a second palette to keep in step, and the biggest word
 * is the darkest — the only encoding a word cloud has room for.
 */
export function WordcloudCanvas({
  words,
  compact = false,
}: {
  words: WordCount[];
  compact?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas || words.length === 0) return;

    const width = box.clientWidth || 280;
    const height = box.clientHeight || 200;
    const counts = words.map((word) => word.count);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    // Area, not height: a word twice as frequent reads as twice as big only when
    // the *size* grows by the square root.
    const sizeFor = (count: number) => {
      const span = compact ? 22 : 52;
      const floor = compact ? 10 : 14;
      if (max === min) return floor + span / 2;
      return floor + span * Math.sqrt((count - min) / (max - min));
    };

    const style = getComputedStyle(canvas);
    const font = style.fontFamily || "system-ui";
    const colour = style.color || "#888";

    // d3-cloud 2 replaces the factory/event API with a class and explicit
    // sprite placement. Reproduce v1's behaviour: bounded to the box, seeded
    // for a stable picture, largest words first, all horizontal.
    const layout = new CloudLayout().size([width, height]).overflow(false).random(seeded(7));

    const prepared = words
      .map((word) => ({
        datum: { text: word.word, count: word.count },
        size: Math.max(1, Math.round(sizeFor(word.count))),
      }))
      // v1 sorted by descending font size; v2 places in input order, so sort here.
      .toSorted((a, b) => b.size - a.size);

    const placed: CloudWord[] = [];
    for (const word of prepared) {
      const sprite = layout.getSprite(word.datum.text, {
        datum: word.datum,
        font,
        size: word.size,
        rotate: 0,
        padding: compact ? 1 : 2,
      });
      if (!sprite) continue;
      const result = layout.place(sprite);
      if (result) placed.push(result as CloudWord);
    }

    paint(canvas, placed, width, height, colour, font, max, min);
  }, [words, compact]);

  return (
    <div ref={boxRef} className={cn("w-full", compact ? "h-[150px]" : "h-full min-h-[220px]")}>
      <canvas ref={canvasRef} className="text-text-2 h-full w-full" aria-label="词云图" />
    </div>
  );
}

/** The inline cloud, with a way to see it bigger. */
export function WordcloudView({
  words,
  compact = false,
}: {
  words: WordCount[];
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (words.length === 0) return null;

  return (
    <>
      <div className="relative">
        <WordcloudCanvas words={words} compact={compact} />
        <GlassIconButton
          size="sm"
          variant="subtle"
          label="放大词云"
          onClick={() => setOpen(true)}
          className="absolute top-1 right-1"
        >
          <ArrowsOut size={13} />
        </GlassIconButton>
      </div>

      <GlassDialog
        open={open}
        onOpenChange={setOpen}
        title={`词云 · ${words.length} 个词`}
        widthClass="w-[min(94vw,900px)]"
      >
        <div className="h-[58vh]">
          <WordcloudCanvas words={words} />
        </div>
      </GlassDialog>
    </>
  );
}

/** A small LCG. Enough to make the layout reproducible, not a cipher. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Draws the placed words, scaled for the device pixel ratio. */
function paint(
  canvas: HTMLCanvasElement,
  placed: CloudWord[],
  width: number,
  height: number,
  colour: string,
  font: string,
  max: number,
  min: number,
) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = colour;

  for (const word of placed) {
    const weight = max === min ? 1 : (word.datum.count - min) / (max - min);
    context.save();
    context.translate(word.x + width / 2, word.y + height / 2);
    context.rotate(((word.rotate ?? 0) * Math.PI) / 180);
    context.globalAlpha = 0.45 + 0.55 * weight;
    context.font = `${weight > 0.55 ? 600 : 400} ${Math.round(word.size)}px ${font}`;
    context.fillText(word.text, 0, 0);
    context.restore();
  }
}
