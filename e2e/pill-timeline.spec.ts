import { expect, test } from "@playwright/test";

/**
 * THROWAWAY diagnostic. Green when the pill is steady; red *with the whole
 * timeline attached* when it is not.
 *
 * A CI run of `tts-pill.spec.ts` failed seven times over with two different
 * words — "element is not stable" and "element was detached from the DOM" —
 * plus one "element(s) not found", and one more where the reader's own `footer`
 * could not be measured for thirty seconds. Three symptoms, one shape: things
 * being **destroyed and rebuilt**, not things being in the wrong place. This
 * watches for exactly that, and samples the two things a reader would feel if it
 * were happening to them: whether the pill is there, and whether it is where it
 * was.
 *
 * The proxy for the engine's state is the transport button's own wording — 暂停
 * while a voice is on, 播放 when there is none — so nothing here reaches into the
 * app.
 */
const PILL = "[data-tts-pill]";
const DEMO_BOOK = /我们为什么会生病/;

/** The same never-ending engine `tts-pill.spec.ts` installs, and for the same
 *  reason: this file is about whether the pill *moves*, and a session that ends
 *  mid-sample makes it move for the most boring reason there is. */
function installVoiceThatNeverFinishes(): void {
  const proto = window.SpeechSynthesis?.prototype;
  if (!proto) return;
  const voice = {
    name: "Test Voice",
    lang: "zh-CN",
    default: true,
    localService: true,
    voiceURI: "test",
  } as SpeechSynthesisVoice;
  proto.getVoices = () => [voice];
  proto.speak = () => {};
  proto.pause = () => {};
  proto.resume = () => {};
}

/** How far the pill sits above whatever anchors it — the footer's top edge in
 *  the reader, the window's foot on the shelf.
 *
 *  Measured this way rather than as a raw `y` because the pill's *anchor* can
 *  move: the reader's footer is shorter for the first paint or two and taller
 *  once its contents are in, and the pill is lifted by exactly that height — so
 *  the window coordinates change while the pill is doing precisely what it was
 *  built to do. CI read that as the pill drifting (772 → 760 one second in).
 *  What must not change is the clearance: a pill that slid down its own footer
 *  would still be a defect, and still fails here. */
const lift = (s: Sample) => (s.footer > 0 ? s.y - s.footerTop : s.y);

interface Sample {
  ms: number;
  pill: number;
  y: number;
  h: number;
  state: string;
  footer: number;
  footerY: number;
  /** The footer's own top edge, so the pill can be measured against the thing
   *  it is anchored to rather than against the window. */
  footerTop: number;
  title: string;
}

test("the pill is either there and still, or gone — and which", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(installVoiceThatNeverFinishes);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: DEMO_BOOK }).first().click();
  await expect(page.getByRole("button", { name: "阅读设置" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "从当前位置朗读" }).first().click();
  await expect(page.locator(PILL)).toBeVisible();

  const started = Date.now();
  const sample = async (): Promise<Sample> =>
    page.evaluate((t0) => {
      const pill = document.querySelector("[data-tts-pill]");
      const footer = document.querySelector("footer");
      const box = pill?.getBoundingClientRect();
      // 暂停 while a voice is on; 播放 when there is none.
      const state = pill?.querySelector("[aria-label='暂停']")
        ? "playing"
        : pill?.querySelector("[aria-label='播放']")
          ? "idle"
          : "none";
      return {
        // `Date.now()` on both sides: the sample is taken in the page and the
        // origin comes from the driver, so `performance.now()` here would
        // subtract two unrelated clocks and print `-1793281358661ms`.
        ms: Math.round(Date.now() - t0),
        pill: pill ? 1 : 0,
        y: box ? Math.round(box.top) : -1,
        h: box ? Math.round(box.height) : -1,
        state,
        footer: footer ? 1 : 0,
        footerY: footer ? Math.round(footer.getBoundingClientRect().height) : -1,
        footerTop: footer ? Math.round(footer.getBoundingClientRect().top) : -1,
        title: document.title.slice(0, 40),
      };
    }, started);

  // In the reader, where the footer is on screen and the pill is lifted clear
  // of it — then on the shelf, where there is no footer at all and the pill has
  // to carry the session on its own. Both states, because CI failed in both.
  const inReader: Sample[] = [];
  // Wait for the pill to *arrive* before sampling instead of spending the first
  // two samples on the arrival. Arriving is not a 12px hop at t=0: the pill's
  // lift is a measured value, and on a starved renderer the measurement that
  // settles it lands a second or more after the first paint (CI: steady at 772
  // for 750ms, then 760 for the rest of the session). **Five** agreeing samples
  // 250ms apart — a full second of stillness — is what "arrived" means here; a
  // pill that never settles still fails, on the samples below.
  //
  // Three was not enough, and the log says why: the loop broke at 1099ms with
  // 772 read three times, and the hop landed at 1370ms — 271ms after the loop
  // had already called it arrived. The hop is a fixed distance but not a fixed
  // time, and a second of stillness clears the slowest one measured (1.4s).
  let settled = Number.NaN;
  let agreeing = 0;
  for (let i = 0; i < 24; i += 1) {
    const s = await sample();
    agreeing = s.y > 0 && lift(s) === settled ? agreeing + 1 : 0;
    settled = lift(s);
    if (agreeing >= 4) break;
    await page.waitForTimeout(250);
  }
  for (let i = 0; i < 12; i += 1) {
    inReader.push(await sample());
    await page.waitForTimeout(250);
  }

  await page.getByRole("link", { name: "书库", exact: true }).click();
  await expect(page.locator("[data-shelf-scroller]")).toBeVisible();
  await page.waitForTimeout(1200);

  const onShelf: Sample[] = [];
  for (let i = 0; i < 12; i += 1) {
    onShelf.push(await sample());
    await page.waitForTimeout(250);
  }

  const timeline = { inReader, onShelf };
  /** Anything that is not "identical to the sample before it" — ignoring the
   *  two samples each state spends arriving, since the pill rises into place by
   *  12px and that is the surface working rather than the pill drifting. */
  const churn = (samples: Sample[]) =>
    samples
      .map((s, i) => ({ s, prev: i > 0 ? samples[i - 1] : undefined, i }))
      .filter(
        ({ s, prev, i }) =>
          // The first two samples of a state are the pill arriving: it rises into
          // place by 12px, and that is the surface working, not the pill drifting.
          i >= 2 &&
          prev !== undefined &&
          (s.pill !== prev.pill || lift(s) !== lift(prev) || s.state !== prev.state),
      )
      .map(
        ({ s, prev }) =>
          `${s.ms}ms pill ${prev?.pill ?? "-"}→${s.pill} lift ${prev ? lift(prev) : "-"}→${lift(s)} (y ${prev?.y ?? "-"}→${s.y}) ${prev?.state ?? "-"}→${s.state}`,
      );

  const moved = [...churn(inReader), ...churn(onShelf)];
  // …and the half this file is named for: a session is running, so the pill is
  // *there*. An absent pill is not "steady" — it is the other thing, and it is
  // what a CI run reported six times over. Checked from the third sample of each
  // state, so arriving does not count as being late.
  const missing = [...inReader, ...onShelf]
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i >= 2 && s.pill === 0)
    .map(({ s }) => `${s.ms}ms pill GONE (state ${s.state}, footer ${s.footer})`);

  const report = JSON.stringify({ moved, missing, ...timeline }, null, 1);
  expect(missing, `PILL GONE — ${report}`).toHaveLength(0);
  expect(moved, `PILL MOVED — ${report}`).toHaveLength(0);
});
