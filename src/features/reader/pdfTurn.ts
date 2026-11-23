import { bounds, createCurl, startCurl, type CurlShot, type CurlTurn } from "./pdfCurl";
import type { PageTransition } from "./theme";

/**
 * The page-turn animation for a paged PDF.
 *
 * A PDF page is one canvas that pdf.js keeps drawing into, so the page the
 * reader leaves is destroyed by the very render that brings the next one in —
 * there is no outgoing element left to animate. A turn has to copy the bitmap
 * out first and animate the copy: an overlay that rides over the page
 * arriving and is dropped once it has gone.
 *
 * This is the shape readest's captured turn takes — snapshot, navigate,
 * animate the snapshot out — with the expensive half removed. readest has to
 * ask the native webview for a screenshot (and pre-bake it, and budget for
 * it) because its page is live DOM; ours is already pixels, so the snapshot
 * is a synchronous `drawImage` and none of that orchestration exists.
 */
/** `--ease-out` from globals.css. WAAPI cannot read a custom property, so the
    curve is spelled out here; keep the two in step. */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** An expo-out spends most of its time crawling into the last few pixels: at
    300 ms the first frames had already crossed half the page, so the reader saw
    a middle-to-left jump instead of a right-to-left turn. */
const SLIDE_MS = 380;
const SLIDE_EASING = "cubic-bezier(0.42, 0, 0.58, 1)";

/** How far the sheet swings before it retires. Past ~90° its back would show,
    and a flat bitmap has none — it fades out on the way there instead. */
const FOLD_DEG = 88;

/** readest's Slide trailing edge: a static gradient, not a full-canvas blur
    (which rasterises a shadow around all four sides). */
const EDGE_SHADOW_PX = 28;

/**
 * CSS `border-radius` clips a canvas element but does not change its pixels.
 * Cut the corners out of the snapshot itself, so a renderer that samples the
 * bitmap — the WebGL curl above all — bends a rounded page rather than a
 * square one. `radius` is in the snapshot's own pixel space.
 */
function cutCorners(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  if (r <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** How long the mesh curl takes for one page, matching foliate's own curl
    keyframes. A spread bends the *whole* two-page sheet, so its duration is
    scaled by `verticalTurnMs` below. */
export const CURL_MS = 500;

/**
 * 翻牌(curl/fold)卷走的是整张 sheet：单页一页宽，双页是两页并集，行程翻倍。
 * 时长写死会让双页用同样的时间走两倍路 —— 线速度翻倍，看着就比单页快。
 * 按 sheet 宽 / 单页宽 缩放，双页与单页的纸面速度一致。
 * 500ms 是单页基准；pan/slide 本来就只走一个 pitch，不受影响。
 */
export function verticalTurnMs(sheetWidth: number, pageWidth: number): number {
  if (!(sheetWidth > 0) || !(pageWidth > 0)) return CURL_MS;
  return Math.round(CURL_MS * (sheetWidth / pageWidth));
}

export interface PdfTurn {
  frames: Keyframe[];
  duration: number;
  /** 左右平移: the live incoming page travels with the sheet, one strip. */
  push?: boolean;
  /** 覆盖: a 28px gradient rides the sheet's leading edge. */
  edgeShadow?: boolean;
  /** Overrides `--ease-out` when the travel itself has to stay visible. */
  easing?: string;
  /** The sheet swings about its own spine instead of the viewport edge. */
  fold?: boolean;
}

/**
 * The animation for one turn of the outgoing page, or `null` when the setting
 * asks for none. `dir` is the direction of travel: 1 forward, -1 back.
 *
 * The two horizontal turns mirror readest's `PagePushRenderer` and
 * `PageSlideRenderer`: both slide the captured outgoing sheet out of the book
 * box, but 左右平移 (Push) also translates the live incoming page in from the
 * opposite side so the two read as one strip of paper — no shadow, because
 * nothing overlaps — while 覆盖 (Slide) leaves it still underneath and trails
 * a 28px edge shadow on the moving sheet.
 *
 * `travel` is the width of the visible book box: a centred page turns by its
 * own width, not across the reader's margins.
 */
export function pdfTurn(mode: PageTransition, dir: 1 | -1, travel: number): PdfTurn | null {
  switch (mode) {
    case "pan":
      // readest Push: the sheet and the live page move as one strip.
      return {
        frames: [{ transform: "none" }, { transform: `translateX(${-dir * travel}px)` }],
        duration: SLIDE_MS,
        easing: SLIDE_EASING,
        push: true,
      };
    case "slide":
      // readest Slide: only the sheet moves; the live page waits underneath.
      return {
        frames: [{ transform: "none" }, { transform: `translateX(${-dir * travel}px)` }],
        duration: SLIDE_MS,
        easing: SLIDE_EASING,
        edgeShadow: true,
      };
    case "fade":
      return { frames: [{ opacity: 1 }, { opacity: 0 }], duration: 300 };
    case "flip":
    case "paper": {
      // The flat fold: the sheet lifts by its outer edge and swings away from
      // the reader about the spine on the left. Backward is the mirror.
      //
      // "仿真" prefers `pdfCurl.ts` and only reaches this when WebGL is
      // unavailable; "翻牌" is this fold by design.
      const away = dir === 1 ? -1 : 1;
      return {
        frames: [
          { opacity: 1, transform: "perspective(1400px) rotateY(0deg)" },
          { opacity: 0.9, offset: 0.6, transform: `perspective(1400px) rotateY(${away * 55}deg)` },
          { opacity: 0, transform: `perspective(1400px) rotateY(${away * FOLD_DEG}deg)` },
        ],
        duration: CURL_MS,
        fold: true,
      };
    }
  }
  // "none": nothing to play.
  return null;
}

/**
 * Where the incoming live page is allowed to show during a Push, in the
 * canvas's own coordinates. `offset`/`width` are the canvas's place inside the
 * sheet, `sheetWidth` is the book box, `travel` is the signed shift still to
 * apply (starts one sheet away, ends at rest), `dir` is the turn direction.
 *
 * A clip travels with its element's transform, so working in local coordinates
 * keeps the revealed strip inside the book box whether the page is centred
 * alone or one half of a spread — the reader never sees it enter from the
 * margin around the book.
 */
export function pushClip(
  offset: number,
  width: number,
  sheetWidth: number,
  travel: number,
  dir: 1 | -1,
  radius = 0,
): string {
  const left = Math.max(0, -offset - travel);
  const right = Math.max(0, width - sheetWidth + offset + travel);
  // `round` keeps the edge the clip exposes — the book's outer edge — as
  // rounded as the paper underneath it. A plain inset cuts a hard square corner
  // into the arriving page for the whole length of the push.
  const round = radius > 0 ? ` round ${radius}px` : "";
  return dir === 1 ? `inset(0 ${right}px 0 0${round})` : `inset(0 0 0 ${left}px${round})`;
}

/**
 * Push animates the *live* canvas, so unlike the snapshot layer that animation
 * survives a layer being removed. A held arrow key can start the next turn
 * before the previous 380 ms is over, and two `translateX` keyframes on the
 * same element compose: the page arrives in the reader's right margin instead
 * of resting in the book. One animation per canvas, cancelled by the next turn.
 */
const livePushes = new WeakMap<Element, Animation>();

/**
 * `goTo` changes the page number synchronously but the canvas is repainted in
 * an async blit — a prefetch hits within the same task, a cold render in
 * ~100 ms. A Push that starts before that blit slides the *outgoing* page in
 * from the right, then swaps its pixels under the reader's eyes mid-turn: the
 * flash that makes a fast turn look like it flickers twice.
 *
 * The wrapper writes `data-pdf-raster` in `blit()` and clears it when the next
 * render starts, so the *write* is the signal the incoming page is on the
 * canvas. Watch for that write with a MutationObserver rather than polling:
 * a warm blit clears and rewrites the attribute inside one task, between two
 * frames, and a frame poll never sees the cleared state — it would sit out
 * the whole animation waiting for a condition that already passed. The
 * observer runs on the same microtask checkpoint as the write.
 */
function whenPageRastered(host: HTMLElement, done: () => void): void {
  const wrappers = Array.from(host.querySelectorAll("[data-pdf-page]"));
  if (wrappers.length === 0) {
    done();
    return;
  }
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    window.clearTimeout(fallback);
    done();
  };
  const observer = new MutationObserver(() => {
    if (wrappers.every((wrapper) => wrapper.hasAttribute("data-pdf-raster"))) release();
  });
  for (const wrapper of wrappers) {
    observer.observe(wrapper, { attributes: true, attributeFilter: ["data-pdf-raster"] });
  }
  // A page that never reports a raster (an empty slot, a failed render) must
  // not hold the turn hostage. Same bound as before: a cold render lands well
  // inside it, so this is a last resort rather than the normal path.
  const fallback = window.setTimeout(release, 700);
}

function cancelLivePushes(host: HTMLElement): void {
  for (const canvas of host.querySelectorAll("[data-pdf-page] canvas")) {
    const previous = livePushes.get(canvas);
    if (!previous) continue;
    previous.cancel();
    livePushes.delete(canvas);
  }
}

/**
 * Drop a turn that is still in flight when the pane's geometry changes.
 *
 * A snapshot is measured in pixels against the page boxes at turn start. The
 * sidebar spring (and the width pin that follows it) moves and resizes those
 * boxes while the sheet is sliding: the snapshot then covers only part of the
 * new page and the strip it misses shows a different one — the flash seen when
 * the sidebar is hidden during a turn, or a turn is started while the pane is
 * still pinned. The page itself has already landed, so the sheet is only
 * decoration; dropping it and resetting the live Push transform is the whole
 * recovery. A running curl finishes its rAF into a detached canvas and cleans
 * itself up; nothing is left over the reader.
 */
export function cancelPdfTurn(host: HTMLElement | null): void {
  if (!host) return;
  for (const layer of host.querySelectorAll("[data-pdf-turn]")) layer.remove();
  cancelLivePushes(host);
}

/**
 * Copies the PDF page(s) on screen into an overlay over `host` and animates
 * them out. Call this *before* the page number changes — the canvas it copies
 * is the one pdf.js is about to redraw.
 *
 * `host` is the reading viewport, but the overlay is clipped to the book's own
 * box: one page in 单页, the pair's union in 双页. The sheet turns inside that
 * box, not across the reader's margins.
 */
export function snapshotPdfTurn(
  host: HTMLElement | null,
  dir: 1 | -1,
  mode: PageTransition,
  /** `null` while the motion preference is undetermined; treated as motion. */
  reduced: boolean | null,
): CurlTurn | null {
  if (!host || reduced || mode === "none") return null;
  // A held arrow key turns faster than the animation lasts, and two overlays
  // of page-sized bitmaps is memory the reader never gets to see. The older
  // one goes first — along with its live Push animation, which is bound to the
  // real canvas and would otherwise keep pushing the page long after its
  // snapshot layer has gone.
  cancelLivePushes(host);
  for (const layer of host.querySelectorAll("[data-pdf-turn]")) layer.remove();

  const hostBox = host.getBoundingClientRect();
  const shots: { copy: HTMLCanvasElement; shot: CurlShot; corner: number }[] = [];
  for (const src of host.querySelectorAll<HTMLCanvasElement>("[data-pdf-page] canvas")) {
    if (src.width === 0 || src.height === 0) continue;
    const box = src.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const copy = document.createElement("canvas");
    copy.width = src.width;
    copy.height = src.height;
    const context = copy.getContext("2d");
    if (!context) continue;
    context.drawImage(src, 0, 0);
    // The real page's own border and corner radius: a bare bitmap sliding over
    // a rounded page reads as a second, wrong page underneath it. The CSS
    // class handles the element; the bitmap needs the cut for the curl, whose
    // texture is drawn from these pixels rather than styled.
    copy.className = src.className;
    // Read the live page, not the detached copy: computed styles need a DOM.
    const radius = Number.parseFloat(getComputedStyle(src).borderRadius);
    const corner = Number.isFinite(radius) ? radius : 0;
    if (corner > 0) cutCorners(context, copy.width, copy.height, corner * (copy.width / box.width));
    shots.push({
      copy,
      corner,
      shot: {
        canvas: copy,
        x: box.left - hostBox.left,
        y: box.top - hostBox.top,
        w: box.width,
        h: box.height,
      },
    });
  }
  if (shots.length === 0) return null;
  // The overlay clips a sheet that is sliding *out* of the book box. Its left
  // edge is the clip's, not the sheet's own rounded corner, so the clip itself
  // has to be as round as the paper — otherwise the turn shows a square corner
  // where a still page showed a round one.
  const paperRadius = shots[0]!.corner;
  // The book box is the union of the visible canvases, clipped to the viewport
  // so a zoomed page cannot carry the overlay over the sidebar.
  const pages = bounds(shots.map((entry) => entry.shot));
  const x = Math.max(0, pages.x);
  const y = Math.max(0, pages.y);
  const sheetBox = {
    x,
    y,
    w: Math.max(0, Math.min(hostBox.width, pages.x + pages.w) - x),
    h: Math.max(0, Math.min(hostBox.height, pages.y + pages.h) - y),
  };
  if (sheetBox.w < 1 || sheetBox.h < 1) return null;

  // A spread turns one page, not both: the outer sheet crosses the spine and
  // becomes the next spread's inner page. The snapshot still covers the whole
  // book box, so the inner page changing underneath stays hidden; the travel
  // is one page's *pitch* — its width plus the gutter to its neighbour. Using
  // the bare width lands the outgoing sheet one gutter short of where the live
  // page rests, so the frame the snapshot is dropped snaps sideways by that
  // gutter: a visible flash on the backward turn, where the two slices show
  // different pages. Without this, two sheets also meet at the spine and the
  // turn reads as two pages shoving past each other.
  const pitch = shots.length > 1 ? shots[1]!.shot.x - shots[0]!.shot.x : sheetBox.w;
  // Curl and fold bend the *whole* book box: one page wide in 单页, a spread's
  // union in 双页. Their fixed per-page time would make the spread travel
  // twice as far in the same 500 ms — the speed difference the reader sees.
  // Scaling by sheet/pitch keeps the paper's surface speed equal. Pan and
  // slide already travel one pitch, so they keep their own 380 ms.
  const verticalMs = verticalTurnMs(sheetBox.w, pitch || sheetBox.w);

  // "仿真" bends the sheet on the GPU. Where WebGL is refused — a headless
  // WebKit, a blocked GPU — the flat fold below is what the reader gets
  // instead: half a turn is worse than a plainer one.
  if (mode === "paper") {
    const layer = document.createElement("div");
    layer.dataset.pdfTurn = "";
    layer.className = "pointer-events-none absolute overflow-hidden";
    layer.style.left = `${sheetBox.x}px`;
    layer.style.top = `${sheetBox.y}px`;
    layer.style.width = `${sheetBox.w}px`;
    layer.style.height = `${sheetBox.h}px`;
    layer.style.borderRadius = `${paperRadius}px`;
    // The curl is rAF-driven, so it has no WAAPI timing for a probe to read.
    // Record the resolved duration on the layer itself.
    layer.dataset.turnMs = String(verticalMs);
    const curl = createCurl(
      shots.map((entry) => entry.shot),
      dir,
      sheetBox,
    );
    if (curl) {
      // The shader paints a folded back as well, which has no texture corners
      // to inherit. Clip the canvas to the paper's own radius as well.
      if (shots[0]!.corner > 0) curl.canvas.style.borderRadius = `${shots[0]!.corner}px`;
      layer.append(curl.canvas);
      host.append(layer);
      // Handed back unfinished: a gesture holds it with `set` and lets go with
      // `finish`, and a turn with no gesture behind it just finishes at once.
      return startCurl(layer, curl, verticalMs);
    }
  }

  const turn = pdfTurn(mode, dir, pitch);
  if (!turn) return null;
  // The flat fold falls through here when WebGL is refused. It bends the same
  // whole book box as the curl, so it scales the same way; the wall-clock
  // hold in RULER_SETTLE_MS is sized for this worst case.
  if (turn.fold) turn.duration = verticalMs;
  const layer = document.createElement("div");
  layer.dataset.pdfTurn = "";
  layer.className = "pointer-events-none absolute overflow-hidden";
  layer.style.left = `${sheetBox.x}px`;
  layer.style.top = `${sheetBox.y}px`;
  layer.style.width = `${sheetBox.w}px`;
  layer.style.height = `${sheetBox.h}px`;
  layer.style.borderRadius = `${paperRadius}px`;
  layer.dataset.turnMs = String(turn.duration);
  // Keep the book clip still and move an inner sheet: transforming the layer
  // would move its own clip along with the page.
  const sheet = document.createElement("div");
  sheet.className = "absolute inset-0";
  for (const { copy, shot } of shots) {
    copy.style.position = "absolute";
    copy.style.left = `${shot.x - sheetBox.x}px`;
    copy.style.top = `${shot.y - sheetBox.y}px`;
    copy.style.width = `${shot.w}px`;
    copy.style.height = `${shot.h}px`;
  }
  if (turn.fold) {
    sheet.style.transformOrigin = `${dir === 1 ? 0 : sheetBox.w}px ${sheetBox.h / 2}px`;
  }
  sheet.append(...shots.map((entry) => entry.copy));
  if (turn.edgeShadow) {
    // Leading edge of the sheet, trailing it out of the book box. A gradient
    // strip instead of a full-canvas blur: readest does the same for raster
    // cost.
    //
    // The strip must span the page's full height. Insetting it past the
    // rounded corners (and capping the ends) leaves a floating capsule that
    // stops well short of both page edges — a shadow that visibly has the
    // wrong height. But a bare full-height strip is square at its ends, so
    // where the paper's corner has rounded away a hard dark square remains.
    // Keep the full height and fade the ends out across exactly the corner
    // radius: the shadow reads edge-to-edge, with nothing sticking into the
    // corner the paper no longer occupies.
    const shadow = document.createElement("div");
    shadow.dataset.pdfEdgeShadow = "";
    const cornerFade = `linear-gradient(to bottom, transparent 0px, #000 ${paperRadius}px, #000 calc(100% - ${paperRadius}px), transparent 100%)`;
    Object.assign(shadow.style, {
      position: "absolute",
      top: "0",
      bottom: "0",
      width: `${EDGE_SHADOW_PX}px`,
      left: dir === 1 ? "100%" : `${-EDGE_SHADOW_PX}px`,
      background:
        dir === 1
          ? "linear-gradient(to right, rgba(0,0,0,0.35), transparent)"
          : "linear-gradient(to right, transparent, rgba(0,0,0,0.35))",
    });
    // WKWebView still leans on the prefixed property; setting both keeps the
    // fade identical in the two engines.
    shadow.style.maskImage = cornerFade;
    shadow.style.setProperty("-webkit-mask-image", cornerFade);
    sheet.append(shadow);
  }
  layer.append(sheet);
  host.append(layer);

  const animation = sheet.animate(turn.frames, {
    duration: turn.duration,
    easing: turn.easing ?? EASE_OUT,
    // Held until the overlay is gone: without it the sheet snaps back to its
    // start for the frame between the animation ending and `remove` running.
    fill: "forwards",
  });
  const drop = () => layer.remove();
  animation.addEventListener("finish", drop);
  animation.addEventListener("cancel", drop);
  if (turn.push) {
    // readest PagePushRenderer: the live page starts one book width away on
    // the incoming side and travels to rest with the sheet. Its own clip has
    // to travel *with* it — in local coordinates — so the strip is revealed
    // only where it overlaps the book box. Without it the page keeps running
    // into the reader's margin, which is the edge the reader sees it enter
    // from. The same formula covers one page and both halves of a spread:
    // `offset` is where this canvas sits inside the sheet.
    const from = dir === 1 ? pitch : -pitch;
    const lives: Animation[] = [];
    const canvases = Array.from(host.querySelectorAll<HTMLCanvasElement>("[data-pdf-page] canvas"));
    // A spread has two live canvases, but only the outer page turns: it comes
    // to rest where the inner page sat, and the inner page switches behind the
    // snapshot. Animating both is what made a spread look like two sheets
    // shoving past each other. Canvases are in left-to-right page order.
    const outer = dir === 1 ? canvases.at(-1) : canvases[0];
    for (const src of outer ? [outer] : []) {
      if (src.width === 0 || src.height === 0) continue;
      const srcBox = src.getBoundingClientRect();
      const offset = srcBox.left - hostBox.left - sheetBox.x;
      const width = srcBox.width;
      const clipAt = (d: number) => pushClip(offset, width, sheetBox.w, d, dir, paperRadius);
      const live = src.animate(
        [
          { transform: `translateX(${from}px)`, clipPath: clipAt(from) },
          { transform: "none", clipPath: clipAt(0) },
        ],
        { duration: turn.duration, easing: turn.easing ?? EASE_OUT, fill: "both" },
      );
      lives.push(live);
      livePushes.set(src, live);
      const forget = () => {
        if (livePushes.get(src) === live) livePushes.delete(src);
      };
      live.addEventListener("finish", () => {
        live.cancel();
        forget();
      });
      live.addEventListener("cancel", forget);
    }
    if (lives.length > 0) {
      // Hold both animations on frame 0 until the incoming page is actually on
      // the canvas. Starting now would animate the outgoing page for a frame
      // or two — the sheet and the live page would both show the old page,
      // then the live one would change pixels mid-slide and flicker. Releasing
      // both in one task keeps their clocks identical (WAAPI hands out
      // `startTime` on the next frame) so the strip still moves as one piece.
      animation.pause();
      for (const live of lives) live.pause();
      whenPageRastered(host, () => {
        if (!layer.isConnected) return;
        animation.play();
        for (const live of lives) {
          // A rapid next turn may already have cancelled this one.
          if (live.playState !== "idle") live.play();
        }
      });
    }
  }
  // The flat fold is a fixed animation: there is nothing for a gesture to hold.
  return null;
}
