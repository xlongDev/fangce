//! `graph.*` commands: knowledge graph status, build and query.
//!
//! The build runs chapter by chapter over the chat endpoint and reports
//! progress as events, mirroring the RAG index flow.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai;
use crate::error::AppResult;
use crate::library::graph::{self, GraphView};
use crate::state::AppState;

/// Progress of one book's graph build.
pub const GRAPH_BUILD_EVENT: &str = "graph://build-progress";

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphProgress {
    pub done: usize,
    pub total: usize,
}

/// Node and edge counts plus the chat model that would do the extraction.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatus {
    pub entities: usize,
    pub relations: usize,
    pub model: String,
}

/// `graph.status` — what the panel needs to decide what to show.
#[tauri::command]
#[specta::specta]
pub fn graph_status(state: State<'_, AppState>, book_id: String) -> AppResult<GraphStatus> {
    let (entities, relations) = state.library.with(|conn| graph::counts(conn, &book_id))?;
    let model = ai::config(&state.library)?.model;
    Ok(GraphStatus { entities, relations, model })
}

/// `graph.build` — extracts entities and relations chapter by chapter and
/// replaces the book's graph. Progress arrives on [`GRAPH_BUILD_EVENT`].
#[tauri::command]
#[specta::specta]
pub async fn graph_build(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<crate::library::graph::GraphBuildReport> {
    let config = ai::config(&state.library)?;
    let client = super::ai::client()?;
    let library = state.library.clone();

    let entities = graph::build(&library, &client, &config, &book_id, &|done, total| {
        // A closed window just stops listening; dropping the event is correct.
        let _ = app.emit(GRAPH_BUILD_EVENT, GraphProgress { done, total });
    })
    .await;
    match entities {
        Ok(report) => {
            // The last progress event used to report the *entity* count as
            // done/total, which made the bar jump to a number that had nothing
            // to do with chapters.
            let _ = app.emit(
                GRAPH_BUILD_EVENT,
                GraphProgress { done: report.chapters, total: report.chapters },
            );
            Ok(report)
        }
        Err(err) => Err(err),
    }
}

/// `graph.query` — all entities when `entity` is `null`, otherwise the
/// neighborhood of that one entity.
#[tauri::command]
#[specta::specta]
pub fn graph_query(
    state: State<'_, AppState>,
    book_id: String,
    entity: Option<String>,
) -> AppResult<GraphView> {
    state.library.with(|conn| graph::query(conn, &book_id, entity.as_deref()))
}
