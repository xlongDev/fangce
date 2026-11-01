//! Process wide state injected into every command handler.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::db::{Layout, Library};

/// Values resolved once during setup and shared with commands.
pub struct AppState {
    /// Process start time, used to report uptime without a second clock.
    pub started_at: Instant,
    /// Per-user data directory layout: database, books and covers live here.
    pub layout: Layout,
    /// The open library database. Cheap to clone, so commands can hand one to
    /// a blocking task.
    pub library: Library,
    /// The turns currently streaming, so the reader can stop one.
    pub ai_runs: AiRuns,
}

/// One flag per in-flight AI turn, keyed by request id.
///
/// A flag rather than an abort handle: the loop reads it before each round and
/// on every streamed chunk, and dropping the response closes the connection.
/// That covers a turn waiting on the model as well as one about to run another
/// tool.
///
/// Keyed by request id because the renderer may have more than one in flight —
/// a selection lookup while the panel is answering — and stopping one must not
/// stop the others.
#[derive(Default)]
pub struct AiRuns {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AiRuns {
    /// Registers a turn and hands back the flag its loop watches.
    pub fn begin(&self, request_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut flags) = self.flags.lock() {
            // A reused id replaces the old flag: the previous turn is over, and
            // keeping its flag would leak one entry per re-ask.
            flags.insert(request_id.to_string(), flag.clone());
        }
        flag
    }

    /// Asks the turn with this id to stop. Unknown ids are ignored — the reader
    /// may press stop a moment after the answer already arrived.
    pub fn cancel(&self, request_id: &str) {
        if let Ok(flags) = self.flags.lock()
            && let Some(flag) = flags.get(request_id)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Forgets a finished turn.
    pub fn end(&self, request_id: &str) {
        if let Ok(mut flags) = self.flags.lock() {
            flags.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_turn_reports_itself_and_leaves_the_others_alone() {
        let runs = AiRuns::default();
        let first = runs.begin("r1");
        let second = runs.begin("r2");

        runs.cancel("r1");
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed), "停一个不该停另一个");

        // A finished turn is forgotten, so the table does not grow by one entry
        // per question for the life of the process.
        runs.end("r1");
        assert_eq!(runs.flags.lock().expect("锁").len(), 1);
        // Cancelling after the turn is gone is not an error; it reaches nothing.
        runs.cancel("r1");
        assert!(!second.load(Ordering::Relaxed));
    }

    #[test]
    fn reusing_an_id_starts_from_a_clean_flag() {
        let runs = AiRuns::default();
        let first = runs.begin("r1");
        runs.cancel("r1");
        assert!(first.load(Ordering::Relaxed));

        let again = runs.begin("r1");
        assert!(!again.load(Ordering::Relaxed), "上一轮的停止不该传给这一轮");
    }
}
