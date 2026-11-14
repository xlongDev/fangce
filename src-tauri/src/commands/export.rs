//! Commands that get things out of the app as a file: `notes.*` for
//! highlights, `library.export_catalog` for the shelf's inventory.

use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// `notes.export` — writes one book's highlights and notes to a readable file.
///
/// The destination extension picks the format (`.md` or `.csv`), the same
/// contract `pack.export` follows: what the save dialog promised is what gets
/// written. `flavor` picks the Markdown *dialect* without touching the
/// extension, because Obsidian only ever indexes `.md` — see
/// [`crate::library::export::OBSIDIAN`]. The write happens off the main thread
/// because it reads the whole annotation list and touches the disk — small work,
/// but the reader is waiting on a button.
#[tauri::command]
#[specta::specta]
pub async fn notes_export(
    state: State<'_, AppState>,
    id: String,
    path: String,
    flavor: Option<String>,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::export::export(
            &library,
            &id,
            PathBuf::from(&path).as_path(),
            flavor.as_deref(),
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}

/// `notes.export_selection` — writes the highlights a screen is showing,
/// across as many books as they come from.
///
/// Two arguments rather than one because the two answer different questions:
/// `ids` is the set the reader narrowed to (a search, or 有笔记), and `book_ids`
/// is the order the screen put them in, which is the shelf's. Sending only the
/// ids would lose the order; sending only the books would lose the narrowing.
#[tauri::command]
#[specta::specta]
pub async fn notes_export_selection(
    state: State<'_, AppState>,
    book_ids: Vec<String>,
    ids: Vec<String>,
    path: String,
    flavor: Option<String>,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::export::export_selection(
            &library,
            &book_ids,
            &ids,
            PathBuf::from(&path).as_path(),
            flavor.as_deref(),
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}

/// `library.export_catalog` — writes the shelf as a CSV book list to `path`.
///
/// Desktop only: the save panel hands over a path, and the file lands where the
/// reader pointed. The web build has no filesystem and no local implementation
/// of this command, so its settings page does not offer the row. A browser
/// download would mean a second renderer for the same columns, which is not
/// worth it for a one-way list the backup archive already covers.
///
/// `spawn_blocking` because it reads the whole shelf and writes a file. The
/// count comes back so the row can say how many books were listed rather than
/// just 「已导出」 — an empty shelf is a different outcome from a filled one.
#[tauri::command]
#[specta::specta]
pub async fn library_export_catalog(state: State<'_, AppState>, path: String) -> AppResult<usize> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::catalog::export(&library, PathBuf::from(&path).as_path())
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}

/// `card.save` — writes a rendered share card (PNG bytes) where the reader
/// pointed.
///
/// The bytes are the frontend's: the card is drawn on a canvas (see
/// `quoteCard.ts`), so there is no library state to consult and no book id to
/// look up — this is a plain file write with the notes export's job. It exists
/// as a command rather than a frontend download because the desktop reader
/// gets a real save panel; the browser build keeps using its own download.
#[tauri::command]
#[specta::specta]
pub async fn card_save(path: String, bytes: Vec<u8>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(PathBuf::from(&path), &bytes))
        .await
        .map_err(|err| AppError::Message(format!("保存任务被中断：{err}")))?
        .map_err(|err| AppError::Message(format!("图片保存失败：{err}")))
}
