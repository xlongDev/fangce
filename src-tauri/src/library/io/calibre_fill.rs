//! Writing Calibre metadata into 方册's **own** library.
//!
//! `calibre.rs` never opens `metadata.db` for writing; this module never opens
//! it at all. The renderer pairs `book_import`'s outcomes with the scanned
//! books by the path it sent, then hands the pairs back. Everything below is
//! ordinary shelf persistence, in one transaction, with the same before-image
//! as every other metadata write.
//!
//! 🔴 **Only blanks are filled.** Calibre is somebody else's database and the
//! shelf is the reader's: a title the reader fixed by hand, a description
//! pasted from a catalogue, an ISBN from a different edition — none of those
//! may be overwritten by a bulk import. This also makes a re-import (which
//! reports `Duplicate`) harmless: it can add what is missing and nothing else.
//!
//! Two Calibre fields deliberately have no destination:
//!
//! * `series` — 方册 has no series column, and putting a series name into
//!   `subtitle` or `description` would be a lie about what that field means.
//! * `rating` — Calibre's 0–10 is the *reader's own* stars; 方册's `rating` is
//!   a catalogue's community score with a `rating_source` and `rating_count`.
//!   Writing `8` into it would print an unexplained number where the UI says
//!   "豆瓣评分". Both stay visible in the scan preview.
//!
//! `description` and `language` need a small translation rather than a copy:
//! the former arrives as HTML already flattened by `calibre.rs::plain_text`,
//! the latter as ISO 639-2 (`zho`) while the shelf groups on short codes
//! (`zh`). Unknown language codes pass through untouched.

use rusqlite::Transaction;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::library::calibre::CalibreMetadata;
use crate::library::repository::{BookMetadataPatch, BookSummary};
use crate::library::{ops, repository, tags};

/// One imported book and the Calibre record it came from.
///
/// `book_id` is what `book_import` returned, not Calibre's numeric id — the
/// write targets 方册's row, and a `Duplicate` outcome points at an existing
/// one. `authors` is separate from `metadata` because on the scan it is a
/// first-class field of `CalibreBook`, not one of the optional probes.
#[derive(specta::Type, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreFill {
    pub book_id: String,
    pub authors: Vec<String>,
    pub metadata: CalibreMetadata,
}

#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreApplyResult {
    /// Rows whose metadata was rewritten. Books deleted in between are skipped.
    pub written: usize,
    /// Books that received at least one tag.
    pub tagged: usize,
    /// Tag names dropped for exceeding `tags::MAX_TAG_CHARS`. Reported rather
    /// than silently lost, and never fatal to the batch.
    pub skipped_tags: usize,
}

/// Applies a batch inside the caller's transaction.
///
/// Two log entries, on purpose: the metadata write carries a before-image and
/// is undoable, while tags go through `ops::record` exactly like the reader's
/// own `book.setTags` does. A single `record_before` covering both would offer
/// an undo that cannot put the labels back — a button that lies is worse than
/// no button (see `ops::Before`).
pub fn apply(tx: &Transaction<'_>, fills: &[CalibreFill]) -> AppResult<CalibreApplyResult> {
    let mut befores = Vec::with_capacity(fills.len());
    let mut tag_batches: Vec<(String, Vec<String>)> = Vec::new();
    let mut skipped_tags = 0;

    for fill in fills {
        let Some(book) = repository::get(tx, &fill.book_id)? else {
            // Deleted between the import and this write: nothing to fill.
            continue;
        };
        // One read per book: the before-image and the patch describe the same
        // row. Reading it twice let the two disagree.
        befores.push(ops::snapshot(tx, &book)?);
        repository::update_metadata(tx, &fill.book_id, &patch_for(&book, fill))?;

        let (names, skipped) = usable_tags(&fill.metadata.tags);
        skipped_tags += skipped;
        if !names.is_empty() {
            tag_batches.push((fill.book_id.clone(), names));
        }
    }

    let written = befores.len();
    ops::record_before(
        tx,
        ops::Source::Ui,
        "calibre_metadata",
        &befores,
        &format!("从 Calibre 补全了 {written} 本"),
    )?;

    // `tags::assign` takes one add-set for a list of books, and every Calibre
    // book has its own labels, so this is one call per book. `assign` only
    // adds (`remove` is empty), which is the same rule the batch bar follows:
    // a bulk import can never take a label away that it did not know about.
    let mut tagged = 0;
    for (id, names) in &tag_batches {
        tags::assign(tx, std::slice::from_ref(id), names, &[])?;
        tagged += 1;
    }
    if tagged > 0 {
        let ids: Vec<String> = tag_batches.iter().map(|(id, _)| id.clone()).collect();
        ops::record(
            tx,
            ops::Source::Ui,
            "calibre_tags",
            &ids,
            &format!("从 Calibre 给 {tagged} 本加了标签"),
        )?;
    }

    Ok(CalibreApplyResult { written, tagged, skipped_tags })
}

/// A whole `BookMetadataPatch` built from the row plus what the scan has to
/// say. `update_metadata` writes every column, so carrying the existing values
/// through is what makes "only blanks" true rather than aspirational.
fn patch_for(book: &BookSummary, fill: &CalibreFill) -> BookMetadataPatch {
    let m = &fill.metadata;
    BookMetadataPatch {
        title: book.title.clone(),
        subtitle: book.subtitle.clone(),
        description: book.description.clone().or_else(|| nonblank(m.description.as_deref())),
        language: book
            .language
            .clone()
            .or_else(|| nonblank(m.language.as_deref()).map(|code| normalize_language(&code))),
        publisher: book.publisher.clone().or_else(|| nonblank(m.publisher.as_deref())),
        isbn: book.isbn.clone().or_else(|| nonblank(m.isbn.as_deref())),
        published_year: book.published_year.or_else(|| publication_year(m.published.as_deref())),
        // Catalogue ratings are a different number from a different set of
        // people. Keep the row exactly as it was.
        rating: book.rating,
        rating_count: book.rating_count,
        rating_source: book.rating_source.clone(),
        douban_url: book.douban_url.clone(),
        // `authors` is a whole replacement, not an append. Only use Calibre's
        // list when the imported file told us nothing at all.
        authors: if book.authors.is_empty() { fill.authors.clone() } else { book.authors.clone() },
    }
}

fn nonblank(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
}

/// Calibre's `pubdate` is a free-form date (`2006-05`, or a full timestamp
/// with a timezone), and uses `0101-01-01` for "unknown". 方册 stores just the
/// edition year, so take the leading four digits and reject the placeholders.
/// 1450 is the print era's floor; 2100 leaves room for announced reprints
/// without admitting a typo like `9999`.
fn publication_year(raw: Option<&str>) -> Option<i32> {
    let text = raw?.trim();
    let digits: String = text.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.len() != 4 {
        return None;
    }
    let year = digits.parse::<i32>().ok()?;
    (1450..=2100).contains(&year).then_some(year)
}

/// ISO 639-2 → the short code the shelf's facet panel and edit sheet use.
/// A short alias table, not a claim to know every code: an unknown one is kept
/// verbatim, because dropping a language is worse than showing an odd bucket.
fn normalize_language(code: &str) -> String {
    let trimmed = code.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "zho" | "chi" => "zh".to_string(),
        "eng" => "en".to_string(),
        "jpn" => "ja".to_string(),
        "kor" => "ko".to_string(),
        "fra" | "fre" => "fr".to_string(),
        "deu" | "ger" => "de".to_string(),
        "spa" => "es".to_string(),
        "rus" => "ru".to_string(),
        "ita" => "it".to_string(),
        "por" => "pt".to_string(),
        _ => trimmed.to_string(),
    }
}

/// `tags::assign` rejects an overlong name, and one bad name would roll back
/// the whole import's metadata. Filter by its own limit first and count what
/// was dropped. A leading `#` is stripped by `assign` afterwards, so a name
/// that fits here can only get shorter — this filter is conservative.
fn usable_tags(names: &[String]) -> (Vec<String>, usize) {
    let mut kept: Vec<String> = Vec::new();
    let mut skipped = 0;
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > tags::MAX_TAG_CHARS {
            skipped += 1;
            continue;
        }
        if !kept.iter().any(|seen| seen.eq_ignore_ascii_case(trimmed)) {
            kept.push(trimmed.to_string());
        }
    }
    (kept, skipped)
}

#[cfg(test)]
mod tests {
    use crate::db::Library;
    use crate::document::BookFormat;
    use crate::document::fixture::temp_dir;
    use crate::library::repository::NewBook;

    use super::*;

    fn metadata() -> CalibreMetadata {
        CalibreMetadata {
            publisher: Some("重庆出版社".into()),
            tags: vec!["科幻".into(), "中国文学".into()],
            series: Some("地球往事".into()),
            rating: Some("8".into()),
            language: Some("zho".into()),
            description: Some("一段简介".into()),
            isbn: Some("9787536692930".into()),
            published: Some("2006-05".into()),
        }
    }

    fn fill(book_id: &str, metadata: CalibreMetadata) -> CalibreFill {
        CalibreFill { book_id: book_id.into(), authors: vec!["刘慈欣".into()], metadata }
    }

    /// A library with one bare book, the way `book_import` would have left it
    /// if the file carried no metadata at all.
    fn harness(tag: &str) -> (std::path::PathBuf, Library) {
        let dir = temp_dir(tag);
        let library = Library::open(&dir).expect("open library");
        library
            .with_tx(|tx| {
                repository::insert(
                    tx,
                    &NewBook {
                        id: "b1",
                        title: "三体",
                        subtitle: None,
                        description: None,
                        language: None,
                        publisher: None,
                        identifier: None,
                        format: BookFormat::Epub,
                        content_hash: "b1",
                        file_path: "/books/三体.epub",
                        file_size: 1,
                        cover_path: None,
                        authors: &[],
                    },
                )
            })
            .expect("seed book");
        (dir, library)
    }

    fn book(library: &Library) -> BookSummary {
        library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1")
    }

    fn run(library: &Library, fills: Vec<CalibreFill>) -> CalibreApplyResult {
        library.with_tx(|tx| apply(tx, &fills)).expect("apply")
    }

    #[test]
    fn blanks_are_filled_and_the_whole_batch_is_logged() {
        let (_dir, library) = harness("calibre-fill-blanks");
        let result = run(&library, vec![fill("b1", metadata())]);

        assert_eq!(result, CalibreApplyResult { written: 1, tagged: 1, skipped_tags: 0 });
        let book = book(&library);
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"));
        assert_eq!(book.description.as_deref(), Some("一段简介"));
        assert_eq!(book.isbn.as_deref(), Some("9787536692930"));
        assert_eq!(book.published_year, Some(2006));
        assert_eq!(book.language.as_deref(), Some("zh"), "ISO 639-2 → short code");
        assert_eq!(book.authors, vec!["刘慈欣"]);
        assert_eq!(book.tags, vec!["中国文学", "科幻"]);

        // Series and rating have no honest destination in 方册.
        assert_eq!(book.rating, None);
        assert_eq!(book.rating_source, None);
        let rows = library.with(|conn| ops::list(conn, 10)).expect("list");
        assert_eq!(rows.len(), 2, "one undoable metadata row, one tag row");
        assert!(rows.iter().any(|row| row.action == "calibre_metadata" && row.undoable));
        assert!(rows.iter().any(|row| row.action == "calibre_tags" && !row.undoable));
    }

    #[test]
    fn existing_values_survive_a_second_import() {
        let (_dir, library) = harness("calibre-fill-keep");
        library
            .with_tx(|tx| {
                let book = repository::get(tx, "b1")?.expect("b1");
                repository::update_metadata(
                    tx,
                    "b1",
                    &BookMetadataPatch {
                        title: book.title,
                        subtitle: None,
                        description: Some("读者自己写的简介".into()),
                        language: Some("en".into()),
                        publisher: Some("读者更正的出版社".into()),
                        isbn: Some("1111111111".into()),
                        published_year: Some(2014),
                        rating: Some(9.1),
                        rating_count: Some(1000),
                        rating_source: Some("douban".into()),
                        douban_url: Some("https://book.douban.com/subject/1/".into()),
                        authors: vec!["读者指定的作者".into()],
                    },
                )
            })
            .expect("seed existing metadata");

        run(&library, vec![fill("b1", metadata())]);

        let book = book(&library);
        assert_eq!(book.publisher.as_deref(), Some("读者更正的出版社"));
        assert_eq!(book.description.as_deref(), Some("读者自己写的简介"));
        assert_eq!(book.language.as_deref(), Some("en"));
        assert_eq!(book.isbn.as_deref(), Some("1111111111"));
        assert_eq!(book.published_year, Some(2014));
        assert_eq!(book.rating, Some(9.1), "目录评分没被 Calibre 的个人星级冲掉");
        assert_eq!(book.authors, vec!["读者指定的作者"]);
        assert_eq!(book.title, "三体");
    }

    #[test]
    fn tags_only_add_and_never_take_away() {
        let (_dir, library) = harness("calibre-fill-tags");
        library
            .with_tx(|tx| tags::assign(tx, &["b1".into()], &["在读".into()], &[]))
            .expect("seed a reader's own label");

        run(&library, vec![fill("b1", metadata())]);

        let labels = book(&library).tags;
        assert!(labels.contains(&"在读".to_string()), "读者自己的标签还在");
        assert!(labels.contains(&"科幻".to_string()));
    }

    #[test]
    fn an_overlong_tag_is_counted_not_fatal() {
        let (_dir, library) = harness("calibre-fill-long-tag");
        let mut m = metadata();
        m.tags.push("字".repeat(tags::MAX_TAG_CHARS + 1));

        let result = run(&library, vec![fill("b1", m)]);

        assert_eq!(result.skipped_tags, 1);
        assert_eq!(result.written, 1, "the metadata still landed");
        assert!(book(&library).tags.contains(&"科幻".to_string()));
    }

    #[test]
    fn a_deleted_book_and_an_empty_batch_are_skipped() {
        let (_dir, library) = harness("calibre-fill-missing");
        assert_eq!(
            run(&library, vec![fill("gone", metadata())]),
            CalibreApplyResult { written: 0, tagged: 0, skipped_tags: 0 }
        );
        assert_eq!(
            run(&library, vec![]),
            CalibreApplyResult { written: 0, tagged: 0, skipped_tags: 0 }
        );
        assert!(library.with(|conn| ops::list(conn, 10)).expect("list").is_empty());
    }

    #[test]
    fn calibre_dates_map_to_an_edition_year_or_nothing() {
        assert_eq!(publication_year(Some("2006-05")), Some(2006));
        assert_eq!(publication_year(Some(" 2006-05-01 00:00:00+00:00 ")), Some(2006));
        assert_eq!(publication_year(Some("2014/8/1")), Some(2014));
        assert_eq!(publication_year(Some("0101-01-01 00:00:00+00:00")), None);
        assert_eq!(publication_year(Some("9999-01-01")), None);
        assert_eq!(publication_year(Some("未注明")), None);
        assert_eq!(publication_year(Some("20")), None);
        assert_eq!(publication_year(None), None);
    }

    #[test]
    fn unknown_language_codes_pass_through() {
        assert_eq!(normalize_language("ENG"), "en");
        assert_eq!(normalize_language("zho"), "zh");
        assert_eq!(normalize_language(" chi "), "zh");
        assert_eq!(normalize_language("zh-CN"), "zh-CN");
        assert_eq!(normalize_language(""), "");
    }

    /// 🔴 The before-image used to carry no authors. `update_metadata` writes
    /// the author list wholesale, so an undo restored nine fields and left the
    /// tenth changed while reporting success. This pins the whole round trip.
    #[test]
    fn undo_puts_the_fields_and_the_authors_back() {
        let (dir, library) = harness("calibre-fill-undo");
        run(&library, vec![fill("b1", metadata())]);
        assert_eq!(book(&library).authors, vec!["刘慈欣"]);

        let call_id = library
            .with(|conn| ops::list(conn, 10))
            .expect("list")
            .into_iter()
            .find(|row| row.action == "calibre_metadata")
            .expect("metadata row")
            .call_id;
        let outcome =
            library.with_tx(|tx| ops::undo(tx, &call_id, &dir.join("covers"))).expect("undo");
        assert_eq!(outcome.undone, 1);

        let book = book(&library);
        assert_eq!(book.publisher, None);
        assert_eq!(book.description, None);
        assert_eq!(book.language, None);
        assert_eq!(book.isbn, None);
        assert_eq!(book.published_year, None);
        assert!(book.authors.is_empty(), "作者也回到了写入之前");
    }
}
