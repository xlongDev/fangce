//! `cover.*` commands: managing downloaded covers from the settings page.
//!
//! The domain logic lives in `library::covers`; these are the IPC edges. The
//! directory walks and file renames run on a blocking task so a few hundred
//! covers never stall the UI thread.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::covers::{self, CleanupResult, CoverManagerData, CoverOpResult};
use crate::state::AppState;

/// `cover.list` — the whole manager in one read.
#[tauri::command]
#[specta::specta]
pub async fn cover_list(state: State<'_, AppState>) -> AppResult<CoverManagerData> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    let books_dir = state.layout.books_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Older builds lost some originals on a re-download after undo. Heal
        // them from the source books before listing, so the 「原文件」 side of
        // each card shows the book's own cover again.
        covers::heal_originals(&library, &covers_dir, &books_dir);
        library.with(|conn| covers::list(conn, &covers_dir))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("读取封面被中断：{err}")))?
}

/// `cover.retire` — take downloaded covers off their books into the bin.
#[tauri::command]
#[specta::specta]
pub async fn cover_retire(
    state: State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<CoverOpResult> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.with(|conn| covers::retire(conn, &covers_dir, &keys))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("取下封面被中断：{err}")))?
}

/// `cover.restore` — put retired covers back onto their books.
#[tauri::command]
#[specta::specta]
pub async fn cover_restore(
    state: State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<CoverOpResult> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.with(|conn| covers::restore(conn, &covers_dir, &keys))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("恢复封面被中断：{err}")))?
}

/// `cover.purge` — permanently delete retired covers. Irreversible.
#[tauri::command]
#[specta::specta]
pub async fn cover_purge(
    state: State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<CoverOpResult> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.with(|conn| covers::purge(conn, &covers_dir, &keys))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("删除封面被中断：{err}")))?
}

/// `cover.cleanup_orphans` — permanently delete unreferenced `.dl.` files.
/// Re-checks each path against the database on the blocking task before touching
/// it; the UI's list is a hint, never the authority.
#[tauri::command]
#[specta::specta]
pub async fn cover_cleanup_orphans(
    state: State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<CleanupResult> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.with(|conn| covers::cleanup_orphans(conn, &covers_dir, &keys))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("清理无主封面被中断：{err}")))?
}

/// `cover.dedupe` — hard-link redundant copies of one picture to the keeper.
#[tauri::command]
#[specta::specta]
pub async fn cover_dedupe(
    state: State<'_, AppState>,
    keeper: String,
    keys: Vec<String>,
) -> AppResult<CleanupResult> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.with(|conn| covers::dedupe(conn, &covers_dir, &keeper, &keys))
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("合并重复封面被中断：{err}")))?
}

/// `cover.export` — copy the chosen cover files into a folder the reader
/// picked, named after their books (`三体.jpg`) rather than the opaque storage
/// key. Names are sanitised in the domain layer and no path can escape the
/// chosen directory. A name that is already taken gets a ` (2)` suffix, so a
/// second export never overwrites the first. Returns the number written.
#[tauri::command]
#[specta::specta]
pub async fn cover_export(
    state: State<'_, AppState>,
    keys: Vec<String>,
    dest: String,
) -> AppResult<usize> {
    let library = state.library.clone();
    let covers_dir = state.layout.covers_dir.clone();
    let target = std::path::PathBuf::from(&dest);
    if !target.is_dir() {
        return Err(AppError::InvalidArgument("目标文件夹不存在".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        // The only DB work is reading titles; do it in one short lock, then
        // copy files outside it so a slow disk never blocks other commands.
        let names = library.with(|conn| Ok::<_, AppError>(covers::export_plan(conn, &keys)))?;
        let mut written = 0;
        for (key, name) in names {
            let source = covers_dir.join(&key);
            if !source.is_file() {
                continue;
            }
            let file_name = covers::unique_export_name(&name, &target);
            if std::fs::copy(&source, target.join(file_name)).is_ok() {
                written += 1;
            }
        }
        Ok::<usize, AppError>(written)
    })
    .await
    .map_err(|err| crate::error::AppError::Message(format!("导出封面被中断：{err}")))?
}
