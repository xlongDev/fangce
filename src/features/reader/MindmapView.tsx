import { useEffect, useRef, useState } from "react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { ArrowsOut } from "@phosphor-icons/react";

import { GlassIconButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { cn } from "@/lib/cn";

/** Parsing the same Markdown twice is pure cost, and a conversation may redraw
 *  the same map on every render. */
const transformer = new Transformer();

/**
 * The map itself, drawn by markmap.
 *
 * The colours come from `currentColor` rather than from markmap's own defaults:
 * its stylesheet ships a light palette (`#333` text) and switches to a dark one
 * on `prefers-color-scheme`, which this app does not use — it has its own theme
 * switch, so a reader on the light theme with a dark OS would get dark text on a
 * white card, and vice versa. `currentColor` makes the map inherit whatever the
 * surrounding text is, which is correct by construction.
 *
 * `compact` is the inline preview in the drawer: fewer levels expanded and
 * smaller type, because a 320px column cannot show a whole map legibly.
 */
export function MindmapCanvas({
  markdown,
  compact = false,
}: {
  markdown: string;
  compact?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const { root } = transformer.transform(markdown);
    const map = Markmap.create(
      svg,
      {
        // No entry animation: this mounts inside a drawer that is already
        // animating, and two motions on one gesture read as a stutter.
        duration: 0,
        autoFit: true,
        scrollForPan: false,
        paddingX: compact ? 4 : 12,
        spacingVertical: compact ? 6 : 10,
        spacingHorizontal: compact ? 40 : 70,
        initialExpandLevel: compact ? 2 : -1,
        maxWidth: compact ? 160 : 260,
      },
      root,
    );

    return () => map.destroy();
  }, [markdown, compact]);

  return (
    <svg
      ref={svgRef}
      // `markmap` is the class its stylesheet keys on; the inline custom
      // properties below override the palette it would otherwise apply.
      className={cn("markmap text-text-2 h-full w-full", compact ? "text-[11px]" : "text-[13px]")}
      style={
        {
          "--markmap-text-color": "currentColor",
          "--markmap-circle-open-bg": "transparent",
          "--markmap-code-bg": "transparent",
          "--markmap-code-color": "currentColor",
          "--markmap-font": compact
            ? "400 11px/15px var(--font-sans, system-ui)"
            : "400 13px/18px var(--font-sans, system-ui)",
        } as React.CSSProperties
      }
      aria-label="思维导图"
    />
  );
}

/**
 * The inline map, with a way to see it bigger.
 *
 * The drawer is 320px wide and the row is 230px tall, which shows a map's shape
 * and none of its leaves. Markmap does its own zooming and folding, so the
 * enlarged view is the same component in a bigger box rather than a second
 * implementation.
 */
export function MindmapView({
  markdown,
  compact = false,
}: {
  markdown: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="relative h-full w-full">
        <MindmapCanvas markdown={markdown} compact={compact} />
        {compact ? (
          <GlassIconButton
            size="sm"
            variant="subtle"
            label="放大思维导图"
            onClick={() => setOpen(true)}
            className="absolute top-1 right-1"
          >
            <ArrowsOut size={13} />
          </GlassIconButton>
        ) : null}
      </div>

      <GlassDialog
        open={open}
        onOpenChange={setOpen}
        title="思维导图"
        widthClass="w-[min(94vw,1100px)]"
      >
        <div className="h-[70vh]">
          <MindmapCanvas markdown={markdown} />
        </div>
      </GlassDialog>
    </>
  );
}
