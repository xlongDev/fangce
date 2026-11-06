//! Chapter persistence: the reader engine's working set.
//!
//! Chapters are plain text split at import time. The reader loads one chapter
//! at a time and maps a global progress fraction onto a chapter using the
//! `chars` counts, so no content is ever fetched just to know where to resume.

use std::path::Path;

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;

use crate::db::Library;
use crate::document::{self, RawChapter};
use crate::error::AppResult;
use crate::library::repository;

/// One chapter row, ready to hand to the frontend without its body.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterMeta {
    pub idx: usize,
    pub title: String,
    /// Character count of the whole chapter, used for progress mapping.
    pub chars: usize,
}

/// A single chapter's body, returned by the reader.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContent {
    pub idx: usize,
    pub title: String,
    pub paragraphs: Vec<String>,
}

/// One in-book image: the chapter it sits in and its archive entry path.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImage {
    pub chapter_idx: usize,
    pub path: String,
}

/// Inserts every extracted chapter for a book. Called inside the import
/// transaction so a book and its chapters are atomic.
pub fn insert(tx: &Transaction<'_>, book_id: &str, chapters: &[RawChapter]) -> AppResult<()> {
    for (index, chapter) in chapters.iter().enumerate() {
        let title = chapter
            .title
            .clone()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| crate::document::untitled_section(index + 1));
        let content = chapter.paragraphs.join("\n");
        let chars = content.chars().count();
        tx.execute(
            "INSERT INTO chapters (book_id, idx, title, content, chars) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![book_id, index as i64, title, content, chars as i64],
        )?;
    }
    Ok(())
}

/// Replaces every stored chapter with a fresh extraction of the source file.
///
/// Chapters are derived data, so a re-import of an unchanged file (deduped by
/// content hash) still refreshes them — healing books imported before a parser
/// fix, such as the one that started keeping images.
pub fn replace(tx: &Transaction<'_>, book_id: &str, chapters: &[RawChapter]) -> AppResult<()> {
    tx.execute("DELETE FROM chapters WHERE book_id = ?1", params![book_id])?;
    insert(tx, book_id, chapters)
}

/// Chapter metadata in reading order, without the bodies.
pub fn list(conn: &Connection, book_id: &str) -> AppResult<Vec<ChapterMeta>> {
    let mut stmt =
        conn.prepare("SELECT idx, title, chars FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let mut rows = stmt.query(params![book_id])?;
    let mut chapters = Vec::new();
    while let Some(row) = rows.next()? {
        chapters.push(ChapterMeta {
            idx: row.get::<_, i64>(0)? as usize,
            title: row.get(1)?,
            chars: row.get::<_, i64>(2)? as usize,
        });
    }
    Ok(chapters)
}

/// The body of one chapter, split back into paragraphs, or `None` when the
/// book or chapter does not exist.
pub fn content(conn: &Connection, book_id: &str, idx: usize) -> AppResult<Option<ChapterContent>> {
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT title, content FROM chapters WHERE book_id = ?1 AND idx = ?2",
            params![book_id, idx as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((title, content)) = found else { return Ok(None) };
    let paragraphs = content.split('\n').map(str::to_string).collect();
    Ok(Some(ChapterContent { idx, title, paragraphs }))
}

/// Every image in a book, in reading order: one row per image marker line.
///
/// Powers the lightbox's book-wide browsing; the reader only has the current
/// chapter's body in memory, so this scans the stored chapter text instead.
pub fn images(conn: &Connection, book_id: &str) -> AppResult<Vec<BookImage>> {
    let mut stmt =
        conn.prepare("SELECT idx, content FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let mut rows = stmt.query(params![book_id])?;
    let mut images = Vec::new();
    while let Some(row) = rows.next()? {
        let idx = row.get::<_, i64>(0)? as usize;
        let content: String = row.get(1)?;
        for line in content.split('\n') {
            if let Some(path) = line.strip_prefix(document::IMAGE_PARAGRAPH_PREFIX) {
                images.push(BookImage { chapter_idx: idx, path: path.to_string() });
            }
        }
    }
    Ok(images)
}

/// Number of chapters for a book; `0` for books imported before Phase 3.
pub fn count(conn: &Connection, book_id: &str) -> AppResult<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chapters WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Extracts a deferred book's chapter text, then clears the flag that asked
/// for it. A no-op for every book that was not deferred, which is all of them
/// except PDFs.
///
/// The importer stores a PDF's page index but not its text, because the text is
/// one full decode of the document (974 ms on a 756-page file, 98% of the
/// import) and nothing on the shelf needs it yet. This is where it comes back:
/// the importer runs it on a background thread so the book is searchable
/// moments after it lands, and [`content_ready`] / [`ensure_text`] run it again
/// whenever a *consumer of the words* touches a book whose backfill never
/// finished — so the deferral is a delay, never a loss.
///
/// What deliberately does *not* call this: [`ensure`], the reader's TOC. The
/// TOC is only the page index, and the reader asks for it and the first chapter
/// in parallel on mount — routing the backfill through the TOC put a full
/// decode in front of "正在打开…" on a freshly imported PDF, which is the
/// import delay again, moved one click later rather than removed.
pub fn backfill(library: &Library, book_id: &str) -> AppResult<()> {
    if !library.with(|conn| repository::chapters_pending(conn, book_id))? {
        return Ok(());
    }

    let (path, format) = library.with(|conn| repository::source(conn, book_id))?;
    let raw = document::read_chapters(Path::new(&path), format)?;

    library.with_tx(|tx| {
        replace(tx, book_id, &raw)?;
        repository::set_chapters_pending(tx, book_id, false)
    })
}

/// The body of one chapter, with the text guaranteed to be there first.
///
/// `reader.chapter` goes through here rather than straight to [`content`],
/// because the reader asks for the TOC and the current chapter *in parallel*:
/// the TOC is what runs the backfill, so a chapter read can land first and be
/// served the empty index. The reader then caches that blank body for a minute
/// — long enough for TTS to find nothing to read and for a highlight made in
/// the meantime to be anchored at offset 0, which is a wrong position rather
/// than a missing one. Reading the chapter is the moment the text stops being
/// optional, so that is where the debt gets paid.
pub fn content_ready(
    library: &Library,
    book_id: &str,
    idx: usize,
) -> AppResult<Option<ChapterContent>> {
    backfill(library, book_id)?;
    library.with(|conn| content(conn, book_id, idx))
}

/// Chapter metadata for a book, building it from the source file when absent.
///
/// Two promise regimes. This one — the reader's — is the *light* promise:
/// the index is there and the reader can page through it. The text is a
/// separate debt (see [`ensure_text`]): the importer defers it past the import,
/// and the search index is the path that pays it. The reader fetches the TOC
/// and the current chapter in parallel on mount, so a TOC call that blocked on
/// the extraction would put the whole reader behind a multi-second decode on
/// a freshly imported PDF — the very delay the deferral was meant to spare.
pub fn ensure(library: &Library, book_id: &str) -> AppResult<Vec<ChapterMeta>> {
    if library.with(|conn| count(conn, book_id))? > 0 {
        return library.with(|conn| list(conn, book_id));
    }

    let (path, format) = library.with(|conn| repository::source(conn, book_id))?;
    let raw = document::read_chapters(Path::new(&path), format)?;

    library.with_tx(|tx| {
        let existing: i64 = tx.query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?1",
            params![book_id],
            |row| row.get(0),
        )?;
        if existing == 0 {
            insert(tx, book_id, &raw)?;
        }
        Ok(())
    })?;

    library.with(|conn| list(conn, book_id))
}

/// The same as [`ensure`], but pays off a deferred book's text first so the
/// returned index carries the words search, TTS and the assistant read.
///
/// Racing the importer's background pass is harmless: `backfill` is idempotent
/// and whichever call loses the flag simply finds nothing to do.
pub fn ensure_text(library: &Library, book_id: &str) -> AppResult<Vec<ChapterMeta>> {
    backfill(library, book_id)?;
    ensure(library, book_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'txt', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn
    }

    fn chapters() -> Vec<RawChapter> {
        vec![
            RawChapter { title: Some("甲".into()), paragraphs: vec!["一".into(), "二".into()] },
            RawChapter { title: None, paragraphs: vec!["三".into()] },
        ]
    }

    #[test]
    fn chapters_round_trip_through_the_database() {
        let mut conn = seed();
        let tx = conn.transaction().expect("tx");
        insert(&tx, "b", &chapters()).expect("insert");
        tx.commit().expect("commit");

        let meta = list(&conn, "b").expect("list");
        assert_eq!(meta.len(), 2);
        assert_eq!(meta[0].title, "甲");
        assert_eq!(
            meta[1].title, "第 2 节",
            "缺标题的章节要编号兜底，且不能叫「章」——会和书里真正的章撞名"
        );

        let body = content(&conn, "b", 0).expect("content").expect("some");
        assert_eq!(body.paragraphs, ["一", "二"]);
        assert_eq!(body.idx, 0);
    }

    #[test]
    fn replace_swaps_stale_chapters_for_a_fresh_extraction() {
        let mut conn = seed();
        let tx = conn.transaction().expect("tx");
        insert(&tx, "b", &chapters()).expect("insert");
        tx.commit().expect("commit");

        let fresh = vec![RawChapter {
            title: Some("新".into()),
            paragraphs: vec!["\u{FFFC}images/p.png".into()],
        }];
        let tx = conn.transaction().expect("tx");
        replace(&tx, "b", &fresh).expect("replace");
        tx.commit().expect("commit");

        let meta = list(&conn, "b").expect("list");
        assert_eq!(meta.len(), 1);
        assert_eq!(meta[0].title, "新");
        let body = content(&conn, "b", 0).expect("content").expect("some");
        assert_eq!(body.paragraphs, ["\u{FFFC}images/p.png"]);
    }

    #[test]
    fn images_lists_every_marker_line_in_reading_order() {
        let mut conn = seed();
        let tx = conn.transaction().expect("tx");
        insert(
            &tx,
            "b",
            &[
                RawChapter {
                    title: Some("甲".into()),
                    paragraphs: vec!["一".into(), "\u{FFFC}a.png".into()],
                },
                RawChapter {
                    title: None, paragraphs: vec!["\u{FFFC}b/b.jpg".into(), "二".into()]
                },
            ],
        )
        .expect("insert");
        tx.commit().expect("commit");

        let images = images(&conn, "b").expect("images");
        assert_eq!(
            images,
            [
                BookImage { chapter_idx: 0, path: "a.png".into() },
                BookImage { chapter_idx: 1, path: "b/b.jpg".into() },
            ]
        );
    }

    #[test]
    fn a_missing_chapter_is_none() {
        let conn = seed();
        assert!(content(&conn, "b", 42).expect("query").is_none());
    }

    #[test]
    fn chars_reflects_the_joined_content() {
        let mut conn = seed();
        let tx = conn.transaction().expect("tx");
        insert(&tx, "b", &chapters()).expect("insert");
        tx.commit().expect("commit");

        let meta = list(&conn, "b").expect("list");
        // Chapter 0 content is "一\n二" = 3 chars.
        assert_eq!(meta[0].chars, 3);
    }
}
