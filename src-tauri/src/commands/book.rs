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
use crate::library::{self, ops};
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

/// Moves the picture a replacement is about to take away, so 撤销 can put it
/// back.
///
/// `None` for no previous picture, and — the case that matters — for a path
/// outside the covers directory: an imported cover is the reader's own file,
/// and replacing what the shelf shows must not move it.
///
/// A rename rather than a copy: one file, not two, and the old path is free for
/// the new picture.
///
/// One book keeps **one** previous picture (`{id}.prev.<ext>`), not a stack of
/// them: 撤销 is one step, and a copy per replacement would grow the covers
/// directory forever. Replacing twice forgets the first picture, which is the
/// honest limit of what a single undo can promise.
fn move_aside(
    previous: Option<&str>,
    covers_dir: &std::path::Path,
    id: &str,
) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let old = std::path::PathBuf::from(previous?);
    if old.parent() != Some(covers_dir) || !old.exists() {
        return None;
    }
    forget_backups(covers_dir, id);
    let extension = old.extension().and_then(|value| value.to_str()).unwrap_or("jpg");
    let kept = covers_dir.join(format!("{id}.prev.{extension}"));
    std::fs::rename(&old, &kept).ok().map(|()| (old, kept))
}

/// Removes whatever `{id}.prev.*` is lying around — the picture kept for a
/// single undo, and the last thing to clean up when a book is purged.
fn forget_backups(covers_dir: &std::path::Path, id: &str) {
    let prefix = format!("{id}.prev.");
    let Ok(entries) = std::fs::read_dir(covers_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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
    tauri::async_runtime::spawn_blocking(move || {
        library::delete_book(&library, &id)?;
        library.with(|conn| {
            ops::record(conn, ops::Source::Ui, "trash", std::slice::from_ref(&id), "移到回收站")
        })
    })
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
        })?;
        library.with(|conn| ops::record(conn, ops::Source::Ui, "trash", &ids, "移到回收站"))
    })
    .await
    .map_err(|err| AppError::Message(format!("删除任务被中断：{err}")))?
}

/// `book.setMetadataMany` — the batch bar's 编辑信息.
///
/// Two fields, and a field left out is a field left alone: `publisher` and
/// `language` are the facts that belong to a shelf's worth of books at once.
/// Returns how many rows were written, so the bar can say what it did.
#[tauri::command]
#[specta::specta]
pub fn book_set_metadata_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
    patch: crate::library::repository::BookFieldsPatch,
) -> AppResult<usize> {
    let summary = match (&patch.publisher, &patch.language) {
        (Some(publisher), None) => format!("批量改出版社：{publisher}"),
        (None, Some(language)) => format!("批量改语言：{language}"),
        (Some(publisher), Some(language)) => format!("批量改出版社：{publisher}，语言：{language}"),
        (None, None) => "批量改书籍信息".to_string(),
    };
    // Before the write, for the same reason as the single-book path.
    let befores: Vec<ops::Before> = state.library.with(|conn| {
        let mut out = Vec::new();
        for id in &ids {
            if let Some(before) = ops::snapshot_of(conn, id)? {
                out.push(before);
            }
        }
        Ok(out)
    })?;
    let written = library::set_metadata_fields(&state.library, &ids, &patch)?;
    state.library.with(|conn| {
        ops::record_before(conn, ops::Source::Ui, "batch_metadata", &befores, &summary)
    })?;
    Ok(written)
}

/// `book.restore` — takes books back out of the trash.
///
/// One command for one book and for a batch: a restore writes a timestamp and
/// cannot fail half-way through, so there is no progress to report and no
/// all-or-nothing question worth a second command.
#[tauri::command]
#[specta::specta]
pub fn book_restore(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    library::restore_books(&state.library, &ids)?;
    state.library.with(|conn| ops::record(conn, ops::Source::Ui, "restore", &ids, "从回收站恢复"))
}

/// `book.purge` — deletes one book and its files, for good.
///
/// Only reachable from the bin. `book.delete` is the reversible half.
#[tauri::command]
#[specta::specta]
pub async fn book_purge(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Recorded before the row goes: the title is copied at write time, and
        // after the purge there is nothing left to copy it from.
        library.with(|conn| {
            ops::record(conn, ops::Source::Ui, "purge", std::slice::from_ref(&id), "彻底删除")
        })?;
        library::purge_book(&library, &id)?;
        // The picture kept for a single undo has nothing left to be restored
        // to.
        forget_backups(&covers_dir, &id);
        Ok(())
    })
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
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.with(|conn| ops::record(conn, ops::Source::Ui, "purge", &ids, "彻底删除"))?;
        library::purge_books(&library, &ids, &mut |done, total, path| {
            let _ = app.emit(
                DELETE_PROGRESS_EVENT,
                DeleteProgress { done, total, path: path.to_string() },
            );
        })?;
        for id in &ids {
            forget_backups(&covers_dir, id);
        }
        Ok(())
    })
    .await
    .map_err(|err| AppError::Message(format!("彻底删除任务被中断：{err}")))?
}

/// `book.emptyTrash` — everything in the bin, gone. Returns how many books went.
#[tauri::command]
#[specta::specta]
pub async fn book_empty_trash(state: State<'_, AppState>) -> AppResult<usize> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids = library::empty_trash(&library)?;
        library
            .with(|conn| ops::record(conn, ops::Source::Ui, "empty_trash", &ids, "清空回收站"))?;
        for id in &ids {
            forget_backups(&covers_dir, id);
        }
        Ok(ids.len())
    })
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

/// `book.update` — rewrites title, authors and the descriptive fields, and
/// optionally the picture.
///
/// Async because of the cover: a download held inside the library's single
/// connection would freeze the shelf for as long as somebody else's server
/// takes. The bytes are fetched first; one transaction then writes the row, the
/// file and one log entry.
///
/// 🔴 **One save is one record.** The cover used to be its own command with its
/// own call id, so every save that also replaced the picture produced two rows
/// — 「改了书籍信息」 and 「换了封面」 — two lines for one click, and two undo
/// buttons for one decision. The reader has no way to know those were the same
/// action, and the log stopped being readable.
///
/// Returns whether the picture landed. A cover that will not download is not a
/// reason to drop the fields that did.
#[tauri::command]
#[specta::specta]
pub async fn book_update(
    state: State<'_, AppState>,
    id: String,
    patch: crate::library::repository::BookMetadataPatch,
    cover_url: Option<String>,
) -> AppResult<bool> {
    let fetched = match cover_url.as_deref() {
        Some(url) => {
            let client = crate::library::metadata::client();
            match crate::library::metadata::download_cover(&client, url).await {
                Ok(bytes) => crate::library::metadata::image_extension(&bytes)
                    .map(|extension| (bytes, extension)),
                // The fields still go in; the picture is one more thing the
                // next attempt can try.
                Err(_) => None,
            }
        }
        None => None,
    };

    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cover = fetched.as_ref().map(|(bytes, extension)| (bytes.as_slice(), *extension));
        write_update(&library, &covers_dir, &id, &patch, cover)
    })
    .await
    .map_err(|err| AppError::Message(format!("保存被中断：{err}")))?
}

/// The transaction half of [`book_update`], separated so the promise 「一次保存
/// 一条记录」 can be tested without a Tauri app handle.
///
/// The before-image is read first, the row is written, the picture lands if one
/// came with it, and **one** log entry covers all of it. Splitting the cover
/// back out into its own command is what produced two rows and two undo
/// buttons for one click.
fn write_update(
    library: &crate::db::Library,
    covers_dir: &std::path::Path,
    id: &str,
    patch: &crate::library::repository::BookMetadataPatch,
    cover: Option<(&[u8], &'static str)>,
) -> AppResult<bool> {
    library.with_tx(|tx| {
        // Read first: the before-image is what makes the change undoable, and
        // after the write there is nothing left to read it from.
        let mut before = ops::snapshot_of(tx, id)?;
        crate::library::repository::update_metadata(tx, id, patch)?;

        let mut saved = false;
        if let Some((bytes, extension)) = cover {
            let target = covers_dir.join(format!("{id}.{extension}"));
            // 🔴 Move the picture being replaced aside **before** writing. A
            // same-format replacement overwrites those bytes, and 撤销 needs
            // them to put the old cover back. A rename, not a copy: one file,
            // not two, and the old path is free for the new picture.
            let moved =
                move_aside(before.as_ref().and_then(|b| b.cover_path.as_deref()), covers_dir, id);
            if let Err(err) = std::fs::write(&target, bytes) {
                // Put the old picture back where the row still points to it.
                if let Some((old, kept)) = &moved {
                    let _ = std::fs::rename(kept, old);
                }
                return Err(err.into());
            }
            crate::library::repository::set_cover(tx, id, target.to_string_lossy().as_ref())?;
            if let (Some(before), Some((_, kept))) = (before.as_mut(), moved) {
                before.cover_previous = Some(kept.to_string_lossy().into_owned());
            }
            saved = true;
        }

        if let Some(before) = before {
            // One record, but a distinct action when it also carried a picture:
            // 「我什么时候换过封面」 and 「谁改了出版社」 are both questions this
            // line has to answer, and a filter can only find it if the row says
            // what happened.
            let (action, summary) = if saved {
                ("update_metadata_cover", "改了书籍信息，换了封面")
            } else {
                ("update_metadata", "改了书籍信息")
            };
            ops::record_before(tx, ops::Source::Ui, action, &[before], summary)?;
        }
        Ok(saved)
    })
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

    /// 🔴 One save is one record. The cover used to be a separate command with
    /// its own call id, so a save that also replaced the picture left two rows
    /// — 「改了书籍信息」 and 「换了封面」 — and two undo buttons for one click. A
    /// reader cannot tell those were the same decision.
    #[test]
    fn one_save_writes_one_record_even_when_it_changes_the_cover() {
        let dir = crate::document::fixture::temp_dir("book-update-cover");
        let library = crate::db::Library::open(&dir).expect("open");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers");

        library
            .with_tx(|tx| {
                crate::library::repository::insert(
                    tx,
                    &crate::library::repository::NewBook {
                        id: "b1",
                        title: "三体",
                        subtitle: None,
                        description: None,
                        language: Some("zh"),
                        publisher: None,
                        identifier: None,
                        format: crate::document::BookFormat::Epub,
                        content_hash: "h1",
                        file_path: "/books/x.epub",
                        file_size: 1,
                        cover_path: None,
                        authors: &[],
                    },
                )
            })
            .expect("seed");

        let patch = crate::library::repository::BookMetadataPatch {
            title: "三体".into(),
            subtitle: None,
            publisher: Some("重庆出版社".into()),
            language: Some("zh".into()),
            isbn: None,
            published_year: None,
            description: None,
            rating: None,
            rating_count: None,
            rating_source: None,
            douban_url: None,
            authors: Vec::new(),
        };
        let jpeg = b"\xff\xd8\xff\xe0";
        let saved =
            write_update(&library, &covers, "b1", &patch, Some((jpeg, "jpg"))).expect("save");
        assert!(saved, "封面写进去了");

        let rows = library.with(|conn| crate::library::ops::list(conn, 10)).expect("list");
        assert_eq!(rows.len(), 1, "一次保存只有一条记录");
        assert_eq!(rows[0].action, "update_metadata_cover", "这一行说自己换了封面");
        assert!(rows[0].summary.contains("封面"), "摘要要说清这次也换了封面");
        assert!(rows[0].undoable, "一条记录，一个撤销按钮");

        let book = library.with(|conn| crate::library::repository::get(conn, "b1"));
        let book = book.expect("get").expect("b1");
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"));
        assert!(book.cover_url.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 🔴 The whole promise of 撤销: replace a cover, undo, and the book is
    /// showing its own picture again. The old file is gone from its old path by
    /// then, so this only works because the replacement moved it aside first.
    #[test]
    fn undo_puts_the_replaced_cover_back() {
        let dir = crate::document::fixture::temp_dir("book-cover-undo");
        let library = crate::db::Library::open(&dir).expect("open");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers");

        let old = covers.join("b1.png");
        std::fs::write(&old, b"\x89PNG\r\n\x1a\nold").expect("old cover");

        library
            .with_tx(|tx| {
                crate::library::repository::insert(
                    tx,
                    &crate::library::repository::NewBook {
                        id: "b1",
                        title: "三体",
                        subtitle: None,
                        description: None,
                        language: Some("zh"),
                        publisher: None,
                        identifier: None,
                        format: crate::document::BookFormat::Epub,
                        content_hash: "h1",
                        file_path: "/books/x.epub",
                        file_size: 1,
                        cover_path: Some(old.to_str().expect("path")),
                        authors: &[],
                    },
                )
            })
            .expect("seed");

        let patch = crate::library::repository::BookMetadataPatch {
            title: "三体".into(),
            subtitle: None,
            publisher: None,
            language: Some("zh".into()),
            isbn: None,
            published_year: None,
            description: None,
            rating: None,
            rating_count: None,
            rating_source: None,
            douban_url: None,
            authors: Vec::new(),
        };
        let jpeg = b"\xff\xd8\xffnew";
        write_update(&library, &covers, "b1", &patch, Some((jpeg, "jpg"))).expect("save");

        let replaced = library
            .with(|conn| crate::library::repository::cover_path(conn, "b1"))
            .expect("path")
            .expect("cover");
        assert_eq!(std::fs::read(&replaced).expect("read"), jpeg, "新封面已就位");

        let call_id = library.with(|conn| crate::library::ops::list(conn, 10)).expect("list")[0]
            .call_id
            .clone();
        library.with_tx(|tx| crate::library::ops::undo(tx, &call_id, &covers)).expect("undo");

        let restored = library
            .with(|conn| crate::library::repository::cover_path(conn, "b1"))
            .expect("path")
            .expect("cover");
        assert_eq!(
            std::fs::read(&restored).expect("read"),
            b"\x89PNG\r\n\x1a\nold",
            "原封面的字节回来了"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 🔴 The picture a replacement takes away is **moved**, not deleted: 撤销
    /// has to be able to put it back, and a same-format replacement would
    /// otherwise overwrite the bytes. This pins both halves — our own file is
    /// moved and keeps its bytes, a file outside our directory is left alone.
    #[test]
    fn a_replaced_cover_is_moved_aside_and_kept() {
        let dir = crate::document::fixture::temp_dir("book-cover-aside");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers");
        let old = covers.join("b1.jpg");
        std::fs::write(&old, b"\xff\xd8\xffold").expect("old cover");

        let (from, kept) =
            move_aside(Some(old.to_str().expect("path")), &covers, "b1").expect("moved");
        assert_eq!(from, old);
        assert!(!from.exists(), "旧路径让出来给新文件");
        assert_eq!(std::fs::read(&kept).expect("kept"), b"\xff\xd8\xffold", "字节还在");
        assert_eq!(kept.parent(), Some(covers.as_path()));

        // An imported cover pointing at the reader's own file: not ours to move.
        let outside = dir.join("mine.jpg");
        std::fs::write(&outside, b"x").expect("mine");
        assert_eq!(move_aside(Some(outside.to_str().expect("path")), &covers, "b1"), None);
        assert!(outside.exists(), "读者自己的文件原地不动");

        // No previous picture at all.
        assert_eq!(move_aside(None, &covers, "b1"), None);
        std::fs::remove_dir_all(&dir).ok();
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
