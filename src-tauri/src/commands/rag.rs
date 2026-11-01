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
use crate::error::AppResult;
use crate::library::rag;
use crate::state::AppState;

/// Progress of one book's index build.
pub const RAG_INDEX_EVENT: &str = "rag://index-progress";

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
}

/// `rag.status` — what the AI drawer needs to decide which controls to show.
#[tauri::command]
#[specta::specta]
pub fn rag_status(state: State<'_, AppState>, book_id: String) -> AppResult<RagStatus> {
    let (book_chunks, library_chunks) = state.library.with(|conn| rag::counts(conn, &book_id))?;
    let embedding_model = ai::config(&state.library)?.embedding_model;
    Ok(RagStatus { book_chunks, library_chunks, embedding_model })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_event_is_namespaced() {
        assert!(RAG_INDEX_EVENT.starts_with("rag://"));
    }
}
