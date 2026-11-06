//! `graph.*` commands: knowledge graph status, build and query.
//!
//! The build runs chapter by chapter over the chat endpoint and reports
//! progress as events, mirroring the RAG index flow.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::ai;
use crate::error::{AppError, AppResult};
use crate::library::characters::{self, PackedCharacter};
use crate::library::graph::{self, GraphEntity, GraphView};
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

/// One card on the character wall: the entity, plus where its portrait is.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCard {
    pub name: String,
    pub kind: String,
    pub mentions: usize,
    /// Served from the resource protocol; `None` until one is drawn or imported.
    pub portrait: Option<String>,
}

/// Where one book's portraits live on disk.
fn portrait_dir(state: &AppState, book_id: &str) -> PathBuf {
    crate::ai::image::portraits_dir(&state.layout.covers_dir).join(crate::ai::image::slug(book_id))
}

/// `graph.characters` — the card wall.
///
/// One command rather than a query plus N portrait lookups: whether a picture
/// exists is a `stat`, and a hundred round trips to answer it is how a wall of
/// cards ends up painting in order.
#[tauri::command]
#[specta::specta]
pub fn graph_characters(
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<Vec<CharacterCard>> {
    let entities = state.library.with(|conn| graph::characters(conn, &book_id))?;
    Ok(entities.into_iter().map(|entity| card(&state, &book_id, entity)).collect())
}

/// `graph.addCharacter` — a name the extractor never found.
#[tauri::command]
#[specta::specta]
pub fn graph_add_character(
    state: State<'_, AppState>,
    book_id: String,
    name: String,
) -> AppResult<CharacterCard> {
    let entity = state.library.with(|conn| graph::add_character(conn, &book_id, &name))?;
    Ok(card(&state, &book_id, entity))
}

/// `graph.clearCharacters` — empties the wall, portraits included.
#[tauri::command]
#[specta::specta]
pub fn graph_clear_characters(state: State<'_, AppState>, book_id: String) -> AppResult<usize> {
    let names = state.library.with(|conn| graph::clear_characters(conn, &book_id))?;
    for name in &names {
        let path = crate::ai::image::portrait_path(&state.layout.covers_dir, &book_id, name);
        // A portrait that is already gone is not a failure: the wall is being
        // emptied, and the file is the only thing left to remove.
        let _ = std::fs::remove_file(path);
    }
    Ok(names.len())
}

/// `graph.openPortraits` — reveals this book's portrait folder in the file
/// manager, so a reader can drop in their own pictures.
#[tauri::command]
#[specta::specta]
pub fn graph_open_portraits(
    app: AppHandle,
    state: State<'_, AppState>,
    book_id: String,
) -> AppResult<()> {
    let dir = portrait_dir(&state, &book_id);
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|err| AppError::Message(format!("打不开立绘目录：{err}")))
}

/// `graph.exportCharacters` — writes the wall to a pack and returns how many
/// cards went into it.
#[tauri::command]
#[specta::specta]
pub fn graph_export_characters(
    state: State<'_, AppState>,
    book_id: String,
    path: String,
) -> AppResult<usize> {
    let entities = state.library.with(|conn| graph::characters(conn, &book_id))?;
    let mut portraits = Vec::new();
    for entity in &entities {
        let file =
            crate::ai::image::portrait_path(&state.layout.covers_dir, &book_id, &entity.name);
        // A card without a picture is still a card; a pack with a hole in it
        // would be a file that cannot be re-imported.
        if let Ok(bytes) = std::fs::read(&file) {
            portraits.push((crate::ai::image::slug(&entity.name), bytes));
        }
    }
    let cards: Vec<PackedCharacter> = entities
        .into_iter()
        .map(|entity| PackedCharacter {
            name: entity.name,
            kind: entity.kind,
            mentions: entity.mentions,
        })
        .collect();
    characters::export(Path::new(&path), &cards, &portraits)?;
    Ok(cards.len())
}

/// `graph.importCharacters` — merges a pack into this book, returning how many
/// cards it added.
#[tauri::command]
#[specta::specta]
pub fn graph_import_characters(
    state: State<'_, AppState>,
    book_id: String,
    path: String,
) -> AppResult<usize> {
    let pack = characters::unpack(Path::new(&path))?;
    if pack.characters.is_empty() {
        return Err(AppError::InvalidArgument("这个角色卡包里没有角色".into()));
    }

    if !pack.portraits.is_empty() {
        let dir = portrait_dir(&state, &book_id);
        std::fs::create_dir_all(&dir)?;
        for (slug, bytes) in &pack.portraits {
            std::fs::write(dir.join(format!("{slug}.png")), bytes)?;
        }
    }

    // Names already on the wall are promoted rather than duplicated — a pack
    // exported from this book re-imports as a no-op.
    for packed in &pack.characters {
        state.library.with(|conn| graph::add_character(conn, &book_id, &packed.name))?;
    }
    Ok(pack.characters.len())
}

/// A row plus its picture, if one was ever drawn.
fn card(state: &AppState, book_id: &str, entity: GraphEntity) -> CharacterCard {
    let path = crate::ai::image::portrait_path(&state.layout.covers_dir, book_id, &entity.name);
    let portrait = path.is_file().then(|| crate::library::portrait_url(book_id, &entity.name));
    CharacterCard { name: entity.name, kind: entity.kind, mentions: entity.mentions, portrait }
}
