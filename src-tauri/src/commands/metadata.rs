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

/// How many hits a single-book lookup opens up.
///
/// Three, because the reader is looking at a list and editions differ: the same
/// title has a 2014 中信 printing and a 2017 one, and only they can say which
/// copy is on their shelf. The batch below uses one — nobody reads forty rows
/// of alternatives, and each one costs another request.
const SEARCH_DEPTH: usize = 3;

/// `metadata.search` — what the catalogues know about this book.
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
    // A fresh record for a single lookup: there is no second book to spare a
    // timeout on.
    let attempts = metadata::Attempts::new();
    metadata::find(
        &client,
        &Lookup { title: &book.title, authors: &book.authors },
        SEARCH_DEPTH,
        &attempts,
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
    /// The catalogue's snapshot: written with the fills, never edited by hand.
    pub rating: Option<f64>,
    pub rating_count: Option<i32>,
    pub douban_url: Option<String>,
    /// `douban` or `neodb`. Stored with the number: they are different numbers
    /// from different sets of people, and the sheet prints the source.
    pub rating_source: Option<String>,
}

/// `metadata.propose` — what a fill would add to these books, without writing.
///
/// Four books at a time, and two requests each — Douban's autocomplete plus the
/// record behind the hit. Measured at about 1.5 s per book end to end, so forty
/// books land in the fifteen-second range rather than the minute it would take
/// one at a time. Not higher: these are other people's servers, and the point of
/// the cap is to stay welcome, not to finish first.
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
                    rating: book.rating,
                    douban_url: book.douban_url,
                });
            }
        }
        Ok(out)
    })?;

    let client = reqwest::Client::new();
    // Shared by the whole batch: a provider that failed for book three is not
    // asked again for book four, so forty books with the proxy off cost one
    // timeout rather than forty.
    let attempts = std::sync::Arc::new(metadata::Attempts::new());
    let mut proposals: Vec<Proposal> =
        futures_util::stream::iter(targets.into_iter().map(|target| {
            let client = client.clone();
            let attempts = attempts.clone();
            async move {
                let lookup = Lookup { title: &target.title, authors: &target.authors };
                // A failure is reported per book, not swallowed into 「没有找到」:
                // a reader whose network is down was being told to try a better
                // title. One book failing still leaves the other twenty-nine
                // worth asking about.
                match metadata::find(&client, &lookup, 1, &attempts).await {
                    Ok(found) => metadata::propose_for(&target, found.into_iter().next()),
                    Err(err) => metadata::propose_failed(&target, &err.to_string()),
                }
            }
        }))
        .buffer_unordered(4)
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
                rating: None,
                rating_count: None,
                douban_url: None,
                rating_source: None,
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
                patch.rating = item.rating.or(book.rating);
                patch.rating_count = item.rating_count.or(book.rating_count);
                patch.douban_url = item.douban_url.clone().or(book.douban_url);
                // The label travels with the number, or neither does: a rating
                // whose source is unknown prints as a bare number, and a bare
                // number gets read as Douban's.
                patch.rating_source = item.rating_source.clone().or_else(|| {
                    item.rating.is_some().then(|| book.rating_source.clone()).flatten()
                });
            }
            repository::update_metadata(tx, &item.id, &patch)?;
        }
        ops::record_before(
            tx,
            ops::Source::Ui,
            "fill_metadata",
            &befores,
            &format!("从目录补全了 {} 本", items.len()),
        )?;
        Ok(items.len())
    })
}
