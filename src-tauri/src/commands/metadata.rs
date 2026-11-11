//! `metadata.*` — asking a catalogue about a book.
//!
//! Read-only, and deliberately not part of the write path: a candidate is a
//! suggestion, and applying it goes through `book.update` like any other edit.

use futures_util::StreamExt;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::metadata::{self, Candidate, Lookup, Proposal, Provider, Target};
use crate::library::{ops, repository};
use crate::state::AppState;

/// How many hits a single-book lookup opens up.
///
/// Three, because the reader is looking at a list and editions differ: the same
/// title has a 2014 中信 printing and a 2017 one, and only they can say which
/// copy is on their shelf. The batch below uses one — nobody reads forty rows
/// of alternatives, and each one costs another request.
const SEARCH_DEPTH: usize = 3;

/// `metadata.search` — what one catalogue knows about this book.
///
/// The source is the caller's choice, not a chain. The two catalogues answer
/// differently — Douban has Chinese coverage and no ISBN, NeoDB has both and
/// needs a proxy — and a reader comparing them is the whole reason the sheet
/// has two buttons. Asking both and merging would hide which record they are
/// looking at.
///
/// The book is read first and the network call comes after, so no database
/// guard is held across the await: the app's single connection serialises
/// everything, and a twelve-second HTTP timeout inside it would freeze the
/// shelf.
#[tauri::command]
#[specta::specta]
pub async fn metadata_search(
    state: State<'_, AppState>,
    id: String,
    source: String,
) -> AppResult<Vec<Candidate>> {
    let provider = Provider::parse(&source)
        .ok_or_else(|| AppError::InvalidArgument(format!("没有这个书目来源：{source}")))?;
    let book = state
        .library
        .with(|conn| repository::get(conn, &id))?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;

    let client = metadata::client();
    metadata::search(
        &client,
        provider,
        &Lookup::new(&book.title, &book.authors, book.isbn.is_none()),
        SEARCH_DEPTH,
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
    /// A picture to fetch, when the book has none. Not a field: it is a file,
    /// downloaded before the write rather than inside it.
    pub cover_url: Option<String>,
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
                    has_cover: book.cover_url.is_some(),
                });
            }
        }
        Ok(out)
    })?;

    let client = metadata::client();
    // Shared by the whole batch: a provider that failed for book three is not
    // asked again for book four, so forty books with the proxy off cost one
    // timeout rather than forty.
    let attempts = std::sync::Arc::new(metadata::Attempts::new());
    let mut proposals: Vec<Proposal> =
        futures_util::stream::iter(targets.into_iter().map(|target| {
            let client = client.clone();
            let attempts = attempts.clone();
            async move {
                let lookup = Lookup::new(&target.title, &target.authors, target.isbn.is_none());
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
/// **Covers are downloaded before the transaction opens.** The library has one
/// connection and a twenty-second download inside it would freeze the shelf;
/// it is the same rule the read path follows in the other direction.
///
/// A cover that will not download is not a reason to drop the fields that did.
/// The row still gains its metadata, and the missing picture is one more thing
/// the next run can try.
///
/// One transaction and one log entry for the whole batch, with before-images:
/// a fill is a bulk edit, and the reader has to be able to put it back.
#[tauri::command]
#[specta::specta]
pub async fn metadata_apply(
    state: State<'_, AppState>,
    items: Vec<MetadataFill>,
) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    let client = metadata::client();
    let mut covers: Vec<(String, Vec<u8>)> = Vec::new();
    for item in &items {
        let Some(url) = item.cover_url.as_deref() else {
            continue;
        };
        if let Ok(bytes) = metadata::download_cover(&client, url).await {
            covers.push((item.id.clone(), bytes));
        }
    }

    let covers_dir = state.layout.covers_dir.clone();
    state.library.with_tx(move |tx| {
        let mut befores = Vec::new();
        let mut written = 0;
        for item in &items {
            // One read per book: the before-image and the patch both come from
            // the same row. Reading it twice let the two disagree.
            let Some(book) = repository::get(tx, &item.id)? else {
                // Deleted between the lookup and the write — nothing to fill.
                continue;
            };
            befores.push(ops::snapshot(tx, &book)?);
            // A full record, built from the row plus whatever this fill says:
            // `update_fields_many` only knows the two fields the batch sheet
            // edits, and a fill writes more than that.
            let patch = crate::library::repository::BookMetadataPatch {
                title: book.title.clone(),
                subtitle: item.subtitle.clone().or(book.subtitle.clone()),
                description: item.description.clone().or(book.description.clone()),
                language: item.language.clone().or(book.language.clone()),
                publisher: item.publisher.clone().or(book.publisher.clone()),
                isbn: item.isbn.clone().or(book.isbn.clone()),
                published_year: item.published_year.or(book.published_year),
                rating: item.rating.or(book.rating),
                rating_count: item.rating_count.or(book.rating_count),
                // The label travels with the number, or neither does: a rating
                // whose source is unknown prints as a bare number, and a bare
                // number gets read as Douban's.
                rating_source: item.rating_source.clone().or_else(|| {
                    item.rating.is_some().then(|| book.rating_source.clone()).flatten()
                }),
                douban_url: item.douban_url.clone().or(book.douban_url.clone()),
                authors: book.authors.clone(),
            };
            repository::update_metadata(tx, &item.id, &patch)?;
            written += 1;

            // The cover, only when the book still has none: the proposal was
            // made minutes ago, and the reader may have added one since.
            if book.cover_url.is_none()
                && let Some((_, bytes)) = covers.iter().find(|(id, _)| id == &item.id)
                && let Some(extension) = metadata::image_extension(bytes)
            {
                let target = covers_dir.join(format!("{}.{extension}", item.id));
                std::fs::write(&target, bytes)?;
                repository::set_cover(tx, &item.id, target.to_string_lossy().as_ref())?;
            }
        }
        ops::record_before(
            tx,
            ops::Source::Ui,
            "fill_metadata",
            &befores,
            &format!("从目录补全了 {written} 本"),
        )?;
        Ok(written)
    })
}
