//! `metadata.*` — asking a catalogue about a book.
//!
//! Read-only, and deliberately not part of the write path: a candidate is a
//! suggestion, and applying it goes through `book.update` like any other edit.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::StreamExt;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::custom_source::{self, CustomProvider, CustomSourceDef, CustomSourceEntry};
use crate::library::metadata::{
    self, Candidate, Lookup, MIN_SCORE, MetadataProvider, Proposal, Target,
};
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
    let builtin = metadata::by_key(&source);
    // A custom source's key is its row id. Resolve it before any network call,
    // and keep the provider alive across the await — it owns its definition.
    let custom = if builtin.is_none() {
        custom_source::load(&state.library, &source)
            .ok()
            .map(|def| CustomProvider::new(source.clone(), def))
    } else {
        None
    };
    if builtin.is_none() && custom.is_none() {
        return Err(AppError::InvalidArgument(format!("没有这个书目来源：{source}")));
    }

    let book = state
        .library
        .with(|conn| repository::get(conn, &id))?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;

    let client = metadata::client();
    let lookup = Lookup::new(&book.title, &book.authors, book.isbn.is_none());
    if let Some(provider) = &custom {
        return metadata::search(&client, provider, &lookup, SEARCH_DEPTH).await;
    }
    metadata::search(&client, builtin.expect("resolved above"), &lookup, SEARCH_DEPTH).await
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
    // 「连已有封面一起换」. Off by default, and the reason a book that has a
    // picture is normally not offered another one.
    replace_covers: bool,
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
    // Loaded once for the whole batch, like `Attempts`: a definition the
    // reader wrote is part of the chain for every book in this run.
    // Loaded once for the whole batch, like `Attempts`: a definition the
    // reader wrote is part of the chain for every book in this run. An Arc
    // lets each concurrent task borrow its providers without outliving them.
    let customs = std::sync::Arc::new(
        state
            .library
            .with(custom_source::list)?
            .into_iter()
            .map(|entry| CustomProvider::new(entry.id, entry.def))
            .collect::<Vec<_>>(),
    );

    // Shared by the whole batch: a provider that failed for book three is not
    // asked again for book four, so forty books with the proxy off cost one
    // timeout rather than forty.
    let attempts = std::sync::Arc::new(metadata::Attempts::new());
    let mut proposals: Vec<Proposal> =
        futures_util::stream::iter(targets.into_iter().map(|target| {
            let client = client.clone();
            let attempts = attempts.clone();
            let customs = customs.clone();
            async move {
                let lookup = Lookup::new(&target.title, &target.authors, target.isbn.is_none());
                // A failure is reported per book, not swallowed into 「没有找到」:
                // a reader whose network is down was being told to try a better
                // title. One book failing still leaves the other twenty-nine
                // worth asking about.
                let mut chain = metadata::PROVIDERS.to_vec();
                chain.extend(customs.iter().map(|provider| provider as &dyn MetadataProvider));
                match metadata::find_with(&client, &chain, &lookup, 1, &attempts).await {
                    Ok(found) => metadata::propose_for_with(
                        &target,
                        found.into_iter().next(),
                        replace_covers,
                    ),
                    Err(AppError::Throttled { provider, status, retry_after }) => {
                        metadata::propose_throttled(&target, &provider, status, retry_after)
                    }
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

/// One book's title choices for the explicit batch rename sheet.
///
/// Not a fill: a fill only writes empty fields, and a book always has a title.
/// This is a separate action because renaming forty books on the strength of a
/// heuristic is a different decision from filling in what is missing — the
/// reader sees each old title against each candidate and ticks the ones to take.
#[derive(specta::Type, Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleProposal {
    pub book_id: String,
    /// The title on the shelf right now, shown beside the candidate.
    pub book_title: String,
    /// Catalogue titles, best first. Never the title already on the shelf.
    pub candidates: Vec<Candidate>,
    /// Whether the first candidate clears the normal match bar. A weak answer
    /// is still shown, but nothing is ticked by default: this sheet asks the
    /// reader, it does not vote by proxy.
    pub confident: bool,
    /// Why there is nothing to choose from. Distinct from a weak match.
    pub skipped: Option<String>,
}

/// How many choices one book shows. `depth` opens that many records from the
/// first answer; it is not another request to somebody else's server.
const TITLE_DEPTH: usize = 3;

/// `metadata.proposeTitles` — what the catalogues would call these books.
#[tauri::command]
#[specta::specta]
pub async fn metadata_propose_titles(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<TitleProposal>> {
    let targets: Vec<(String, String, Vec<String>, bool)> = state.library.with(|conn| {
        let mut out = Vec::new();
        for id in &ids {
            if let Some(book) = repository::get(conn, id)? {
                out.push((id.clone(), book.title, book.authors, book.isbn.is_none()));
            }
        }
        Ok(out)
    })?;

    let client = metadata::client();
    let customs = std::sync::Arc::new(
        state
            .library
            .with(custom_source::list)?
            .into_iter()
            .map(|entry| CustomProvider::new(entry.id, entry.def))
            .collect::<Vec<_>>(),
    );
    let attempts = std::sync::Arc::new(metadata::Attempts::new());

    let mut proposals: Vec<(usize, TitleProposal)> = futures_util::stream::iter(
        targets.into_iter().enumerate().map(|(position, (id, title, authors, no_isbn))| {
            let client = client.clone();
            let attempts = attempts.clone();
            let customs = customs.clone();
            async move {
                let lookup = Lookup::new(&title, &authors, no_isbn);
                let mut chain = metadata::PROVIDERS.to_vec();
                chain.extend(customs.iter().map(|provider| provider as &dyn MetadataProvider));
                let (candidates, skipped) =
                    match metadata::find_with(&client, &chain, &lookup, TITLE_DEPTH, &attempts)
                        .await
                    {
                        Ok(found) => {
                            let candidates: Vec<Candidate> = found
                                .into_iter()
                                .filter(|candidate| {
                                    !candidate.title.trim().is_empty()
                                        && candidate.title.trim() != title.trim()
                                })
                                .take(TITLE_DEPTH)
                                .collect();
                            let skipped =
                                candidates.is_empty().then(|| "目录里没有别的书名".to_string());
                            (candidates, skipped)
                        }
                        Err(err) => (Vec::new(), Some(format!("查询失败：{err}"))),
                    };
                let confident =
                    candidates.first().is_some_and(|candidate| candidate.match_score >= MIN_SCORE);
                (
                    position,
                    TitleProposal {
                        book_id: id,
                        book_title: title,
                        candidates,
                        confident,
                        skipped,
                    },
                )
            }
        }),
    )
    .buffer_unordered(4)
    .collect()
    .await;
    // The network decides when answers arrive; the reader reads in shelf order.
    proposals.sort_by_key(|(position, _)| *position);
    Ok(proposals.into_iter().map(|(_, proposal)| proposal).collect())
}

/// One accepted rename, as the preview sends it.
#[derive(specta::Type, Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleRename {
    pub id: String,
    pub title: String,
}

/// `metadata.applyTitles` — writes only the titles the reader ticked.
#[tauri::command]
#[specta::specta]
pub fn metadata_apply_titles(
    state: State<'_, AppState>,
    items: Vec<TitleRename>,
) -> AppResult<usize> {
    apply_title_renames(&state.library, &items)
}

fn apply_title_renames(library: &crate::db::Library, items: &[TitleRename]) -> AppResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    library.with_tx(|tx| {
        let mut rows = Vec::new();
        let mut written = 0;
        for item in items {
            let Some(book) = repository::get(tx, &item.id)? else {
                continue;
            };
            let title = item.title.trim();
            if title.is_empty() || title == book.title.trim() {
                continue;
            }
            let before = ops::snapshot(tx, &book)?;
            rows.push((item.id.clone(), title_before(&book, &before)));
            repository::update_metadata(tx, &item.id, &rename_patch(&book, title))?;
            written += 1;
        }
        let summary = format!("从目录改了 {written} 本书名");
        ops::record_details(tx, ops::Source::Ui, "rename_titles", &summary, &rows)?;
        Ok(written)
    })
}

/// A whole record with only the title changed: `update_metadata` writes every
/// column, and a rename has no business clearing a blurb or a rating.
fn rename_patch(book: &repository::BookSummary, title: &str) -> repository::BookMetadataPatch {
    repository::BookMetadataPatch {
        title: title.to_string(),
        subtitle: book.subtitle.clone(),
        description: book.description.clone(),
        language: book.language.clone(),
        publisher: book.publisher.clone(),
        isbn: book.isbn.clone(),
        published_year: book.published_year,
        rating: book.rating,
        rating_count: book.rating_count,
        rating_source: book.rating_source.clone(),
        douban_url: book.douban_url.clone(),
        authors: book.authors.clone(),
    }
}

/// A v3 before-image with one extra key: `ops::restore` already reads `title`
/// when present and orders ordinary fills to carry theirs through. Writing that
/// key only for renames keeps an undo of an unrelated fill from clobbering a
/// title the reader edited afterwards.
fn title_before(book: &repository::BookSummary, before: &ops::Before) -> serde_json::Value {
    serde_json::json!({
        "v": 3,
        "before": {
            "title": book.title,
            "authors": before.authors,
            "subtitle": before.subtitle,
            "publisher": before.publisher,
            "language": before.language,
            "isbn": before.isbn,
            "published_year": before.published_year,
            "description": before.description,
            "rating": before.rating,
            "rating_count": before.rating_count,
            "rating_source": before.rating_source,
            "douban_url": before.douban_url,
            "cover_path": before.cover_path,
            "cover_previous": before.cover_previous,
        }
    })
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
            let before = ops::snapshot(tx, &book)?;
            // Read before the write: the picture this one may replace.
            let previous = before.cover_path.clone();
            befores.push(before);
            // A full record: `update_metadata` takes the whole row, so every
            // field this fill does not name has to be carried over.
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

            // The proposal already decided whether this book may take another
            // picture — it only carries a `cover_url` when it may. So a
            // downloaded cover is written, replacing the old one if there was
            // one, and the old file is moved aside so 撤销 can put it back.
            if let Some((_, bytes)) = covers.iter().find(|(id, _)| id == &item.id)
                && let Some(extension) = metadata::image_extension(bytes)
            {
                // `.dl.` marks a cover this app downloaded from a catalogue
                // (Douban / NeoDB), so the storage report can count downloaded
                // covers without mistaking a book's own embedded picture for
                // one.
                let target = covers_dir.join(format!("{}.dl.{}", item.id, extension));
                let moved = crate::library::move_aside(previous.as_deref(), &covers_dir, &item.id);
                std::fs::write(&target, bytes)?;
                repository::set_cover(tx, &item.id, target.to_string_lossy().as_ref())?;
                if let (Some(last), Some((_, kept))) = (befores.last_mut(), moved) {
                    last.cover_previous = Some(kept.to_string_lossy().into_owned());
                }
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

/// A preview is a thumbnail in a 40-pixel box. Past this it is not a thumbnail,
/// and base64 makes it a third larger again while it crosses the IPC boundary —
/// the sheet would stall for a picture the reader is about to see at a tenth of
/// the size. The real download keeps its own, larger, limit.
const PREVIEW_LIMIT: usize = 4 * 1024 * 1024;

/// `metadata.cover_preview` — the picture a catalogue offers, as a data URL.
///
/// The candidate list has to show the cover **before** anything is saved. Two
/// editions of one title differ by their cover more than by their title, and
/// picking one blind is how a reader ends up with the wrong printing's blurb.
///
/// The bytes pass the same gate a real download does — https, a catalogue's own
/// image host, a real JPEG or PNG — but nothing is written: this is a question,
/// and the answer lives in the webview's memory until the query cache drops it.
///
/// `data:` rather than the URL itself for two reasons. The CSP allows
/// `img-src data:` and not the catalogues' CDNs, and Douban's image host
/// answers 418 to a bare `<img>`: it wants a referer, which only a request from
/// here can send.
#[tauri::command]
#[specta::specta]
pub async fn metadata_cover_preview(url: String) -> AppResult<String> {
    let client = metadata::client();
    let bytes = metadata::download_cover(&client, &url).await?;
    if bytes.len() > PREVIEW_LIMIT {
        return Err(AppError::Message("封面太大，预览不了".into()));
    }
    let mime =
        metadata::preview_mime(&bytes).ok_or_else(|| AppError::Parse("拿到的不是图片".into()))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// `metadata.sourceList` — reader-defined catalogues, definitions included.
#[tauri::command]
#[specta::specta]
pub fn metadata_source_list(state: State<'_, AppState>) -> AppResult<Vec<CustomSourceEntry>> {
    state.library.with(custom_source::list)
}

/// `metadata.sourceSave` — add or update one reader-defined catalogue.
#[tauri::command]
#[specta::specta]
pub fn metadata_source_save(
    state: State<'_, AppState>,
    id: Option<String>,
    def: CustomSourceDef,
) -> AppResult<String> {
    custom_source::save(&state.library, id.as_deref(), &def)
}

/// `metadata.sourceDelete` — remove one reader-defined catalogue. Ratings
/// already written from it keep their source key; this never touches books.
#[tauri::command]
#[specta::specta]
pub fn metadata_source_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    custom_source::delete(&state.library, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::db::Library;
    use crate::document::BookFormat;
    use crate::library::repository::NewBook;

    fn seeded(tag: &str) -> (std::path::PathBuf, Library) {
        let dir = crate::document::fixture::temp_dir(tag);
        let library = Library::open(&dir).expect("open");
        library
            .with_tx(|tx| {
                repository::insert(
                    tx,
                    &NewBook {
                        id: "b1",
                        title: "理想国译丛009 · 零年：1945现代世界诞生的时刻",
                        subtitle: Some("现代世界诞生的时刻"),
                        description: Some("一段简介"),
                        language: Some("zh"),
                        publisher: Some("广西师范大学出版社"),
                        identifier: None,
                        format: BookFormat::Epub,
                        content_hash: "b1",
                        file_path: "/books/x.epub",
                        file_size: 1,
                        cover_path: None,
                        authors: &["伊恩·布鲁玛".to_string()],
                    },
                )
            })
            .expect("seed");
        (dir, library)
    }

    #[test]
    fn a_rename_changes_the_title_only_and_the_log_can_put_it_back() {
        let (dir, library) = seeded("title-rename");
        let written = apply_title_renames(
            &library,
            &[TitleRename { id: "b1".into(), title: "  零年：1945  ".into() }],
        )
        .expect("apply");
        assert_eq!(written, 1);

        library
            .with(|conn| {
                let book = repository::get(conn, "b1").expect("get").expect("book");
                assert_eq!(book.title, "零年：1945");
                assert_eq!(book.subtitle.as_deref(), Some("现代世界诞生的时刻"));
                assert_eq!(book.publisher.as_deref(), Some("广西师范大学出版社"));
                assert_eq!(book.description.as_deref(), Some("一段简介"));
                assert_eq!(book.authors, ["伊恩·布鲁玛".to_string()]);
                Ok(())
            })
            .expect("read back");

        let rows = library.with(|conn| ops::list(conn, 10)).expect("log");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "rename_titles");
        library.with_tx(|tx| ops::undo(tx, &rows[0].call_id, &dir.join("covers"))).expect("undo");

        library
            .with(|conn| {
                let book = repository::get(conn, "b1").expect("get").expect("book");
                assert_eq!(book.title, "理想国译丛009 · 零年：1945现代世界诞生的时刻");
                Ok(())
            })
            .expect("read after undo");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rename_to_the_title_already_on_the_shelf_is_not_written() {
        let (dir, library) = seeded("title-noop");
        let written = apply_title_renames(
            &library,
            &[TitleRename {
                id: "b1".into(),
                title: "理想国译丛009 · 零年：1945现代世界诞生的时刻".into(),
            }],
        )
        .expect("apply");
        assert_eq!(written, 0, "a no-op must not leave an undo button behind");
        assert!(library.with(|conn| ops::list(conn, 10)).expect("log").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
