/**
 * The mesh curl for a paged PDF turn — the "仿真" style.
 *
 * The page is a flat bitmap, so bending it is a shader's job: a grid of
 * vertices is wrapped around a cylinder whose axis is the fold, and the fold
 * travels across the sheet as the turn progresses. Everything else — the
 * shading along the curl, the blank back of the sheet — falls out of that one
 * piece of geometry.
 *
 * This is the same construction readest's `pageCurl.ts` uses, arrived at from
 * a cheaper direction: readest has to ask the native webview for a screenshot
 * because its page is live DOM, while ours is already a canvas, so the texture
 * is a `drawImage` away and none of its capture pipeline exists here.
 *
 * WebGL is not a given — a headless WebKit, a blocked GPU or a locked-down
 * machine all decline it — so `createCurl` answers `null` and the caller falls
 * back to the flat fold rather than leaving the reader with half a turn.
 */

/** Vertices per side of the mesh. 48 is 4.6k triangles: smooth along the curl
    at page size, and one draw call either way. */
const GRID = 48;

/** The curl tightens as it travels. `0.16·w` at the start, 60% of that at the
    end, with a floor so a narrow page still bends like paper and not like a
    hinge. */
const RADIUS_RATIO = 0.16;
const RADIUS_FLOOR = 24;

/** How far the fold's cylinder lifts the sheet, as a fraction of its radius.
    Past ~90° of wrap the sheet is over the fold and shows its back. */
const ARC = Math.PI;

/** How much the curl darkens the paper at its deepest point. */
const SHADE = 0.35;

/** A page-sized bitmap is tens of megabytes at 3x; 2x is what the eye can
    actually resolve on a moving sheet. */
const MAX_DPR = 2;

/** One page (or half of a spread) already rasterised, and where it sits inside
    the reading viewport, in CSS pixels. */
export interface CurlShot {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The box a curl may paint into, in host coordinates. */
export interface CurlClip {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CurlHandle {
  /** The overlay: sized to the clip box, transparent where the sheet is not. */
  canvas: HTMLCanvasElement;
  /** Draws the sheet at `progress`, 0 flat through 1 fully turned. */
  draw(progress: number): void;
  /** Releases the GL objects and takes the overlay out of the DOM. */
  destroy(): void;
}

/** The box the shots cover together — the sheet the curl bends. */
export function bounds(shots: CurlShot[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const shot of shots) {
    x0 = Math.min(x0, shot.x);
    y0 = Math.min(y0, shot.y);
    x1 = Math.max(x1, shot.x + shot.w);
    y1 = Math.max(y1, shot.y + shot.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The paper the *back* of the sheet is made of, read off the page itself: the
 * corner of a rasterised page is the paper colour pdf.js painted first, and
 * that is the colour a turned sheet has to show on its far side. A night-mode
 * page therefore turns to night paper, not to white.
 */
export function paperInk(shot: CurlShot): [number, number, number] {
  try {
    const context = shot.canvas.getContext("2d");
    // Not the corner: the turn's own snapshot has its rounded corners cut out
    // of the bitmap, so (2, 2) is transparent black there — sampling it painted
    // the folded-over back of the sheet black. The top edge halfway across is
    // paper in every layout and outside every corner cut.
    const data = context?.getImageData(Math.floor(shot.canvas.width / 2), 2, 1, 1).data;
    if (data && (data[3] ?? 0) > 0) {
      return [data[0]! / 255, data[1]! / 255, data[2]! / 255];
    }
  } catch {
    // A zero-sized canvas throws; the default below is the answer anyway.
  }
  return [1, 1, 1];
}

const VERTEX_SHADER = `
attribute vec2 aPos;
uniform vec4 uRect;
uniform vec2 uSize;
uniform vec2 uFold;
uniform vec2 uDir;
uniform float uRadius;
uniform float uFlipV;
varying vec2 vUv;
void main() {
  vec2 origin = uRect.xy + aPos * uRect.zw;
  float s = dot(origin - uFold, uDir);
  float arc = 3.14159265 * uRadius;
  vec2 p = origin;
  if (s > 0.0) {
    if (s < arc) {
      // On the cylinder: pulled back along the fold by however much of the
      // arc it has consumed, and lifted by the sagitta of that arc.
      float a = s / uRadius;
      p -= uDir * (s - uRadius * sin(a));
    } else {
      // Past the fold: the mirror of what is still flat, exactly as a sheet
      // turned over onto itself lands.
      p -= uDir * (2.0 * s - arc);
    }
  }
  // uFlipV carries the one thing this shader cannot know: whether the engine
  // put the uploaded canvas's first row at v = 0. See uploadsTopDown in JS.
  vUv = vec2(aPos.x, mix(aPos.y, 1.0 - aPos.y, uFlipV));
  gl_Position = vec4(2.0 * p.x / uSize.x - 1.0, 1.0 - 2.0 * p.y / uSize.y, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uBack;
// Every uniform used in the back-face test sits in the same precision as the
// vertex stage. The mediump default under this stage's precision statement
// would silently disagree with the vertex default (highp) and refuse to link.
uniform highp vec4 uRect;
uniform highp vec2 uFold;
uniform highp vec2 uDir;
uniform highp float uFlipV;
// highp, matching the vertex stage's default: a uniform declared at two
// different precisions fails to link, and the radius decides where the
// sheet's back begins, which is a comparison that wants the precision anyway.
uniform highp float uRadius;
varying vec2 vUv;
void main() {
  // Recompute s in the fragment, not from a varying. The vertex stage's s
  // is interpolated, but a varying picked up *after* the per-vertex branch
  // arrives at the fragment out of order — the wrap and mirror branches
  // write different p, and the interpolated s no longer reflects the
  // fragment's actual distance to the fold.
  vec2 origin =
    uRect.xy + vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlipV)) * uRect.zw;
  float s = dot(origin - uFold, uDir);
  float arc = 3.14159265 * uRadius;
  float over = step(arc, s);
  float shade = (s > 0.0 && s < arc) ? sin(s / uRadius) : 0.0;
  vec4 sheet = texture2D(uTex, vUv);
  vec3 front = sheet.rgb * (1.0 - ${SHADE} * shade);
  gl_FragColor = vec4(mix(front, uBack, over), mix(sheet.a, 1.0, over));
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

const PROBE_VERTEX = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const PROBE_FRAGMENT = `
precision mediump float;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vec2(0.5, 0.25));
}
`;

/** Which row of an uploaded canvas this engine puts at v = 0. Cached for the
    process: the answer cannot change under a running page. */
let uploadTopDown: boolean | null = null;

/**
 * Probes the upload direction, once.
 *
 * There is no setting that makes the engines agree. A canvas handed to
 * `texImage2D` lands top-down on WKWebView and bottom-up on Chromium, the
 * standard's `UNPACK_FLIP_Y_WEBGL` flag is ignored by WebKit, and the WebKit
 * in a test runner does not even match the WKWebView a reader runs — a shader
 * that hardcodes either direction is upside down on somebody's machine.
 * (readest's curl shipped upside down on iOS for exactly this reason.)
 *
 * So: upload a two-row probe, read back which row arrived at v = 0, and let
 * the sheet shader take the direction as a uniform. One 1x1 draw, once.
 */
function uploadsTopDown(): boolean {
  if (uploadTopDown !== null) return uploadTopDown;
  // If the probe cannot run at all, assume WKWebView — the engine a reader
  // actually reads on.
  uploadTopDown = true;
  const source = document.createElement("canvas");
  source.width = 1;
  source.height = 2;
  const paint = source.getContext("2d");
  const target = document.createElement("canvas");
  target.width = 1;
  target.height = 1;
  const gl = target.getContext("webgl");
  if (!paint || !gl) return uploadTopDown;
  paint.fillStyle = "#ff0000";
  paint.fillRect(0, 0, 1, 1);
  paint.fillStyle = "#0000ff";
  paint.fillRect(0, 1, 1, 1);

  const vertex = compile(gl, gl.VERTEX_SHADER, PROBE_VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, PROBE_FRAGMENT);
  const program = vertex && fragment ? gl.createProgram() : null;
  const surface = gl.createTexture();
  const buffer = gl.createBuffer();
  if (!vertex || !fragment || !program || !surface || !buffer) return uploadTopDown;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return uploadTopDown;
  gl.useProgram(program);

  gl.bindTexture(gl.TEXTURE_2D, surface);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);
  gl.viewport(0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // v = 0.25 falls in the probe's first row if the upload is top-down, in its
  // second if it is not. Red means top-down.
  const pixel = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  uploadTopDown = pixel[0]! > pixel[2]!;

  gl.deleteBuffer(buffer);
  gl.deleteTexture(surface);
  gl.deleteProgram(program);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return uploadTopDown;
}

/**
 * Where the fold is at `progress`, for a sheet `width` wide.
 *
 * `offset` is measured from the sheet's own left edge and already carries the
 * direction: forward starts at the outer (right) edge and drives the fold
 * left past the sheet, backward starts at the left edge and drives right. The
 * fold travels the sheet's width plus the arc it ends on, so at progress 1
 * every point of the sheet has passed it.
 */
export function curlGeometry(
  width: number,
  progress: number,
  dir: 1 | -1,
): {
  radius: number;
  offset: number;
} {
  const radius = Math.max(RADIUS_FLOOR, RADIUS_RATIO * width * (1 - 0.4 * progress));
  const end = Math.max(RADIUS_FLOOR, RADIUS_RATIO * width * (1 - 0.4));
  const travel = width + ARC * end;
  const start = dir === 1 ? width : 0;
  return { radius, offset: start + (dir === 1 ? -1 : 1) * travel * progress };
}

/**
 * Builds the mesh and its texture for one turn. Returns `null` when WebGL is
 * unavailable, so the caller can fall back to the flat fold.
 */
export function createCurl(
  shots: CurlShot[],
  /** 1 forward, -1 back: which edge the sheet lifts from. */
  dir: 1 | -1,
  /** The book box the turn is allowed to paint into, in host coordinates. */
  clip: CurlClip,
): CurlHandle | null {
  if (shots.length === 0) return null;
  const rect = bounds(shots);
  if (rect.w <= 0 || rect.h <= 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  // One flat texture for the whole sheet: a spread is two pages side by side,
  // and the mesh bends them as one.
  const texture = document.createElement("canvas");
  texture.width = Math.max(1, Math.round(rect.w * dpr));
  texture.height = Math.max(1, Math.round(rect.h * dpr));
  const paint = texture.getContext("2d");
  if (!paint) return null;
  for (const shot of shots) {
    paint.drawImage(
      shot.canvas,
      (shot.x - rect.x) * dpr,
      (shot.y - rect.y) * dpr,
      shot.w * dpr,
      shot.h * dpr,
    );
  }

  const canvas = document.createElement("canvas");
  canvas.className = "absolute inset-0 h-full w-full";
  // Marks which of the two turn renderers ran, for the browser test that has
  // to tell a bent sheet from a folded one.
  canvas.dataset.pdfCurl = "";
  // The shader's clip space is the book box, not the reading viewport: a curled
  // page that swings past the paper's edge must disappear there rather than
  // travel across the margin the reader added around the book.
  const width = Math.max(1, Math.round(clip.w * dpr));
  const height = Math.max(1, Math.round(clip.h * dpr));
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
    depth: false,
  });
  // The shots are only a texture source now; the bitmaps they hold are the
  // memory that matters, and a page-sized pair lingers until it is dropped.
  if (!gl) {
    texture.width = 0;
    texture.height = 0;
    return null;
  }

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = vertex && fragment ? gl.createProgram() : null;
  if (!program || !vertex || !fragment) {
    texture.width = 0;
    texture.height = 0;
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    texture.width = 0;
    texture.height = 0;
    return null;
  }
  gl.useProgram(program);

  const positions = new Float32Array((GRID + 1) * (GRID + 1) * 2);
  for (let row = 0; row <= GRID; row += 1) {
    for (let col = 0; col <= GRID; col += 1) {
      const at = (row * (GRID + 1) + col) * 2;
      positions[at] = col / GRID;
      positions[at + 1] = row / GRID;
    }
  }
  const indices = new Uint16Array(GRID * GRID * 6);
  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      const a = row * (GRID + 1) + col;
      const at = (row * GRID + col) * 6;
      indices[at] = a;
      indices[at + 1] = a + 1;
      indices[at + 2] = a + GRID + 1;
      indices[at + 3] = a + 1;
      indices[at + 4] = a + GRID + 2;
      indices[at + 5] = a + GRID + 1;
    }
  }
  const positionBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  const surface = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, surface);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture);

  const at = (name: string) => gl.getUniformLocation(program, name);
  const uRect = at("uRect");
  const uSize = at("uSize");
  const uFold = at("uFold");
  const uDir = at("uDir");
  const uRadius = at("uRadius");
  const uBack = at("uBack");

  gl.uniform4f(uRect, rect.x - clip.x, rect.y - clip.y, rect.w, rect.h);
  gl.uniform2f(uSize, clip.w, clip.h);
  gl.uniform1f(at("uFlipV"), uploadsTopDown() ? 0 : 1);
  // Forward lifts the outer (right) edge and drives the fold leftward, so the
  // turned-away side grows to the right of it; backward is the mirror.
  gl.uniform2f(uDir, dir === 1 ? 1 : -1, 0);
  const ink = paperInk(shots[0]!);
  gl.uniform3f(uBack, ink[0], ink[1], ink[2]);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const count = indices.length;

  return {
    canvas,
    draw(progress: number) {
      const { radius, offset } = curlGeometry(rect.w, progress, dir);
      gl.uniform1f(uRadius, radius);
      gl.uniform2f(uFold, rect.x - clip.x + offset, rect.y - clip.y);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    },
    destroy() {
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteTexture(surface);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      texture.width = 0;
      texture.height = 0;
    },
  };
}

/** A curl in progress, as the pointer (or the clock) drives it. */
export interface CurlTurn {
  /** Puts the sheet where the gesture has dragged it, 0 flat through 1 turned. */
  set(progress: number): void;
  /**
   * Lets go. `commit` finishes the turn; otherwise the sheet springs back and
   * `revert` runs while it still covers the page, so the reader never watches
   * the old page re-render underneath it.
   */
  finish(commit: boolean, revert?: () => void): void;
}

/**
 * Starts one curl. Driven by a clock rather than by WAAPI because the sheet is
 * redrawn every frame — there is no CSS transform that bends a bitmap — and
 * left open so a gesture can hold it: `set` follows the fingers, `finish`
 * plays out from wherever they let go.
 */
export function startCurl(layer: HTMLElement, curl: CurlHandle, duration: number): CurlTurn {
  let frame = 0;
  let progress = 0;
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const finish = (commit: boolean, revert?: () => void) => {
    stop();
    const from = progress;
    const target = commit ? 1 : 0;
    const span = Math.abs(target - from);
    const done = () => {
      // Only a turn that was let go short of the end puts the page back. A
      // committed one has already landed, and calling `revert` here would undo
      // it.
      if (!commit) revert?.();
      curl.destroy();
      layer.remove();
    };
    // Nothing left to travel: a turn let go at either end is already there.
    if (span < 0.002) {
      done();
      return;
    }
    // Proportional to the distance left, so a turn released halfway does not
    // take as long as one released at the start. Eased out: the sheet leaves at
    // full speed and settles, which is how a page let go behaves.
    const ms = Math.max(120, span * duration);
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / ms);
      progress = from + (target - from) * (1 - (1 - t) ** 3);
      curl.draw(progress);
      if (t < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      done();
    };
    frame = requestAnimationFrame(step);
  };
  return {
    set(next: number) {
      stop();
      progress = Math.min(1, Math.max(0, next));
      curl.draw(progress);
    },
    finish,
  };
}
