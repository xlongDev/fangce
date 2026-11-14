//! `source.*` commands: online book sources.
//!
//! Sources are user-authored JSON rule definitions; every command loads the
//! definition, validates it implicitly by the rules it executes, and talks HTTP
//! on the caller's behalf.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::library::source::{self, SourceBook, SourceChapter, SourceDef, SourceEntry};
use crate::state::AppState;

/// Progress of one book download.
pub const SOURCE_DOWNLOAD_EVENT: &str = "source://download-progress";

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProgress {
    pub done: usize,
    pub total: usize,
    /// Title of the chapter that just finished.
    pub chapter: String,
}

/// `source.list` — every stored source, definition included.
#[tauri::command]
#[specta::specta]
pub fn source_list(state: State<'_, AppState>) -> AppResult<Vec<SourceEntry>> {
    state.library.with(source::list)
}

/// `source.save` — insert or update one source; returns its id.
#[tauri::command]
#[specta::specta]
pub fn source_save(
    state: State<'_, AppState>,
    id: Option<String>,
    def: SourceDef,
) -> AppResult<String> {
    source::save(&state.library, id.as_deref(), &def)
}

/// `source.delete`
#[tauri::command]
#[specta::specta]
pub fn source_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    source::delete(&state.library, &id)
}

/// `source.search`
#[tauri::command]
#[specta::specta]
pub async fn source_search(
    state: State<'_, AppState>,
    source_id: String,
    keyword: String,
) -> AppResult<Vec<SourceBook>> {
    let keyword = keyword.trim().to_string();
    if keyword.is_empty() {
        return Err(AppError::InvalidArgument("先输入要搜索的书名或作者".into()));
    }
    let (def, hosts, client) = prepare(&state, &source_id)?;
    source::search(&client, &def, &hosts, &keyword).await
}

/// `source.book` — book detail for a URL from the search results.
#[tauri::command]
#[specta::specta]
pub async fn source_book(
    state: State<'_, AppState>,
    source_id: String,
    book_url: String,
) -> AppResult<SourceBook> {
    let (def, hosts, client) = prepare(&state, &source_id)?;
    source::book_detail(&client, &def, &hosts, &book_url).await
}

/// `source.chapters`
#[tauri::command]
#[specta::specta]
pub async fn source_chapters(
    state: State<'_, AppState>,
    source_id: String,
    book_url: String,
) -> AppResult<Vec<SourceChapter>> {
    let (def, hosts, client) = prepare(&state, &source_id)?;
    source::chapters(&client, &def, &hosts, &book_url).await
}

/// `source.download` — walks the whole book into the library and reports
/// progress per chapter. The command resolves only when the book is on the
/// shelf, so the UI can navigate straight to it.
#[tauri::command]
#[specta::specta]
pub async fn source_download(
    app: AppHandle,
    state: State<'_, AppState>,
    source_id: String,
    book_url: String,
) -> AppResult<source::Downloaded> {
    let (def, hosts, client) = prepare(&state, &source_id)?;
    let library = state.library.clone();
    let layout = state.layout.clone();
    source::download(
        &library,
        &layout,
        &client,
        &def,
        &hosts,
        &book_url,
        &mut |done, total, chapter| {
            // A closed window just stops listening; dropping the event is correct.
            let _ = app.emit(
                SOURCE_DOWNLOAD_EVENT,
                SourceProgress { done, total, chapter: chapter.to_string() },
            );
        },
    )
    .await
}

fn def_of(state: &State<'_, AppState>, source_id: &str) -> AppResult<SourceDef> {
    source::load(&state.library, source_id)
}

/// Everything one call needs: the definition, the hosts it may reach, and a
/// client whose redirects are held to the same list.
fn prepare(
    state: &State<'_, AppState>,
    source_id: &str,
) -> AppResult<(SourceDef, crate::net::Hosts, reqwest::Client)> {
    let def = def_of(state, source_id)?;
    let hosts = def.hosts()?;
    let client = super::ai::client_restricted(hosts.redirect_policy())?;
    Ok((def, hosts, client))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_download_event_is_namespaced() {
        assert!(SOURCE_DOWNLOAD_EVENT.starts_with("source://"));
    }

    #[test]
    fn progress_serializes_in_camel_case() {
        let value =
            serde_json::to_value(SourceProgress { done: 1, total: 3, chapter: "第一章".into() })
                .expect("serialize");
        assert_eq!(value["chapter"], "第一章");
        assert_eq!(value["done"], serde_json::json!(1));
    }
}
