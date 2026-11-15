//! The reader-saved review of one book's notes.
//!
//! Kept in `settings` under `notes-recap:<book_id>`, the same place the reading
//! guide caches its text: a few rows of derived prose are not worth a table of
//! their own. It is a cache the reader chose to keep, not a note on any one
//! highlight — `annotations.note` stays the reader's own words.
//!
//! Nothing here runs while the model is streaming. `store` is only reachable
//! from `notes.recapSave`, which the reader presses after reading the preview.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::AppResult;

const PREFIX: &str = "notes-recap:";

fn key(book_id: &str) -> String {
    format!("{PREFIX}{book_id}")
}

/// The saved review, or `None` when it has never been saved (or was blank).
pub fn cached(conn: &Connection, book_id: &str) -> AppResult<Option<String>> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key(book_id)], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(stored.filter(|text| !text.trim().is_empty()))
}

/// Saves — or replaces — the review for one book.
pub fn store(conn: &Connection, book_id: &str, text: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, \
         updated_at = excluded.updated_at",
        params![key(book_id), text, crate::library::now_seconds()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn seeded() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        migrations::migrate(&mut conn).expect("migrate");
        conn
    }

    #[test]
    fn a_saved_review_round_trips_and_overwrites() {
        let conn = seeded();
        assert_eq!(cached(&conn, "b1").expect("read"), None);

        store(&conn, "b1", "第一版").expect("save");
        assert_eq!(cached(&conn, "b1").expect("read").as_deref(), Some("第一版"));

        // 「重新整理 → 再保存」replaces it rather than appending a second one.
        store(&conn, "b1", "第二版").expect("save again");
        assert_eq!(cached(&conn, "b1").expect("read").as_deref(), Some("第二版"));
    }

    #[test]
    fn a_blank_saved_review_reads_as_unsaved() {
        let conn = seeded();
        store(&conn, "b1", "   ").expect("save");
        assert_eq!(cached(&conn, "b1").expect("read"), None);
    }

    #[test]
    fn two_books_never_share_a_review() {
        let conn = seeded();
        store(&conn, "b1", "第一本").expect("save b1");
        assert_eq!(cached(&conn, "b2").expect("read"), None);
        store(&conn, "b2", "第二本").expect("save b2");
        assert_eq!(cached(&conn, "b1").expect("read").as_deref(), Some("第一本"));
        assert_eq!(cached(&conn, "b2").expect("read").as_deref(), Some("第二本"));
    }
}
