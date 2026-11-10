//! `book.*` commands: shelf queries, import and mutations.
//!
//! Read-only queries stay synchronous: they touch an indexed table and return
//! in microseconds. Anything that hashes or unlinks files moves to a blocking
//! task so the UI thread never waits on the disk.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::chapters;
use crate::library::import::{self, ImportOutcome};
use crate::library::repository::{self, BookQuery, BookSummary, LibraryFacets, LibraryStats};
use crate::library::{self};
use crate::state::AppState;

/// Emitted once per file while an import batch runs.
pub const IMPORT_PROGRESS_EVENT: &str = "book://import-progress";

/// Emitted once per book while a batch delete runs. Same shape and purpose as
/// [`IMPORT_PROGRESS_EVENT`]: a long batch is a counter, not a frozen shelf.
pub const DELETE_PROGRESS_EVENT: &str = "book://delete-progress";

/// `book.list`
#[tauri::command]
#[specta::specta]
pub fn book_list(state: State<'_, AppState>, query: BookQuery) -> AppResult<Vec<BookSummary>> {
    state.library.with(|conn| crate::library::repository::list(conn, &query))
}

/// `book.get`
#[tauri::command]
#[specta::specta]
pub fn book_get(state: State<'_, AppState>, id: String) -> AppResult<Option<BookSummary>> {
    state.library.with(|conn| crate::library::repository::get(conn, &id))
}

/// `book.stats`
#[tauri::command]
#[specta::specta]
pub fn book_stats(state: State<'_, AppState>) -> AppResult<LibraryStats> {
    state.library.with(crate::library::repository::stats)
}

/// `book.facets` — the counts behind the shelf's filter panel.
///
/// Takes the same `BookQuery` the shelf is showing, because a facet is only
/// honest next to the filters it is counted against.
#[tauri::command]
#[specta::specta]
pub fn book_facets(state: State<'_, AppState>, query: BookQuery) -> AppResult<LibraryFacets> {
    state.library.with(|conn| crate::library::repository::facets(conn, &query))
}

/// `book.images` — every image in the book, in reading order, with the
/// chapter each one sits in. Powers the lightbox's book-wide browsing.
#[tauri::command]
#[specta::specta]
pub fn book_images(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<crate::library::chapters::BookImage>> {
    state.library.with(|conn| crate::library::chapters::images(conn, &id))
}

/// `book.asset` — raw bytes of one image inside a book's source file.
///
/// Chapters reference images by archive entry path (see
/// `IMAGE_PARAGRAPH_PREFIX`), or by `#<id>` for FB2's inlined binaries. The
/// reader calls this lazily so a chapter with no images never touches the
/// container. Returns over the binary IPC channel.
#[tauri::command]
pub async fn book_asset(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> AppResult<tauri::ipc::Response> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if path.split('/').any(|segment| segment == "..") {
            return Err(AppError::Parse("非法的资源路径".into()));
        }
        let (file_path, format) = library.with(|conn| library::repository::source(conn, &id))?;
        let bytes = crate::document::read_asset(std::path::Path::new(&file_path), format, &path)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|err| AppError::Message(format!("读取资源任务被中断：{err}")))?
}

/// `book.source_file` — the whole stored source file, for clients that render
/// it themselves (the PDF reader hands the bytes to pdf.js). Returns over the
/// binary IPC channel.
#[tauri::command]
pub async fn book_source_file(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<tauri::ipc::Response> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (file_path, _) = library.with(|conn| library::repository::source(conn, &id))?;
        // Same re-labelling as `document::read_*`: a PDF the reader cannot open
        // because its file is gone should say so, not report an errno.
        let bytes = std::fs::read(&file_path).map_err(|err| {
            AppError::missing_source(std::path::Path::new(&file_path), err.into())
        })?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|err| AppError::Message(format!("读取书籍文件被中断：{err}")))?
}

/// `book.export` — saves a copy of the book's own file wherever the reader
/// asks for it.
///
/// The bytes are the ones that were imported, unchanged: an epub saved here
/// opens in any other reader, a PDF in any PDF reader. That is the difference
/// from `pack.export`, which writes a `.ctz` carrying the metadata and the
/// highlights as well — richer, but only this app reads it back, so it is no
/// use for handing a book to somebody else.
///
/// The path is read under the lock and the copy happens outside it: a 200 MB
/// PDF is a slow write, and the library owns the app's single connection (see
/// the note on `with`).
#[tauri::command]
#[specta::specta]
pub async fn book_export(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (file_path, _) = library.with(|conn| library::repository::source(conn, &id))?;
        std::fs::copy(file_path, &path)?;
        Ok(())
    })
    .await
    .map_err(|err| AppError::Message(format!("导出书籍文件被中断：{err}")))?
}

/// `book.source_url` — the protocol URL the reader streams the source file
/// from. Pure: the origin is a compile-time constant per platform, so this
/// does no I/O and answers instantly.
#[tauri::command]
#[specta::specta]
pub fn book_source_url(id: String) -> String {
    crate::library::book_url(&id)
}

/// `book.cover_save` — stores a PNG the frontend rendered for a book whose
/// cover cannot be extracted on the Rust side (PDF first pages, drawn by
/// pdf.js). The bytes must start with the PNG magic; anything else is a bug
/// in the caller, not user input to decode.
#[tauri::command]
#[specta::specta]
pub async fn book_cover_save(
    state: State<'_, AppState>,
    id: String,
    bytes: Vec<u8>,
) -> AppResult<()> {
    const MAX_COVER_BYTES: usize = 12 * 1024 * 1024;
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    if bytes.len() > MAX_COVER_BYTES || !bytes.starts_with(&PNG_MAGIC) {
        return Err(AppError::Parse("封面必须是 PNG 且小于 12 MB".into()));
    }
    let library = state.library.clone();
    let layout = state.layout.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Only touch the disk for books the library actually knows.
        library.with(|conn| library::repository::get(conn, &id))?;
        let target = layout.covers_dir.join(format!("{id}.png"));
        std::fs::write(&target, &bytes)?;
        library
            .with(|conn| {
                library::repository::set_cover(conn, &id, target.to_string_lossy().as_ref())
            })
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&target);
            })
    })
    .await
    .map_err(|err| AppError::Message(format!("保存封面任务被中断：{err}")))?
}

/// `book.import`
///
/// Takes absolute paths chosen by the native file dialog or dropped onto the
/// window. One bad file never aborts the batch; each outcome is returned so the
/// UI can summarise what happened.
///
/// The batch is hashed, parsed and copied four files at a time (see
/// [`import::import_files`]); the whole run still lives on one blocking task, so
/// the UI thread never waits on it.
///
/// `password` only matters to `.ctzx` packs. It travels as an argument rather
/// than in a prompt callback so the whole batch runs on one blocking task.
#[tauri::command]
#[specta::specta]
pub async fn book_import(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    password: Option<String>,
) -> AppResult<Vec<ImportOutcome>> {
    let library = state.library.clone();
    let layout = state.layout.clone();
    let targets: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();

    let outcomes = tauri::async_runtime::spawn_blocking(move || {
        import::import_files(
            &library,
            &layout,
            &targets,
            password.as_deref(),
            &|done, total, path| {
                // A closed window simply stops listening; losing the event is fine.
                let _ = app.emit(
                    IMPORT_PROGRESS_EVENT,
                    ImportProgress { done, total, path: path.to_string() },
                );
            },
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导入任务被中断：{err}")))?;

    let imported = outcomes.iter().filter(|outcome| outcome.is_success()).count();
    tracing::info!(imported, total = outcomes.len(), "导入批次完成");

    backfill_deferred_chapters(state.library.clone());
    Ok(outcomes)
}

/// Extracts the chapter text of every book whose import deferred it — PDFs,
/// whose index is written but whose per-page text is not.
///
/// Fire-and-forget on purpose: the import has already answered, and the point
/// of deferring is that the shelf does not wait. Idempotent, and it clears the
/// same flag `chapters::backfill` watches, so a reader or a search racing this
/// pass is harmless and a pass that never finished simply runs again — the
/// reader's own paths pay the debt inline when that happens.
fn backfill_deferred_chapters(library: Library) {
    tauri::async_runtime::spawn_blocking(move || {
        let pending = match library.with(repository::pending_chapters) {
            Ok(pending) => pending,
            Err(err) => {
                tracing::warn!(error = %err, "查询待补章节的书失败");
                return;
            }
        };
        for id in pending {
            match chapters::backfill(&library, &id) {
                Ok(()) => tracing::debug!(book = %id, "章节正文补齐"),
                Err(err) => tracing::warn!(book = %id, error = %err, "补齐章节正文失败"),
            }
        }
    });
}

/// `pack.export` — writes one book to a `.ctz` or `.ctzx` file.
///
/// The destination extension picks the format: `.ctzx` requires `password` and
/// encrypts the archive with AES-256-GCM under an Argon2id key.
#[tauri::command]
#[specta::specta]
pub async fn pack_export(
    state: State<'_, AppState>,
    id: String,
    path: String,
    password: Option<String>,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::pack::export(
            &library,
            &id,
            PathBuf::from(&path).as_path(),
            password.as_deref(),
        )
    })
    .await
    .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
}

/// `book.migrate` — move a reader's marks onto a re-imported edition.
///
/// Re-importing a file that changed is a new book: `content_hash` is the
/// identity key, so the corrected file lands beside the old one carrying
/// nothing. This copies the marks across and then removes the old edition,
/// which is what "replace" means to somebody who fixed a typo in their epub.
///
/// The old edition is deleted *after* the copy commits, and the copy leaves it
/// in place until then — so a failure here costs the reader nothing they had.
#[tauri::command]
#[specta::specta]
pub async fn book_migrate(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> AppResult<Migrated> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let moved = library::migrate::migrate(&library, &from, &to)?;
        library::delete_book(&library, &from)?;
        Ok(Migrated {
            annotations: moved.annotations,
            unlocated: moved.unlocated,
            bookmarks: moved.bookmarks,
            progress: moved.progress,
        })
    })
    .await
    .map_err(|err| AppError::Message(format!("迁移任务被中断：{err}")))?
}

/// What one `book.migrate` carried across, for the dialog that asked for it.
#[derive(specta::Type, Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Migrated {
    pub annotations: usize,
    /// Highlights whose text the new file does not contain. Reported rather
    /// than swallowed: a reader who is told "3 of 30 could not be found" knows
    /// what to look for, one who is told nothing loses three highlights.
    pub unlocated: usize,
    pub bookmarks: usize,
    pub progress: bool,
}

/// `book.delete`
#[tauri::command]
#[specta::specta]
pub async fn book_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || library::delete_book(&library, &id))
        .await
        .map_err(|err| AppError::Message(format!("删除任务被中断：{err}")))?
}

/// `book.deleteMany` — the shelf's batch bar.
///
/// One transaction for the whole selection rather than one `book.delete` per
/// book: twenty books meant twenty transactions, and twenty book-list
/// invalidations on the frontend. All or nothing, so a stale id cannot leave
/// the shelf half-deleted.
///
/// Emits [`DELETE_PROGRESS_EVENT`] once per book, so the shelf can count a long
/// batch down instead of watching a disabled bar. `book.delete` — one book —
/// emits nothing: a counter reading 1/1 is noise, and its dialog already has a
/// pending state on the confirm button.
#[tauri::command]
#[specta::specta]
pub async fn book_delete_many(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library::delete_books(&library, &ids, &mut |done, total, path| {
            // A closed window simply stops listening; losing the event is fine.
            let _ = app.emit(
                DELETE_PROGRESS_EVENT,
                DeleteProgress { done, total, path: path.to_string() },
            );
        })
    })
    .await
    .map_err(|err| AppError::Message(format!("删除任务被中断：{err}")))?
}

/// `book.restore` — takes books back out of the trash.
///
/// One command for one book and for a batch: a restore writes a timestamp and
/// cannot fail half-way through, so there is no progress to report and no
/// all-or-nothing question worth a second command.
#[tauri::command]
#[specta::specta]
pub fn book_restore(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    library::restore_books(&state.library, &ids)
}

/// `book.purge` — deletes one book and its files, for good.
///
/// Only reachable from the bin. `book.delete` is the reversible half.
#[tauri::command]
#[specta::specta]
pub async fn book_purge(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || library::purge_book(&library, &id))
        .await
        .map_err(|err| AppError::Message(format!("彻底删除任务被中断：{err}")))?
}

/// `book.purgeMany` — the bin's batch bar. Same contract as
/// [`book_delete_many`], including the progress event.
#[tauri::command]
#[specta::specta]
pub async fn book_purge_many(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<()> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library::purge_books(&library, &ids, &mut |done, total, path| {
            let _ = app.emit(
                DELETE_PROGRESS_EVENT,
                DeleteProgress { done, total, path: path.to_string() },
            );
        })
    })
    .await
    .map_err(|err| AppError::Message(format!("彻底删除任务被中断：{err}")))?
}

/// `book.emptyTrash` — everything in the bin, gone. Returns how many books went.
#[tauri::command]
#[specta::specta]
pub async fn book_empty_trash(state: State<'_, AppState>) -> AppResult<usize> {
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || library::empty_trash(&library))
        .await
        .map_err(|err| AppError::Message(format!("清空回收站被中断：{err}")))?
}

/// `book.setFavorite`
#[tauri::command]
#[specta::specta]
pub fn book_set_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> AppResult<()> {
    state.library.with(|conn| crate::library::repository::set_favorite(conn, &id, favorite))
}

/// `book.setFavoriteMany` — the batch bar's 收藏 / 取消收藏, one transaction.
#[tauri::command]
#[specta::specta]
pub fn book_set_favorite_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
    favorite: bool,
) -> AppResult<()> {
    state.library.with_tx(|tx| crate::library::repository::set_favorite_many(tx, &ids, favorite))
}

/// `book.update` — rewrites title, authors and the descriptive fields.
///
/// Synchronous: it is a handful of row updates on an indexed table, far
/// cheaper than the round trip that asked for it. The reader keeps whatever
/// position it had — none of these columns are a reading anchor.
#[tauri::command]
#[specta::specta]
pub fn book_update(
    state: State<'_, AppState>,
    id: String,
    patch: crate::library::repository::BookMetadataPatch,
) -> AppResult<()> {
    state.library.with_tx(|tx| crate::library::repository::update_metadata(tx, &id, &patch))
}

/// Progress payload for [`IMPORT_PROGRESS_EVENT`].
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
    pub path: String,
}

/// Progress payload for [`DELETE_PROGRESS_EVENT`]. `path` is the source file of
/// the book whose rows just went — the same field import reports, and for the
/// same reason: the count is what the shelf draws, the path is what a log line
/// or a future summary can use.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProgress {
    pub done: usize,
    pub total: usize,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_payload_is_camel_case() {
        let value = serde_json::to_value(ImportProgress {
            done: 2,
            total: 5,
            path: "/books/a.epub".into(),
        })
        .expect("payload must serialize");
        assert_eq!(value["done"], 2);
        assert_eq!(value["total"], 5);
        assert_eq!(value["path"], "/books/a.epub");
    }

    #[test]
    fn progress_event_is_namespaced() {
        assert!(IMPORT_PROGRESS_EVENT.starts_with("book://"));
        assert!(DELETE_PROGRESS_EVENT.starts_with("book://"));
        assert_ne!(IMPORT_PROGRESS_EVENT, DELETE_PROGRESS_EVENT);
    }

    #[test]
    fn delete_progress_payload_is_camel_case() {
        let value = serde_json::to_value(DeleteProgress {
            done: 3,
            total: 12,
            path: "/books/b.epub".into(),
        })
        .expect("payload must serialize");
        assert_eq!(value["done"], 3);
        assert_eq!(value["total"], 12);
        assert_eq!(value["path"], "/books/b.epub");
    }
}
