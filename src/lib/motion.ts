import { useMemo } from "react";
import { useReducedMotion, type Transition } from "motion/react";

/**
 * The app's motion vocabulary.
 *
 * Before this module the UI carried seven different spring specs and as many
 * durations, which read as seven different apps stitched together. Everything
 * that moves now names one of these instead.
 *
 * Two rules the numbers encode:
 *
 * - **Spatial changes are springs.** Position, size and scale read as physical
 *   only if they behave physically, and a spring that is interrupted carries
 *   its velocity into the next one instead of restarting from rest.
 * - **Non-spatial changes are durations.** A spring on opacity or colour only
 *   adds latency; there is nothing to overshoot.
 *
 * Damping ratios sit between 0.73 and 0.85 — enough overshoot to feel alive,
 * far short of a toy. The `--ease-*` and `--blur-*` tokens in `globals.css`
 * are the same vocabulary for the CSS-driven animations (page turns, the heat
 * map), which cannot reach a spring.
 */
export const SPRING = {
  /** Anything under the finger: fast, tight, a hint of overshoot. */
  tap: { type: "spring", stiffness: 560, damping: 28, mass: 0.6 },
  /** Something that appears where the eye already is — no travel to absorb. */
  enter: { type: "spring", stiffness: 420, damping: 30 },
  /** Panels, popovers, dialogs: heavier, settles without a wobble. */
  panel: { type: "spring", stiffness: 340, damping: 30 },
  /** Shared-layout moves, where an element travels a real distance. */
  layout: { type: "spring", stiffness: 400, damping: 34 },
} satisfies Record<string, Transition>;

export const DURATION = {
  /** Opacity and colour micro-changes. */
  fast: 0.15,
  /** Scrims and cross-fades. */
  base: 0.22,
  /** Content that fades in on its own. */
  slow: 0.34,
} as const;

/**
 * The stagger between siblings entering together, and the point at which it
 * stops growing. Capped on purpose: an uncapped stagger over a 200-book shelf
 * spends six seconds finishing an entrance nobody is still watching.
 */
export const STAGGER = { step: 0.035, cap: 8 } as const;

/** How far content rises as it enters, in px. */
export const RISE = 10;

/** Mirrors `--ease-out` in `globals.css`, for the few places that need the
 *  curve as a value rather than a class. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Mirrors `--ease-land` in `globals.css`: travel that has to arrive rather
 *  than drift in. Shared so the JS-driven icon swaps can use the same landing
 *  curve the CSS-driven nudges do. */
export const EASE_LAND: [number, number, number, number] = [0.33, 1, 0.68, 1];

export interface MotionVocabulary {
  tap: Transition;
  enter: Transition;
  panel: Transition;
  layout: Transition;
  /** Rise distance for an entrance, and the stagger step between siblings.
   *  Both collapse to 0 under reduced motion. */
  rise: number;
  stagger: number;
  /** True when the OS asks for less motion. Read it to drop decorative
   *  flourishes that have no informational job. */
  reduce: boolean;
}

/**
 * The vocabulary with reduced motion already folded in.
 *
 * Under `prefers-reduced-motion` every spring becomes an instant swap and
 * every entrance loses its travel: opacity still cross-fades, because a hard
 * cut between two states is its own kind of jarring, but nothing slides or
 * scales. Components read this instead of calling `useReducedMotion` and
 * inventing a fallback each.
 */
export function useMotion(): MotionVocabulary {
  const reduce = useReducedMotion();
  return useMemo(
    () =>
      reduce
        ? {
            tap: { duration: 0 },
            enter: { duration: 0 },
            panel: { duration: 0 },
            layout: { duration: 0 },
            rise: 0,
            stagger: 0,
            reduce: true,
          }
        : { ...SPRING, rise: RISE, stagger: STAGGER.step, reduce: false },
    [reduce],
  );
}

/**
 * The entrance delay for the `index`-th sibling of a staggered group. Capped,
 * so a long list finishes together rather than trickling in.
 */
export function staggerDelay(index: number, stagger: number): number {
  return Math.min(index, STAGGER.cap) * stagger;
}
