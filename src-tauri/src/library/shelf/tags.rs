//! Tags: the reader's own vocabulary for the shelf.
//!
//! `tags` and `book_tags` have existed since the first migration; this module
//! is the first thing to write them. A tag is a label on a book, not a second
//! shelf: the book still lives in exactly one place and can carry any number
//! of labels, which is what makes "在读 / 参考 / 借来的" coexist with "科幻".
//!
//! Names are matched case-insensitively, so "Novel" and "novel" are one tag
//! rather than two rows the reader has to tell apart.

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Longest accepted tag, in characters. Long enough for a phrase, short
/// enough to stay a label rather than a note.
pub const MAX_TAG_CHARS: usize = 40;

/// One tag and how many books carry it.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub id: String,
    pub name: String,
    pub count: i64,
}

/// Every tag in use, with its book count, **most-used first**.
///
/// Name order was the old rule, and for Chinese it meant codepoint order —
/// 专 before 世 before 中 — which is an order nobody reads. It also put a tag
/// used once next to one used fifty times. Frequency first is what makes a
/// shelf with 273 tags browsable: the top of the list is the vocabulary the
/// reader actually has, and the long tail is what the search field is for.
pub fn list(conn: &Connection) -> AppResult<Vec<TagSummary>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, COUNT(bt.book_id)
           FROM tags t
           JOIN book_tags bt ON bt.tag_id = t.id
          GROUP BY t.id, t.name
          ORDER BY COUNT(bt.book_id) DESC, t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TagSummary { id: row.get(0)?, name: row.get(1)?, count: row.get(2)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Applies a set difference to the given books, inside the caller's
/// transaction.
///
/// One entry point covers both editors: the per-book sheet sends its whole
/// desired set as `add` + `remove`, while the batch bar only ever adds, so
/// tagging a selection can never wipe labels it did not know about.
///
/// Tags left attached to nothing are pruned, so the shelf never offers a label
/// that leads to an empty grid.
pub fn assign(
    tx: &Transaction<'_>,
    book_ids: &[String],
    add: &[String],
    remove: &[String],
) -> AppResult<()> {
    let add = normalize(add)?;
    let remove = normalize(remove)?;
    if book_ids.is_empty() {
        return Ok(());
    }

    for book_id in book_ids {
        // Refuse unknown ids instead of silently tagging nothing: a stale card
        // after a delete in another window is a bug worth surfacing.
        let known: Option<i64> = tx
            .query_row("SELECT 1 FROM books WHERE id = ?1", params![book_id], |row| row.get(0))
            .ok();
        if known.is_none() {
            return Err(AppError::NotFound(book_id.clone()));
        }

        for name in &remove {
            tx.execute(
                "DELETE FROM book_tags
                  WHERE book_id = ?1
                    AND tag_id IN (SELECT id FROM tags WHERE name = ?2 COLLATE NOCASE)",
                params![book_id, name],
            )?;
        }
        for name in &add {
            let tag_id = upsert(tx, name)?;
            tx.execute(
                "INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?1, ?2)",
                params![book_id, tag_id],
            )?;
        }
    }

    prune(tx)?;
    Ok(())
}

/// The id of this tag, creating it on first use.
///
/// The lookup ignores case so a second spelling reuses the existing row; the
/// column's own `UNIQUE (name)` is case-sensitive, which is why the check has
/// to happen here.
fn upsert(tx: &Transaction<'_>, name: &str) -> AppResult<String> {
    let existing: Option<String> = tx
        .query_row("SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE", params![name], |row| {
            row.get(0)
        })
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", params![id, name])?;
    Ok(id)
}

/// Drops tags no book carries any more.
fn prune(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM book_tags)", [])?;
    Ok(())
}

/// Removes a tag from every book. `NotFound` when the id is unknown.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    // `book_tags` rows go with it through the schema's ON DELETE CASCADE.
    let changed = conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// Trims, strips a leading `#`, drops blanks and de-duplicates case-insensitively
/// while keeping the caller's order.
fn normalize(names: &[String]) -> AppResult<Vec<String>> {
    let mut kept: Vec<String> = Vec::new();
    for name in names {
        let trimmed = name.trim().trim_start_matches('#').trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > MAX_TAG_CHARS {
            return Err(AppError::InvalidArgument(format!("标签不能超过 {MAX_TAG_CHARS} 个字")));
        }
        if !kept.iter().any(|seen| seen.eq_ignore_ascii_case(trimmed)) {
            kept.push(trimmed.to_string());
        }
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        for id in ["a", "b"] {
            conn.execute(
                "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                 file_size, added_at, updated_at) VALUES (?1, ?1, ?1, 'txt', ?1, 'p', 1, 1, 1)",
                params![id],
            )
            .expect("insert book");
        }
        conn
    }

    fn assign_on(conn: &mut Connection, books: &[&str], add: &[&str], remove: &[&str]) {
        let books: Vec<String> = books.iter().map(|id| id.to_string()).collect();
        let add: Vec<String> = add.iter().map(|id| id.to_string()).collect();
        let remove: Vec<String> = remove.iter().map(|id| id.to_string()).collect();
        let tx = conn.transaction().expect("begin");
        assign(&tx, &books, &add, &remove).expect("assign");
        tx.commit().expect("commit");
    }

    /// The labels one book carries, read straight from the join so the test
    /// checks the data rather than the code path that produced it.
    fn labels(conn: &Connection, book_id: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
                  WHERE bt.book_id = ?1 ORDER BY t.name COLLATE NOCASE",
            )
            .expect("prepare");
        let rows = stmt.query_map(params![book_id], |row| row.get(0)).expect("query");
        rows.collect::<rusqlite::Result<Vec<_>>>().expect("collect")
    }

    #[test]
    fn a_tag_is_created_once_and_reused() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["科幻"], &[]);
        assign_on(&mut conn, &["b"], &["科幻"], &[]);

        let tags = list(&conn).expect("list");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "科幻");
        assert_eq!(tags[0].count, 2);
    }

    #[test]
    fn spelling_differences_share_one_tag() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["Novel"], &[]);
        assign_on(&mut conn, &["b"], &["novel"], &[]);
        assert_eq!(list(&conn).expect("list").len(), 1);
        // The first spelling is the one kept.
        assert_eq!(list(&conn).expect("list")[0].name, "Novel");
    }

    #[test]
    fn names_are_trimmed_and_a_leading_hash_is_dropped() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["  # 在读 "], &[]);
        let names = labels(&conn, "a");
        assert_eq!(names, vec!["在读".to_string()]);
    }

    #[test]
    fn removing_the_last_book_prunes_the_tag() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["参考"], &[]);
        assign_on(&mut conn, &["a"], &[], &["参考"]);
        assert!(list(&conn).expect("list").is_empty());
        assert!(labels(&conn, "a").is_empty());
    }

    #[test]
    fn assigning_a_second_time_does_not_duplicate() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["科幻"], &[]);
        assign_on(&mut conn, &["a"], &["科幻"], &[]);
        assert_eq!(list(&conn).expect("list")[0].count, 1);
    }

    /// 用得多的排前面：273 个标签的库里，这才让人第一屏就看见自己的词汇。
    #[test]
    fn tags_are_listed_by_how_many_books_carry_them() {
        let mut conn = seed();
        assign_on(&mut conn, &["a", "b"], &["长篇小说"], &[]);
        assign_on(&mut conn, &["a"], &["伦理学"], &[]);

        let listed = list(&conn).expect("list");
        assert_eq!(listed[0].name, "长篇小说", "{listed:?}");
        assert_eq!(listed[0].count, 2);
        assert_eq!(listed[1].name, "伦理学", "只挂一本的排在后面");
    }

    #[test]
    fn one_book_keeps_several_tags_in_name_order() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["科幻", "在读", "参考"], &[]);
        let names = labels(&conn, "a");
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"在读".to_string()));
    }

    #[test]
    fn an_overlong_name_is_rejected() {
        let mut conn = seed();
        let long = "字".repeat(MAX_TAG_CHARS + 1);
        let tx = conn.transaction().expect("begin");
        let result = assign(&tx, &["a".into()], &[long], &[]);
        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }

    #[test]
    fn an_unknown_book_is_reported() {
        let mut conn = seed();
        let tx = conn.transaction().expect("begin");
        let result = assign(&tx, &["ghost".into()], &["x".into()], &[]);
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    #[test]
    fn deleting_a_tag_detaches_it_from_every_book() {
        let mut conn = seed();
        assign_on(&mut conn, &["a", "b"], &["科幻"], &[]);
        let id = list(&conn).expect("list")[0].id.clone();
        delete(&conn, &id).expect("delete");

        assert!(list(&conn).expect("list").is_empty());
        assert!(labels(&conn, "a").is_empty());
        assert!(matches!(delete(&conn, &id), Err(AppError::NotFound(_))));
    }

    #[test]
    fn the_batch_bar_only_adds() {
        let mut conn = seed();
        assign_on(&mut conn, &["a"], &["在读"], &[]);
        // A selection tagged "科幻" keeps the label it already had.
        assign_on(&mut conn, &["a", "b"], &["科幻"], &[]);
        let names = labels(&conn, "a");
        assert_eq!(names.len(), 2);
        assert_eq!(labels(&conn, "b").len(), 1);
    }
}
