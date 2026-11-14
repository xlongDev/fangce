//! `calibre.*` — read-only inspection of an external Calibre library.
//!
//! One command: the caller picks a directory, we say what is in it and which
//! of its files can be imported. Importing itself goes through the ordinary
//! `book.import` pipeline; the browser build has no filesystem, so callers
//! gate on desktop runtime, the same way the duplicate report does.

use std::path::PathBuf;

use crate::error::{AppError, AppResult};
use crate::library::calibre::{self, CalibreScan};

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
