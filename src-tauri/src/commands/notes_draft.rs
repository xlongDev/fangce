//! `notes.draftSuggest` / `notes.draftApply`: AI drafts for notes-less highlights.

use serde::Serialize;
use tauri::State;

use crate::ai::is_ready;
use crate::error::{AppError, AppResult};
use crate::library::note_draft::{self, AiNoteDraft, AiNoteSuggestion};
use crate::state::AppState;

/// What one suggestion run produced.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNoteRun {
    pub suggestions: Vec<AiNoteSuggestion>,
    /// 参与这次建议的划线（选中且还没有笔记的）。
    pub considered: usize,
    /// 没有笔记但超出这一轮上限的，留给下一次。
    pub remaining: usize,
    pub failed_batches: usize,
}

/// `notes.draftSuggest` — asks the model for drafts on the selected highlights
/// that have no note. Returns suggestions only; nothing is written here.
#[tauri::command]
#[specta::specta]
pub async fn notes_draft_suggest(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<AiNoteRun> {
    if ids.is_empty() {
        return Err(AppError::InvalidArgument("先选中要整理的划线".into()));
    }
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(super::ai::NOT_CONFIGURED.into()));
    }

    let rows = state.library.with(|conn| note_draft::without_note(conn, &ids))?;
    if rows.is_empty() {
        return Err(AppError::InvalidArgument("选中的划线都已经写过笔记了".into()));
    }
    let remaining = rows.len().saturating_sub(note_draft::RUN_LIMIT);
    let batch: Vec<_> = rows.into_iter().take(note_draft::RUN_LIMIT).collect();
    let considered = batch.len();

    let client = super::ai::client()?;
    let mut suggestions = Vec::new();
    let mut failed_batches = 0;
    let mut last_error = None;
    for chunk in batch.chunks(note_draft::BATCH) {
        match note_draft::suggest(&client, &config, chunk).await {
            Ok(found) => suggestions.extend(found),
            Err(err) => {
                // One dead batch must not throw away the drafts the others
                // brought back — the same rule the catalogue fill follows.
                failed_batches += 1;
                tracing::warn!(error = %err, "这一批笔记草稿没出来");
                last_error = Some(err);
            }
        }
    }
    if suggestions.is_empty() {
        return Err(last_error.unwrap_or_else(|| AppError::Message("模型没有给出笔记草稿".into())));
    }
    Ok(AiNoteRun { suggestions, considered, remaining, failed_batches })
}

/// `notes.draftApply` — writes what the reader kept. The log line is sourced as
/// `ai`, so 操作记录 says where the note came from, and undo can clear it.
#[tauri::command]
#[specta::specta]
pub fn notes_draft_apply(state: State<'_, AppState>, items: Vec<AiNoteDraft>) -> AppResult<usize> {
    note_draft::apply(&state.library, &items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_reports_the_batches_it_could_not_finish() {
        let run =
            AiNoteRun { suggestions: Vec::new(), considered: 20, remaining: 5, failed_batches: 1 };
        let value = serde_json::to_value(&run).expect("serialize");
        assert_eq!(value["failedBatches"], serde_json::json!(1));
        assert_eq!(value["remaining"], serde_json::json!(5));
    }
}
