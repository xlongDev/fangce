//! Read-only inspection of a Calibre library (`metadata.db`).
//!
//! Calibre's `metadata.db` stays the property of Calibre — the connection is
//! `SQLITE_OPEN_READ_ONLY` **and** `query_only`, so a bug in this module cannot
//! turn into a write even by accident. Importing the files it finds is done by
//! the ordinary `book.import` pipeline, never from here.
//!
//! Calibre's schema has grown columns and tables across versions. Checking
//! only the columns this slice actually reads (via `PRAGMA table_info`) keeps
//! old and new libraries both readable, and turns a foreign SQLite file into a
//! sentence naming the missing table instead of a `no such column` panic.
//!
//! 🔴 `books.path` comes from a database the reader did not create. 5.1 kept
//! it as data only; 5.3 joins it to the root to find real files, and
//! re-validates at that boundary: suspicious strings are blanked, and every
//! resolved directory and file is canonicalised and must still start with the
//! canonical root. A database is not permission to read anywhere.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};

use rusqlite::{Connection, OpenFlags, types::Value};
use serde::{Deserialize, Serialize};

use crate::document::BookFormat;
use crate::error::{AppError, AppResult};

const DB_FILE: &str = "metadata.db";

/// Calibre's `comments.text` can be a whole essay. The scan keeps as much as
/// 方册's own edit sheet accepts, because 5.4's write half copies this value
/// into the book's description; the preview tooltip does its own, shorter cut.
/// Truncating here would have silently written a 200-character blurb into the
/// library.
const DESCRIPTION_LIMIT: usize = 4000;

/// The tables and the *columns we use*, not Calibre's full schema.
const REQUIRED: &[(&str, &[&str])] = &[
    ("books", &["id", "title", "path"]),
    ("authors", &["id", "name"]),
    ("books_authors_link", &["book", "author"]),
    ("data", &["book", "format"]),
];

/// One file 方册 can actually open, best first. A Calibre book often carries
/// both EPUB and AZW3; importing both would put the same novel on the shelf
/// twice (different bytes, so hash-dedupe cannot see them). One file per book.
const FORMAT_ORDER: &[&str] =
    &["epub", "pdf", "azw3", "mobi", "azw", "prc", "fb2", "cbz", "markdown", "txt"];

/// Optional metadata. The four tables in [`REQUIRED`] are what makes a file a
/// Calibre library; everything here is a bonus that older, trimmed or
/// hand-built libraries may not carry. Values stay as text on purpose: this
/// slice reports what a library *has*, it does not guess how a rating or a
/// date is typed across Calibre versions.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreMetadata {
    pub publisher: Option<String>,
    pub tags: Vec<String>,
    pub series: Option<String>,
    pub rating: Option<String>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub published: Option<String>,
}

#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreFile {
    /// Absolute, canonical path, verified to stay under the library root.
    pub path: String,
    /// `BookFormat::as_str()` — the same stable value the shelf stores.
    pub format: String,
}

#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreBook {
    pub id: i64,
    pub title: String,
    pub authors: Vec<String>,
    /// Upper-case format names as Calibre stores them (`EPUB`, `AZW3`, ...).
    pub formats: Vec<String>,
    /// Relative book directory under the library root. Empty when Calibre's
    /// value was missing or tried to climb out of the library.
    pub path: String,
    /// Real files on disk, in preference order. Empty means "cannot import".
    pub files: Vec<CalibreFile>,
    /// Whatever optional metadata this library happened to have.
    pub metadata: CalibreMetadata,
}

#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibreScan {
    pub root: String,
    pub db_path: String,
    pub books: Vec<CalibreBook>,
    /// Per-book problems that did not abort the scan. A library with a few odd
    /// rows is still a library; silently dropping those books is the bug.
    pub warnings: Vec<String>,
    /// Which optional metadata fields this library actually exposed. What is
    /// *absent* is just as useful: it tells the reader (and us) that a table
    /// or column differs from what 方册 expected, instead of silently losing it.
    pub metadata_fields: Vec<String>,
}

/// Scan the library rooted at `root`.
pub fn scan(root: &Path) -> AppResult<CalibreScan> {
    if !root.is_dir() {
        return Err(AppError::NotFound(format!("书库目录不存在：{}", root.display())));
    }
    let db_path = root.join(DB_FILE);
    if !db_path.is_file() {
        return Err(AppError::Message(format!(
            "{} 里没有 {}。请选 Calibre 书库的根目录（含 metadata.db 的那一层），不是书的子目录。",
            root.display(),
            DB_FILE
        )));
    }

    let conn = open(&db_path)?;
    check_schema(&conn, &db_path)?;
    let mut books = read_books(&conn)?;
    read_authors(&conn, &mut books)?;
    let mut warnings = read_formats(&conn, &mut books)?;
    warnings.extend(guard_paths(&mut books));
    // Files come from the filesystem, not from Calibre's `data.name`, whose
    // exact naming rules vary across versions. What exists is the truth.
    warnings.extend(find_files(root, &mut books));
    let metadata_fields = read_optional(&conn, &mut books);

    Ok(CalibreScan {
        root: root.to_string_lossy().into_owned(),
        db_path: db_path.to_string_lossy().into_owned(),
        books,
        warnings,
        metadata_fields,
    })
}

/// Two independent locks, because a read-only *flag* and a read-only *pragma*
/// guard different mistakes: the flag is about the file handle, the pragma is
/// about any statement this module might later grow.
fn open(db_path: &Path) -> AppResult<Connection> {
    let conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|err| {
            AppError::Message(format!(
                "只读打开 {} 失败：{err}。若 Calibre 正在运行，请先退出再扫描。",
                db_path.display()
            ))
        })?;
    // Both are connection-local settings; neither writes to the file. In
    // particular, `journal_mode` is deliberately absent — setting it is a
    // write even when the value would not change.
    conn.execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;")?;
    Ok(conn)
}

fn check_schema(conn: &Connection, db_path: &Path) -> AppResult<()> {
    let mut missing = Vec::new();
    for (table, needed) in REQUIRED {
        let present = columns(conn, table);
        if present.is_empty() {
            missing.push(format!("缺少 {table} 表"));
            continue;
        }
        for column in *needed {
            if !present.contains(*column) {
                missing.push(format!("{table} 表缺少 {column} 列"));
            }
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(AppError::Message(format!(
        "{} 不是可识别的 Calibre 书库：{}。",
        db_path.display(),
        missing.join("、")
    )))
}

/// Column names, or an empty set when the table does not exist. Names passed
/// here are compile-time constants, never strings from the database.
fn columns(conn: &Connection, table: &str) -> HashSet<String> {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return HashSet::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return HashSet::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// Reads a `book, value` query from an optional side table.
///
/// `prepare` is the probe and the guard at once: if a table or column is
/// missing the statement simply cannot be compiled and `None` comes back.
/// `Value` (rather than `String`) is what lets an INTEGER `rating` or a REAL
/// `series_index` survive without guessing its declared type.
fn linked(conn: &Connection, sql: &str) -> Option<HashMap<i64, Vec<String>>> {
    let mut stmt = conn.prepare(sql).ok()?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Value>>(1)?)))
        .ok()?;
    let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
    // One bad row costs that row, not the field, and never the whole scan.
    for (id, value) in rows.flatten() {
        if let Some(text) = value.and_then(value_text).filter(|text| !text.trim().is_empty()) {
            by_id.entry(id).or_default().push(text);
        }
    }
    Some(by_id)
}

fn value_text(value: Value) -> Option<String> {
    match value {
        Value::Text(text) => Some(text),
        Value::Integer(number) => Some(number.to_string()),
        Value::Real(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Calibre stores `comments.text` as HTML. The preview tooltip is plain text,
/// so drop tags and collapse whitespace instead of showing `<p>…</p>`. This is
/// deliberately not a full HTML decoder — entities survive as text.
fn plain_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first(values: &HashMap<i64, Vec<String>>, id: i64) -> Option<String> {
    values.get(&id).and_then(|items| items.first()).cloned()
}

/// Optional metadata, probed one field at a time.
///
/// 🔴 Calibre's optional tables differ across versions and can be pruned by
/// hand. Nothing here may fail the scan: each probe is independent, and the
/// returned list says which fields this particular library actually exposed.
/// That list is the diagnosis a reader can bring back when a real library
/// looks different from the fixture.
fn read_optional(conn: &Connection, books: &mut [CalibreBook]) -> Vec<String> {
    let mut found = Vec::new();

    // ISBN lives in `identifiers(book, type, val)`, NOT on `books`: Calibre's
    // own schema (metadata_sqlite.sql, user_version 28) has no `books.isbn`
    // column. Our first hand-made fixture added one, which hid this probe
    // failing on every real library. `lower(type)` covers custom identifier
    // types typed in a different case.
    if let Some(values) =
        linked(conn, "SELECT book, val FROM identifiers WHERE lower(type) = 'isbn'")
    {
        for book in books.iter_mut() {
            book.metadata.isbn = first(&values, book.id);
        }
        found.push("ISBN".into());
    }
    if let Some(values) = linked(conn, "SELECT id, pubdate FROM books") {
        for book in books.iter_mut() {
            book.metadata.published = first(&values, book.id);
        }
        found.push("出版日期".into());
    }
    if let Some(values) = linked(
        conn,
        "SELECT l.book, p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher",
    ) {
        for book in books.iter_mut() {
            book.metadata.publisher = first(&values, book.id);
        }
        found.push("出版社".into());
    }
    if let Some(values) = linked(
        conn,
        "SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag ORDER BY l.book, t.name",
    ) {
        for book in books.iter_mut() {
            book.metadata.tags = values.get(&book.id).cloned().unwrap_or_default();
        }
        found.push("标签".into());
    }
    if let Some(values) = linked(
        conn,
        "SELECT l.book, s.name FROM books_series_link l JOIN series s ON s.id = l.series",
    ) {
        for book in books.iter_mut() {
            book.metadata.series = first(&values, book.id);
        }
        found.push("系列".into());
    }
    if let Some(values) = linked(
        conn,
        "SELECT l.book, r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating",
    ) {
        for book in books.iter_mut() {
            book.metadata.rating = first(&values, book.id);
        }
        found.push("评分".into());
    }
    if let Some(values) = linked(
        conn,
        "SELECT l.book, g.lang_code FROM books_languages_link l JOIN languages g ON g.id = l.lang_code",
    ) {
        for book in books.iter_mut() {
            book.metadata.language = first(&values, book.id);
        }
        found.push("语言".into());
    }
    if let Some(values) = linked(conn, "SELECT book, text FROM comments") {
        for book in books.iter_mut() {
            book.metadata.description = first(&values, book.id)
                .map(|html| plain_text(&html).chars().take(DESCRIPTION_LIMIT).collect::<String>());
        }
        found.push("简介".into());
    }

    found
}

fn read_books(conn: &Connection) -> AppResult<Vec<CalibreBook>> {
    let mut stmt = conn.prepare("SELECT id, title, path FROM books ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        Ok(CalibreBook {
            id: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            authors: Vec::new(),
            formats: Vec::new(),
            // NULL or a blank path is data to report, not a reason to abort.
            path: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            files: Vec::new(),
            metadata: CalibreMetadata::default(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_authors(conn: &Connection, books: &mut [CalibreBook]) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT l.book, a.name FROM books_authors_link l
         JOIN authors a ON a.id = l.author ORDER BY l.book, a.name",
    )?;
    let rows =
        stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)))?;
    let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        let (id, name) = row?;
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            by_id.entry(id).or_default().push(name);
        }
    }
    for book in books {
        book.authors = by_id.remove(&book.id).unwrap_or_default();
    }
    Ok(())
}

fn read_formats(conn: &Connection, books: &mut [CalibreBook]) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT book, format FROM data ORDER BY book, format")?;
    let rows =
        stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)))?;
    let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        let (id, format) = row?;
        let Some(format) = format.map(|f| f.trim().to_ascii_uppercase()).filter(|f| !f.is_empty())
        else {
            continue;
        };
        let formats = by_id.entry(id).or_default();
        if !formats.contains(&format) {
            formats.push(format);
        }
    }
    let mut without_format = 0;
    for book in books {
        book.formats = by_id.remove(&book.id).unwrap_or_default();
        if book.formats.is_empty() {
            without_format += 1;
        }
    }
    if without_format > 0 {
        Ok(vec![format!(
            "有 {without_format} 本书在 data 表里没有格式文件记录（仍会从书库目录找文件）。"
        )])
    } else {
        Ok(Vec::new())
    }
}

/// `path` arrives from a database the reader did not create. Keep only plain
/// relative paths; an absolute path or `..` is worth a warning, not a crash.
fn guard_paths(books: &mut [CalibreBook]) -> Vec<String> {
    let mut bad = 0;
    for book in books {
        if !safe_relative(&book.path) {
            book.path.clear();
            bad += 1;
        }
    }
    if bad == 0 {
        Vec::new()
    } else {
        vec![format!("有 {bad} 本书的 path 指向书库之外，已忽略其路径。")]
    }
}

fn safe_relative(path: &str) -> bool {
    if path.trim().is_empty() {
        return true;
    }
    let candidate = Path::new(path);
    !candidate.is_absolute()
        && !candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
}

fn find_files(root: &Path, books: &mut [CalibreBook]) -> Vec<String> {
    let mut missing = 0;
    for book in books {
        book.files = files_for(root, &book.path);
        if book.files.is_empty() {
            missing += 1;
        }
    }
    if missing == 0 {
        Vec::new()
    } else {
        vec![format!("有 {missing} 本书在书库目录里找不到可导入的电子书文件，导入时会被跳过。")]
    }
}

/// Resolve a book's directory to real, importable files.
///
/// Every path that crosses this function is untrusted: `books.path` is a
/// string from somebody else's database, and a directory inside a Calibre
/// library can contain symlinks. Both the directory and each file are
/// canonicalised *after* the string check and must still sit under the
/// canonical root.
fn files_for(root: &Path, relative: &str) -> Vec<CalibreFile> {
    if relative.is_empty() || !safe_relative(relative) {
        return Vec::new();
    }
    let Ok(root_real) = root.canonicalize() else {
        return Vec::new();
    };
    let Ok(dir_real) = root.join(relative).canonicalize() else {
        return Vec::new();
    };
    if !dir_real.starts_with(&root_real) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir_real) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // `symlink_metadata` does not follow: a symlink is not a regular file
        // here, so it is dropped rather than resolving outside the library.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Some(format) = BookFormat::from_path(&path) else {
            continue;
        };
        let Ok(real) = path.canonicalize() else {
            continue;
        };
        if !real.starts_with(&root_real) {
            continue;
        }
        files.push(CalibreFile {
            path: real.to_string_lossy().into_owned(),
            format: format.as_str().to_owned(),
        });
    }
    files.sort_by_key(|file| {
        FORMAT_ORDER.iter().position(|known| *known == file.format).unwrap_or(usize::MAX)
    });
    files
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::document::fixture::temp_dir;

    /// A real Calibre library has dozens of tables we never read, plus a
    /// user-defined `custom_column_N` table per custom column. None of them
    /// may change the answer or abort the scan.
    #[test]
    fn extra_tables_and_custom_columns_do_not_break_the_scan() {
        let dir = library_with_optional(
            "calibre-custom-columns",
            "INSERT INTO books (id, title, path) VALUES (1, '书', '作者/书 (1)');
             CREATE TABLE custom_columns (id INTEGER PRIMARY KEY, label TEXT, name TEXT,
                                          datatype TEXT, normalized BOOL);
             CREATE TABLE custom_column_1 (id INTEGER PRIMARY KEY, book INTEGER, value TEXT);
             INSERT INTO custom_column_1 VALUES (1, 1, '科幻架');
             CREATE TABLE books_plugin_data (id INTEGER PRIMARY KEY, book INTEGER,
                                             name TEXT, val BLOB);",
        );
        with_files(&dir, "作者/书 (1)", &["书.epub"]);

        let report = scan(&dir).expect("extra tables are none of our business");
        assert_eq!(report.books.len(), 1);
        assert_eq!(report.books[0].files.len(), 1);
        assert_eq!(report.books[0].authors.len(), 0);
        assert!(report.metadata_fields.contains(&"ISBN".to_string()));
    }

    #[test]
    fn identifier_type_case_does_not_hide_isbn() {
        let dir = library_with_optional(
            "calibre-upper-isbn",
            "INSERT INTO books (id, title, path) VALUES (1, '书', '作者/书 (1)');
             INSERT INTO identifiers VALUES (1, 1, 'ISBN', '9780000000001');",
        );
        let report = scan(&dir).expect("scan");
        assert_eq!(report.books[0].metadata.isbn.as_deref(), Some("9780000000001"));
    }

    const DDL: &str = "
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT);
        CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
        CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT);
    ";

    fn library(tag: &str, inserts: &str) -> PathBuf {
        let dir = temp_dir(tag);
        let db = dir.join(DB_FILE);
        let conn = Connection::open(&db).expect("create fixture db");
        conn.execute_batch(DDL).expect("create calibre-shaped tables");
        if !inserts.trim().is_empty() {
            conn.execute_batch(inserts).expect("seed fixture rows");
        }
        drop(conn);
        dir
    }

    /// Side tables with Calibre's own column names (`metadata_sqlite.sql`,
    /// user_version 28). 🔴 `books` has NO `isbn` column: our first fixture
    /// invented one and masked an ISBN probe that failed on every real library.
    /// ISBN belongs to `identifiers(book, type, val)`.
    const OPTIONAL_DDL: &str = "
        ALTER TABLE books ADD COLUMN pubdate TEXT;
        CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
        CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
        CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
        CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
        CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER);
        CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER, rating INTEGER);
        CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT);
        CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER, lang_code INTEGER);
        CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
    ";

    fn library_with_optional(tag: &str, inserts: &str) -> PathBuf {
        let dir = library(tag, "");
        let conn = Connection::open(dir.join(DB_FILE)).expect("reopen fixture db");
        conn.execute_batch(OPTIONAL_DDL).expect("create optional tables");
        conn.execute_batch(inserts).expect("seed optional rows");
        drop(conn);
        dir
    }

    /// Creates a Calibre-shaped book directory with real (tiny) files.
    fn with_files(dir: &Path, relative: &str, names: &[&str]) {
        let book_dir = dir.join(relative);
        std::fs::create_dir_all(&book_dir).expect("create book dir");
        for name in names {
            std::fs::write(book_dir.join(name), b"fixture").expect("write book file");
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(dir)
            .expect("read library dir")
            .map(|entry| entry.expect("dir entry").file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_calibre_shaped_library_is_recognised() {
        let dir = library(
            "calibre-scan",
            "INSERT INTO books VALUES (1, '三体', '刘慈欣/三体 (1)');
             INSERT INTO books VALUES (2, '活着', '余华/活着 (2)');
             INSERT INTO authors VALUES (1, '刘慈欣'), (2, '余华');
             INSERT INTO books_authors_link VALUES (1, 1, 1), (2, 2, 2);
             INSERT INTO data VALUES (1, 1, 'EPUB'), (2, 1, 'AZW3'), (3, 2, 'epub');",
        );
        with_files(
            &dir,
            "刘慈欣/三体 (1)",
            &["三体.epub", "三体.azw3", "cover.jpg", "metadata.opf"],
        );
        with_files(&dir, "余华/活着 (2)", &["活着.pdf"]);

        let scan = scan(&dir).expect("scan");
        assert_eq!(scan.books.len(), 2);
        let three_body = &scan.books[0];
        assert_eq!(three_body.id, 1);
        assert_eq!(three_body.title, "三体");
        assert_eq!(three_body.authors, vec!["刘慈欣"]);
        assert_eq!(three_body.formats, vec!["AZW3", "EPUB"]);
        assert_eq!(three_body.path, "刘慈欣/三体 (1)");
        assert_eq!(scan.books[1].formats, vec!["EPUB"]);
        assert!(scan.warnings.is_empty(), "{:?}", scan.warnings);
    }

    #[test]
    fn only_supported_formats_become_importable_files() {
        let dir = library(
            "calibre-formats",
            "INSERT INTO books VALUES (1, '三体', '刘慈欣/三体 (1)');
             INSERT INTO data VALUES (1, 1, 'EPUB'), (2, 1, 'AZW3');",
        );
        with_files(
            &dir,
            "刘慈欣/三体 (1)",
            &["三体.azw3", "三体.epub", "cover.jpg", "metadata.opf"],
        );
        let scan = scan(&dir).expect("scan");
        let files = &scan.books[0].files;

        // jpg/opf are not books; EPUB wins over AZW3 so one novel does not
        // arrive on the shelf twice.
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].format, "epub");
        assert_eq!(files[1].format, "azw3");
        assert!(Path::new(&files[0].path).is_absolute());
        // macOS resolves /var to /private/var; compare against the canonical
        // root, not the string the temp-dir helper handed us.
        let root_real = dir.canonicalize().expect("canonical root");
        assert!(Path::new(&files[0].path).starts_with(&root_real));
        assert!(Path::new(&files[0].path).exists());
    }

    #[test]
    fn scanning_does_not_change_the_library() {
        let dir = library("calibre-readonly", "INSERT INTO books VALUES (1, '书', '作者/书 (1)');");
        with_files(&dir, "作者/书 (1)", &["书.epub"]);
        let db = dir.join(DB_FILE);
        let before = names(&dir);
        let size_before = std::fs::metadata(&db).expect("db metadata").len();

        scan(&dir).expect("scan a read-only library");

        // No -wal / -shm / -journal sidecar appeared, and the database did not
        // grow. A `journal_mode` pragma would have broken this.
        assert_eq!(names(&dir), before);
        assert_eq!(std::fs::metadata(&db).expect("db metadata").len(), size_before);
    }

    #[test]
    fn the_handle_refuses_writes_even_if_this_module_tries() {
        let dir = library("calibre-write-guard", "");
        let conn = open(&dir.join(DB_FILE)).expect("open read-only");
        let err = conn
            .execute("INSERT INTO books VALUES (9, '不该写进去', 'x')", [])
            .expect_err("a read-only handle must refuse a write");
        assert!(err.to_string().contains("readonly"), "{err}");
    }

    #[test]
    fn a_directory_without_metadata_db_explains_where_to_point() {
        let dir = temp_dir("calibre-no-db");
        let err = scan(&dir).expect_err("a bare directory is not a library");
        let message = err.to_string();
        assert!(message.contains("metadata.db"), "{message}");
        assert!(message.contains("根目录"), "{message}");
    }

    #[test]
    fn a_foreign_sqlite_file_names_the_missing_tables() {
        let dir = temp_dir("calibre-foreign");
        let db = dir.join(DB_FILE);
        let conn = Connection::open(&db).expect("create foreign db");
        conn.execute_batch("CREATE TABLE books (id INTEGER PRIMARY KEY);").expect("one table");
        drop(conn);
        let err = scan(&dir).expect_err("not a calibre library");
        let message = err.to_string();
        assert!(message.contains("books_authors_link"), "{message}");
        assert!(message.contains("title"), "{message}");
    }

    #[test]
    fn a_broken_row_is_reported_instead_of_aborting_the_scan() {
        let dir = library(
            "calibre-broken-row",
            "INSERT INTO books VALUES (1, '没有格式', '作者/没有格式 (1)');
             INSERT INTO books VALUES (2, '越界', '../../etc');
             INSERT INTO books VALUES (3, NULL, NULL);
             INSERT INTO data VALUES (1, 3, 'PDF');",
        );
        let scan = scan(&dir).expect("odd rows must not abort the scan");
        assert_eq!(scan.books.len(), 3);
        assert_eq!(scan.books[1].path, "");
        assert_eq!(scan.books[2].title, "");
        assert!(scan.books.iter().all(|book| book.files.is_empty()));
        assert!(scan.warnings.iter().any(|w| w.contains("格式文件")));
        assert!(scan.warnings.iter().any(|w| w.contains("path")));
        assert!(scan.warnings.iter().any(|w| w.contains("可导入")));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_book_directory_cannot_escape_the_library() {
        let outside = temp_dir("calibre-outside-dir");
        std::fs::write(outside.join("secret.epub"), b"secret").expect("write outside file");
        let dir = library("calibre-symlink-dir", "INSERT INTO books VALUES (1, '越界', 'link');");
        std::os::unix::fs::symlink(&outside, dir.join("link")).expect("link book dir");

        let scan = scan(&dir).expect("scan");
        assert!(scan.books[0].files.is_empty(), "{:?}", scan.books[0].files);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_is_not_offered_for_import() {
        let outside = temp_dir("calibre-outside-file");
        let outside_file = outside.join("secret.epub");
        std::fs::write(&outside_file, b"secret").expect("write outside file");
        let dir = library(
            "calibre-symlink-file",
            "INSERT INTO books VALUES (1, '书', '作者/书 (1)');
             INSERT INTO data VALUES (1, 1, 'EPUB');",
        );
        with_files(&dir, "作者/书 (1)", &["real.epub"]);
        std::os::unix::fs::symlink(&outside_file, dir.join("作者/书 (1)/linked.epub"))
            .expect("link file");

        let scan = scan(&dir).expect("scan");
        let files = &scan.books[0].files;
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].path.ends_with("real.epub"));
    }

    #[test]
    fn a_library_without_optional_tables_is_still_a_library() {
        let dir = library("calibre-minimal", "INSERT INTO books VALUES (1, '书', '作者/书 (1)');");
        let report = scan(&dir).expect("four required tables are enough");
        assert!(report.metadata_fields.is_empty(), "{:?}", report.metadata_fields);
        assert_eq!(report.books[0].metadata, CalibreMetadata::default());
    }

    #[test]
    fn optional_metadata_is_reported_field_by_field() {
        let dir = library_with_optional(
            "calibre-optional",
            "INSERT INTO books (id, title, path, pubdate) VALUES (1, '三体', '刘慈欣/三体 (1)', '2006-05');
             INSERT INTO identifiers VALUES (1, 1, 'isbn', '9787536692930');
             INSERT INTO identifiers VALUES (2, 1, 'doi', '10.1000/xyz');
             INSERT INTO publishers VALUES (1, '重庆出版社');
             INSERT INTO books_publishers_link VALUES (1, 1, 1);
             INSERT INTO tags VALUES (1, '科幻'), (2, '中国文学');
             INSERT INTO books_tags_link VALUES (1, 1, 1), (2, 1, 2);
             INSERT INTO series VALUES (1, '地球往事');
             INSERT INTO books_series_link VALUES (1, 1, 1);
             INSERT INTO ratings VALUES (1, 8);
             INSERT INTO books_ratings_link VALUES (1, 1, 1);
             INSERT INTO languages VALUES (1, 'zho');
             INSERT INTO books_languages_link VALUES (1, 1, 1);
             INSERT INTO comments VALUES (1, 1, '<p>简介文本 <b>加粗</b></p>');",
        );
        let report = scan(&dir).expect("scan a fuller library");
        let book = &report.books[0];

        // Calibre keeps ISBN in `identifiers`, not on `books`.
        assert_eq!(book.metadata.isbn.as_deref(), Some("9787536692930"));
        assert_eq!(book.metadata.published.as_deref(), Some("2006-05"));
        assert_eq!(book.metadata.publisher.as_deref(), Some("重庆出版社"));
        assert_eq!(book.metadata.tags.len(), 2);
        assert!(book.metadata.tags.contains(&"科幻".to_string()));
        assert_eq!(book.metadata.series.as_deref(), Some("地球往事"));
        // INTEGER survives as text rather than being dropped by a String read.
        assert_eq!(book.metadata.rating.as_deref(), Some("8"));
        assert_eq!(book.metadata.language.as_deref(), Some("zho"));
        // Calibre writes comments as HTML; the tooltip shows plain text.
        assert_eq!(book.metadata.description.as_deref(), Some("简介文本 加粗"));
        assert_eq!(report.metadata_fields.len(), 8, "{:?}", report.metadata_fields);
    }

    #[test]
    fn a_non_isbn_identifier_is_not_reported_as_isbn() {
        let dir = library_with_optional(
            "calibre-doi-only",
            "INSERT INTO books (id, title, path) VALUES (1, '书', '作者/书 (1)');
             INSERT INTO identifiers VALUES (1, 1, 'doi', '10.1000/xyz');",
        );
        let report = scan(&dir).expect("scan");
        assert_eq!(report.books[0].metadata.isbn, None);
        // The table exists, so the field is still reportable — it just has no
        // value for this book. "No value" and "no column" are different facts.
        assert!(report.metadata_fields.contains(&"ISBN".to_string()));
    }

    #[test]
    fn a_bad_value_in_an_optional_column_costs_only_that_field() {
        let dir = library_with_optional(
            "calibre-optional-blob",
            "INSERT INTO books (id, title, path) VALUES (1, '书', '作者/书 (1)');
             INSERT INTO comments VALUES (1, 1, X'00FF');",
        );
        let report = scan(&dir).expect("a blob must not break the scan");
        assert_eq!(report.books[0].metadata.description, None);
        assert!(report.metadata_fields.contains(&"简介".to_string()));
    }

    #[test]
    fn a_missing_directory_is_reported() {
        let missing = temp_dir("calibre-gone").join("not-there");
        assert!(scan(&missing).is_err());
    }
}
