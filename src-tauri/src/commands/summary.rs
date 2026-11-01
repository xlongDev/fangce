//! `summary.*` commands: one paragraph per chapter, and the recap built from
//! them.
//!
//! The build runs chapter by chapter over the chat endpoint and reports
//! progress as events. It is the same shape of job as the graph build — N model
//! calls behind one button — and it is deliberately not automatic: a chapter
//! opened is not a chapter the reader wants summarised, and every call is
//! billed.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai::chat::{ChatMessage, Role};
use crate::ai::{self, is_ready};
use crate::error::{AppError, AppResult};
use crate::library::summary::{self, ChapterSummary, SummaryBuildReport};
use crate::state::AppState;

use super::ai::{NOT_CONFIGURED, StreamArgs, blank, emit, run_stream};

/// Progress of one book's summary build.
pub const SUMMARY_BUILD_EVENT: &str = "summary://build-progress";

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryProgress {
    pub done: usize,
    pub total: usize,
}

/// `summary.list` — every chapter up to the reader's position, with whatever
/// summary exists.
///
/// The limit is applied here rather than in the panel: a list that carries
/// chapters the reader has not reached is one screenshot away from spoiling the
/// book.
#[tauri::command]
#[specta::specta]
pub fn chapter_summaries(
    state: State<'_, AppState>,
    book_id: String,
    upto: usize,
) -> AppResult<Vec<ChapterSummary>> {
    state.library.with(|conn| summary::list(conn, &book_id, upto))
}

/// `summary.build` — summarises the chapters up to `upto` that have none.
#[tauri::command]
#[specta::specta]
pub async fn chapter_summary_build(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
    upto: usize,
) -> AppResult<SummaryBuildReport> {
    let config = ai::config(&state.library)?;
    let client = super::ai::client()?;
    let library = state.library.clone();

    summary::build(&library, &client, &config, &book_id, upto, &|done, total| {
        // A closed window just stops listening; dropping the event is correct.
        let _ = app.emit(SUMMARY_BUILD_EVENT, SummaryProgress { done, total });
    })
    .await
}

/// `summary.recap` — streams a 前情提要 built from the cached summaries.
///
/// Streamed through the same event as every other answer, so the panel gets the
/// same incremental rendering, the same error handling and the same 停止 button
/// without a second mechanism.
#[tauri::command]
#[specta::specta]
pub async fn chapter_recap(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    book_id: String,
    upto: usize,
) -> AppResult<()> {
    let config = ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }
    let material = state.library.with(|conn| summary::recap_material(conn, &book_id, upto))?;

    // The recap carries its own instructions. `with_system_extra` leaves a
    // conversation alone when it already opens with a system message, so the
    // reader's assistant persona cannot reshape a recap into a chat answer.
    let messages = vec![
        ChatMessage::new(Role::System, summary::RECAP_PROMPT.to_string()),
        ChatMessage::new(Role::User, material),
    ];

    let result = run_stream(
        &app,
        &state,
        StreamArgs {
            request_id: &request_id,
            config: &config,
            messages,
            citations: Vec::new(),
            tools: None,
            book_id: Some(&book_id),
            max_chapter: Some(upto),
            context: None,
        },
    )
    .await;

    match result {
        Ok(_) => Ok(()),
        Err(err) => {
            let mut delta = blank(&request_id);
            delta.done = true;
            delta.error = Some(err.to_string());
            emit(&app, delta);
            Err(err)
        }
    }
}
