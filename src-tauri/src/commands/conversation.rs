//! `ai.conversation.*` commands: the assistant's saved history.
//!
//! Thin wrappers over `library::conversation` — the queries and the validation
//! live there, so the rules are testable without a Tauri app.

use tauri::State;

use crate::ai::tools::ToolCallView;
use crate::ai::usage::TokenUsage;
use crate::error::{AppError, AppResult};
use crate::library::conversation::{self, Conversation, ConversationSummary, StoredMessage};
use crate::library::rag::RagHit;
use crate::state::AppState;

/// `ai.conversationList` — the switcher's rows, newest first.
#[tauri::command]
#[specta::specta]
pub fn ai_conversation_list(
    state: State<'_, AppState>,
    book_id: Option<String>,
) -> AppResult<Vec<ConversationSummary>> {
    state.library.with(|conn| conversation::list(conn, book_id.as_deref()))
}

/// `ai.conversationGet` — one conversation with its messages.
#[tauri::command]
#[specta::specta]
pub fn ai_conversation_get(state: State<'_, AppState>, id: String) -> AppResult<Conversation> {
    state.library.with(|conn| conversation::get(conn, &id))
}

/// `ai.conversationCreate` — starts an empty one; the first question titles it.
#[tauri::command]
#[specta::specta]
pub fn ai_conversation_create(
    state: State<'_, AppState>,
    book_id: Option<String>,
) -> AppResult<ConversationSummary> {
    state.library.with(|conn| conversation::create(conn, book_id.as_deref()))
}

/// `ai.conversationRename`
#[tauri::command]
#[specta::specta]
pub fn ai_conversation_rename(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<()> {
    state.library.with(|conn| conversation::rename(conn, &id, &title))
}

/// `ai.conversationDelete`
#[tauri::command]
#[specta::specta]
pub fn ai_conversation_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.library.with(|conn| conversation::delete(conn, &id))
}

/// `ai.conversationAppend` — stores one finished turn.
///
/// Called by the renderer twice per exchange: once for the question as it is
/// sent, once for the answer when the stream completes. A stream that failed
/// half way through therefore leaves nothing behind.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn ai_conversation_append(
    state: State<'_, AppState>,
    id: String,
    role: String,
    content: String,
    reasoning: Option<String>,
    citations: Vec<RagHit>,
    usage: Option<TokenUsage>,
    tools: Vec<ToolCallView>,
) -> AppResult<StoredMessage> {
    state.library.with(|conn| {
        conversation::append(
            conn,
            &id,
            &role,
            &content,
            reasoning.as_deref(),
            &citations,
            usage,
            &tools,
        )
    })
}

/// `ai.conversationExport` — writes one conversation out as Markdown.
///
/// The path comes from the native save panel, so this only has to write. The
/// formatting lives in `library::conversation` where it can be tested without a
/// filesystem.
#[tauri::command]
#[specta::specta]
pub async fn ai_conversation_export(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> AppResult<()> {
    let markdown =
        conversation::to_markdown(&state.library.with(|conn| conversation::get(conn, &id))?);
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, markdown))
        .await
        .map_err(|err| AppError::Message(format!("导出任务被中断：{err}")))?
        .map_err(|err| AppError::Message(format!("对话导出失败：{err}")))
}
