//! `metadata.*` — asking a catalogue about a book.
//!
//! Read-only, and deliberately not part of the write path: a candidate is a
//! suggestion, and applying it goes through `book.update` like any other edit.

use futures_util::StreamExt;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::metadata::{self, Candidate, Lookup, Proposal, Target};
use crate::library::{ops, repository};
use crate::state::AppState;

/// `metadata.search` — what NeoDB knows about this book.
///
/// The book is read first and the network call comes after, so no database
/// guard is held across the await: the app's single connection serialises
/// everything, and a twelve-second HTTP timeout inside it would freeze the
/// shelf.
#[tauri::command]
#[specta::specta]
pub async fn metadata_search(state: State<'_, AppState>, id: String) -> AppResult<Vec<Candidate>> {
    let book = state
        .library
        .with(|conn| repository::get(conn, &id))?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;

    let client = reqwest::Client::new();
    metadata::search(
        &client,
        metadata::NEODB,
        &Lookup { title: &book.title, authors: &book.authors },
    )
    .await
}

/// One book's share of a batch fill: the fields the reader accepted.
#[derive(specta::Type, Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFill {
    pub id: String,
    /// `None` = leave it alone, which is what a proposal with nothing to say
    /// for that field sends.
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub published_year: Option<i32>,
    pub description: Option<String>,
}

/// `metadata.propose` — what a fill would add to these books, without writing.
///
/// Two requests at a time. NeoDB is a community instance, not a commercial API:
/// the cap is about being a good guest rather than finishing fastest, and two
/// still turns a forty-book batch into seconds rather than a minute.
#[tauri::command]
#[specta::specta]
pub async fn metadata_propose(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<Proposal>> {
    let targets: Vec<Target> = state.library.with(|conn| {
        let mut out = Vec::new();
        for id in &ids {
            if let Some(book) = repository::get(conn, id)? {
                out.push(Target {
                    id: book.id,
                    title: book.title,
                    subtitle: book.subtitle,
                    authors: book.authors,
                    publisher: book.publisher,
                    language: book.language,
                    isbn: book.isbn,
                    published_year: book.published_year,
                    description: book.description,
                });
            }
        }
        Ok(out)
    })?;

    let client = reqwest::Client::new();
    let mut proposals: Vec<Proposal> =
        futures_util::stream::iter(targets.into_iter().map(|target| {
            let client = client.clone();
            async move {
                let lookup = Lookup { title: &target.title, authors: &target.authors };
                // A failure is reported per book, not swallowed into 「没有找到」:
                // a reader whose network is down was being told to try a better
                // title. One book failing still leaves the other twenty-nine
                // worth asking about.
                match metadata::search(&client, metadata::NEODB, &lookup).await {
                    Ok(found) => metadata::propose_for(&target, found.into_iter().next()),
                    Err(err) => metadata::propose_failed(&target, &err.to_string()),
                }
            }
        }))
        .buffer_unordered(2)
        .collect()
        .await;

    // Completion order is whatever the network said; the reader reads top-down,
    // so the ones that actually gain something come first.
    proposals.sort_by(|a, b| {
        b.fills
            .len()
            .cmp(&a.fills.len())
            .then(b.match_score.partial_cmp(&a.match_score).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(proposals)
}

/// `metadata.apply` — writes the proposals the reader accepted.
///
/// One transaction and one log entry for the whole batch, with before-images:
/// a fill is a bulk edit, and the reader has to be able to put it back.
#[tauri::command]
#[specta::specta]
pub fn metadata_apply(state: State<'_, AppState>, items: Vec<MetadataFill>) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    state.library.with_tx(|tx| {
        let mut befores = Vec::new();
        for item in &items {
            // Read before writing, for the before-image the undo needs.
            if let Some(book) = repository::get(tx, &item.id)? {
                befores.push(ops::Before {
                    book_id: item.id.clone(),
                    publisher: book.publisher,
                    language: book.language,
                });
            }
            // A full record, built from the row plus whatever this fill says:
            // `update_fields_many` only knows the two fields the batch sheet
            // edits, and a fill writes more than that.
            let mut patch = crate::library::repository::BookMetadataPatch {
                title: String::new(),
                subtitle: None,
                description: None,
                language: None,
                publisher: None,
                isbn: None,
                published_year: None,
                authors: Vec::new(),
            };
            if let Some(book) = repository::get(tx, &item.id)? {
                patch.title = book.title;
                patch.authors = book.authors;
                patch.subtitle = item.subtitle.clone().or(book.subtitle);
                patch.description = item.description.clone().or(book.description);
                patch.language = item.language.clone().or(book.language);
                patch.publisher = item.publisher.clone().or(book.publisher);
                patch.isbn = item.isbn.clone().or(book.isbn);
                patch.published_year = item.published_year.or(book.published_year);
            }
            repository::update_metadata(tx, &item.id, &patch)?;
        }
        ops::record_before(
            tx,
            ops::Source::Ui,
            "fill_metadata",
            &befores,
            &format!("从 NeoDB 补全了 {} 本", items.len()),
        )?;
        Ok(items.len())
    })
}
