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

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::library::repository::BookFieldsPatch;

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
/// Only the two fields a write can change: a before-image of everything would
/// be a copy of the row, and a copy is a second source of truth waiting to
/// disagree with the first.
pub struct Before {
    pub book_id: String,
    pub publisher: Option<String>,
    pub language: Option<String>,
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
            let detail = json!({
                "before": {
                    "publisher": before.publisher,
                    "language": before.language,
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

fn carries_before(detail: Option<&str>) -> bool {
    detail
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .is_some_and(|value| value.get("before").is_some_and(Value::is_object))
}

/// Puts back what one call changed.
///
/// Idempotent by construction: it writes the values the books had before, so a
/// second undo of the same call writes the same values again. The `undo` marker
/// row is what stops the settings page from offering it a second time.
pub fn undo(tx: &Transaction<'_>, call_id: &str) -> AppResult<Undo> {
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
        // A row without a book (a library-level action) and a row without a
        // before-image are both "nothing to put back", not failures.
        let (Some(book_id), Some(patch)) = (book_id, before_patch(detail.as_deref())) else {
            skipped += 1;
            continue;
        };
        // A book purged or trashed in the meantime is gone, not broken: the
        // undo moves on and reports how many it could not reach.
        match crate::library::repository::update_fields_many(
            tx,
            std::slice::from_ref(book_id),
            &patch,
        ) {
            Ok(_) => undone += 1,
            Err(AppError::NotFound(_)) => skipped += 1,
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

/// `None` on the left of the patch means "leave alone", so a field the write
/// cleared has to come back as an empty string, which is this repository's word
/// for "no value".
fn before_patch(detail: Option<&str>) -> Option<BookFieldsPatch> {
    let detail: Value = serde_json::from_str(detail?).ok()?;
    let before = detail.get("before")?.as_object()?;
    let field = |key: &str| match before.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Null) | None => Some(String::new()),
        _ => None,
    };
    Some(BookFieldsPatch {
        publisher: before.get("publisher").map(|_| field("publisher").unwrap_or_default()),
        language: before.get("language").map(|_| field("language").unwrap_or_default()),
    })
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
        let befores = [
            Before {
                book_id: "b1".into(),
                publisher: Some("重庆出版社".into()),
                language: Some("zh".into()),
            },
            Before { book_id: "b2".into(), publisher: None, language: Some("en".into()) },
        ];
        library
            .with_tx(|tx| {
                repository::update_fields_many(
                    tx,
                    &["b1".into(), "b2".into()],
                    &BookFieldsPatch { publisher: Some("统一".into()), language: None },
                )?;
                record_before(tx, Source::Ui, "batch_metadata", &befores, "批量改出版社：统一")
            })
            .expect("write");

        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();
        let outcome = library.with_tx(|tx| undo(tx, &call_id)).expect("undo");
        assert_eq!(outcome, Undo { undone: 2, skipped: 0 });

        let first = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(first.publisher.as_deref(), Some("重庆出版社"), "旧值回来了");
        let second = library.with(|conn| repository::get(conn, "b2")).expect("get").expect("b2");
        assert_eq!(second.publisher, None, "原本没有出版社的，撤销之后还是没有");
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
                    &[Before { book_id: "b1".into(), publisher: None, language: None }],
                    "改了",
                )
            })
            .expect("record");

        let before = library.with(|conn| list(conn, 10)).expect("list");
        assert!(before[0].undoable, "带 before 的行应该可以撤销");
        let call_id = before[0].call_id.clone();

        library.with_tx(|tx| undo(tx, &call_id)).expect("undo");

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
        let outcome = library.with_tx(|tx| undo(tx, "nope"));
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
                    &[
                        Before {
                            book_id: "b1".into(),
                            publisher: Some("A".into()),
                            language: None,
                        },
                        Before {
                            book_id: "b2".into(),
                            publisher: Some("B".into()),
                            language: None,
                        },
                    ],
                    "改了",
                )?;
                repository::purge(tx, "b2")?;
                Ok(())
            })
            .expect("seed");
        let call_id = library.with(|conn| list(conn, 10)).expect("list")[0].call_id.clone();

        let outcome = library.with_tx(|tx| undo(tx, &call_id)).expect("undo");
        assert_eq!(outcome, Undo { undone: 1, skipped: 1 });
        std::fs::remove_dir_all(&dir).ok();
    }
}
