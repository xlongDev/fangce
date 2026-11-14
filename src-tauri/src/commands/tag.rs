//! `tag.*` and `book.setTags`: the shelf's labelling commands.

use serde::Serialize;
use tauri::State;

use crate::ai::is_ready;
use crate::error::{AppError, AppResult};
use crate::library::tagging::{self, Suggestion, TagAdd};
use crate::library::tags::{self, TagSummary};
use crate::state::AppState;

/// `tag.list`
#[tauri::command]
#[specta::specta]
pub fn tag_list(state: State<'_, AppState>) -> AppResult<Vec<TagSummary>> {
    state.library.with(tags::list)
}

/// `tag.delete` — removes one tag from every book that carries it.
#[tauri::command]
#[specta::specta]
pub fn tag_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.library.with(|conn| tags::delete(conn, &id))
}

/// `book.setTags` — applies a set difference to one or more books.
///
/// The per-book sheet computes `add`/`remove` against what it was shown; the
/// batch bar passes only `add`, so selecting ten books cannot clear a label
/// the bar never knew about. One command instead of two, because the operation
/// really is one: a difference applied to a set of books.
#[tauri::command]
#[specta::specta]
pub fn book_set_tags(
    state: State<'_, AppState>,
    ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let summary = match (add.is_empty(), remove.is_empty()) {
        (false, true) => format!("加标签：{}", add.join("、")),
        (true, false) => format!("去标签：{}", remove.join("、")),
        _ => "改了标签".to_string(),
    };
    state.library.with_tx(|tx| {
        tags::assign(tx, &ids, &add, &remove)?;
        crate::library::ops::record(
            tx,
            crate::library::ops::Source::Ui,
            "manage_tags",
            &ids,
            &summary,
        )
    })
}

/// What one suggestion run produced.
///
/// `failedBatches` is reported rather than folded into a shorter list: a run
/// where two of three batches never answered is not the same answer as 「这些书
/// 看不出题材」, and the reader would fix the wrong thing.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRun {
    pub suggestions: Vec<Suggestion>,
    /// 参与这次建议的书（选中且还没有标签的）。
    pub considered: usize,
    /// 没有标签但超出这一轮上限的，留给下一次。
    pub remaining: usize,
    pub failed_batches: usize,
}

/// `tag.suggest` — asks the model for labels on the selected books that have
/// none, and returns suggestions only. Nothing is written here.
#[tauri::command]
#[specta::specta]
pub async fn tag_suggest(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<TagRun> {
    if ids.is_empty() {
        return Err(AppError::InvalidArgument("先选中要整理的书".into()));
    }
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(super::ai::NOT_CONFIGURED.into()));
    }

    let books = state.library.with(|conn| tagging::untagged(conn, &ids))?;
    if books.is_empty() {
        return Err(AppError::InvalidArgument("选中的书都已经有标签了".into()));
    }
    let remaining = books.len().saturating_sub(tagging::RUN_LIMIT);
    let batch: Vec<_> = books.into_iter().take(tagging::RUN_LIMIT).collect();
    let considered = batch.len();

    // Read once for the whole run: the vocabulary is what keeps the model from
    // inventing 科幻小说 next to an existing 科幻.
    let vocabulary = state.library.with(tagging::vocabulary)?;
    let client = super::ai::client()?;
    let mut suggestions = Vec::new();
    let mut failed_batches = 0;
    let mut last_error = None;
    for chunk in batch.chunks(tagging::BATCH) {
        match tagging::suggest(&client, &config, chunk, &vocabulary).await {
            Ok(found) => suggestions.extend(found),
            Err(err) => {
                // One dead batch must not throw away the labels the others
                // brought back — the same rule the catalogue fill follows.
                failed_batches += 1;
                tracing::warn!(error = %err, "这一批标签建议没出来");
                last_error = Some(err);
            }
        }
    }
    if suggestions.is_empty() {
        return Err(last_error.unwrap_or_else(|| AppError::Message("模型没有给出标签".into())));
    }
    Ok(TagRun { suggestions, considered, remaining, failed_batches })
}

/// `tag.suggestApply` — writes what the reader kept. Sources the log line as
/// `ai`, so 操作记录 says where these labels came from.
#[tauri::command]
#[specta::specta]
pub fn tag_suggest_apply(state: State<'_, AppState>, items: Vec<TagAdd>) -> AppResult<usize> {
    tagging::apply(&state.library, &items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_reports_the_batches_it_could_not_finish() {
        let run =
            TagRun { suggestions: Vec::new(), considered: 20, remaining: 5, failed_batches: 1 };
        let value = serde_json::to_value(&run).expect("serialize");
        assert_eq!(value["failedBatches"], serde_json::json!(1));
        assert_eq!(value["remaining"], serde_json::json!(5));
    }
}
