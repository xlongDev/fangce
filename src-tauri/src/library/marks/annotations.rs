//! Annotation persistence: highlights anchored to immutable chapter text.
//!
//! A highlight is a character range into one chapter plus the text it covers.
//! Offsets are UTF-16 code-unit counts computed and interpreted only by the
//! frontend; the backend stores them opaquely and keeps `text` as the snippet
//! shown in the list. Chapter content never changes for a given book (re-import
//! is a new content hash), so nothing re-locates stale offsets.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// A highlight as the UI sees it.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub book_id: String,
    pub chapter_idx: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub text: String,
    /// Opaque re-anchoring key for foliate-rendered books (a CFI). `None` for
    /// every format the (chapter, offset) pair already locates.
    pub cfi: Option<String>,
    /// Highlight ink as a hex string (e.g. "#ffd12e"); `None` = legacy yellow.
    pub color: Option<String>,
    /// How the ink paints: "highlight" (translucent wash), "underline" or
    /// "squiggly"; `None` reads as "highlight".
    pub style: Option<String>,
    /// The reader's own words about this highlight. `None` = no note, which is
    /// the common case; blanks are folded to `None` on the way in, so a cleared
    /// note reads exactly like one that was never written.
    pub note: Option<String>,
    pub created_at: i64,
}

/// Allowed `style` values; anything else is rejected at the trust boundary.
const STYLES: [&str; 3] = ["highlight", "underline", "squiggly"];

fn validated_style(style: Option<&str>) -> AppResult<Option<String>> {
    match style {
        None => Ok(None),
        Some(value) if STYLES.contains(&value) => Ok(Some(value.to_string())),
        Some(other) => Err(AppError::InvalidArgument(format!("未知的标注样式: {other}"))),
    }
}

/// Validates and inserts one highlight, returning it with its generated id.
///
/// `text` is trimmed and must not be empty; the range must be non-empty.
/// `cfi` carries the foliate anchor of a Kindle highlight; it is stored
/// verbatim and never interpreted here. `color` is the frontend's hex string,
/// `style` one of `STYLES`; both optional and stored verbatim.
#[allow(clippy::too_many_arguments)]
pub fn create(
    conn: &Connection,
    book_id: &str,
    chapter_idx: usize,
    start_char: usize,
    end_char: usize,
    text: &str,
    cfi: Option<&str>,
    color: Option<&str>,
    style: Option<&str>,
) -> AppResult<Annotation> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::InvalidArgument("高亮内容不能为空".into()));
    }
    if start_char >= end_char {
        return Err(AppError::InvalidArgument("高亮范围无效".into()));
    }
    let style = validated_style(style)?;
    let now = crate::library::now_seconds();

    let annotation = Annotation {
        id: uuid::Uuid::new_v4().to_string(),
        book_id: book_id.to_string(),
        chapter_idx,
        start_char,
        end_char,
        text: text.to_string(),
        cfi: cfi.map(str::to_string),
        color: color.map(str::to_string),
        style,
        // Born without one: `set_note` is the only writer of notes, so this
        // path takes no parameter for it and the column stays `NULL`.
        note: None,
        created_at: now,
    };
    conn.execute(
        "INSERT INTO annotations \
         (id, book_id, chapter_idx, start_char, end_char, text, cfi, color, style, created_at, \
          updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            annotation.id,
            annotation.book_id,
            annotation.chapter_idx as i64,
            annotation.start_char as i64,
            annotation.end_char as i64,
            annotation.text,
            annotation.cfi,
            annotation.color,
            annotation.style,
            annotation.created_at,
            now,
        ],
    )?;
    Ok(annotation)
}

/// Restyles one highlight (the toolbar's re-colour / re-shape path). Only the
/// fields that are `Some` change; the row is read back so the cache updates
/// from the database's own answer.
pub fn update(
    conn: &Connection,
    id: &str,
    color: Option<&str>,
    style: Option<&str>,
) -> AppResult<Annotation> {
    let style = validated_style(style)?;
    let changed = conn.execute(
        "UPDATE annotations SET color = COALESCE(?2, color), style = COALESCE(?3, style), \
         updated_at = ?4 WHERE id = ?1",
        params![id, color, style, crate::library::now_seconds()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    read(conn, id)
}

/// Sets the foliate anchor of an imported highlight.
///
/// A clipping from `My Clippings.txt` arrives as text alone, so its row is
/// written without a CFI and the reader — the only party that has the book
/// loaded — calls this once it has located that text in a section. Deliberately
/// not folded into [`update`], which owns the ink: sharing one `UPDATE` would
/// let a re-colour blank the anchor, or an anchor blank the colour.
pub fn anchor(conn: &Connection, id: &str, cfi: &str) -> AppResult<Annotation> {
    if cfi.trim().is_empty() {
        return Err(AppError::InvalidArgument("标注锚点不能为空".into()));
    }
    let changed = conn.execute(
        "UPDATE annotations SET cfi = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, cfi.trim(), crate::library::now_seconds()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    read(conn, id)
}

/// Writes — or clears — the reader's own note on a highlight.
///
/// A third dedicated `UPDATE`, for the reason [`anchor`] is one plus a second
/// that is specific to notes: `update` folds its arguments with `COALESCE`,
/// which cannot express "set this back to nothing". A blank or absent note
/// clears the column; anything else is trimmed and stored.
pub fn set_note(conn: &Connection, id: &str, note: Option<&str>) -> AppResult<Annotation> {
    let note = note.map(str::trim).filter(|value| !value.is_empty());
    let changed = conn.execute(
        "UPDATE annotations SET note = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, note, crate::library::now_seconds()],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    read(conn, id)
}

/// The annotation columns, in the order [`from_row`] reads them.
const COLUMNS: &str = "id, book_id, chapter_idx, start_char, end_char, text, cfi, color, style, \
                       note, created_at";

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        book_id: row.get(1)?,
        chapter_idx: row.get::<_, i64>(2)? as usize,
        start_char: row.get::<_, i64>(3)? as usize,
        end_char: row.get::<_, i64>(4)? as usize,
        text: row.get(5)?,
        cfi: row.get(6)?,
        color: row.get(7)?,
        style: row.get(8)?,
        note: row.get(9)?,
        created_at: row.get(10)?,
    })
}

/// One annotation by id, as the database holds it.
/// One highlight by id, for callers holding annotation ids rather than a book.
pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Annotation>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM annotations WHERE id = ?1"),
        params![id],
        from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn read(conn: &Connection, id: &str) -> AppResult<Annotation> {
    let sql = format!("SELECT {COLUMNS} FROM annotations WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_row(params![id], from_row).map_err(|_| AppError::NotFound(id.to_string()))
}

/// Every highlight for a book, ordered by chapter then position.
pub fn list(conn: &Connection, book_id: &str) -> AppResult<Vec<Annotation>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM annotations WHERE book_id = ?1 ORDER BY chapter_idx, start_char"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![book_id], from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Deletes one highlight; `NotFound` when it does not exist.
///
/// The row goes for real — every local query stays free of a "not deleted"
/// filter — but a tombstone is left behind so the deletion can travel to the
/// other devices. Without it the next sync would pull the highlight straight
/// back from a copy that still has it.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    tx.execute(
        "INSERT INTO annotation_tombstones (id, updated_at) VALUES (?1, ?2) \
         ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at",
        params![id, crate::library::now_seconds()],
    )?;
    tx.commit()?;
    Ok(())
}

/// Deletes a set of highlights in one transaction, returning how many rows went.
///
/// The notes page works across books, so a selection deleted through the
/// single-row path above would be one request — and one transaction — per
/// highlight. One transaction also means a failure leaves the shelf as it was
/// rather than half-deleted.
///
/// Ids that are no longer there are skipped rather than refused. A selection is
/// a snapshot of what a screen was showing, and a highlight deleted in another
/// window between the click and the write is not something the reader can act
/// on; failing the whole batch for it would be worse than the no-op.
pub fn delete_many(conn: &Connection, ids: &[String]) -> AppResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let now = crate::library::now_seconds();
    let mut removed = 0;
    for id in ids {
        if tx.execute("DELETE FROM annotations WHERE id = ?1", params![id])? == 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO annotation_tombstones (id, updated_at) VALUES (?1, ?2) \
             ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at",
            params![id, now],
        )?;
        removed += 1;
    }
    tx.commit()?;
    Ok(removed)
}

/// One highlight as the sync layer moves it between devices.
///
/// `book` is the owning book's `content_hash` — the only book identity two
/// devices agree on — and `id` its own UUID, which the creating device mints
/// once and every other device adopts verbatim, making it a stable cross-device
/// key. `deleted` marks a tombstone, whose position fields are meaningless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAnnotation {
    pub id: String,
    #[serde(default)]
    pub book: String,
    pub chapter_idx: usize,
    pub start_char: usize,
    pub end_char: usize,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub cfi: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

impl SyncAnnotation {
    /// Everything a merge compares except the write clock: same payload means
    /// the two devices already agree, so neither side needs to be rewritten.
    pub fn same_payload(&self, other: &Self) -> bool {
        self.id == other.id
            && self.book == other.book
            && self.chapter_idx == other.chapter_idx
            && self.start_char == other.start_char
            && self.end_char == other.end_char
            && self.text == other.text
            && self.cfi == other.cfi
            && self.color == other.color
            && self.style == other.style
            && self.note == other.note
            && self.deleted == other.deleted
    }
}

/// Every highlight to sync — live rows and tombstones alike.
///
/// ponytail: tombstones are never pruned, so a repeatedly-used library grows a
/// few rows per deletion. At personal scale that is nothing; prune tombstones
/// older than ~90 days if a state file ever gets unwieldy.
pub fn for_sync(conn: &Connection) -> AppResult<Vec<SyncAnnotation>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, b.content_hash, a.chapter_idx, a.start_char, a.end_char, a.text, a.cfi, \
                a.color, a.style, a.note, a.updated_at \
         FROM annotations a JOIN books b ON b.id = a.book_id",
    )?;
    let live = stmt.query_map([], |row| {
        Ok(SyncAnnotation {
            id: row.get(0)?,
            book: row.get(1)?,
            chapter_idx: row.get::<_, i64>(2)? as usize,
            start_char: row.get::<_, i64>(3)? as usize,
            end_char: row.get::<_, i64>(4)? as usize,
            text: row.get(5)?,
            cfi: row.get(6)?,
            color: row.get(7)?,
            style: row.get(8)?,
            note: row.get(9)?,
            updated_at: row.get(10)?,
            deleted: false,
        })
    })?;
    let mut out = live.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare("SELECT id, updated_at FROM annotation_tombstones")?;
    let graves = stmt.query_map([], |row| {
        Ok(SyncAnnotation {
            id: row.get(0)?,
            book: String::new(),
            chapter_idx: 0,
            start_char: 0,
            end_char: 0,
            text: String::new(),
            cfi: None,
            color: None,
            style: None,
            note: None,
            updated_at: row.get(1)?,
            deleted: true,
        })
    })?;
    out.extend(graves.collect::<rusqlite::Result<Vec<_>>>()?);
    Ok(out)
}

/// Writes a highlight that won the merge into the local database.
///
/// A no-op when the book is not imported here: the entry stays in the sync
/// state for the device that does have the book, exactly like a book's own
/// progress entry.
pub fn apply_remote(conn: &Connection, remote: &SyncAnnotation) -> AppResult<()> {
    let book_id: Option<String> = conn
        .query_row("SELECT id FROM books WHERE content_hash = ?1", params![remote.book], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(book_id) = book_id else { return Ok(()) };
    conn.execute(
        "INSERT INTO annotations \
         (id, book_id, chapter_idx, start_char, end_char, text, cfi, color, style, note, created_at, \
          updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT (id) DO UPDATE SET book_id = excluded.book_id, \
           chapter_idx = excluded.chapter_idx, start_char = excluded.start_char, \
           end_char = excluded.end_char, text = excluded.text, cfi = excluded.cfi, \
           color = excluded.color, style = excluded.style, note = excluded.note, \
           updated_at = excluded.updated_at",
        params![
            remote.id,
            book_id,
            remote.chapter_idx as i64,
            remote.start_char as i64,
            remote.end_char as i64,
            remote.text,
            remote.cfi,
            remote.color,
            remote.style,
            remote.note,
            crate::library::now_seconds(),
            remote.updated_at,
        ],
    )?;
    Ok(())
}

/// Drops one highlight without leaving a tombstone — the other device's delete
/// already is one. Used when a remote tombstone wins the merge.
pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    Ok(())
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

    #[test]
    fn highlights_round_trip_and_list_in_reading_order() {
        let conn = seed();
        let second = create(&conn, "b", 1, 2, 6, "later", None, None, None).expect("create");
        let first = create(&conn, "b", 0, 0, 4, " start ", None, None, None).expect("create");

        assert_eq!(first.text, "start", "文本要裁剪首尾空白");
        assert_ne!(first.id, second.id);
        assert_eq!(first.cfi, None);

        let all = list(&conn, "b").expect("list");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].chapter_idx, 0);
        assert_eq!(all[1].chapter_idx, 1, "按章节与位置排序");
    }

    /// The batch the notes page's selection mode needs: one transaction, one
    /// tombstone per row, and no complaint about what is already gone.
    #[test]
    fn a_batch_delete_removes_what_is_there_and_ignores_what_is_not() {
        let conn = seed();
        let first = create(&conn, "b", 0, 0, 4, "one", None, None, None).expect("create");
        let second = create(&conn, "b", 0, 5, 9, "two", None, None, None).expect("create");
        let kept = create(&conn, "b", 1, 0, 3, "three", None, None, None).expect("create");

        let ids = vec![first.id.clone(), "already-gone".to_string(), second.id.clone()];
        assert_eq!(delete_many(&conn, &ids).expect("delete"), 2, "只算真正删掉的");

        let left = list(&conn, "b").expect("list");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, kept.id);

        // Both rows left a tombstone, or the next sync would pull them back
        // from a device that still has them.
        let stones: Vec<String> = conn
            .prepare("SELECT id FROM annotation_tombstones ORDER BY id")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect");
        assert_eq!(stones.len(), 2, "墓碑要留下");
        assert!(!stones.contains(&"already-gone".to_string()), "没删掉的不用立碑");
    }

    #[test]
    fn an_empty_batch_delete_is_a_no_op() {
        let conn = seed();
        assert_eq!(delete_many(&conn, &[]).expect("delete"), 0);
    }

    #[test]
    fn empty_text_or_range_is_rejected() {
        let conn = seed();
        assert!(matches!(
            create(&conn, "b", 0, 0, 1, "   ", None, None, None),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            create(&conn, "b", 0, 3, 3, "x", None, None, None),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn cfi_is_stored_and_read_back() {
        let conn = seed();
        let cfi = "epubcfi(/6/4!/4/2/2:3)";
        create(&conn, "b", 0, 3, 9, "quoted", Some(cfi), None, None).expect("create");
        let all = list(&conn, "b").expect("list");
        assert_eq!(all[0].cfi.as_deref(), Some(cfi), "CFI 要原样持久化");
    }

    #[test]
    fn deleting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(delete(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn update_restyles_partially_and_validates() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        let styled = update(&conn, &made.id, Some("#7cd92c"), Some("squiggly")).expect("update");
        assert_eq!(styled.color.as_deref(), Some("#7cd92c"));
        assert_eq!(styled.style.as_deref(), Some("squiggly"));
        // Partial: a colour-only update keeps the previous style.
        let recolored = update(&conn, &made.id, Some("#ffd12e"), None).expect("update");
        assert_eq!(recolored.style.as_deref(), Some("squiggly"));
        assert!(matches!(
            update(&conn, &made.id, None, Some("bold")),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(update(&conn, "nope", Some("#fff"), None), Err(AppError::NotFound(_))));
    }

    #[test]
    fn anchoring_an_imported_highlight_leaves_its_ink_alone() {
        let conn = seed();
        // An imported clipping: text, no CFI, and the reader has since coloured it.
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        update(&conn, &made.id, Some("#7cd92c"), Some("underline")).expect("update");

        let cfi = "epubcfi(/6/4!/4/2/2:3)";
        let anchored = anchor(&conn, &made.id, cfi).expect("anchor");
        assert_eq!(anchored.cfi.as_deref(), Some(cfi));
        assert_eq!(anchored.color.as_deref(), Some("#7cd92c"), "写锚点不能抹掉颜色");
        assert_eq!(anchored.style.as_deref(), Some("underline"), "写锚点不能抹掉样式");

        // And the other way round: a re-colour keeps the anchor.
        let restyled = update(&conn, &made.id, Some("#ffd12e"), None).expect("update");
        assert_eq!(restyled.cfi.as_deref(), Some(cfi), "改样式不能抹掉锚点");
    }

    #[test]
    fn anchoring_validates_its_input_and_reports_a_missing_row() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        assert!(matches!(anchor(&conn, &made.id, "  "), Err(AppError::InvalidArgument(_))));
        assert!(matches!(anchor(&conn, "nope", "epubcfi(/6/4)"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn a_note_is_written_trimmed_and_cleared() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        assert_eq!(made.note, None, "新高亮默认没有笔记");

        let noted = set_note(&conn, &made.id, Some("  第 4 章讲到这里  ")).expect("note");
        assert_eq!(noted.note.as_deref(), Some("第 4 章讲到这里"), "笔记要裁剪首尾空白");
        assert_eq!(
            list(&conn, "b").expect("list")[0].note.as_deref(),
            Some("第 4 章讲到这里"),
            "笔记要能读回来"
        );

        // Blank input clears rather than storing an empty string, so "has a
        // note" stays one `IS NOT NULL` test.
        let blanked = set_note(&conn, &made.id, Some("   \n  ")).expect("blank");
        assert_eq!(blanked.note, None);
        set_note(&conn, &made.id, Some("再来一条")).expect("note");
        let cleared = set_note(&conn, &made.id, None).expect("clear");
        assert_eq!(cleared.note, None, "传 None 也要能清空");
    }

    #[test]
    fn writing_a_note_leaves_ink_and_anchor_alone() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        let cfi = "epubcfi(/6/4!/4/2/2:3)";
        anchor(&conn, &made.id, cfi).expect("anchor");
        update(&conn, &made.id, Some("#7cd92c"), Some("underline")).expect("update");

        let noted = set_note(&conn, &made.id, Some("记一笔")).expect("note");
        assert_eq!(noted.cfi.as_deref(), Some(cfi), "写笔记不能抹掉锚点");
        assert_eq!(noted.color.as_deref(), Some("#7cd92c"), "写笔记不能抹掉颜色");
        assert_eq!(noted.style.as_deref(), Some("underline"), "写笔记不能抹掉样式");

        // And the note survives the other two writers.
        update(&conn, &made.id, Some("#ffd12e"), None).expect("update");
        anchor(&conn, &made.id, "epubcfi(/6/6!/4/2/2:1)").expect("anchor");
        assert_eq!(
            read(&conn, &made.id).expect("read").note.as_deref(),
            Some("记一笔"),
            "改样式或写锚点都不能抹掉笔记"
        );
    }

    #[test]
    fn noting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(set_note(&conn, "nope", Some("x")), Err(AppError::NotFound(_))));
    }

    #[test]
    fn deleting_a_book_cascades_to_its_highlights() {
        let conn = seed();
        create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete book");
        assert!(list(&conn, "b").expect("list").is_empty(), "外键级联必须清空高亮");
    }

    /// The write clock, read straight from the row (it stays out of the API).
    fn stamp(conn: &Connection, id: &str) -> i64 {
        conn.query_row("SELECT updated_at FROM annotations WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .expect("updated_at")
    }

    #[test]
    fn every_writer_advances_the_write_clock() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        assert_eq!(stamp(&conn, &made.id), made.created_at, "创建即写入 updated_at");

        // Pin the clock into the past so the bump is observable regardless of
        // how fast the test runs (second resolution would hide it otherwise).
        for write in 0..3 {
            conn.execute("UPDATE annotations SET updated_at = 1 WHERE id = ?1", params![made.id])
                .expect("pin");
            match write {
                0 => {
                    update(&conn, &made.id, Some("#7cd92c"), None).expect("update");
                }
                1 => {
                    anchor(&conn, &made.id, "epubcfi(/6/4!/4/2/2:3)").expect("anchor");
                }
                _ => {
                    set_note(&conn, &made.id, Some("记一笔")).expect("note");
                }
            }
            assert!(stamp(&conn, &made.id) > 1, "第 {write} 条写者必须推进 updated_at");
        }
    }

    #[test]
    fn deleting_leaves_a_tombstone_that_sync_can_carry() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        delete(&conn, &made.id).expect("delete");

        assert!(list(&conn, "b").expect("list").is_empty(), "本地行必须真的没了");
        let grave = for_sync(&conn)
            .expect("for_sync")
            .into_iter()
            .find(|entry| entry.id == made.id)
            .expect("墓碑必须在同步列表里");
        assert!(grave.deleted, "墓碑要带删除标志");
        assert!(grave.updated_at > 0, "墓碑要带写时钟");
        assert!(grave.book.is_empty(), "墓碑不需要书引用");
    }

    #[test]
    fn for_sync_identifies_the_owning_book_by_content_hash() {
        let conn = seed();
        create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        let entry = &for_sync(&conn).expect("for_sync")[0];
        assert_eq!(entry.book, "h", "跨设备要靠 content_hash 认书");
        assert!(!entry.deleted);
    }

    #[test]
    fn apply_remote_resolves_the_book_and_upserts_by_id() {
        let conn = seed();
        let remote = SyncAnnotation {
            id: "from-other-device".into(),
            book: "h".into(),
            chapter_idx: 2,
            start_char: 5,
            end_char: 9,
            text: "云端".into(),
            cfi: None,
            color: Some("#7cd92c".into()),
            style: Some("underline".into()),
            note: Some("另一台设备写的".into()),
            updated_at: 500,
            deleted: false,
        };
        apply_remote(&conn, &remote).expect("apply");

        let all = list(&conn, "b").expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "from-other-device", "要保持对方的 id 才能继续跨设备对齐");
        assert_eq!(all[0].text, "云端");
        assert_eq!(all[0].note.as_deref(), Some("另一台设备写的"));

        // Applying an updated version of the same id overwrites in place.
        apply_remote(&conn, &SyncAnnotation { note: Some("改过".into()), ..remote.clone() })
            .expect("apply again");
        assert_eq!(list(&conn, "b").expect("list").len(), 1, "同一个 id 不能变成两行");
        assert_eq!(list(&conn, "b").expect("list")[0].note.as_deref(), Some("改过"));

        // A book this device has not imported is skipped, not an error.
        let orphan = SyncAnnotation { book: "not-here".into(), ..remote };
        apply_remote(&conn, &orphan).expect("未导入的书要静默跳过");
        assert_eq!(list(&conn, "b").expect("list").len(), 1);
    }

    #[test]
    fn remove_drops_the_row_without_leaving_a_tombstone() {
        let conn = seed();
        let made = create(&conn, "b", 0, 0, 2, "hi", None, None, None).expect("create");
        // Simulate the tombstone living only on the remote: deleting it here
        // must not manufacture a second one to echo back.
        remove(&conn, &made.id).expect("remove");
        assert!(list(&conn, "b").expect("list").is_empty());
        assert!(
            for_sync(&conn).expect("for_sync").iter().all(|entry| !entry.deleted),
            "远端墓碑的本地应用不该再产出一个墓碑"
        );
    }
}
