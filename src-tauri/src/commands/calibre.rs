//! `calibre.*` — read-only inspection of an external Calibre library, then an
//! opt-in write into 方册's own shelf.
//!
//! The scan never opens `metadata.db` for writing. Importing the files it
//! found goes through the ordinary `book.import` pipeline. The second command
//! answers a different question: `book.import` returns an id per path, and the
//! renderer pairs those with the scanned books so their metadata can be
//! copied into 方册. Nothing here touches Calibre again.
//!
//! The browser build has no filesystem, so callers gate on desktop runtime,
//! the same way the duplicate report does.

use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::calibre::{self, CalibreScan};
use crate::library::calibre_fill::{self, CalibreApplyResult, CalibreFill};
use crate::state::AppState;

/// `calibre.scan` — never opens the directory for writing.
///
/// A scan reads one directory per book, so a large library is thousands of
/// filesystem calls. Blocking the UI thread for that would freeze the shelf;
/// `book.import` uses the same `spawn_blocking` shape.
#[tauri::command]
#[specta::specta]
pub async fn calibre_scan(path: String) -> AppResult<CalibreScan> {
    tauri::async_runtime::spawn_blocking(move || calibre::scan(&PathBuf::from(path)))
        .await
        .unwrap_or_else(|err| Err(AppError::Message(format!("扫描任务失败：{err}"))))
}

/// `calibre.applyMetadata` — copies the scanned metadata onto imported books.
///
/// Synchronous like `metadata.apply`: this is one transaction over rows that
/// are already in the library, not disk IO over a thousand directories. The
/// caller sends only the outcomes that succeeded; failed paths have no id and
/// must not be written to.
#[tauri::command]
#[specta::specta]
pub fn calibre_apply_metadata(
    state: State<'_, AppState>,
    fills: Vec<CalibreFill>,
) -> AppResult<CalibreApplyResult> {
    state.library.with_tx(|tx| calibre_fill::apply(tx, &fills))
}
