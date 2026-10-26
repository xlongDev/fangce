//! `mini_bar.*` commands: the shell state behind the floating read-aloud bar.
//!
//! The bar is a second window, and it exists because a window that is not on
//! screen cannot draw. The in-app pill lives inside the main window, so putting
//! that window away — minimized to the Dock, or hidden by the red button —
//! takes the transport with it, and the only thing left to pause with is the
//! menu-bar icon. This is the other half: a small always-on-top capsule that
//! stays on the desktop while the reader is somewhere else.
//!
//! What this module does *not* decide is what the bar shows. The queue, the
//! position and the voice are frontend state, and the frontend is exactly what
//! the bar is drawn next to; so the frontend pushes what to draw over
//! `tts://mini-state` and the bar forwards its buttons as the same names the
//! tray already uses (`tts://control`). What is left for Rust are the two
//! things the frontend cannot see: whether the main window is on screen at all,
//! and the shape of the bar's own frame — a webview knows its content and not
//! the window around it, so the bar says which face it is drawing and the
//! geometry is worked out here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::reveal_window;

/// The bar's window label — and therefore what its capability is scoped to.
pub const BAR_LABEL: &str = "mini";

/// The bar's window, in logical pixels. The capsule inside is 468×48 — wider
/// than the in-app pill because it carries two extra controls, the way back to
/// the text and the fold-away — and the rest is the hairline and the focus
/// ring, which a window clipped to the content would cut off.
const BAR_SIZE: (f64, f64) = (476.0, 56.0);

/// The height of the bar's window with the player's *main* view open, in
/// logical pixels.
///
/// The card is the *same* card the app draws, capped at 520 there and given the
/// same 8px of air here that the capsule gets. Only the height moves: the card
/// is the width of the window and the capsule is centred in it, so a second
/// width would make the bar jump sideways as it unfolds.
const CARD_HEIGHT: f64 = 528.0;

/// The same, for 设置 → 朗读 → 播放器样式 = 简约: no sentence list and no settings
/// row, so the card is a header, a clock and a transport.
const CARD_MINIMAL_HEIGHT: f64 = 176.0;

/// The same, for 语速: the transport plus a single row of rate chips.
const CARD_SPEED_HEIGHT: f64 = 188.0;

/// The same, for 定时关闭: two rows of choices and the sentence under them.
const CARD_TIMER_HEIGHT: f64 = 312.0;

/// Where the bar first appears, in logical pixels from the bottom of the
/// screen: clear of the Dock, and low enough that it does not sit over the
/// middle of whatever the reader switched to.
const BAR_LIFT: f64 = 72.0;

/// How often the bar re-checks the main window.
const TICK: Duration = Duration::from_millis(400);

/// What the shell knows about the bar that the frontend cannot.
///
/// Three flags and no state machine: the frontend owns "a voice is on", this
/// owns "the main window is out of the way", and [`bar_belongs`] folds them
/// together on every tick.
#[derive(Default)]
pub struct MiniBar {
    /// The bar is wanted: a read-aloud session is live *and* the setting that
    /// allows the bar is on. Both are frontend knowledge, so they arrive as one
    /// flag on `mini_bar.watch`.
    wanted: AtomicBool,
    /// The reader folded the bar away by hand. Cleared the moment the main
    /// window is on screen again, so the next minimize brings it back.
    dismissed: AtomicBool,
    /// Whether the ticker is already running, so it is started once per session
    /// rather than once per `watch`.
    watching: AtomicBool,
    /// Where the capsule sat before the card was opened, in physical pixels.
    ///
    /// `None` is the ordinary case and the reason this is not simply "where the
    /// capsule was": the frame's **bottom edge** is what an unfold holds on to,
    /// so folding the card away needs nothing remembered. It is only when the
    /// card would not fit above that bottom that the window has to be pushed
    /// somewhere else — and then the capsule's own place is the one thing worth
    /// keeping, because the clamp has just consumed it.
    anchor: Mutex<Option<(i32, i32)>>,
}

/// Registers the bar's state. Called from `setup`, which is the only place that
/// can happen — the commands below reach for it by type.
pub fn install(app: &tauri::App) {
    app.manage(MiniBar::default());
}

/// Whether the bar belongs on screen.
///
/// The one judgement in this module, and the reason it is a free function: the
/// window calls around it are `let _ =` and cannot be asserted on, while this
/// can. "Away" is either half of what putting a window aside means — minimized
/// to the Dock, or hidden by the red button — because a reader who did either
/// one has lost the transport either way.
fn bar_belongs(wanted: bool, dismissed: bool, main_visible: bool, main_minimized: bool) -> bool {
    wanted && !dismissed && (!main_visible || main_minimized)
}

/// Which face the bar's window is drawing.
///
/// The bar has five faces and one window, and the split of knowledge decides
/// who names them: the frontend can see the content and not the frame, this
/// module can see the frame and not the content — so the frontend says which
/// face it is about to draw and the geometry is worked out here.
///
/// The names are the card's own (`SpeechView`) with the capsule added in front,
/// so neither side translates the other and a face cannot be reported as
/// something the card has no view for.
#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarFace {
    /// The bar at rest: the capsule, with no card behind it.
    Capsule,
    /// The card's main view — the sentence list, the scrubber, the three tiles.
    Main,
    /// 语速.
    Speed,
    /// The voice catalogue. A scroll of a hundred-odd rows, so it wants the box
    /// the main view gets rather than a height of its own.
    Voice,
    /// 定时关闭.
    Timer,
}

/// How tall the bar's window should be, in logical pixels, for the face the
/// frontend is drawing.
///
/// The frontend *says* which face it is on rather than being measured: it knows
/// what the card has to say and this module knows what a window costs, and the
/// two numbers that meet in the middle (the 8px of air, the card's own cap) are
/// both already declared here.
///
/// The heights themselves are measured, not guessed. The app's card sizes
/// itself to its content, so rendering it at the bar's width and reading its
/// box gives what each view actually wants — both engines agree to the pixel —
/// and the totals are that plus the 8px of air, rounded **up** to the next 4 so
/// a font that rounds the other way cannot clip the last line. 语速 needs 178 of
/// card and 简约 168; 定时关闭 301; the main view wants more than the app's cap
/// and gets the cap plus the air, which is the 528 this was all built on.
///
/// `minimal` is the one axis that is not a face: 简约 changes what the *player*
/// draws, not which panel it is on, and it forces the main view — so it can
/// only ever move the main view's height, and every other arm ignores it.
fn bar_height(face: BarFace, minimal: bool) -> f64 {
    match face {
        BarFace::Capsule => BAR_SIZE.1,
        BarFace::Main if minimal => CARD_MINIMAL_HEIGHT,
        BarFace::Main | BarFace::Voice => CARD_HEIGHT,
        BarFace::Speed => CARD_SPEED_HEIGHT,
        BarFace::Timer => CARD_TIMER_HEIGHT,
    }
}

/// Where a frame of `new_height` goes, given the frame it is replacing and the
/// top of the work area — plus whether it had to be held there.
///
/// The **bottom edge** is what stays put. The bar is a player lying near the
/// dock and the card is a taller version of the same object, so unfolding
/// upward keeps the reader's own placement while unfolding downward would
/// either walk off the bottom of the screen or oblige the bar to jump back up
/// every time the card was folded away.
///
/// When the card is taller than the space above the bottom edge — the capsule
/// dragged to the top of a short screen — the top is clamped into the work
/// area, and the caller is told: that is the one case where the capsule's own
/// place is no longer implied by the bottom and has to be remembered.
fn resized_y(old_y: i32, old_height: i32, new_height: i32, work_top: i32) -> (i32, bool) {
    let top = old_y + old_height - new_height;
    if top < work_top { (work_top, true) } else { (top, false) }
}

/// `mini_bar.watch` — the frontend's answer to "is a voice on, and is the bar
/// allowed to appear".
///
/// Also the switch for the ticker: the poll only runs while this is true, so an
/// app that is not reading anything does not wake up four times a second.
#[tauri::command]
#[specta::specta]
pub fn mini_bar_watch(app: AppHandle, state: State<'_, MiniBar>, active: bool) {
    state.wanted.store(active, Ordering::SeqCst);
    if !active {
        set_bar_visible(&app, false);
        return;
    }
    // A new session starts with the bar allowed, whatever was folded away
    // during the last one.
    state.dismissed.store(false, Ordering::SeqCst);
    start_ticker(&app);
}

/// `mini_bar.dismiss` — the bar's own fold-away button.
///
/// Separate from `watch(false)` because the two mean different things: that one
/// is the session ending, this is "get out of the way, I am still listening".
#[tauri::command]
#[specta::specta]
pub fn mini_bar_dismiss(app: AppHandle, state: State<'_, MiniBar>) {
    state.dismissed.store(true, Ordering::SeqCst);
    set_bar_visible(&app, false);
}

/// `mini_bar.reveal` — puts the main window back on screen.
///
/// Wanted by the bar's own「回到阅读」, which the bar forwards as a `focus` event
/// rather than calling this: only the main window can also take the reader to
/// the sentence being spoken, so the two steps belong to the same side.
///
/// Nothing is reset here: the ticker sees a visible, un-minimized main window
/// on its next pass and takes the bar down itself.
#[tauri::command]
#[specta::specta]
pub fn mini_bar_reveal(app: AppHandle) {
    reveal_window(&app);
}

/// `mini_bar.expand` — resizes the bar's window to the face it is about to
/// draw.
///
/// The bar has five faces and one window: the capsule, which is the bar at
/// rest, and the player card — the *app's own* card, drawn in this window so a
/// reader who asked for it does not have to bring the whole app back — on one
/// of its four views. Every face has its own height, and the window has to
/// change for each: the card's drill-downs are a third the height of its main
/// view, and leaving the window tall enough for the list behind a row of rate
/// chips is what an empty half of a floating panel looks like.
///
/// The frontend cannot do any of this — a webview sees its own content, not its
/// frame — so it says which face it is drawing and this works out the geometry.
///
/// Called with the face it already has (the tick, a re-render) it is a no-op in
/// everything but two syscalls, which is the right trade for not having to keep
/// a second copy of "which view is open" on this side of the IPC.
#[tauri::command]
#[specta::specta]
pub fn mini_bar_expand(app: AppHandle, state: State<'_, MiniBar>, face: BarFace, minimal: bool) {
    let Some(bar) = app.get_webview_window(BAR_LABEL) else {
        return;
    };
    let (Ok(size), Ok(position)) = (bar.outer_size(), bar.outer_position()) else {
        return;
    };
    let scale = bar.scale_factor().unwrap_or(1.0);
    let height = (bar_height(face, minimal) * scale).round();
    if height < 1.0 {
        return;
    }
    let height = height as i32;

    // The capsule is the frame every other face unfolds out of, so "is this one
    // of them" is the whole of what the placement below has to know: a
    // drill-down is a card like any other, and the bottom edge it holds on to is
    // the one the card already has.
    let card = face != BarFace::Capsule;

    let mut anchor = state.anchor.lock().unwrap_or_else(PoisonError::into_inner);
    let mut x = position.x;
    let y = if card {
        let work_top = bar
            .current_monitor()
            .ok()
            .flatten()
            .map_or(0, |monitor| monitor.work_area().position.y);
        let (y, clamped) = resized_y(position.y, size.height as i32, height, work_top);
        if clamped {
            *anchor = Some((position.x, position.y));
        }
        y
    } else if let Some((saved_x, saved_y)) = anchor.take() {
        x = saved_x;
        saved_y
    } else {
        position.y + size.height as i32 - height
    };
    drop(anchor);

    // Size first, then position: both calls are their own round trip to the
    // event loop, and the position is the one that has to be true of the frame
    // that ends up on screen.
    if let Err(err) = bar.set_size(PhysicalSize::new(size.width, height as u32)) {
        tracing::warn!(%err, "floating bar could not be resized");
        return;
    }
    if let Err(err) = bar.set_position(PhysicalPosition::new(x, y)) {
        tracing::warn!(%err, "floating bar could not be placed");
    }
}

/// Starts the ticker if it is not already running.
///
/// There is no event for "the window was minimized": tao reports focus, size
/// and move, and miniaturizing a macOS window is none of the three. So the bar
/// asks instead — four times a second, and only while a session is on. A raw
/// event would be tidier and is not available; this is the cheap half of the
/// trade.
fn start_ticker(app: &AppHandle) {
    if app.state::<MiniBar>().watching.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            let state = app.state::<MiniBar>();
            if !state.wanted.load(Ordering::SeqCst) {
                state.watching.store(false, Ordering::SeqCst);
                break;
            }
            let Some(main) = app.get_webview_window("main") else {
                continue;
            };
            // A window that cannot be read is assumed to be where it should be:
            // guessing "away" would put a bar on screen for someone who is
            // looking at the app itself.
            let visible = main.is_visible().unwrap_or(true);
            let minimized = main.is_minimized().unwrap_or(false);
            if visible && !minimized {
                // The reader is back, so a fold-away from the last time does
                // not apply to the next one.
                state.dismissed.store(false, Ordering::SeqCst);
            }
            let show = bar_belongs(
                state.wanted.load(Ordering::SeqCst),
                state.dismissed.load(Ordering::SeqCst),
                visible,
                minimized,
            );
            set_bar_visible(&app, show);
        }
    });
}

/// Shows or hides the bar, building it the first time it is wanted.
///
/// Built on demand rather than at launch: a reader who never listens — or who
/// turned the bar off — should not pay for a second webview. Creating it costs
/// one page load, and only the first time.
///
/// The "already in that state" check is not an optimisation. Asks the ticker
/// makes every 400ms, the answer is almost always the same one, and on macOS
/// showing a window that is already up goes through `makeKeyAndOrderFront` —
/// which would make the bar key again and again, pulling the keyboard out of
/// whatever the reader had switched to.
fn set_bar_visible(app: &AppHandle, visible: bool) {
    let bar = match app.get_webview_window(BAR_LABEL) {
        Some(bar) => bar,
        None if visible => match build_bar(app) {
            Ok(bar) => bar,
            Err(err) => {
                tracing::warn!(%err, "floating bar could not be created");
                return;
            }
        },
        None => return,
    };
    if bar.is_visible().unwrap_or(false) == visible {
        return;
    }
    let outcome = if visible { bar.show() } else { bar.hide() };
    if let Err(err) = outcome {
        tracing::warn!(%err, "floating bar could not be shown or hidden");
    }
}

fn build_bar(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        BAR_LABEL,
        // The same bundle as the main window, told apart by this one query
        // parameter: the shell is a memory router, so there is no route a
        // second window could be pointed at instead.
        WebviewUrl::App("index.html?mini=1".into()),
    )
    .title("方册 朗读")
    .inner_size(BAR_SIZE.0, BAR_SIZE.1)
    // A capsule lying on the desktop, so the window itself has to be nothing:
    // no frame, no shadow, and a transparent surface for the pill's rounded
    // corners to cut out of.
    .decorations(false)
    .shadow(false)
    .transparent(true)
    // Above its own app *and* above whatever the reader switched to. The bar is
    // only ever used while another app is in front, so a normal window level
    // would put it exactly where it can never be seen.
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
        builder = builder
            .position((screen.width - BAR_SIZE.0) / 2.0, screen.height - BAR_SIZE.1 - BAR_LIFT);
    }
    let window = builder.build()?;
    // `transparent(true)` sets `isOpaque = false`, but the app-wide
    // `backgroundColor` from tauri.conf is still painted underneath, and the
    // capsule is translucent — whatever the window fills with shows through it.
    // This is not what drew the rectangle the reader saw (that was the capsule's
    // own drop shadow, clipped by the window edge; see `html.mini-bar` in
    // globals.css), it is what makes the fill genuinely clear.
    #[cfg(target_os = "macos")]
    clear_background(&window)?;
    Ok(window)
}

/// AppKit, directly.
///
/// `transparent(true)` makes the window non-opaque but it still paints its
/// `backgroundColor`, and that fill is the rectangle the reader keeps seeing
/// around the capsule's rounded corners — the window is a rectangle, the pill
/// is not, and the four corners plus the 4px gutter show the fill.
#[cfg(target_os = "macos")]
fn clear_background(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let ns = window.ns_window()? as *mut AnyObject;
    // SAFETY: `ns_window` hands back this window's own NSWindow, and both
    // messages are ones NSWindow answers — and we are on the main thread, which
    // is where the window was just built.
    unsafe {
        let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns, setOpaque: false];
        let _: () = msg_send![ns, setBackgroundColor: clear];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bar_is_only_up_when_a_voice_is_on_and_the_window_is_away() {
        // The main window on screen: nothing to add, whatever else is true.
        assert!(!bar_belongs(true, false, true, false));
        // Minimized, hidden, or both — all three are "away".
        assert!(bar_belongs(true, false, false, false));
        assert!(bar_belongs(true, false, true, true));
        assert!(bar_belongs(true, false, false, true));
    }

    #[test]
    fn an_idle_app_never_shows_the_bar() {
        assert!(!bar_belongs(false, false, false, true));
    }

    #[test]
    fn a_folded_away_bar_stays_away_until_the_window_comes_back() {
        // Folded away while minimized: still away, even though that is exactly
        // the state that brought it out in the first place.
        assert!(!bar_belongs(true, true, true, true));
        assert!(!bar_belongs(true, true, false, false));
    }

    #[test]
    fn the_card_unfolds_upward_from_the_capsule() {
        // A bar lying near the dock: the bottom edge stays put and the top
        // moves up by exactly what the card adds.
        assert_eq!(resized_y(800, 56, 528, 0), (328, false));
        // Which is its own inverse — folding the card away needs nowhere
        // remembered, because the bottom it comes back to never moved.
        assert_eq!(resized_y(328, 528, 56, 0), (800, false));
    }

    #[test]
    fn a_drill_down_holds_the_same_bottom_edge_the_card_had() {
        // 语速 is a third of the main view: the bottom stays and the top comes
        // down, so the card closes from the top rather than walking off the
        // bottom of the screen.
        assert_eq!(resized_y(328, 528, 188, 0), (668, false));
        // And back out again, through the same edge.
        assert_eq!(resized_y(668, 188, 528, 0), (328, false));
    }

    #[test]
    fn a_card_with_no_room_above_stops_at_the_top_of_the_screen() {
        // Dragged up against the menu bar: the card cannot unfold past the work
        // area, and being told so is what makes the capsule's own place worth
        // remembering.
        assert_eq!(resized_y(10, 56, 528, 25), (25, true));
        // The clamp is a floor rather than a limiter: however far the
        // arithmetic lands above the work area, the answer is its top.
        assert_eq!(resized_y(25, 56, 528, 25), (25, true));
    }

    #[test]
    fn every_face_has_its_own_height_and_the_capsule_is_the_short_one() {
        assert_eq!(bar_height(BarFace::Capsule, false), BAR_SIZE.1);
        // Folded, the style is not a question anyone is asking.
        assert_eq!(bar_height(BarFace::Capsule, true), BAR_SIZE.1);
        assert_eq!(bar_height(BarFace::Main, false), CARD_HEIGHT);
        assert_eq!(bar_height(BarFace::Main, true), CARD_MINIMAL_HEIGHT);
        assert_eq!(bar_height(BarFace::Voice, false), CARD_HEIGHT);
    }

    #[test]
    fn the_drill_downs_are_shorter_than_the_main_view_and_minimal_shorter_still() {
        // The whole point of asking for a face: a row of rate chips under a
        // window sized for a sentence list is what the empty half of the card
        // looked like.
        for face in [BarFace::Speed, BarFace::Timer] {
            let height = bar_height(face, false);
            assert!(
                height < CARD_HEIGHT,
                "{face:?} must be shorter than the main view, got {height}"
            );
            // 简约 has no drill-downs — the card forces its main view — so the
            // axis cannot reach them, and a shorter card must still be shorter.
            assert_eq!(bar_height(face, true), height, "{face:?} ignores minimal");
            assert!(height > CARD_MINIMAL_HEIGHT, "{face:?} is more than a transport");
        }
    }
}
