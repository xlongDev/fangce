//! `ops.*` — the record of what changed in the library.
//!
//! One command, because there is one question: what happened lately. The rows
//! are written by whoever did the change (a `book.*` command or an MCP tool),
//! not here.

use tauri::State;

use crate::error::AppResult;
use crate::library::ops::{self, Operation, Undo};
use crate::state::AppState;

/// `ops.list` — the newest changes, newest first.
#[tauri::command]
#[specta::specta]
pub fn ops_list(state: State<'_, AppState>, limit: usize) -> AppResult<Vec<Operation>> {
    state.library.with(|conn| ops::list(conn, limit))
}

/// `ops.undo` — puts back what one call changed.
///
/// One transaction: the writes and the marker row that stops the page from
/// offering the same undo twice.
#[tauri::command]
#[specta::specta]
pub fn ops_undo(state: State<'_, AppState>, call_id: String) -> AppResult<Undo> {
    let covers_dir = state.layout.covers_dir.clone();
    state.library.with_tx(|tx| ops::undo(tx, &call_id, &covers_dir))
}
