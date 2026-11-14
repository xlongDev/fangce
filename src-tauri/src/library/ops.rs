//! The library's own record of what changed — and the way back.
//!
//! Two writers share this library now (the reader and an MCP agent), and until
//! this table existed 「昨天谁把这三十本的出版社改了」 had no answer. A log
//! without an undo is only a receipt, though: so a metadata write stores the
//! values it replaced, and [`undo`] puts them back.
//!
//! What is recorded: writes to metadata, labels and the shelf's membership.
//! What is not: reading, searching, and the reading position — this is a record
//! of changes, not of surveillance.

use std::path::Path;

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};

/// Where a change came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The reader, through the app.
    Ui,
    /// An outside agent, through `fangce --mcp`.
    Mcp,
}

impl Source {
    fn key(self) -> &'static str {
        match self {
            Source::Ui => "ui",
            Source::Mcp => "mcp",
        }
    }
}

/// What one book's metadata looked like before a write, so it can be put back.
///
/// **Every field a write can change**, and no more: this is the list of things
/// being touched, not a copy of the row. A copy would be a second source of
/// truth waiting to disagree with the first — and it would restore fields the
/// write never touched, which is its own kind of wrong.
///
/// The two-field version this replaced was written when a fill only knew
/// publisher and language. By the time it knew eleven fields, 「撤销」 still
/// restored two of them and said 「已撤销 N 本」 — a button that lies is worse
/// than no button.
pub struct Before {
    pub book_id: String,
    /// `update_metadata` replaces the author list wholesale. A Calibre fill
    /// writes it when the imported file had none, so the before-image has to
    /// remember it too — otherwise undo restores nine fields and reports
    /// success with the tenth still changed.
    pub authors: Vec<String>,
    pub subtitle: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub published_year: Option<i32>,
    pub description: Option<String>,
    pub rating: Option<f64>,
    pub rating_count: Option<i32>,
    pub rating_source: Option<String>,
    pub douban_url: Option<String>,
    /// The cover file this book had, if any. `None` means it had none — undo
    /// clears the column and removes the file the write created.
    pub cover_path: Option<String>,
    /// Where the replaced picture was moved to before the write, when the
    /// write replaced one. Undo needs these bytes: `cover_path` names a file
    /// the replacement took away.
    pub cover_previous: Option<String>,
}

/// Reads what a book looks like right now, for a write that is about to change
/// it.
pub fn snapshot(
    conn: &Connection,
    book: &crate::library::repository::BookSummary,
) -> AppResult<Before> {
    let cover_path = crate::library::repository::cover_path(conn, &book.id)?
        .map(|path| path.to_string_lossy().into_owned());
    Ok(Before {
        book_id: book.id.clone(),
        authors: book.authors.clone(),
        subtitle: book.subtitle.clone(),
        publisher: book.publisher.clone(),
        language: book.language.clone(),
        isbn: book.isbn.clone(),
        published_year: book.published_year,
        description: book.description.clone(),
        rating: book.rating,
        rating_count: book.rating_count,
        rating_source: book.rating_source.clone(),
        douban_url: book.douban_url.clone(),
        cover_path,
        // Filled by the caller that is about to replace a picture; a snapshot
        // on its own does not know what a later step will move aside.
        cover_previous: None,
    })
}

/// The same, by id, for a caller that has not read the row yet.
pub fn snapshot_of(conn: &Connection, id: &str) -> AppResult<Option<Before>> {
    match crate::library::repository::get(conn, id)? {
        Some(book) => Ok(Some(snapshot(conn, &book)?)),
        None => Ok(None),
    }
}

/// One change, as the settings page prints it.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: i64,
    pub at: i64,
    /// `ui` or `mcp`; a string rather than an enum so an unknown future source
    /// reads as itself instead of failing to deserialize.
    pub source: String,
    pub action: String,
    /// Every row written by one call shares this. A batch of thirty books is
    /// thirty rows and one call, and undoing "that" means undoing the call.
    pub call_id: String,
    pub book_id: Option<String>,
    pub book_title: Option<String>,
    pub summary: String,
    /// Whether this row can be put back: it carries a before-image and its
    /// call has not already been undone.
    pub undoable: bool,
}

/// How much of an undo actually landed.
#[derive(specta::Type, Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    pub undone: usize,
    /// Books the undo could not reach — purged, or in the bin. Not an error:
    /// the rest of the call is still worth putting back.
    pub skipped: usize,
}

/// Records one change against every book it touched.
///
/// `conn` rather than `tx`: callers inside a transaction pass `tx` and get the
/// same guarantee (the log and the change land together), while the tool server
/// — which has no transaction of its own — can still write the line.
pub fn record(
    conn: &Connection,
    source: Source,
    action: &str,
    book_ids: &[String],
    summary: &str,
) -> AppResult<()> {
    let rows: Vec<(String, Option<Value>)> = book_ids.iter().map(|id| (id.clone(), None)).collect();
    write(conn, source, action, summary, &rows)
}

/// [`record`] for a write that can be put back: one before-image per book.
pub fn record_before(
    conn: &Connection,
    source: Source,
    action: &str,
    befores: &[Before],
    summary: &str,
) -> AppResult<()> {
    let rows: Vec<(String, Option<Value>)> = befores
        .iter()
        .map(|before| {
            // `v` is not decoration: rows written before this format have a
            // `before` object with two keys, and reading those as 「the other
            // nine were null」 would wipe nine fields on undo.
            //
            // v3 adds `cover_previous` — the picture moved aside before a
            // replacement. v2 rows stay undoable: they simply cannot put a
            // replaced cover back, and `restore` falls back to keeping the
            // current one. `authors` is another optional key at v3: older
            // rows lack it, and `restore` keeps the current list for those.
            let detail = json!({
                "v": 3,
                "before": {
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
            });
            (before.book_id.clone(), Some(detail))
        })
        .collect();
    write(conn, source, action, summary, &rows)
}

fn write(
    conn: &Connection,
    source: Source,
    action: &str,
    summary: &str,
    rows: &[(String, Option<Value>)],
) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let at = crate::library::now_seconds();
    let call_id = uuid::Uuid::new_v4().to_string();
    // Titles are copied, not joined later: a purge deletes the row this would
    // read from, and 「《三体》被彻底删除」 is exactly the line that has to
    // survive it.
    let mut title_of = conn.prepare("SELECT title FROM books WHERE id = ?1")?;
    for (id, detail) in rows {
        let title: Option<String> = title_of.query_row(params![id], |row| row.get(0)).ok();
        conn.execute(
            "INSERT INTO operations \
             (at, source, action, book_id, book_title, summary, detail, call_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                at,
                source.key(),
                action,
                id,
                title,
                summary,
                detail.as_ref().map(|value| value.to_string()),
                call_id
            ],
        )?;
    }
    Ok(())
}

/// The newest `limit` operations, newest first.
///
/// Undo rows are filtered out: they are bookkeeping for this module, and a log
/// that shows 「撤销了一次撤销」 is a log nobody reads.
pub fn list(conn: &Connection, limit: usize) -> AppResult<Vec<Operation>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, at, source, action, call_id, book_id, book_title, summary, detail, \
                EXISTS (SELECT 1 FROM operations u \
                         WHERE u.call_id = o.call_id AND u.action = 'undo') \
           FROM operations o \
          WHERE o.action <> 'undo' \
          ORDER BY o.at DESC, o.id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        let detail: Option<String> = row.get(8)?;
        let undone: i64 = row.get(9)?;
        Ok(Operation {
            id: row.get(0)?,
            at: row.get(1)?,
            source: row.get(2)?,
            action: row.get(3)?,
            call_id: row.get(4)?,
            book_id: row.get(5)?,
            book_title: row.get(6)?,
            summary: row.get(7)?,
            undoable: undone == 0 && carries_before(detail.as_deref()),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Whether this row carries a before-image complete enough to put back.
///
/// Rows written before the format carried every field do not: restoring the two
/// they remember would leave nine changed and report success, so the button is
/// not offered at all.
fn carries_before(detail: Option<&str>) -> bool {
    before_fields(detail).is_some()
}

/// Puts back what one call changed.
///
/// Idempotent by construction: it writes the values the books had before, so a
/// second undo of the same call writes the same values again. The `undo` marker
/// row is what stops the settings page from offering it a second time.
pub fn undo(tx: &Transaction<'_>, call_id: &str, covers_dir: &Path) -> AppResult<Undo> {
    let rows: Vec<(Option<String>, Option<String>)> = tx
        .prepare(
            "SELECT book_id, detail FROM operations \
              WHERE call_id = ?1 AND action <> 'undo'",
        )?
        .query_map(params![call_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if rows.is_empty() {
        return Err(AppError::NotFound(format!("没有编号为 {call_id} 的操作")));
    }

    let mut undone = 0;
    let mut skipped = 0;
    for (book_id, detail) in &rows {
        // A row without a book (a library-level action) and a row whose
        // before-image is from the older, two-field format are both "cannot be
        // put back", not failures. The second is the honest one: restoring the
        // two fields such a row remembers would leave nine changed and report
        // success.
        let (Some(book_id), Some(fields)) = (book_id, before_fields(detail.as_deref())) else {
            skipped += 1;
            continue;
        };
        // A book purged or trashed in the meantime is gone, not broken: the
        // undo moves on and reports how many it could not reach.
        match restore(tx, book_id, &fields, covers_dir) {
            Ok(true) => undone += 1,
            Ok(false) => skipped += 1,
            Err(err) => return Err(err),
        }
    }

    let at = crate::library::now_seconds();
    let summary = format!("撤销了一次改动（{undone} 本）");
    tx.execute(
        "INSERT INTO operations \
         (at, source, action, book_id, book_title, summary, detail, call_id) \
         VALUES (?1, 'ui', 'undo', NULL, NULL, ?2, NULL, ?3)",
        params![at, summary, call_id],
    )?;
    Ok(Undo { undone, skipped })
}

/// Puts one book back the way the log says it was.
///
/// `Ok(false)` when the book is gone — the caller counts that as skipped rather
/// than failing the whole call.
fn restore(
    tx: &Transaction<'_>,
    id: &str,
    fields: &serde_json::Map<String, Value>,
    covers_dir: &Path,
) -> AppResult<bool> {
    let Some(book) = crate::library::repository::get(tx, id)? else {
        return Ok(false);
    };
    let text = |key: &str| fields.get(key).and_then(Value::as_str).map(str::to_string);
    let number = |key: &str| fields.get(key).and_then(Value::as_f64);
    let count = |key: &str| fields.get(key).and_then(Value::as_i64).map(|value| value as i32);

    let authors = fields
        .get("authors")
        .and_then(Value::as_array)
        .map(|values| {
            values.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()
        })
        // Rows written before the key existed cannot say what the list was.
        // Those writes never changed it, so keeping the current one is honest.
        .unwrap_or_else(|| book.authors.clone());

    // A whole record: `update_metadata` writes every column, and `None` here
    // means 「it had no value」, which is exactly what the log recorded.
    let patch = crate::library::repository::BookMetadataPatch {
        // The title is not something a fill writes, so it is carried through
        // untouched rather than restored.
        title: book.title,
        authors,
        subtitle: text("subtitle"),
        publisher: text("publisher"),
        language: text("language"),
        isbn: text("isbn"),
        published_year: count("published_year"),
        description: text("description"),
        rating: number("rating"),
        rating_count: count("rating_count"),
        rating_source: text("rating_source"),
        douban_url: text("douban_url"),
    };
    crate::library::repository::update_metadata(tx, id, &patch)?;

    match text("cover_path") {
        // There was a picture: put that file back — but only while it is still
        // there. A cover replaced since (the new file is a different format,
        // and the old one is cleaned up) leaves the recorded path stale, and
        // writing it back points the row at a file that no longer exists:
        // 撤销 turned a book's cover into a question mark. Keeping the current
        // picture is the honest partial restore — this call never changed the
        // cover, so it has no business removing it either.
        Some(path) if Path::new(&path).exists() => {
            crate::library::repository::set_cover(tx, id, &path)?;
        }
        // The file is gone because this write replaced it. The copy moved aside
        // before the write is the way back — that is why it is moved and not
        // deleted.
        Some(_) => {
            if let Some(kept) = text("cover_previous").filter(|path| Path::new(path).exists()) {
                crate::library::repository::set_cover(tx, id, &kept)?;
            }
            // Neither survives: keep the current picture rather than point the
            // row at nothing.
        }
        // There was none. Clearing the column is the restore; the file this
        // write created is garbage once nothing points at it.
        None => {
            if let Some(current) = crate::library::repository::cover_path(tx, id)? {
                crate::library::repository::clear_cover(tx, id)?;
                // Only inside the covers directory. The path came out of the
                // database, and the database is not a licence to delete files
                // anywhere on the disk.
                if current.starts_with(covers_dir) {
                    let _ = std::fs::remove_file(&current);
                }
            }
        }
    }
    Ok(true)
}

/// The before-image of one log row, when it is in the format that carries every
/// field.
fn before_fields(detail: Option<&str>) -> Option<serde_json::Map<String, Value>> {
    let detail: Value = serde_json::from_str(detail?).ok()?;
    // Rows written before this format have a `before` with two keys. Reading
    // those as 「the other nine were null」 would wipe nine fields. v3 only adds
    // a key, so a v2 row is still complete enough to put back.
    match detail.get("v").and_then(Value::as_u64) {
        Some(2) | Some(3) => {}
        _ => return None,
    }
    detail.get("before")?.as_object().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    use crate::db::Library;
    use crate::document::BookFormat;
    use crate::library::repository::{self, NewBook};

    fn harness(tag: &str) -> (PathBuf, Library) {
        let dir = crate::document::fixture::temp_dir(tag);
        let library = Library::open(&dir).expect("open");
        seed(&library);
        (dir, library)
    }

    /// What a book looks like right now — the same call the write paths make.
    fn before_of(library: &Library, id: &str) -> Before {
        library.with(|conn| snapshot_of(conn, id)).expect("snapshot").expect("book")
    }

    /// Undo only ever deletes files inside this directory; the tests do not
    /// write any, so a path that does not exist is the honest stand-in.
    fn covers_dir(dir: &std::path::Path) -> PathBuf {
        dir.join("covers")
    }

    fn seed(library: &Library) {
        library
            .with_tx(|tx| {
                for (id, title, publisher) in
                    [("b1", "三体", Some("重庆出版社")), ("b2", "Dune", Some("Chilton"))]
                {
                    repository::insert(
                        tx,
                        &NewBook {
                            id,
                            title,
                            subtitle: None,
                            description: None,
                            language: Some("zh"),
                            publisher,
                            identifier: None,
                            format: BookFormat::Epub,
                            content_hash: id,
                            file_path: "/books/x.epub",
                            file_size: 1,
                            cover_path: None,
                            authors: &[],
                        },
                    )?;
                }
                Ok(())
            })
            .expect("seed");
    }

    #[test]
    fn one_row_per_book_and_the_call_is_still_recoverable() {
        let (dir, library) = harness("ops-batch");
        library
            .with(|conn| {
                record(
                    conn,
                    Source::Ui,
                    "batch_metadata",
                    &["b1".into(), "b2".into()],
                    "改了出版社",
                )
            })
            .expect("record");

        let rows = library.with(|conn| list(conn, 10)).expect("list");
        assert_eq!(rows.len(), 2, "一批两本，两行");
        assert_eq!(rows[0].summary, rows[1].summary, "同一次调用共享同一句话");
        assert_eq!(rows[0].call_id, rows[1].call_id, "也共享同一个调用编号");
        assert!(rows.iter().any(|row| row.book_title.as_deref() == Some("三体")));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The line that has to outlive the thing it describes.
    #[test]
    fn the_record_of_a_purge_survives_the_purge() {
        let (dir, library) = harness("ops-purge");
        library
            .with_tx(|tx| {
                record(tx, Source::Mcp, "purge", &["b1".into()], "彻底删除")?;
                repository::purge(tx, "b1")?;
                Ok(())
            })
            .expect("purge with log");

        let rows = library.with(|conn| list(conn, 10)).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].book_title.as_deref(), Some("三体"), "书名是抄下来的，不是 join 出来的");
        assert_eq!(rows[0].source, "mcp");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_batch_writes_nothing() {
        let (dir, library) = harness("ops-empty");
        library.with(|conn| record(conn, Source::Ui, "noop", &[], "没有书")).expect("record");
        assert!(library.with(|conn| list(conn, 10)).expect("list").is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_newest_comes_first() {
        let (dir, library) = harness("ops-order");
        library
            .with(|conn| {
                for index in 0..3 {
                    record(
                        conn,
                        Source::Ui,
                        "update_metadata",
                        &["b1".into()],
                        &format!("第 {index} 次"),
                    )?;
                }
                Ok(())
            })
            .expect("record");

        let rows = library.with(|conn| list(conn, 10)).expect("list");
        assert_eq!(rows[0].summary, "第 2 次", "最新的在最上面");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole point of the before-image.
    #[test]
    fn undo_puts_the_old_values_back() {
        let (dir, library) = harness("ops-undo");
        let befores = [before_of(&library, "b1"), before_of(&library, "b2")];
        library
            .with_tx(|tx| {
                repository::update_fields_many(
                    tx,
                    &["b1".into(), "b2".into()],
                    &crate::library::repository::BookFieldsPatch {
                        publisher: Some("统一".into()),
                        language: None,
                    },
                )?;
                record_before(tx, Source::Ui, "batch_metadata", &befores, "批量改出版社：统一")
            })
            .expect("write");

        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();
        let outcome = library.with_tx(|tx| undo(tx, &call_id, &covers_dir(&dir))).expect("undo");
        assert_eq!(outcome, Undo { undone: 2, skipped: 0 });

        let first = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(first.publisher.as_deref(), Some("重庆出版社"), "旧值回来了");
        let second = library.with(|conn| repository::get(conn, "b2")).expect("get").expect("b2");
        assert_eq!(second.publisher.as_deref(), Some("Chilton"), "另一本也回到自己的旧值");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reason the before-image grew: a fill writes eleven fields, and undo
    /// used to put two of them back and call it done.
    #[test]
    fn undo_puts_back_every_field_a_fill_writes() {
        let (dir, library) = harness("ops-undo-all");
        let before = library.with(|conn| snapshot_of(conn, "b1")).expect("snapshot").expect("b1");
        library
            .with_tx(|tx| {
                repository::update_metadata(
                    tx,
                    "b1",
                    &crate::library::repository::BookMetadataPatch {
                        title: "三体".into(),
                        subtitle: Some("全集".into()),
                        publisher: Some("新出版社".into()),
                        language: Some("en".into()),
                        isbn: Some("9787536692930".into()),
                        published_year: Some(2020),
                        description: Some("简介".into()),
                        rating: Some(9.1),
                        rating_count: Some(1000),
                        rating_source: Some("douban".into()),
                        douban_url: Some("https://book.douban.com/subject/1/".into()),
                        authors: Vec::new(),
                    },
                )?;
                record_before(tx, Source::Ui, "fill_metadata", &[before], "从目录补全了 1 本")
            })
            .expect("fill");

        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();
        library.with_tx(|tx| undo(tx, &call_id, &covers_dir(&dir))).expect("undo");

        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.subtitle, None);
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"));
        assert_eq!(book.language.as_deref(), Some("zh"));
        assert_eq!(book.isbn, None);
        assert_eq!(book.published_year, None);
        assert_eq!(book.description, None);
        assert_eq!(book.rating, None, "评分也回去了");
        assert_eq!(book.rating_count, None);
        assert_eq!(book.rating_source, None);
        assert_eq!(book.douban_url, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fill that added a picture is undone by taking it away — column and
    /// file both, so a redo does not leave the old one lying around.
    #[test]
    fn undo_takes_away_the_picture_a_fill_added() {
        let (dir, library) = harness("ops-undo-cover");
        let covers = covers_dir(&dir);
        std::fs::create_dir_all(&covers).expect("covers dir");
        let file = covers.join("b1.jpg");
        std::fs::write(&file, b"\xff\xd8\xff").expect("write cover");

        // Taken before the write, which is the whole point of a before-image.
        let before = library.with(|conn| snapshot_of(conn, "b1")).expect("snapshot").expect("b1");
        assert_eq!(before.cover_path, None, "这本书本来没有封面");
        library
            .with_tx(|tx| {
                repository::set_cover(tx, "b1", file.to_str().expect("path"))?;
                record_before(tx, Source::Ui, "fill_metadata", &[before], "补了封面")
            })
            .expect("fill");

        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();
        library.with_tx(|tx| undo(tx, &call_id, &covers)).expect("undo");

        let path = library.with(|conn| repository::cover_path(conn, "b1")).expect("path");
        assert_eq!(path, None, "列清空了");
        assert!(!file.exists(), "文件也删了，不留垃圾");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 🔴 Undoing a metadata edit must not take the picture with it. The cover
    /// recorded in the before-image was replaced afterwards and its file is
    /// gone; writing that path back pointed the row at nothing, and the shelf
    /// drew a question mark. A call that never touched the cover has no
    /// business removing one.
    #[test]
    fn undo_keeps_the_picture_when_the_recorded_one_is_gone() {
        let (dir, library) = harness("ops-undo-stale-cover");
        let covers = covers_dir(&dir);
        std::fs::create_dir_all(&covers).expect("covers dir");
        let old = covers.join("b1.png");
        let fresh = covers.join("b1.jpg");
        std::fs::write(&old, b"\x89PNG\r\n\x1a\n").expect("old cover");
        std::fs::write(&fresh, b"\xff\xd8\xff").expect("new cover");

        library
            .with(|conn| repository::set_cover(conn, "b1", old.to_str().expect("path")))
            .expect("cover");
        let before = library.with(|conn| snapshot_of(conn, "b1")).expect("snapshot").expect("b1");

        // The reader replaces the picture, then edits a field. Only the edit is
        // logged, and the replacement cleans the old file away.
        library
            .with_tx(|tx| {
                repository::set_cover(tx, "b1", fresh.to_str().expect("path"))?;
                repository::update_fields_many(
                    tx,
                    &["b1".into()],
                    &crate::library::repository::BookFieldsPatch {
                        publisher: Some("新出版社".into()),
                        language: None,
                    },
                )?;
                record_before(tx, Source::Ui, "update_metadata", &[before], "改了出版社")
            })
            .expect("write");
        std::fs::remove_file(&old).expect("old cover cleaned up");

        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();
        library.with_tx(|tx| undo(tx, &call_id, &covers)).expect("undo");

        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"), "字段照常还原");
        assert!(book.cover_url.is_some(), "封面还在：指向不存在的图比不还原更糟");
        assert!(fresh.exists(), "现在这张图没被删");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Rows written before the format carried every field cannot be undone
    /// honestly: restoring the two they remember would leave nine changed and
    /// report success. So the button is not offered, and the call is skipped.
    #[test]
    fn a_row_from_the_older_format_is_not_undoable() {
        let (dir, library) = harness("ops-v1");
        library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO operations \
                     (at, source, action, book_id, book_title, summary, detail, call_id) \
                     VALUES (1, 'ui', 'fill_metadata', 'b1', '三体', '旧格式', ?1, 'old')",
                    params![r#"{"before":{"publisher":"上海人民出版社","language":"zh"}}"#],
                )?;
                Ok(())
            })
            .expect("insert");

        let rows = library.with(|conn| list(conn, 10)).expect("list");
        assert!(!rows[0].undoable, "记不全的行不给撤销按钮");

        let outcome = library.with_tx(|tx| undo(tx, "old", &covers_dir(&dir))).expect("undo");
        assert_eq!(outcome, Undo { undone: 0, skipped: 1 }, "宁可不动，也不装作还原了");

        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"), "一个字段都没被改");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `authors` joined the before-image after v3 shipped. An old v3 row has
    /// no such key; it must stay undoable for the nine fields it *does* know,
    /// and leave the author list alone rather than reading a missing key as
    /// "the book had no authors".
    #[test]
    fn a_v3_row_without_authors_keeps_the_current_list() {
        let (dir, library) = harness("ops-v3-no-authors");
        library
            .with(|conn| {
                conn.execute_batch(
                    "INSERT INTO authors (id, name, sort_name) VALUES ('a1', '曹雪芹', '曹雪芹');
                     INSERT INTO book_authors (book_id, author_id, position) VALUES ('b1', 'a1', 0);",
                )?;
                conn.execute(
                    "INSERT INTO operations \
                     (at, source, action, book_id, book_title, summary, detail, call_id) \
                     VALUES (1, 'ui', 'fill_metadata', 'b1', '三体', '旧 v3', ?1, 'no-authors')",
                    params![r#"{"v":3,"before":{"subtitle":null,"publisher":"重庆出版社","language":"zh","isbn":null,"published_year":null,"description":null,"rating":null,"rating_count":null,"rating_source":null,"douban_url":null,"cover_path":null,"cover_previous":null}}"#],
                )?;
                Ok(())
            })
            .expect("write an old-format row");

        let rows = library.with(|conn| list(conn, 10)).expect("list");
        assert!(rows[0].undoable, "v3 行照样能撤销");
        let outcome =
            library.with_tx(|tx| undo(tx, "no-authors", &covers_dir(&dir))).expect("undo");
        assert_eq!(outcome, Undo { undone: 1, skipped: 0 });

        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.authors, vec!["曹雪芹".to_string()], "不知道旧值就别动作者");
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An undone call must not offer itself again, and the undo itself must not
    /// read as something to undo.
    #[test]
    fn an_undone_call_is_no_longer_undoable() {
        let (dir, library) = harness("ops-undone");
        library
            .with_tx(|tx| {
                record_before(
                    tx,
                    Source::Ui,
                    "batch_metadata",
                    &[snapshot_of(tx, "b1")?.expect("b1")],
                    "改了",
                )
            })
            .expect("record");

        let before = library.with(|conn| list(conn, 10)).expect("list");
        assert!(before[0].undoable, "带 before 的行应该可以撤销");
        let call_id = before[0].call_id.clone();

        library.with_tx(|tx| undo(tx, &call_id, &covers_dir(&dir))).expect("undo");

        let after = library.with(|conn| list(conn, 10)).expect("list");
        assert_eq!(after.len(), 1, "撤销行本身不进列表");
        assert!(!after[0].undoable, "撤销过的不能再撤销一次");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_plain_write_is_not_undoable() {
        let (dir, library) = harness("ops-plain");
        library
            .with(|conn| record(conn, Source::Ui, "trash", &["b1".into()], "移到回收站"))
            .expect("record");
        let rows = library.with(|conn| list(conn, 10)).expect("list");
        assert!(!rows[0].undoable, "没有 before 就没有撤销");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn undoing_a_call_that_never_existed_is_not_found() {
        let dir = crate::document::fixture::temp_dir("ops-missing");
        let library = Library::open(&dir).expect("open");
        let outcome = library.with_tx(|tx| undo(tx, "nope", &covers_dir(&dir)));
        assert!(matches!(outcome, Err(AppError::NotFound(_))));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A book purged between the write and the undo is skipped, not fatal: the
    /// rest of the call is still worth putting back.
    #[test]
    fn a_book_that_is_gone_is_skipped_not_fatal() {
        let (dir, library) = harness("ops-gone");
        library
            .with_tx(|tx| {
                record_before(
                    tx,
                    Source::Ui,
                    "batch_metadata",
                    &[snapshot_of(tx, "b1")?.expect("b1"), snapshot_of(tx, "b2")?.expect("b2")],
                    "改了",
                )?;
                repository::purge(tx, "b2")?;
                Ok(())
            })
            .expect("seed");
        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();

        let outcome = library.with_tx(|tx| undo(tx, &call_id, &covers_dir(&dir))).expect("undo");
        assert_eq!(outcome, Undo { undone: 1, skipped: 1 });
        std::fs::remove_dir_all(&dir).ok();
    }
}
