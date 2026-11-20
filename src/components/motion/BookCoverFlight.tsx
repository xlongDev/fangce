import { useEffect, useState } from "react";

import { useMotion } from "@/lib/motion";
import { useBookHandoff, type CoverBox } from "@/stores/book-handoff";

/**
 * The cover carried from the shelf into the reader.
 *
 * A page-level shared element, done as a `fixed` overlay rather than a shared
 * `layoutId`: a layout animation moves its element with a transform and leaves
 * it where it was in the DOM, so the tile's own `overflow: hidden` would slice
 * the cover as it left. This layer sits in the shell, outside every route, so
 * the route cross-fade (which blurs and scales the page it is leaving) does not
 * drag it along either.
 *
 * It renders in the overlay host, so `fixed` means the window.
 */
export function BookCoverFlight() {
  const m = useMotion();
  const id = useBookHandoff((s) => s.id);
  const coverUrl = useBookHandoff((s) => s.coverUrl);
  const from = useBookHandoff((s) => s.from);
  const to = useBookHandoff((s) => s.to);
  const end = useBookHandoff((s) => s.end);

  // Nobody is going to fly this one: reduced motion, or a handoff that never
  // got an origin. Both ends hide their own cover for as long as `id` matches
  // theirs, so a handoff left set this way would keep a cover hidden for the
  // rest of the session — it is cleared rather than left waiting for a landing.
  const grounded = m.reduce || from === null;
  useEffect(() => {
    if (grounded && id !== null) end();
  }, [grounded, id, end]);

  if (grounded || id === null) return null;

  // A fresh mount per flight, keyed by book: the launcher inside has to start
  // from "not launched" every time, and this component itself stays mounted
  // for the life of the app.
  return <Flight key={id} coverUrl={coverUrl} from={from} to={to} onDone={end} />;
}

/**
 * How long a flight waits for somewhere to land before leaving without one.
 *
 * The far end registers its box as it mounts, a frame or two after this layer
 * does. Leaving in the meantime means leaving toward the *dissolve* box — up
 * and 16% larger — and the real box then arrives and turns the cover around in
 * mid-air (measured: scale 1.09 at y −25, then reversing to 0.2 at y −298). It
 * also re-targets the transition, and a re-targeted transition starts its
 * duration again, which parked the cover on the header for a further 350ms
 * after it had visibly arrived. Waiting a beat costs a frame nobody can see.
 */
const DISSOLVE_AFTER = 200;

function Flight({
  coverUrl,
  from,
  to,
  onDone,
}: {
  coverUrl: string | null;
  from: CoverBox;
  to: CoverBox | null;
  onDone: () => void;
}) {
  /**
   * The frame this layer starts moving is the last frame the pad may aim at it.
   *
   * Marked in the store *in the same callback* that starts the transform, so the
   * pad's own frame — which reads the flag straight from the store — cannot land
   * one report after the transition is under way. A report after that is a new
   * end value, and a transition whose target changes restarts its duration.
   */
  const markLaunched = useBookHandoff((s) => s.markLaunched);

  // Launch on the frame *after* there is somewhere to fly to: the browser needs
  // the "at the shelf" transform committed *and painted* to transition from, or
  // it snaps straight to the end. A fresh `to` restarts that wait, which is what
  // keeps the aim on a destination that is still settling — see `useLandingBox`.
  const [launched, setLaunched] = useState(false);
  useEffect(() => {
    if (to === null) return;
    const frame = requestAnimationFrame(() => {
      markLaunched();
      setLaunched(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [to, markLaunched]);

  // ...but not forever. A cold route chunk can take longer than the gesture
  // reads as connected, and a book with no cover never registers a landing at
  // all; either way the cover lifts and dissolves rather than hovering. Setting
  // an already-true state is a no-op, so this is safe to run unconditionally.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      markLaunched();
      setLaunched(true);
    }, DISSOLVE_AFTER);
    return () => window.clearTimeout(timer);
  }, [markLaunched]);

  // Without a landing box the cover still has to leave: a cold route chunk can
  // take longer than the gesture reads as connected, and a book with no cover
  // never registers one. It lifts and dissolves instead of hovering forever.
  //
  // It keeps the corner it left with, in every direction. The landing not
  // needing anything of its own is not an oversight: the only box a flight
  // lands in is the header thumbnail, 27x36, whose radii already clamp to half
  // its width — a 14px and an 18px corner paint the identical shape there
  // (hit-tested: 859 px of the 972 pixel-identical either way). And on the way
  // back the shelf tile stays hidden until the flight has dissolved, so it is
  // never seen next to a corner of its own.
  const landing: CoverBox = to ?? {
    x: from.x - from.w * 0.08,
    y: from.y - 44,
    w: from.w * 1.16,
    h: from.h * 1.16,
    radius: from.radius,
  };

  /**
   * Whether this flight is the one with nowhere to land — the only case that
   * fades.
   *
   * A flight with a landing is still the only cover on screen when it arrives,
   * so fading it out before it gets there is what made the cover read as
   * *redrawn* rather than handed over: it dimmed to nothing in the last 180 ms
   * of travel and the destination then faded back up from zero (measured: the
   * flight at 0.04 opacity while the tile's own cover sat at 0, then a 300 ms
   * ramp). It stays solid to the last frame instead, and the destination takes
   * over in the same commit — same picture, same box, same corner, so the swap
   * is invisible. A flight with nowhere to go has no such handover and still
   * has to leave some other way.
   */
  const dissolving = to === null;

  /**
   * Travel by transform, and by a CSS transition rather than a JS-driven one.
   *
   * Two things this buys, both measured:
   *
   * 1. **No per-frame layout.** The first version animated
   *    `left/top/width/height`, which recalculated style and laid the element
   *    out again on every frame — 35 layouts and 35 style recalcs for a single
   *    flight, each one re-rasterizing the cover at a new size. That is why a
   *    large EPUB cover stuttered where the small PNG pdf.js renders for a PDF
   *    did not.
   * 2. **The compositor owns it.** A JS-driven animation needs the main thread
   *    every frame, and the main thread is exactly what the reader is using to
   *    build its chapter at that moment — so the cover froze precisely when the
   *    reader was heaviest. A CSS transition keeps the flight running on the
   *    compositor regardless, and re-targets on its own if the reader
   *    registers its landing box mid-flight.
   */
  /**
   * The layer is laid out at the *larger* of the two boxes and scaled down to
   * the origin, never up to it.
   *
   * A layer keeps the raster it was painted with and stretches it, so sizing
   * this one like the cover it starts from made the way home a 5x upscale: the
   * header's 27x36 thumbnail of pixels spread over the 138x184 tile, soft for
   * the whole flight and snapping sharp the instant the tile's own cover (a
   * real `<img>` laid out at its full size) took over. Laid out at the big end
   * instead, the raster is the size the cover is ever seen at, and the small
   * end is a downscale — which stays crisp. The corner scales with it, so the
   * proportions `CoverBox.radius` asks for are unchanged.
   */
  const maxW = Math.max(from.w, to?.w ?? from.w);
  const maxH = Math.max(from.h, to?.h ?? from.h);

  return (
    <div
      data-cover-flight
      // Which of the three states this flight is in, and the only one of them
      // an observer can see: this layer mounts *before* it has anywhere to
      // land, so "the element exists" is not "the flight has left". Written on
      // the same commit that starts the transition, so reading it needs no
      // frame to be delivered — which is what makes it usable from a test on a
      // runner that hands out a frame every 200ms.
      data-flight-phase={launched ? (dissolving ? "dissolving" : "landing") : "aiming"}
      // And where it is going, because that is the one thing about a flight that
      // cannot be measured off the screen: the travel is a CSS transition. Where
      // the cover *is* is the compositor's answer and only arrives with a frame;
      // where it is *aimed* is this number, written where it is decided. A test
      // that reads this asks the app what it decided; one that reads the rect
      // asks a runner painting five frames a second to have painted the right
      // one.
      data-flight-landing-x={landing.x}
      data-flight-landing-y={landing.y}
      className="shadow-panel pointer-events-none fixed z-[70] overflow-hidden"
      style={{
        left: from.x,
        top: from.y,
        width: maxW,
        height: maxH,
        // The corner of the cover it left, not one of its own: see `CoverBox`.
        // In the layer's own units, so that `scale` lands it on that value.
        borderRadius: from.radius * (maxW / from.w),
        // Scaling from the corner makes the offsets plain deltas.
        transformOrigin: "top left",
        willChange: "transform, opacity",
        transform: launched
          ? `translate(${landing.x - from.x}px, ${landing.y - from.y}px) scale(${landing.w / maxW}, ${landing.h / maxH})`
          : `translate(0px, 0px) scale(${from.w / maxW}, ${from.h / maxH})`,
        opacity: launched && dissolving ? 0 : 1,
        // The travel is the transition, on `--ease-land` rather than the house
        // `--ease-out` — the difference is entirely in the last third, and the
        // reasoning is on the token. Only a dissolve fades, and the fade tidies
        // its last third so the cover is still solid while it lifts.
        transition: dissolving
          ? `transform var(--dur-flight) var(--ease-land), opacity 200ms var(--ease-out) 240ms`
          : `transform var(--dur-flight) var(--ease-land)`,
      }}
      onTransitionEnd={(event) => {
        if (event.propertyName === "transform") onDone();
      }}
    >
      {coverUrl && (
        <img src={coverUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      )}
    </div>
  );
}
