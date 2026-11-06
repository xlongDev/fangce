//! `rag.*` commands: indexing and index status.
//!
//! Retrieval itself is no longer a command of its own — it is the `search_book`
//! tool the assistant calls when it decides to (see `ai::tools`). What stays
//! here is the index: building it for one book, and saying whether it exists,
//! which is what the panel needs to offer the "index this book" affordance at
//! all.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai;
use crate::error::{AppError, AppResult};
use crate::library::rag;
use crate::state::AppState;

/// Progress of one book's index build.
pub const RAG_INDEX_EVENT: &str = "rag://index-progress";

/// Progress of a whole-library rebuild, counted in books.
///
/// A separate event rather than a second meaning for the one above: the two
/// counts answer different questions ("chunk 340 of 900" vs "book 12 of 30"),
/// and a panel that cannot tell them apart shows a bar that lies.
pub const RAG_LIBRARY_EVENT: &str = "rag://library-progress";

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagProgress {
    pub done: usize,
    pub total: usize,
}

/// Index status for one book and the library at large.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagStatus {
    /// Chunks stored for `book_id`.
    pub book_chunks: usize,
    /// Chunks stored across the whole library.
    pub library_chunks: usize,
    /// Empty when retrieval is not configured.
    pub embedding_model: String,
    /// Books whose index was built with another model. Retrieval filters on the
    /// model, so these are invisible until rebuilt — the panel has to say so
    /// rather than let the reader wonder why a book that "is indexed" finds
    /// nothing.
    pub stale_books: usize,
    /// Whether this book's own index predates the configured model.
    pub book_stale: bool,
}

/// `rag.status` — what the AI drawer needs to decide which controls to show.
#[tauri::command]
#[specta::specta]
pub fn rag_status(state: State<'_, AppState>, book_id: String) -> AppResult<RagStatus> {
    let (book_chunks, library_chunks) = state.library.with(|conn| rag::counts(conn, &book_id))?;
    let embedding_model = ai::config(&state.library)?.embedding_model;
    // An empty model means retrieval is off, and every stored chunk is "stale"
    // against it — reporting that would be a warning about nothing.
    let (stale_books, book_stale) = if embedding_model.trim().is_empty() {
        (0, false)
    } else {
        let stale = state.library.with(|conn| rag::stale_books(conn, &embedding_model))?;
        let book =
            state.library.with(|conn| rag::book_is_stale(conn, &book_id, &embedding_model))?;
        (stale, book)
    };
    Ok(RagStatus { book_chunks, library_chunks, embedding_model, stale_books, book_stale })
}

/// `rag.indexBook` — rebuilds the embedding index for one book.
#[tauri::command]
#[specta::specta]
pub async fn rag_index_book(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<usize> {
    let config = ai::config(&state.library)?;
    let client = super::ai::client()?;
    let library = state.library.clone();

    let chunks = rag::reindex(&library, &client, &config, &book_id, &|done, total| {
        // A closed window just stops listening; dropping the event is correct.
        let _ = app.emit(RAG_INDEX_EVENT, RagProgress { done, total });
    })
    .await;
    match chunks {
        Ok(count) => {
            let _ = app.emit(RAG_INDEX_EVENT, RagProgress { done: count, total: count });
            Ok(count)
        }
        Err(err) => Err(err),
    }
}

/// `rag.indexLibrary` — rebuilds every book that carries an index, against the
/// model configured now.
///
/// This is what makes switching the embedding model a recoverable mistake: the
/// old vectors stay in the table (they are invisible to retrieval, not deleted),
/// so a reader who tries a model and goes back still has to rebuild, and doing
/// that one book at a time means opening thirty books.
#[tauri::command]
#[specta::specta]
pub async fn rag_index_library(app: AppHandle, state: State<'_, AppState>) -> AppResult<usize> {
    let config = ai::config(&state.library)?;
    if config.embedding_model.trim().is_empty() {
        return Err(AppError::InvalidArgument("先到设置里填写向量模型，才能建立检索索引".into()));
    }
    let client = super::ai::client()?;
    let library = state.library.clone();
    let books = library.with(rag::indexed_books)?;
    let total = books.len();

    let mut rebuilt = 0;
    for (index, id) in books.into_iter().enumerate() {
        // One unreadable book must not end the run: the other twenty-nine still
        // deserve an index, and the failure is already logged with its id.
        match rag::reindex(&library, &client, &config, &id, &|_, _| {}).await {
            Ok(_) => rebuilt += 1,
            Err(err) => tracing::warn!(book = %id, %err, "全库重建跳过这本书"),
        }
        let _ = app.emit(RAG_LIBRARY_EVENT, RagProgress { done: index + 1, total });
    }
    tracing::info!(books = total, rebuilt, "全库索引完成");
    Ok(rebuilt)
}

/// `rag.clearLibrary` — drops every book's index, returning how many chunks went.
#[tauri::command]
#[specta::specta]
pub fn rag_clear_library(state: State<'_, AppState>) -> AppResult<usize> {
    state.library.with(rag::clear_library)
}

/// `rag.clearBook` — drops this book's index and reports how many chunks went.
///
/// Chunks are derived from chapters, so a clear costs one rebuild and nothing
/// else. That is why the assistant's menu offers it without a warning dialog.
#[tauri::command]
#[specta::specta]
pub fn rag_clear_book(state: State<'_, AppState>, book_id: String) -> AppResult<usize> {
    state.library.with(|conn| rag::clear(conn, &book_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_event_is_namespaced() {
        assert!(RAG_INDEX_EVENT.starts_with("rag://"));
    }
}
