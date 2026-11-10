//! Book persistence: queries and mutations for the library shelf.
//!
//! Authors and tags live in their own tables because the UI filters and sorts
//! on them; they are fetched with one grouped query per list rather than one
//! query per book.

use std::path::PathBuf;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

#[cfg(test)]
use std::path::Path;

use crate::document::BookFormat;
use crate::error::{AppError, AppResult};
use crate::library::sort_key;

/// Everything needed to insert a book that has just been imported.
pub struct NewBook<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub description: Option<&'a str>,
    pub language: Option<&'a str>,
    pub publisher: Option<&'a str>,
    pub identifier: Option<&'a str>,
    pub format: BookFormat,
    pub content_hash: &'a str,
    pub file_path: &'a str,
    pub file_size: i64,
    pub cover_path: Option<&'a str>,
    pub authors: &'a [String],
}

/// A book as the UI sees it.
#[derive(specta::Type, Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub format: BookFormat,
    pub file_size: i64,
    /// URL on the custom resource protocol, or `null` when there is no cover.
    pub cover_url: Option<String>,
    /// Unix seconds.
    pub added_at: i64,
    pub updated_at: i64,
    pub last_read_at: Option<i64>,
    /// 0..1.
    pub progress: f64,
    /// Opaque last-position anchor for engines that cannot resume from a
    /// fraction (a CFI for foliate-rendered Kindle books); `None` for every
    /// other format, which restarts from `progress` alone.
    pub location: Option<String>,
    pub favorite: bool,
    /// The edition's ISBN, when something actually said so.
    ///
    /// Its own column rather than `identifier`: that one holds whatever the
    /// file's `dc:identifier` claimed, which is sometimes an ISBN and sometimes
    /// a UUID a converter invented.
    pub isbn: Option<String>,
    /// The edition's publication year.
    pub published_year: Option<i32>,
    /// The catalogue's community rating and how many people gave it.
    ///
    /// Somebody else's opinion at the moment of the lookup, not the reader's
    /// metadata: the UI names the source whenever it prints the number.
    pub rating: Option<f64>,
    pub rating_count: Option<i32>,
    /// Which catalogue that rating came from: `douban` or `neodb`.
    ///
    /// Stored rather than inferred. They are different numbers from different
    /// sets of people, and the sheet prints the source — a label guessed at
    /// render time would eventually print the wrong one.
    pub rating_source: Option<String>,
    /// The Douban page this record was linked from, when there is one.
    pub douban_url: Option<String>,
    pub authors: Vec<String>,
    pub tags: Vec<String>,
}

/// Which shelf the user is looking at.
#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryFilter {
    #[default]
    All,
    Recent,
    Favorites,
}

impl LibraryFilter {
    fn predicate(self) -> Option<&'static str> {
        match self {
            LibraryFilter::All => None,
            LibraryFilter::Recent => Some("b.last_read_at IS NOT NULL"),
            LibraryFilter::Favorites => Some("b.favorite = 1"),
        }
    }
}

/// Sort orders exposed by the UI.
#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibrarySort {
    #[default]
    RecentlyAdded,
    RecentlyRead,
    ProgressDesc,
    TitleAsc,
    AuthorAsc,
    OldestAdded,
    FormatAsc,
    SizeDesc,
}

impl LibrarySort {
    /// `ORDER BY` clause. Whitelisted because user input must never reach SQL
    /// as a fragment.
    fn order_by(self) -> &'static str {
        match self {
            LibrarySort::RecentlyAdded => "b.added_at DESC, b.sort_title ASC",
            LibrarySort::RecentlyRead => "b.last_read_at DESC, b.added_at DESC, b.sort_title ASC",
            // Furthest along first: the question this order answers is which
            // book is closest to the end (or, reversed, which has barely been
            // started). Unread books sink to the bottom in both directions.
            LibrarySort::ProgressDesc => {
                "b.progress DESC, b.last_read_at DESC, b.sort_title COLLATE NOCASE ASC"
            }
            LibrarySort::TitleAsc => "b.sort_title COLLATE NOCASE ASC",
            LibrarySort::AuthorAsc => {
                "(SELECT a.sort_name FROM book_authors ba
                    JOIN authors a ON a.id = ba.author_id
                   WHERE ba.book_id = b.id
                   ORDER BY ba.position LIMIT 1) COLLATE NOCASE ASC, b.sort_title ASC"
            }
            LibrarySort::OldestAdded => "b.added_at ASC, b.sort_title ASC",
            // `format` is stored lowercase ('epub', 'pdf', …), so the plain
            // column collation already groups each format together; the title
            // breaks ties so the group is readable rather than arbitrary.
            LibrarySort::FormatAsc => "b.format ASC, b.sort_title COLLATE NOCASE ASC",
            // Largest first: the question this order answers is which books are
            // taking up the space, and that is asked from the top.
            LibrarySort::SizeDesc => "b.file_size DESC, b.sort_title COLLATE NOCASE ASC",
        }
    }
}

/// Which slice of its own reading history a book is in.
///
/// The thresholds are [`stats`]'s: a book counts as finished at 99.9% because
/// the last page of a real book is often an index or a colophon nobody turns
/// to. A filter that disagreed with the count printed above it would look like
/// a broken filter rather than a different definition.
#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadingStatus {
    #[default]
    Any,
    Unread,
    Reading,
    Finished,
}

/// Parsed list request coming from the frontend.
///
/// Every narrowing field is `#[serde(default)]`: a caller that knows nothing
/// about filters (the web build's own shelf, an older renderer) keeps sending
/// the four original fields and gets the same shelf it always got.
#[derive(specta::Type, Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookQuery {
    #[serde(default)]
    pub filter: LibraryFilter,
    #[serde(default)]
    pub sort: LibrarySort,
    /// Case-insensitive substring matched against title and author names.
    #[serde(default)]
    pub search: Option<String>,
    /// Restricts the shelf to one tag (matched case-insensitively). Orthogonal
    /// to `filter`: the tag browser is the "标签" shelf, but a future caller
    /// could ask for a tag inside 收藏 without a second query type.
    #[serde(default)]
    pub tag: Option<String>,
    /// Empty means every format.
    #[serde(default)]
    pub formats: Vec<BookFormat>,
    /// `books.language` values. The renderer only ever sends values that
    /// [`facets`] reported, so they match the column byte for byte and the
    /// comparison needs no collation.
    #[serde(default)]
    pub languages: Vec<String>,
    /// `books.publisher` values, same provenance as `languages`.
    #[serde(default)]
    pub publishers: Vec<String>,
    #[serde(default)]
    pub status: ReadingStatus,
    /// `Some(true)` = only books with a cover, `Some(false)` = only without.
    #[serde(default)]
    pub has_cover: Option<bool>,
    /// Reads the bin instead of the shelf.
    ///
    /// One flag on the one query type, rather than a second `trash.list`
    /// command: the bin is the same books with the same columns, and giving it
    /// its own query would mean two SQL builders and two facet counters to keep
    /// in step. Every other filter still applies inside it, which is what makes
    /// "find the copy I deleted last week" a search rather than a scroll.
    #[serde(default)]
    pub trash: bool,
    /// How many rows to return; `None` is the whole shelf.
    ///
    /// The renderer asks for the whole shelf on purpose — its grid is windowed
    /// over the full array, and grouping and scroll restore both index into it,
    /// so a page would be a second source of truth for "where am I". The one
    /// caller that pages is the tool server, which has a context window instead
    /// of a viewport.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Rows to skip. Only meaningful together with `limit`.
    #[serde(default)]
    pub offset: Option<usize>,
}

/// Ceiling on `limit`, so a caller cannot ask for a million rows by accident.
const MAX_PAGE: usize = 5_000;

/// A dimension the shelf can be narrowed by.
///
/// Only [`conditions`] reads these: they name which clause to leave out when
/// counting a facet.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dimension {
    Format,
    Language,
    Publisher,
    Status,
    Cover,
}

/// One value of a facet, and how many books the current query would leave if
/// that value were picked.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facet {
    /// As stored: a format name, a language tag, a publisher name, or one of
    /// the fixed `status` / `covers` keys.
    pub value: String,
    pub count: i64,
}

/// Counts for the shelf's filter panel, one list per dimension.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFacets {
    pub formats: Vec<Facet>,
    pub languages: Vec<Facet>,
    pub publishers: Vec<Facet>,
    /// `unread` / `reading` / `finished`, always all three, in that order.
    pub status: Vec<Facet>,
    /// `has` / `none`.
    pub covers: Vec<Facet>,
}

/// Aggregate counts shown above the shelf.
#[derive(specta::Type, Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub total: i64,
    pub favorites: i64,
    /// Opened *and actually read*, and still below 100%.
    ///
    /// `progress > 0` is load-bearing: `last_read_at` is stamped when a book is
    /// opened, so on its own it counted a book the reader opened and closed
    /// without turning a page. On a real 39-book shelf that made 27 of them
    /// 「在读」, which is not what the word means.
    pub reading: i64,
    pub finished: i64,
    /// Books in the bin. Counted separately from `total`, which is the shelf the
    /// reader sees: a header that said 42 while the grid showed 39 would make
    /// the reader hunt for three books that are not there.
    pub trashed: i64,
}

pub fn stats(conn: &Connection) -> AppResult<LibraryStats> {
    let (total, favorites, reading, finished) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(favorite), 0),
                COALESCE(SUM(last_read_at IS NOT NULL AND progress > 0 AND progress < 0.999), 0),
                COALESCE(SUM(progress >= 0.999), 0)
           FROM books_live",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let trashed =
        conn.query_row("SELECT COUNT(*) FROM books WHERE deleted_at IS NOT NULL", [], |row| {
            row.get(0)
        })?;
    Ok(LibraryStats { total, favorites, reading, finished, trashed })
}

/// Absolute cover path for `id`, or `None` when the book has no cover.
pub fn cover_path(conn: &Connection, id: &str) -> AppResult<Option<PathBuf>> {
    let found = conn
        .query_row("SELECT cover_path FROM books WHERE id = ?1", params![id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten();
    Ok(found.map(PathBuf::from))
}

const SELECT_COLUMNS: &str = "b.id, b.title, b.subtitle, b.description, b.language, b.publisher, \
     b.format, b.file_size, b.cover_path, b.added_at, b.updated_at, b.last_read_at, b.progress, \
     b.location, b.favorite, b.isbn, b.published_year, b.rating, b.rating_count, \
     b.rating_source, b.douban_url";

/// SQL conditions and their bound parameters for one shelf query.
///
/// `skip` leaves exactly one dimension out. That is what facet counting needs:
/// every other filter stays applied, so the count printed beside a value is the
/// count the reader gets after clicking it — a count computed against the whole
/// library would offer values that lead straight to an empty grid.
///
/// Every clause here is a literal from this file; user input only ever arrives
/// as a bound parameter. The parameters are `Value`s rather than `String`s
/// because a page's `LIMIT`/`OFFSET` are numbers, and a bind list that can hold
/// only text would push them into the SQL as a formatted fragment.
fn conditions(query: &BookQuery, skip: Option<Dimension>) -> (Vec<String>, Vec<Value>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut binds: Vec<Value> = Vec::new();
    let keep = |dimension: Dimension| skip != Some(dimension);

    // Never skipped: the bin is a different set of rows, not a filter on the
    // same set, so a facet counted without it would count the shelf.
    if query.trash {
        conditions.push("b.deleted_at IS NOT NULL".to_string());
    }

    if let Some(predicate) = query.filter.predicate() {
        conditions.push(predicate.to_string());
    }
    if let Some(tag) = query.tag.as_deref().map(str::trim).filter(|tag| !tag.is_empty()) {
        conditions.push(
            "EXISTS (SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag_id \
              WHERE bt.book_id = b.id AND t.name = ? COLLATE NOCASE)"
                .to_string(),
        );
        binds.push(Value::Text(tag.to_string()));
    }
    if let Some(needle) = normalized_search(&query.search) {
        conditions.push(
            "(b.title LIKE ? ESCAPE '\\' OR b.sort_title LIKE ? ESCAPE '\\' OR EXISTS (\
               SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id \
                WHERE ba.book_id = b.id AND a.name LIKE ? ESCAPE '\\'))"
                .to_string(),
        );
        // One needle, three placeholders.
        binds.extend([needle.clone(), needle.clone(), needle].map(Value::Text));
    }

    if keep(Dimension::Format) && !query.formats.is_empty() {
        conditions.push(in_list("b.format", query.formats.len()));
        binds.extend(query.formats.iter().map(|format| Value::Text(format.as_str().to_string())));
    }
    if keep(Dimension::Language) {
        push_in(&mut conditions, &mut binds, "b.language", &query.languages);
    }
    if keep(Dimension::Publisher) {
        push_in(&mut conditions, &mut binds, "b.publisher", &query.publishers);
    }
    if keep(Dimension::Status)
        && let Some(predicate) = status_predicate(query.status)
    {
        conditions.push(predicate.to_string());
    }
    if keep(Dimension::Cover) {
        match query.has_cover {
            Some(true) => conditions.push("b.cover_path IS NOT NULL".to_string()),
            Some(false) => conditions.push("b.cover_path IS NULL".to_string()),
            None => {}
        }
    }

    (conditions, binds)
}

/// `WHERE a AND b`, or nothing at all when there is no condition.
fn where_clause(conditions: &[String]) -> String {
    if conditions.is_empty() {
        return String::new();
    }
    format!(" WHERE {}", conditions.join(" AND "))
}

/// Which relation a query reads.
///
/// The shelf reads the `books_live` view and the bin reads the table behind it;
/// everything else about the query is identical, which is the whole reason the
/// soft delete lives in a view rather than in thirteen `WHERE` clauses.
fn relation(query: &BookQuery) -> &'static str {
    if query.trash { "books" } else { "books_live" }
}

/// `column IN (?, ?, …)` — one placeholder per value.
fn in_list(column: &str, len: usize) -> String {
    format!("{column} IN ({})", vec!["?"; len].join(", "))
}

/// Pushes an `IN` condition for a text column, skipping an empty selection.
fn push_in(conditions: &mut Vec<String>, binds: &mut Vec<Value>, column: &str, values: &[String]) {
    let values: Vec<&String> = values.iter().filter(|value| !value.trim().is_empty()).collect();
    if values.is_empty() {
        return;
    }
    conditions.push(in_list(column, values.len()));
    binds.extend(values.into_iter().map(|value| Value::Text(value.clone())));
}

fn status_predicate(status: ReadingStatus) -> Option<&'static str> {
    match status {
        ReadingStatus::Any => None,
        ReadingStatus::Unread => Some("b.progress <= 0"),
        ReadingStatus::Reading => Some("b.progress > 0 AND b.progress < 0.999"),
        ReadingStatus::Finished => Some("b.progress >= 0.999"),
    }
}

/// Loads the shelf for the given query.
pub fn list(conn: &Connection, query: &BookQuery) -> AppResult<Vec<BookSummary>> {
    let (conditions, mut binds) = conditions(query, None);
    let mut sql = format!("SELECT {SELECT_COLUMNS} FROM {} b", relation(query));
    sql.push_str(&where_clause(&conditions));
    sql.push_str(" ORDER BY ");
    sql.push_str(query.sort.order_by());
    push_page(&mut sql, &mut binds, query);

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(binds.iter()))?;

    let mut books = Vec::new();
    while let Some(row) = rows.next()? {
        books.push(summary_from_row(row)?);
    }
    drop(rows);

    attach_authors(conn, &mut books)?;
    attach_tags(conn, &mut books)?;
    Ok(books)
}

/// How many books the query matches, ignoring its page.
///
/// A page without a total is a page you cannot navigate: "20 of 20" and "20 of
/// 985" look identical until something counts. This runs the same conditions
/// through `COUNT(*)` rather than `books.len()` so a paged caller never has to
/// load the rows it is not going to show.
pub fn count(conn: &Connection, query: &BookQuery) -> AppResult<usize> {
    let (conditions, binds) = conditions(query, None);
    let sql = format!("SELECT COUNT(*) FROM {} b {}", relation(query), where_clause(&conditions));
    let total: i64 =
        conn.query_row(&sql, rusqlite::params_from_iter(binds.iter()), |row| row.get(0))?;
    Ok(total as usize)
}

/// Appends `LIMIT`/`OFFSET` when the query asked for a page.
///
/// Both are bound rather than formatted in, and both are clamped first: a
/// `usize` cannot carry a fragment, but a caller that asks for ten million rows
/// would still be asking for the whole table under a different name.
fn push_page(sql: &mut String, binds: &mut Vec<Value>, query: &BookQuery) {
    let Some(limit) = query.limit else { return };
    let limit = limit.clamp(1, MAX_PAGE);
    sql.push_str(" LIMIT ?");
    binds.push(Value::Integer(limit as i64));
    if let Some(offset) = query.offset.filter(|offset| *offset > 0) {
        sql.push_str(" OFFSET ?");
        binds.push(Value::Integer(offset.min(i64::MAX as usize) as i64));
    }
}

/// Counts for the shelf's filter panel.
///
/// One `GROUP BY` per text dimension rather than one query per value: a shelf
/// of two thousand books asks this on every filter change, and the alternative
/// is a dozen round trips through the same table scan.
pub fn facets(conn: &Connection, query: &BookQuery) -> AppResult<LibraryFacets> {
    Ok(LibraryFacets {
        formats: facet_counts(conn, query, Dimension::Format, "b.format")?,
        languages: facet_counts(conn, query, Dimension::Language, "b.language")?,
        publishers: facet_counts(conn, query, Dimension::Publisher, "b.publisher")?,
        status: status_counts(conn, query)?,
        covers: cover_counts(conn, query)?,
    })
}

/// `GROUP BY` over one text column, with that dimension's own filter cleared.
fn facet_counts(
    conn: &Connection,
    query: &BookQuery,
    dimension: Dimension,
    column: &str,
) -> AppResult<Vec<Facet>> {
    let (conditions, binds) = conditions(query, Some(dimension));
    let sql = format!(
        "SELECT {column}, COUNT(*) FROM {} b {} \
          GROUP BY {column} ORDER BY COUNT(*) DESC, {column} COLLATE NOCASE",
        relation(query),
        where_clause(&conditions)
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(binds.iter()))?;

    let mut facets = Vec::new();
    while let Some(row) = rows.next()? {
        // A book with no publisher is not a publisher: an unnamed bucket in the
        // panel would be a filter that means "empty", which is a different
        // question (and `has_cover`-style booleans are where that belongs).
        let Some(value) = row.get::<_, Option<String>>(0)?.filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        facets.push(Facet { value, count: row.get(1)? });
    }
    Ok(facets)
}

fn status_counts(conn: &Connection, query: &BookQuery) -> AppResult<Vec<Facet>> {
    let (conditions, binds) = conditions(query, Some(Dimension::Status));
    let sql = format!(
        "SELECT COALESCE(SUM(b.progress <= 0), 0), \
                COALESCE(SUM(b.progress > 0 AND b.progress < 0.999), 0), \
                COALESCE(SUM(b.progress >= 0.999), 0) \
           FROM {} b {}",
        relation(query),
        where_clause(&conditions)
    );
    let (unread, reading, finished) =
        conn.query_row(&sql, rusqlite::params_from_iter(binds.iter()), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
        })?;
    Ok(vec![
        Facet { value: "unread".to_string(), count: unread },
        Facet { value: "reading".to_string(), count: reading },
        Facet { value: "finished".to_string(), count: finished },
    ])
}

fn cover_counts(conn: &Connection, query: &BookQuery) -> AppResult<Vec<Facet>> {
    let (conditions, binds) = conditions(query, Some(Dimension::Cover));
    let sql = format!(
        "SELECT COALESCE(SUM(b.cover_path IS NOT NULL), 0), \
                COALESCE(SUM(b.cover_path IS NULL), 0) \
           FROM {} b {}",
        relation(query),
        where_clause(&conditions)
    );
    let (has, none) = conn.query_row(&sql, rusqlite::params_from_iter(binds.iter()), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    Ok(vec![
        Facet { value: "has".to_string(), count: has },
        Facet { value: "none".to_string(), count: none },
    ])
}

/// A single book by id, for the reader header. `None` when unknown — or when it
/// is in the trash, which is the same answer: the reader cannot open what the
/// shelf cannot show, and restoring it is what brings it back.
pub fn get(conn: &Connection, id: &str) -> AppResult<Option<BookSummary>> {
    let mut stmt =
        conn.prepare(&format!("SELECT {SELECT_COLUMNS} FROM books_live b WHERE b.id = ?1"))?;
    let mut rows = stmt.query(params![id])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let mut book = summary_from_row(row)?;
    drop(rows);

    attach_authors(conn, std::slice::from_mut(&mut book))?;
    attach_tags(conn, std::slice::from_mut(&mut book))?;
    Ok(Some(book))
}

/// Maps a result row onto a `BookSummary` with empty authors/tags; callers
/// attach them afterwards with one grouped query.
fn summary_from_row(row: &rusqlite::Row<'_>) -> AppResult<BookSummary> {
    let id: String = row.get("id")?;
    let has_cover = row.get::<_, Option<String>>("cover_path")?.is_some();
    let cover_url = has_cover.then(|| crate::library::cover_url(&id));
    Ok(BookSummary {
        id,
        title: row.get("title")?,
        subtitle: row.get("subtitle")?,
        description: row.get("description")?,
        language: row.get("language")?,
        publisher: row.get("publisher")?,
        format: parse_format(&row.get::<_, String>("format")?)?,
        file_size: row.get("file_size")?,
        cover_url,
        added_at: row.get("added_at")?,
        updated_at: row.get("updated_at")?,
        last_read_at: row.get("last_read_at")?,
        progress: row.get("progress")?,
        location: row.get("location")?,
        favorite: row.get::<_, i64>("favorite")? != 0,
        isbn: row.get("isbn")?,
        published_year: row.get("published_year")?,
        rating: row.get("rating")?,
        rating_count: row.get("rating_count")?,
        rating_source: row.get("rating_source")?,
        douban_url: row.get("douban_url")?,
        authors: Vec::new(),
        tags: Vec::new(),
    })
}

/// Wraps the search term in `%` and escapes LIKE wildcards.
fn normalized_search(search: &Option<String>) -> Option<String> {
    let trimmed = search.as_deref()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(like_pattern(trimmed))
}

/// Escapes LIKE wildcards and wraps `term` in `%`, for a substring match.
pub fn like_pattern(term: &str) -> String {
    let escaped = term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// Books whose text is not searchable yet, oldest first.
///
/// Two ways to qualify. A book imported before the reader engine existed has no
/// chapters at all until it is first opened, so a library-wide search has to
/// back-fill it. A PDF has its chapter index (one row per page) but no text —
/// that extraction is deferred past the import, and this is what puts it back
/// on the search path if the background pass never finished.
pub fn books_needing_chapters(conn: &Connection, book_id: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT b.id FROM books_live b
          WHERE (b.chapters_pending = 1
                 OR NOT EXISTS (SELECT 1 FROM chapters c WHERE c.book_id = b.id))
            AND (?1 IS NULL OR b.id = ?1)
          ORDER BY b.added_at, b.id",
    )?;
    let rows = stmt.query_map(params![book_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Books whose chapter text was deferred past the import and is still missing.
///
/// The queue the importer hands to its background pass. Narrower than
/// [`books_needing_chapters`] on purpose: a legacy book with no chapters is
/// healed when someone opens or searches it, and dragging every one of them
/// into an import-triggered job would be a surprise, not a fix.
pub fn pending_chapters(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM books_live WHERE chapters_pending = 1 ORDER BY added_at, id")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Whether this book's chapter text still has to be extracted.
pub fn chapters_pending(conn: &Connection, id: &str) -> AppResult<bool> {
    let pending: Option<i64> = conn
        .query_row("SELECT chapters_pending FROM books WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(pending.unwrap_or(0) != 0)
}

/// Sets or clears the deferred-extraction flag. `false` is what `backfill`
/// writes once the text is in; `true` is what the importer writes.
pub fn set_chapters_pending(conn: &Connection, id: &str, pending: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE books SET chapters_pending = ?2 WHERE id = ?1",
        params![id, i64::from(pending)],
    )?;
    Ok(())
}

fn attach_authors(conn: &Connection, books: &mut [BookSummary]) -> AppResult<()> {
    let ids: Vec<&str> = books.iter().map(|book| book.id.as_str()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = placeholders(ids.len());
    let mut stmt = conn.prepare(&format!(
        "SELECT ba.book_id, a.name FROM book_authors ba
           JOIN authors a ON a.id = ba.author_id
          WHERE ba.book_id IN ({placeholders})
          ORDER BY ba.position"
    ))?;
    let mut rows = stmt.query(rusqlite::params_from_iter(ids))?;
    let mut by_book: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next()? {
        by_book.push((row.get(0)?, row.get(1)?));
    }
    for book in books.iter_mut() {
        book.authors =
            by_book.iter().filter(|(id, _)| id == &book.id).map(|(_, name)| name.clone()).collect();
    }
    Ok(())
}

fn attach_tags(conn: &Connection, books: &mut [BookSummary]) -> AppResult<()> {
    let ids: Vec<&str> = books.iter().map(|book| book.id.as_str()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = placeholders(ids.len());
    let mut stmt = conn.prepare(&format!(
        "SELECT bt.book_id, t.name FROM book_tags bt
           JOIN tags t ON t.id = bt.tag_id
          WHERE bt.book_id IN ({placeholders})
          ORDER BY t.name"
    ))?;
    let mut rows = stmt.query(rusqlite::params_from_iter(ids))?;
    let mut by_book: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows.next()? {
        by_book.push((row.get(0)?, row.get(1)?));
    }
    for book in books.iter_mut() {
        book.tags =
            by_book.iter().filter(|(id, _)| id == &book.id).map(|(_, name)| name.clone()).collect();
    }
    Ok(())
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count).collect::<Vec<_>>().join(", ")
}

/// Inserts a book plus its authors, reusing author rows when the name matches.
pub fn insert(tx: &Transaction<'_>, book: &NewBook<'_>) -> AppResult<()> {
    if book.title.trim().is_empty() {
        return Err(AppError::InvalidArgument("书名不能为空".into()));
    }
    tx.execute(
        "INSERT INTO books (id, title, sort_title, subtitle, description, language, publisher, \
         identifier, format, content_hash, file_path, file_size, cover_path, added_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            book.id,
            book.title,
            sort_key(book.title),
            book.subtitle,
            book.description,
            book.language,
            book.publisher,
            book.identifier,
            book.format.as_str(),
            book.content_hash,
            book.file_path,
            book.file_size,
            book.cover_path,
            crate::library::now_seconds(),
            crate::library::now_seconds(),
        ],
    )?;

    for (position, name) in book.authors.iter().enumerate() {
        let author_id = upsert_author(tx, name)?;
        tx.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES (?1, ?2, ?3)",
            params![book.id, author_id, position as i64],
        )?;
    }
    Ok(())
}

/// Returns the id of the author with this name, creating it when needed.
fn upsert_author(tx: &Transaction<'_>, name: &str) -> AppResult<String> {
    let existing: Option<String> = tx
        .query_row("SELECT id FROM authors WHERE name = ?1", params![name], |row| row.get(0))
        .ok();
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO authors (id, name, sort_name) VALUES (?1, ?2, ?3)",
        params![id, name, sort_key(name)],
    )?;
    Ok(id)
}

/// Files that must be removed from disk once a book row is gone.
#[derive(Debug, Default)]
pub struct DeletedFiles {
    pub book: Option<PathBuf>,
    pub cover: Option<PathBuf>,
}

/// Deletes one book **for good** and reports which files the caller should
/// unlink.
///
/// This is the irreversible half of the two-step delete: `trash` moves a book
/// out of sight, this is what runs when the reader empties the bin. Returns
/// `NotFound` when the id does not exist so the UI can say so.
fn purge_one(conn: &Connection, id: &str) -> AppResult<DeletedFiles> {
    let (book_path, cover_path): (String, Option<String>) = conn
        .query_row("SELECT file_path, cover_path FROM books WHERE id = ?1", params![id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|_| AppError::NotFound(id.to_string()))?;

    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;

    Ok(DeletedFiles { book: Some(PathBuf::from(book_path)), cover: cover_path.map(PathBuf::from) })
}

/// [`purge_one`], for a single id.
pub fn purge(conn: &Connection, id: &str) -> AppResult<DeletedFiles> {
    purge_one(conn, id)
}

/// Purges a batch, inside the caller's transaction.
///
/// The shelf's batch bar hands over every selected id at once; one `purge`
/// per id meant one transaction, and one fsync, per book. All or nothing: an
/// unknown id fails the batch and `with_tx` rolls the earlier deletes back,
/// rather than leaving the shelf half-deleted.
///
/// `on_progress` fires once per book, inside the transaction — before the
/// commit. That is the only place the per-book work happens, so it is the only
/// place a count can come from; the caller pre-checks every id
/// ([`ensure_existing`]) so a rollback after a reported book is not reachable
/// through the shelf's own ids.
pub fn purge_many(
    tx: &Transaction<'_>,
    ids: &[String],
    on_progress: &mut dyn FnMut(usize, usize, &str),
) -> AppResult<Vec<DeletedFiles>> {
    let mut files = Vec::with_capacity(ids.len());
    for (index, id) in ids.iter().enumerate() {
        let deleted = purge_one(tx, id)?;
        let path = deleted.book.as_deref().map(|p| p.to_string_lossy()).unwrap_or_default();
        on_progress(index + 1, ids.len(), &path);
        files.push(deleted);
    }
    Ok(files)
}

/// Moves one book to the trash.
///
/// The row, the file, the cover, the chapters, the highlights and the reading
/// position all stay exactly where they are — only `deleted_at` changes, and
/// `books_live` stops answering for it. That is what makes the operation
/// reversible, and it is also why the delete no longer has to be scary.
///
/// Returns `NotFound` for an unknown id, and is a no-op for one that is already
/// in the trash (trashing twice is what a double-click does).
pub fn trash(conn: &Connection, id: &str) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE books SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, crate::library::now_seconds()],
    )?;
    if changed == 0 {
        // Either it never existed or it is already trashed; both answer the
        // same way, because the shelf is already showing the state the caller
        // asked for.
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM books WHERE id = ?1", params![id], |row| row.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound(id.to_string()));
        }
    }
    Ok(())
}

/// [`trash`] for a batch, in one transaction.
pub fn trash_many(
    tx: &Transaction<'_>,
    ids: &[String],
    on_progress: &mut dyn FnMut(usize, usize, &str),
) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        trash(tx, id)?;
        on_progress(index + 1, ids.len(), id);
    }
    Ok(())
}

/// Brings a book back out of the trash. Idempotent: restoring a live book is a
/// no-op rather than an error, because "make sure this is on the shelf" is the
/// thing every caller actually means.
pub fn restore(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE books SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, crate::library::now_seconds()],
    )?;
    Ok(())
}

/// [`restore`] for a batch, in one transaction.
pub fn restore_many(tx: &Transaction<'_>, ids: &[String]) -> AppResult<()> {
    for id in ids {
        restore(tx, id)?;
    }
    Ok(())
}

/// Empties the bin: purges every trashed book and reports the files to unlink.
///
/// The ids come back with the files because the caller has to be able to say
/// *what* it emptied — a count is not a record of anything.
pub fn empty_trash(tx: &Transaction<'_>) -> AppResult<(Vec<String>, Vec<DeletedFiles>)> {
    let ids: Vec<String> = tx
        .prepare("SELECT id FROM books WHERE deleted_at IS NOT NULL")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut files = Vec::with_capacity(ids.len());
    for id in &ids {
        files.push(purge_one(tx, id)?);
    }
    Ok((ids, files))
}

/// Fails with `NotFound` unless every id is on the shelf.
///
/// One `IN` query rather than a failure half-way through the batch's
/// transaction: `purge_many` reports progress as it goes, and a batch that
/// starts deleting and then rolls back would have shown the reader books as
/// deleted that are all still there. Pre-flighting keeps the all-or-nothing
/// guarantee and the progress honest at the cost of one indexed lookup.
pub fn ensure_existing(conn: &Connection, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = std::iter::repeat_n("?", ids.len()).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT id FROM books WHERE id IN ({placeholders})");
    let found = conn
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(ids), |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<std::collections::HashSet<String>>>()?;
    if let Some(missing) = ids.iter().find(|id| !found.contains(*id)) {
        return Err(AppError::NotFound(missing.clone()));
    }
    Ok(())
}

/// Returns the id of the book holding this content hash, if any.
pub fn find_by_hash(conn: &Connection, hash: &str) -> AppResult<Option<(String, String)>> {
    let found = conn
        .query_row("SELECT id, title FROM books WHERE content_hash = ?1", params![hash], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok();
    Ok(found)
}

fn set_favorite_one(conn: &Connection, id: &str, favorite: bool) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE books SET favorite = ?1, updated_at = ?2 WHERE id = ?3",
        params![i64::from(favorite), crate::library::now_seconds(), id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> AppResult<()> {
    set_favorite_one(conn, id, favorite)
}

/// Marks a batch as favourite (or not), inside the caller's transaction.
///
/// Same reason as [`delete_many`]: the shelf's batch bar can hand over twenty
/// ids at once, and twenty single-row transactions is twenty fsyncs.
pub fn set_favorite_many(tx: &Transaction<'_>, ids: &[String], favorite: bool) -> AppResult<()> {
    for id in ids {
        set_favorite_one(tx, id, favorite)?;
    }
    Ok(())
}

/// Re-labels a book that is already on the shelf.
///
/// Only the label moves: `.mobi` and `.azw3` are the same container and the
/// same parser, so no byte on disk changes. The importer calls this when a
/// duplicate is re-imported as a format that has since been given its own
/// name — without it, a book imported under the old label would keep it for
/// good, since the copy in the library directory is never rewritten.
///
/// ponytail: the stored file keeps the name it was copied under (`{id}.mobi`),
/// so the column and the file name disagree until it is re-imported from
/// scratch. Rename it when something starts reading the extension back.
pub fn set_format(conn: &Connection, id: &str, format: BookFormat) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE books SET format = ?1, updated_at = ?2 WHERE id = ?3",
        params![format.as_str(), crate::library::now_seconds(), id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// The editable half of a book's metadata, as the edit sheet sends it.
///
/// The whole form travels, not a diff: the sheet opens pre-filled from the book
/// and saves what is on screen. `authors` replaces the list outright.
#[derive(specta::Type, Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMetadataPatch {
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub published_year: Option<i32>,
    /// Carried, not edited: the sheet has no field for these, and a save that
    /// dropped them would wipe the catalogue's rating every time the reader
    /// fixed a typo in the title.
    pub rating: Option<f64>,
    pub rating_count: Option<i32>,
    pub rating_source: Option<String>,
    pub douban_url: Option<String>,
    pub authors: Vec<String>,
}

/// An empty or whitespace-only field is stored as "no value" rather than as an
/// empty string, so clearing a field in the sheet reads back as absent instead
/// of as a blank line the card would still have to draw.
fn blank_to_none(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|text| !text.is_empty())
}

/// The fields a **batch** edit may overwrite.
///
/// Two fields, not six. A title or a description is a fact about one book; a
/// publisher or a language is a fact about a shelf's worth of them — 「这三十本
/// 是同一家出的」 is the sentence this exists for. Replacing fifty author lists
/// at once is a different feature with a different confirmation, and not one
/// the batch bar should be able to do by accident.
///
/// `None` means "leave it alone" and `Some("")` means "clear it", the same
/// convention the MCP `update_metadata` tool uses.
#[derive(specta::Type, Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookFieldsPatch {
    pub publisher: Option<String>,
    pub language: Option<String>,
}

impl BookFieldsPatch {
    fn is_empty(&self) -> bool {
        self.publisher.is_none() && self.language.is_none()
    }
}

/// Applies `patch` to every id, inside the caller's transaction.
///
/// Read-modify-write per book: [`update_metadata`] takes a whole record, and a
/// batch is defined as "change these fields, leave everything else" — a book's
/// title has to survive a publisher edit. Returns how many rows were written.
pub fn update_fields_many(
    tx: &Transaction<'_>,
    ids: &[String],
    patch: &BookFieldsPatch,
) -> AppResult<usize> {
    if patch.is_empty() {
        return Err(AppError::InvalidArgument("没有要改的字段".into()));
    }
    let mut written = 0;
    for id in ids {
        let book = get(tx, id)?.ok_or_else(|| AppError::NotFound(id.clone()))?;
        let merged = BookMetadataPatch {
            title: book.title,
            subtitle: book.subtitle,
            description: book.description,
            // `Some("")` is meaningful: `blank_to_none` inside `update_metadata`
            // turns it into "no value", which is how a batch clears a field.
            language: patch.language.clone().or(book.language),
            publisher: patch.publisher.clone().or(book.publisher),
            isbn: book.isbn,
            published_year: book.published_year,
            rating: book.rating,
            rating_count: book.rating_count,
            rating_source: book.rating_source,
            douban_url: book.douban_url,
            authors: book.authors,
        };
        update_metadata(tx, id, &merged)?;
        written += 1;
    }
    Ok(written)
}

/// Rewrites the metadata the edit sheet exposes.
///
/// Three tables are involved — `books`, `authors`, `book_authors` — so this
/// takes a transaction: a failure partway would otherwise leave a book whose
/// author links no longer match its title.
///
/// Author rows are shared between books, so the links are dropped and rebuilt
/// (reusing the row whenever a name still matches). A rebuild can strand the
/// author a book no longer names; those rows go with it, rather than stay
/// behind for the sort index to keep carrying.
pub fn update_metadata(tx: &Transaction<'_>, id: &str, patch: &BookMetadataPatch) -> AppResult<()> {
    let title = patch.title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("书名不能为空".into()));
    }
    let authors: Vec<&str> =
        patch.authors.iter().map(|name| name.trim()).filter(|name| !name.is_empty()).collect();

    let changed = tx.execute(
        "UPDATE books SET title = ?1, sort_title = ?2, subtitle = ?3, description = ?4, \
         language = ?5, publisher = ?6, isbn = ?7, published_year = ?8, rating = ?9, \
         rating_count = ?10, rating_source = ?11, douban_url = ?12, updated_at = ?13 \
         WHERE id = ?14",
        params![
            title,
            sort_key(title),
            blank_to_none(patch.subtitle.as_deref()),
            blank_to_none(patch.description.as_deref()),
            blank_to_none(patch.language.as_deref()),
            blank_to_none(patch.publisher.as_deref()),
            blank_to_none(patch.isbn.as_deref()),
            patch.published_year,
            patch.rating,
            patch.rating_count,
            blank_to_none(patch.rating_source.as_deref()),
            blank_to_none(patch.douban_url.as_deref()),
            crate::library::now_seconds(),
            id,
        ],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }

    tx.execute("DELETE FROM book_authors WHERE book_id = ?1", params![id])?;
    for (position, name) in authors.iter().enumerate() {
        let author_id = upsert_author(tx, name)?;
        tx.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES (?1, ?2, ?3)",
            params![id, author_id, position as i64],
        )?;
    }
    tx.execute("DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM book_authors)", [])?;
    Ok(())
}

/// Points a book at an already-written cover file, after import.
pub fn set_cover(conn: &Connection, id: &str, cover_path: &str) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE books SET cover_path = ?1, updated_at = ?2 WHERE id = ?3",
        params![cover_path, crate::library::now_seconds(), id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// Records a reading position, clamped to `0..=1`, and bumps `last_read_at`.
///
/// `location` is the opaque anchor of an engine that cannot resume from a
/// fraction alone (a CFI for foliate). `None` leaves the stored anchor alone —
/// the prose path never has one and must not clear the Kindle one.
pub fn set_progress(
    conn: &Connection,
    id: &str,
    progress: f64,
    location: Option<&str>,
) -> AppResult<()> {
    let progress = progress.clamp(0.0, 1.0);
    let changed = conn.execute(
        "UPDATE books \
         SET progress = ?1, last_read_at = ?2, updated_at = ?2, \
             location = COALESCE(?3, location) \
         WHERE id = ?4",
        params![progress, crate::library::now_seconds(), location, id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(id.to_string()));
    }
    Ok(())
}

/// The stored source file and its format, used to build chapters on demand for
/// books imported before the reader engine existed.
pub fn source(conn: &Connection, id: &str) -> AppResult<(String, BookFormat)> {
    let (path, format) = conn
        .query_row("SELECT file_path, format FROM books WHERE id = ?1", params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| AppError::NotFound(id.to_string()))?;
    Ok((path, parse_format(&format)?))
}

fn parse_format(value: &str) -> AppResult<BookFormat> {
    match value {
        "epub" => Ok(BookFormat::Epub),
        "pdf" => Ok(BookFormat::Pdf),
        "mobi" => Ok(BookFormat::Mobi),
        "azw" => Ok(BookFormat::Azw),
        "azw3" => Ok(BookFormat::Azw3),
        "prc" => Ok(BookFormat::Prc),
        "fb2" => Ok(BookFormat::Fb2),
        "cbz" => Ok(BookFormat::Cbz),
        "markdown" => Ok(BookFormat::Markdown),
        "txt" => Ok(BookFormat::Text),
        other => Err(AppError::UnsupportedFormat(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::document::RawChapter;
    use crate::library::chapters;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn
    }

    fn add(conn: &Connection, id: &str, title: &str, authors: &[&str], hash: &str) {
        add_as(conn, id, title, authors, hash, BookFormat::Epub, 1024);
    }

    /// The same insert with the two columns the shelf's newer orders read —
    /// the format and the size on disk — under the test's own control.
    fn add_as(
        conn: &Connection,
        id: &str,
        title: &str,
        authors: &[&str],
        hash: &str,
        format: BookFormat,
        file_size: i64,
    ) {
        let owned: Vec<String> = authors.iter().map(|a| a.to_string()).collect();
        let tx = conn.unchecked_transaction().expect("tx");
        insert(
            &tx,
            &NewBook {
                id,
                title,
                subtitle: None,
                description: None,
                language: Some("zh"),
                publisher: None,
                identifier: None,
                format,
                content_hash: hash,
                file_path: &format!("/books/{id}.{}", format.extension()),
                file_size,
                cover_path: None,
                authors: &owned,
            },
        )
        .expect("insert");
        tx.commit().expect("commit");
    }

    #[test]
    fn inserted_books_come_back_with_their_authors() {
        let conn = seed();
        add(&conn, "b1", "三体", &["刘慈欣"], "h1");
        add(&conn, "b2", "球状闪电", &["刘慈欣", "某人"], "h2");

        let books = list(&conn, &BookQuery::default()).expect("list");
        assert_eq!(books.len(), 2);
        let first = books.iter().find(|b| b.id == "b2").expect("b2");
        assert_eq!(first.authors, ["刘慈欣", "某人"], "作者顺序必须保留");
    }

    #[test]
    fn sort_keys_strip_leading_articles() {
        assert_eq!(sort_key("The Rust Book"), "rust book");
        assert_eq!(sort_key("An Introduction"), "introduction");
        assert_eq!(sort_key("三体"), "三体");
    }

    #[test]
    fn search_matches_titles_and_authors() {
        let conn = seed();
        add(&conn, "b1", "三体", &["刘慈欣"], "h1");
        add(&conn, "b2", "Dune", &["Frank Herbert"], "h2");

        let by_title =
            list(&conn, &BookQuery { search: Some("dune".into()), ..Default::default() })
                .expect("list");
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].id, "b2");

        let by_author =
            list(&conn, &BookQuery { search: Some("刘慈欣".into()), ..Default::default() })
                .expect("list");
        assert_eq!(by_author.len(), 1);
        assert_eq!(by_author[0].id, "b1");
    }

    #[test]
    fn like_wildcards_in_the_search_box_are_escaped() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");

        // A bare `%` must not collapse to "match everything".
        let all = list(&conn, &BookQuery { search: Some("%".into()), ..Default::default() })
            .expect("list");
        assert_eq!(all.len(), 0, "% 必须被转义而不是当通配符");
    }

    #[test]
    fn author_sort_orders_by_the_first_author() {
        let conn = seed();
        add(&conn, "b1", "Zed", &["Zoe"], "h1");
        add(&conn, "b2", "Alpha", &["Adam"], "h2");

        let books = list(&conn, &BookQuery { sort: LibrarySort::AuthorAsc, ..Default::default() })
            .expect("list");
        assert_eq!(books[0].id, "b2");
    }

    /// The two orders the shelf gained: by format and by size on disk.
    ///
    /// The fixture is built so the two disagree — the largest file is also the
    /// last format alphabetically — because a fixture where both orders produce
    /// the same sequence would pass with one of the two `ORDER BY` clauses
    /// wrong, or with both pointing at the same column.
    #[test]
    fn format_and_size_sorts_order_by_the_column_they_name() {
        let conn = seed();
        add_as(&conn, "b1", "最大的 txt", &[], "h1", BookFormat::Text, 9_000_000);
        add_as(&conn, "b2", "最小的 epub", &[], "h2", BookFormat::Epub, 900);
        add_as(&conn, "b3", "中间的 pdf", &[], "h3", BookFormat::Pdf, 50_000);

        let by_format =
            list(&conn, &BookQuery { sort: LibrarySort::FormatAsc, ..Default::default() })
                .expect("list");
        let ids: Vec<&str> = by_format.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["b2", "b3", "b1"], "epub < pdf < txt");

        let by_size = list(&conn, &BookQuery { sort: LibrarySort::SizeDesc, ..Default::default() })
            .expect("list");
        let ids: Vec<&str> = by_size.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["b1", "b3", "b2"], "从大到小");
    }

    /// Ties fall back to the title, so a group of same-format or same-size
    /// books comes back in a readable order rather than SQLite's own.
    #[test]
    fn the_new_sorts_break_ties_by_title() {
        let conn = seed();
        add_as(&conn, "b1", "Zebra", &[], "h1", BookFormat::Epub, 4096);
        add_as(&conn, "b2", "apple", &[], "h2", BookFormat::Epub, 4096);

        for sort in [LibrarySort::FormatAsc, LibrarySort::SizeDesc] {
            let books = list(&conn, &BookQuery { sort, ..Default::default() }).expect("list");
            let ids: Vec<&str> = books.iter().map(|b| b.id.as_str()).collect();
            assert_eq!(ids, ["b2", "b1"], "{sort:?} 同键时按书名");
        }
    }

    /// 进度排序：进度高的在前，没读过的（进度相同）沉底并按阅读时间回退。
    #[test]
    fn progress_sort_puts_the_furthest_along_first() {
        let conn = seed();
        add(&conn, "b1", "刚开始", &[], "h1");
        add(&conn, "b2", "快读完", &[], "h2");
        add(&conn, "b3", "读完了", &[], "h3");
        add(&conn, "b4", "没动过", &[], "h4");
        conn.execute("UPDATE books SET progress = 0.1, last_read_at = 100 WHERE id = 'b1'", [])
            .expect("touch");
        conn.execute("UPDATE books SET progress = 0.8, last_read_at = 200 WHERE id = 'b2'", [])
            .expect("touch");
        conn.execute("UPDATE books SET progress = 1.0 WHERE id = 'b3'", []).expect("touch");

        let books =
            list(&conn, &BookQuery { sort: LibrarySort::ProgressDesc, ..Default::default() })
                .expect("list");
        let ids: Vec<&str> = books.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["b3", "b2", "b1", "b4"], "进度从高到低，未读沉底");
    }

    #[test]
    fn favorites_and_recent_filters_narrow_the_shelf() {
        let conn = seed();
        add(&conn, "b1", "未读", &[], "h1");
        add(&conn, "b2", "在读", &[], "h2");
        set_favorite(&conn, "b2", true).expect("favorite");
        conn.execute("UPDATE books SET last_read_at = 500 WHERE id = 'b2'", []).expect("touch");

        let favorites =
            list(&conn, &BookQuery { filter: LibraryFilter::Favorites, ..Default::default() })
                .expect("list");
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].id, "b2");

        let recent =
            list(&conn, &BookQuery { filter: LibraryFilter::Recent, ..Default::default() })
                .expect("list");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "b2");
    }

    #[test]
    fn the_tag_filter_narrows_the_shelf_case_insensitively() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");
        conn.execute("INSERT INTO tags (id, name) VALUES ('t1', '科幻'), ('t2', 'Novel')", [])
            .expect("tags");
        conn.execute(
            "INSERT INTO book_tags (book_id, tag_id) VALUES ('b1', 't1'), ('b2', 't2')",
            [],
        )
        .expect("book_tags");

        let sci_fi = list(&conn, &BookQuery { tag: Some("科幻".into()), ..Default::default() })
            .expect("list");
        assert_eq!(sci_fi.len(), 1);
        assert_eq!(sci_fi[0].id, "b1");

        // Spelling must not decide whether a label is found.
        let novel = list(&conn, &BookQuery { tag: Some("novel".into()), ..Default::default() })
            .expect("list");
        assert_eq!(novel.len(), 1);
        assert_eq!(novel[0].id, "b2");

        // A blank tag is not a filter, it is no filter.
        let all =
            list(&conn, &BookQuery { tag: Some("  ".into()), ..Default::default() }).expect("list");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn deleting_removes_the_row_and_reports_its_files() {
        let conn = seed();
        add(&conn, "b1", "三体", &["刘慈欣"], "h1");

        let deleted = &purge(&conn, "b1").expect("delete");
        assert_eq!(deleted.book.as_deref(), Some(Path::new("/books/b1.epub")));
        assert!(find_by_hash(&conn, "h1").expect("query").is_none());
    }

    #[test]
    fn deleting_an_unknown_id_is_not_found() {
        let conn = seed();
        assert!(matches!(&purge(&conn, "nope"), Err(AppError::NotFound(_))));
        assert!(matches!(set_favorite(&conn, "nope", true), Err(AppError::NotFound(_))));
    }

    #[test]
    fn deleting_many_removes_every_row_in_one_pass() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");
        add(&conn, "b3", "留下", &[], "h3");

        let mut seen: Vec<(usize, usize)> = Vec::new();
        let tx = conn.unchecked_transaction().expect("transaction");
        let files = &purge_many(&tx, &["b1".into(), "b2".into()], &mut |done, total, _| {
            seen.push((done, total));
        })
        .expect("delete many");
        tx.commit().expect("commit");

        assert_eq!(seen, [(1, 2), (2, 2)]);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].book.as_deref(), Some(Path::new("/books/b1.epub")));
        assert!(find_by_hash(&conn, "h1").expect("query").is_none());
        assert!(find_by_hash(&conn, "h2").expect("query").is_none());
        assert!(find_by_hash(&conn, "h3").expect("query").is_some());
    }

    /// The batch is all or nothing. An unknown id fails it, and the caller's
    /// `with_tx` rolls the earlier deletes back — reproduced here by dropping
    /// the transaction instead of committing it, which is what `with_tx` does
    /// when `f` returns `Err`.
    #[test]
    fn a_batch_with_one_unknown_id_leaves_every_row_alone() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");

        let tx = conn.unchecked_transaction().expect("transaction");
        let outcome =
            &purge_many(&tx, &["b1".into(), "nope".into(), "b2".into()], &mut |_, _, _| {});
        assert!(matches!(outcome, Err(AppError::NotFound(_))));
        drop(tx);

        assert!(find_by_hash(&conn, "h1").expect("query").is_some());
        assert!(find_by_hash(&conn, "h2").expect("query").is_some());
    }

    /// The pre-flight that keeps reported progress honest: it fails before
    /// `delete_many` deletes anything, naming the first id the shelf does not
    /// have — the same error the batch itself would have produced.
    #[test]
    fn the_pre_flight_names_the_first_missing_id() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");

        assert!(ensure_existing(&conn, &["b1".into()]).is_ok());
        assert!(ensure_existing(&conn, &[]).is_ok());
        let missing = ensure_existing(&conn, &["b1".into(), "gone".into()]);
        assert!(matches!(missing, Err(AppError::NotFound(id)) if id == "gone"));
    }

    #[test]
    fn favouriting_many_touches_every_id_in_one_pass() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");
        add(&conn, "b3", "未标", &[], "h3");

        let tx = conn.unchecked_transaction().expect("transaction");
        set_favorite_many(&tx, &["b1".into(), "b2".into()], true).expect("favourite many");
        tx.commit().expect("commit");

        assert_eq!(stats(&conn).expect("stats").favorites, 2);
    }

    #[test]
    fn stats_count_the_shelf_by_state() {
        let conn = seed();
        assert_eq!(stats(&conn).expect("stats"), LibraryStats::default());

        add(&conn, "b1", "未读", &[], "h1");
        add(&conn, "b2", "在读", &[], "h2");
        add(&conn, "b3", "读完", &[], "h3");
        set_favorite(&conn, "b1", true).expect("favorite");
        conn.execute("UPDATE books SET last_read_at = 1, progress = 0.4 WHERE id = 'b2'", [])
            .expect("touch");
        conn.execute("UPDATE books SET last_read_at = 2, progress = 1.0 WHERE id = 'b3'", [])
            .expect("touch");

        assert_eq!(
            stats(&conn).expect("stats"),
            LibraryStats { total: 3, favorites: 1, reading: 1, finished: 1, trashed: 0 }
        );

        // Opening a book and closing it without turning a page is not 在读.
        // `last_read_at` alone counted it, and on a real 39-book shelf that
        // made 27 of them 在读 — a number the reader could not act on.
        add(&conn, "b4", "只打开过", &[], "h4");
        conn.execute("UPDATE books SET last_read_at = 3, progress = 0 WHERE id = 'b4'", [])
            .expect("touch");

        assert_eq!(
            stats(&conn).expect("stats"),
            LibraryStats { total: 4, favorites: 1, reading: 1, finished: 1, trashed: 0 }
        );
    }

    #[test]
    fn books_needing_chapters_are_listed_until_their_text_lands() {
        let conn = seed();
        add(&conn, "b1", "三体", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");
        assert_eq!(books_needing_chapters(&conn, None).expect("query"), ["b1", "b2"]);

        let tx = conn.unchecked_transaction().expect("tx");
        chapters::insert(&tx, "b1", &[RawChapter { title: None, paragraphs: vec!["正文".into()] }])
            .expect("insert chapters");
        tx.commit().expect("commit");

        assert_eq!(books_needing_chapters(&conn, None).expect("query"), ["b2"]);
        assert!(books_needing_chapters(&conn, Some("b1")).expect("query").is_empty());
    }

    #[test]
    fn a_deferred_pdf_is_listed_even_though_its_page_index_exists() {
        // The index is rows, so "has no chapters" cannot see a PDF whose text
        // was deferred. Without the flag in this query a library-wide search
        // would walk straight past such a book and report no hits for text that
        // is sitting right there in the file.
        let conn = seed();
        add(&conn, "b1", "规范", &[], "h1");
        add(&conn, "b2", "Dune", &[], "h2");
        let tx = conn.unchecked_transaction().expect("tx");
        chapters::insert(&tx, "b1", &[RawChapter { title: None, paragraphs: Vec::new() }])
            .expect("insert chapters");
        tx.commit().expect("commit");

        assert_eq!(books_needing_chapters(&conn, None).expect("query"), ["b2"]);
        assert!(pending_chapters(&conn).expect("query").is_empty());

        set_chapters_pending(&conn, "b1", true).expect("flag");
        assert!(chapters_pending(&conn, "b1").expect("query"));
        assert_eq!(books_needing_chapters(&conn, None).expect("query"), ["b1", "b2"]);
        assert_eq!(pending_chapters(&conn).expect("query"), ["b1"]);

        // `pending_chapters` is the narrower queue: b2 has no chapters at all
        // and is healed when someone opens it, not by the importer.
        set_chapters_pending(&conn, "b1", false).expect("clear");
        assert!(!chapters_pending(&conn, "b1").expect("query"));
        assert!(pending_chapters(&conn).expect("query").is_empty());
    }

    #[test]
    fn cover_path_is_none_for_books_without_a_cover() {
        let conn = seed();
        add(&conn, "b1", "无封面", &[], "h1");
        assert_eq!(cover_path(&conn, "b1").expect("query"), None);
        assert_eq!(cover_path(&conn, "missing").expect("query"), None);
    }

    #[test]
    fn duplicate_hashes_are_rejected_by_the_database() {
        let conn = seed();
        add(&conn, "b1", "第一本", &[], "same");
        assert!(add_tx(&conn, "b2", "第二本", "same").is_err());
    }

    fn add_tx(conn: &Connection, id: &str, title: &str, hash: &str) -> AppResult<()> {
        let tx = conn.unchecked_transaction()?;
        insert(
            &tx,
            &NewBook {
                id,
                title,
                subtitle: None,
                description: None,
                language: None,
                publisher: None,
                identifier: None,
                format: BookFormat::Epub,
                content_hash: hash,
                file_path: "p",
                file_size: 1,
                cover_path: None,
                authors: &[],
            },
        )?;
        tx.commit()?;
        Ok(())
    }

    /// A patch carrying only what the test under it cares about; every other
    /// field starts empty, which is also how the sheet's untouched fields look.
    fn draft(title: &str, authors: &[&str]) -> BookMetadataPatch {
        BookMetadataPatch {
            title: title.into(),
            subtitle: None,
            description: None,
            language: None,
            publisher: None,
            isbn: None,
            published_year: None,
            rating: None,
            rating_count: None,
            rating_source: None,
            douban_url: None,
            authors: authors.iter().map(|name| name.to_string()).collect(),
        }
    }

    fn edit(conn: &Connection, id: &str, patch: &BookMetadataPatch) {
        let tx = conn.unchecked_transaction().expect("tx");
        update_metadata(&tx, id, patch).expect("update");
        tx.commit().expect("commit");
    }

    fn author_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT name FROM authors").expect("prepare");
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).expect("query");
        rows.map(|row| row.expect("row")).collect()
    }

    #[test]
    fn metadata_edits_rewrite_title_sort_key_and_authors() {
        let conn = seed();
        add(&conn, "b1", "未命名", &["佚名"], "h1");

        edit(
            &conn,
            "b1",
            &BookMetadataPatch {
                // Whitespace is not a value: the column goes back to NULL so the
                // card has nothing to draw rather than a blank line.
                subtitle: Some("   ".into()),
                description: Some("  一场战争  ".into()),
                ..draft("The Three-Body Problem", &["Liu Cixin", "  ", " Translator "])
            },
        );

        let book = get(&conn, "b1").expect("get").expect("b1");
        assert_eq!(book.title, "The Three-Body Problem");
        assert_eq!(book.subtitle, None);
        assert_eq!(book.description.as_deref(), Some("一场战争"), "首尾空白要去掉");
        assert_eq!(book.authors, ["Liu Cixin", "Translator"], "作者整列替换，空白项丢弃");

        // The shelf's title order reads `sort_title`, so an edit that left it
        // alone would keep sorting the book under its old name.
        let sort_title: String = conn
            .query_row("SELECT sort_title FROM books WHERE id = 'b1'", [], |row| row.get(0))
            .expect("sort_title");
        assert_eq!(sort_title, "three-body problem");
    }

    #[test]
    fn editing_authors_keeps_shared_rows_and_drops_the_orphans() {
        let conn = seed();
        add(&conn, "b1", "书一", &["共同作者", "被移除"], "h1");
        add(&conn, "b2", "书二", &["共同作者"], "h2");

        edit(&conn, "b1", &draft("书一", &["共同作者", "新作者"]));

        let names = author_names(&conn);
        assert!(names.contains(&"共同作者".to_string()), "另一本书仍在用的作者不能删");
        assert!(names.contains(&"新作者".to_string()));
        assert!(!names.contains(&"被移除".to_string()), "没人再引用的作者行要一并清理");

        let other = get(&conn, "b2").expect("get").expect("b2");
        assert_eq!(other.authors, ["共同作者"], "另一本书的作者链不受影响");
    }

    #[test]
    fn an_empty_title_is_rejected_and_nothing_is_written() {
        let conn = seed();
        add(&conn, "b1", "原名", &["原作者"], "h1");

        let tx = conn.unchecked_transaction().expect("tx");
        let error = update_metadata(&tx, "b1", &draft("   ", &["新作者"]));
        drop(tx);
        assert!(error.is_err(), "空白标题必须被拒绝");

        let book = get(&conn, "b1").expect("get").expect("b1");
        assert_eq!(book.title, "原名");
        assert_eq!(book.authors, ["原作者"], "被拒绝的编辑不能留下半写入的作者链");
    }

    #[test]
    fn editing_a_missing_book_reports_not_found() {
        let conn = seed();
        let tx = conn.unchecked_transaction().expect("tx");
        let error = update_metadata(&tx, "nope", &draft("书", &[]));
        assert!(matches!(error, Err(AppError::NotFound(_))));
    }

    /// A shelf of three books that disagree on every facet dimension.
    fn filtered_shelf() -> Connection {
        let conn = seed();
        add_as(&conn, "b1", "三体", &["刘慈欣"], "h1", BookFormat::Epub, 1024);
        add_as(&conn, "b2", "Dune", &["Herbert"], "h2", BookFormat::Pdf, 2048);
        add_as(&conn, "b3", "Piranesi", &["Clarke"], "h3", BookFormat::Epub, 4096);
        conn.execute_batch(
            "UPDATE books SET language = 'zh', publisher = '重庆出版社', progress = 0.0
              WHERE id = 'b1';
             UPDATE books SET language = 'en', publisher = 'Chilton', progress = 0.4,
                              last_read_at = 1 WHERE id = 'b2';
             UPDATE books SET language = 'en', publisher = NULL, progress = 0.999,
                              last_read_at = 2, cover_path = '/covers/b3.jpg' WHERE id = 'b3';",
        )
        .expect("seed facets");
        conn
    }

    #[test]
    fn an_empty_query_is_the_whole_shelf() {
        let conn = filtered_shelf();
        let books = list(&conn, &BookQuery::default()).expect("list");
        assert_eq!(books.len(), 3, "新字段默认值必须等于旧行为");
    }

    #[test]
    fn formats_narrow_the_shelf_and_an_empty_list_does_not() {
        let conn = filtered_shelf();
        let epub = BookQuery { formats: vec![BookFormat::Epub], ..BookQuery::default() };
        let titles: Vec<String> =
            list(&conn, &epub).expect("list").into_iter().map(|b| b.title).collect();
        assert_eq!(titles.len(), 2);
        assert!(!titles.contains(&"Dune".to_string()));

        let both =
            BookQuery { formats: vec![BookFormat::Epub, BookFormat::Pdf], ..BookQuery::default() };
        assert_eq!(list(&conn, &both).expect("list").len(), 3);
    }

    #[test]
    fn status_uses_the_same_thresholds_as_the_header_count() {
        let conn = filtered_shelf();
        let count = |status| {
            list(&conn, &BookQuery { status, ..BookQuery::default() }).expect("list").len()
        };
        assert_eq!(count(ReadingStatus::Unread), 1);
        assert_eq!(count(ReadingStatus::Reading), 1);
        // 0.999 is finished here because it is finished in `stats` — the two
        // numbers sit one above the other on screen.
        assert_eq!(count(ReadingStatus::Finished), 1);
        assert_eq!(stats(&conn).expect("stats").finished, 1);
        assert_eq!(count(ReadingStatus::Any), 3);
    }

    #[test]
    fn a_language_filter_matches_the_stored_value_exactly() {
        let conn = filtered_shelf();
        let query = BookQuery { languages: vec!["en".into()], ..BookQuery::default() };
        assert_eq!(list(&conn, &query).expect("list").len(), 2);

        let unknown = BookQuery { languages: vec!["fr".into()], ..BookQuery::default() };
        assert!(list(&conn, &unknown).expect("list").is_empty());
    }

    #[test]
    fn the_cover_filter_splits_the_shelf_both_ways() {
        let conn = filtered_shelf();
        let with = BookQuery { has_cover: Some(true), ..BookQuery::default() };
        let without = BookQuery { has_cover: Some(false), ..BookQuery::default() };
        assert_eq!(list(&conn, &with).expect("list").len(), 1);
        assert_eq!(list(&conn, &without).expect("list").len(), 2);
    }

    /// The property the panel depends on: a facet is counted with every *other*
    /// filter applied and its own cleared. Otherwise picking 「epub」 would hide
    /// 「pdf」 from the panel and the reader could never widen the selection
    /// again without clearing the whole panel.
    #[test]
    fn a_facet_ignores_only_its_own_filter() {
        let conn = filtered_shelf();
        let query = BookQuery {
            formats: vec![BookFormat::Epub],
            languages: vec!["en".into()],
            ..BookQuery::default()
        };

        let facets = facets(&conn, &query).expect("facets");
        assert_eq!(list(&conn, &query).expect("list").len(), 1, "两个筛选同时生效只剩 Piranesi");

        // 语言这一维不受语言筛选影响：`zh` 只剩 0 本也要留着，否则读者没有
        // 路回到中文书 —— 面板上唯一还能点的就是当前值。
        let languages: Vec<(String, i64)> =
            facets.languages.iter().map(|f| (f.value.clone(), f.count)).collect();
        assert_eq!(languages.len(), 2);
        assert!(languages.contains(&("zh".to_string(), 1)), "epub 里的三体还在");
        assert!(languages.contains(&("en".to_string(), 1)));

        // 同理，`pdf` 必须还在格式列表里，即使当前只筛了 epub。
        let formats: Vec<(String, i64)> =
            facets.formats.iter().map(|f| (f.value.clone(), f.count)).collect();
        assert!(formats.contains(&("pdf".to_string(), 1)), "Dune 是 en，pdf 仍在候选里");
        assert!(formats.contains(&("epub".to_string(), 1)));
    }

    #[test]
    fn books_without_a_publisher_are_not_a_publisher_facet() {
        let conn = filtered_shelf();
        let facets = facets(&conn, &BookQuery::default()).expect("facets");
        let names: Vec<&str> = facets.publishers.iter().map(|f| f.value.as_str()).collect();
        assert_eq!(names.len(), 2, "Piranesi 没有出版社，不该出现一个空名字的桶");
        assert!(names.contains(&"重庆出版社"));
        assert!(names.contains(&"Chilton"));
    }

    #[test]
    fn facets_count_every_status_and_cover_bucket_even_at_zero() {
        let conn = seed();
        add(&conn, "b1", "只有一本", &[], "h1");

        let facets = facets(&conn, &BookQuery::default()).expect("facets");
        assert_eq!(facets.status.len(), 3, "三个状态始终都在，计数为 0 也要能点");
        assert_eq!(facets.covers.len(), 2);
        assert_eq!(facets.status[0].count, 1, "未读");
        assert_eq!(facets.status[2].count, 0, "已读完");
        assert_eq!(facets.covers[1].count, 1, "没有封面");
    }

    #[test]
    fn a_trashed_book_leaves_the_shelf_and_the_header_count() {
        let conn = filtered_shelf();
        trash(&conn, "b2").expect("trash");

        let books = list(&conn, &BookQuery::default()).expect("list");
        assert_eq!(books.len(), 2, "书架少一本");
        assert!(!books.iter().any(|b| b.id == "b2"));

        let stats = stats(&conn).expect("stats");
        assert_eq!(stats.total, 2, "表头数的是书架，不是表里的行");
        assert_eq!(stats.trashed, 1, "回收站自己有一份计数");
    }

    #[test]
    fn the_bin_holds_only_what_was_trashed_and_cannot_be_opened() {
        let conn = filtered_shelf();
        trash(&conn, "b2").expect("trash");

        let bin = list(&conn, &BookQuery { trash: true, ..BookQuery::default() }).expect("bin");
        assert_eq!(bin.len(), 1);
        assert_eq!(bin[0].id, "b2");

        // The reader asks for one book by id; a trashed one has to answer the
        // same way a missing one does, or the shelf could open what it cannot
        // show.
        assert!(get(&conn, "b2").expect("get").is_none());
    }

    #[test]
    fn the_bin_can_be_searched_like_any_other_shelf() {
        let conn = filtered_shelf();
        trash(&conn, "b2").expect("trash");

        let query = BookQuery { trash: true, search: Some("Dune".into()), ..BookQuery::default() };
        assert_eq!(list(&conn, &query).expect("list").len(), 1);

        let miss = BookQuery { trash: true, search: Some("三体".into()), ..BookQuery::default() };
        assert!(list(&conn, &miss).expect("list").is_empty(), "书架上的书不该出现在回收站里");
    }

    #[test]
    fn facets_in_the_bin_count_only_the_bin() {
        let conn = filtered_shelf();
        trash(&conn, "b2").expect("trash");

        let facets = facets(&conn, &BookQuery { trash: true, ..BookQuery::default() }).expect("f");
        let formats: Vec<(String, i64)> =
            facets.formats.iter().map(|f| (f.value.clone(), f.count)).collect();
        assert_eq!(formats, vec![("pdf".to_string(), 1)], "回收站里只有那本 pdf");
    }

    #[test]
    fn restoring_keeps_the_progress_the_book_had() {
        let conn = filtered_shelf();
        conn.execute("UPDATE books SET progress = 0.4, last_read_at = 7 WHERE id = 'b2'", [])
            .expect("touch");
        trash(&conn, "b2").expect("trash");
        restore(&conn, "b2").expect("restore");

        let book = get(&conn, "b2").expect("get").expect("b2 back");
        assert_eq!(book.progress, 0.4, "恢复的是书，不是一本新书");
        assert_eq!(stats(&conn).expect("stats").trashed, 0);
    }

    #[test]
    fn trashing_twice_is_not_an_error_but_an_unknown_id_is() {
        let conn = filtered_shelf();
        trash(&conn, "b2").expect("first");
        trash(&conn, "b2").expect("second — 双击不该报错");
        assert!(matches!(trash(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    /// A page is a window onto the same list, not a different one: the two
    /// halves have to cover the shelf exactly once.
    #[test]
    fn a_page_returns_its_window_and_the_count_ignores_it() {
        let conn = filtered_shelf();
        let first = list(&conn, &BookQuery { limit: Some(2), ..BookQuery::default() }).expect("p1");
        let rest =
            list(&conn, &BookQuery { limit: Some(2), offset: Some(2), ..BookQuery::default() })
                .expect("p2");

        assert_eq!(first.len(), 2);
        assert_eq!(rest.len(), 1, "第二页只剩一本");
        let mut ids: Vec<&str> =
            first.iter().chain(rest.iter()).map(|book| book.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["b1", "b2", "b3"], "两页合起来正好是书架，不重不漏");

        // The total describes the query, not the page — a page you cannot
        // navigate is a page that looks like the whole library.
        let paged = BookQuery { limit: Some(1), ..BookQuery::default() };
        assert_eq!(count(&conn, &paged).expect("count"), 3);
        // And it counts what the filters leave, not the table.
        let narrowed =
            BookQuery { formats: vec![BookFormat::Epub], limit: Some(1), ..BookQuery::default() };
        assert_eq!(count(&conn, &narrowed).expect("count"), 2);
    }

    #[test]
    fn a_page_past_the_end_is_empty_rather_than_an_error() {
        let conn = filtered_shelf();
        let beyond = BookQuery { limit: Some(10), offset: Some(50), ..BookQuery::default() };
        assert!(list(&conn, &beyond).expect("list").is_empty());
        assert_eq!(count(&conn, &beyond).expect("count"), 3);
    }

    /// The sentence this feature exists for: 「这三十本是同一家出的」. The one
    /// thing it must not do is rewrite the title on the way.
    #[test]
    fn a_batch_edit_changes_only_the_fields_it_names() {
        let conn = filtered_shelf();
        let tx = conn.unchecked_transaction().expect("tx");
        let written = update_fields_many(
            &tx,
            &["b1".into(), "b2".into()],
            &BookFieldsPatch { publisher: Some("统一出版社".into()), language: None },
        )
        .expect("batch");
        tx.commit().expect("commit");

        assert_eq!(written, 2);
        let first = get(&conn, "b1").expect("get").expect("b1");
        assert_eq!(first.publisher.as_deref(), Some("统一出版社"));
        assert_eq!(first.title, "三体", "书名不是批量的字段");
        assert_eq!(first.authors, ["刘慈欣"], "作者不是批量的字段");
        assert_eq!(first.language.as_deref(), Some("zh"), "没点名的字段保持原样");

        let third = get(&conn, "b3").expect("get").expect("b3");
        assert_eq!(third.publisher, None, "没选中的书不动");
    }

    #[test]
    fn a_batch_edit_can_clear_a_field_with_an_empty_string() {
        let conn = filtered_shelf();
        let tx = conn.unchecked_transaction().expect("tx");
        update_fields_many(
            &tx,
            &["b1".into()],
            &BookFieldsPatch { publisher: None, language: Some(String::new()) },
        )
        .expect("batch");
        tx.commit().expect("commit");

        let book = get(&conn, "b1").expect("get").expect("b1");
        assert_eq!(book.language, None, "空串 = 清空");
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"), "别的字段不受影响");
    }

    #[test]
    fn an_empty_batch_patch_is_rejected_rather_than_a_no_op() {
        let conn = filtered_shelf();
        let tx = conn.unchecked_transaction().expect("tx");
        let outcome = update_fields_many(&tx, &["b1".into()], &BookFieldsPatch::default());
        assert!(matches!(outcome, Err(AppError::InvalidArgument(_))));
    }
}
