import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";

interface MarqueeTextProps {
  children: ReactNode;
  className?: string;
  /** Which slot this is, so tests can tell a title from an author line. */
  kind?: string;
  /** Full text for the tooltip when the painted string is shortened. */
  title?: string;
}

/** Seconds held at each end of the slide before it turns around. */
const PAUSE_SECONDS = 1.2;

/** Pixels per second the name travels. */
const SPEED = 60;

/** Both edges fade rather than clip — a hard right edge made the last
 *  character look sliced as it arrived. */
const MASK =
  "linear-gradient(to right, transparent, black 8px, black calc(100% - 8px), transparent)";

/**
 * Text that scrolls horizontally on hover when its content overflows.
 *
 * The shelf tile's author line is where this earns its keep: a long name is
 * otherwise ellipsised and invisible, and a tooltip is too far from the eye
 * to bother with. A name that fits on one line stays a plain ellipsis — the
 * measured overflow is zero and nothing ever moves.
 *
 * **The measuring refs live in the always-rendered branch on purpose.** The
 * first version returned a bare `<span className="truncate">` when the
 * overflow was zero and only attached `outerRef`/`innerRef` on the scrolling
 * branch — but `overflow` starts at zero, so the refs were never attached, so
 * the measurement that would have raised it above zero could never run. The
 * marquee was dead code: every long name silently stayed truncated. One
 * render path now, with the classes carrying the difference.
 *
 * `prefers-reduced-motion` disables the scroll outright, so a reader who asked
 * for less motion never sees it.
 */
export function MarqueeText({ children, className, kind, title }: MarqueeTextProps) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const measure = () => {
      const outer = outerRef.current;
      const inner = innerRef.current;
      if (!outer || !inner) return;
      // While the name still truncates, `scrollWidth` is the whole line and
      // `clientWidth` the slot — their difference is exactly what the slide
      // has to cover. Once it is `w-max` the two are equal, and the sum is the
      // same number, so this settles rather than oscillating.
      setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (outerRef.current) ro.observe(outerRef.current);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, []);

  const scrolling = overflow > 0 && !reduce;
  // Floor at 1.5 s: a short overflow that scrolls at 60 px/s feels snappy
  // rather than twitchy, while a 240 px name takes 4 s and reads naturally.
  const slideSeconds = Math.max(1.5, overflow / SPEED);

  return (
    <span
      ref={outerRef}
      // A hook for the test that guards the dead-code failure above: the
      // difference between the two branches is a class name and a mask, and
      // neither survives a `getByRole` or a text match.
      data-marquee
      data-marquee-kind={kind}
      title={title}
      className={cn("block overflow-hidden", className)}
      // The mask would fade the ellipsis itself on a name that fits, so it is
      // only there while there is something to slide.
      style={scrolling ? { maskImage: MASK, WebkitMaskImage: MASK } : undefined}
    >
      <motion.span
        ref={innerRef}
        // `truncate` while it fits — a block, so it takes the slot's width and
        // has something to ellipsise against; `w-max` once it scrolls, so the
        // span is as wide as the name instead of as wide as the slot.
        className={cn("block whitespace-nowrap", scrolling ? "w-max" : "truncate")}
        initial={false}
        animate={{ x: 0 }}
        whileHover={scrolling ? { x: -overflow } : undefined}
        // `repeatType: "reverse"` flips the direction each iteration, so the
        // same transition handles both legs of the round-trip. Leaving hover
        // re-targets `animate` and the text eases back to 0 on the same
        // curve — the marquee never snaps.
        transition={{
          duration: slideSeconds,
          ease: [0.5, 0, 0.5, 1],
          repeat: Infinity,
          repeatType: "reverse",
          repeatDelay: PAUSE_SECONDS,
        }}
      >
        {children}
      </motion.span>
    </span>
  );
}
