//! The library domain: sorting rules, cover URLs and book removal.
//!
//! Twenty-six modules used to sit flat in this directory, mixing five
//! unrelated domains in one bucket — a dictionary parser next to a WebDAV
//! client next to the shelf's own queries. They are grouped into
//! subdirectories now, and every one is re-exported here, so
//! `crate::library::<module>` still names the same thing it always did: the
//! grouping is about which file to open, not about a new public path.
//!
//! The subdirectories are private for two reasons. `retrieval/` and
//! `transfer/` are not the report's `search/` and `sync/` because
//! `pub mod search;` next to `pub use search::search;` is `E0255` — a module
//! and a re-export of a module cannot share a name. Keeping all seven private
//! solves that uniformly instead of for two of them.

mod assist;
mod io;
mod lookup;
mod marks;
mod retrieval;
mod shelf;
mod transfer;

pub use assist::{conversation, graph, guide, ocr, summary};
pub use io::{clippings, export, import, pack, source};
pub use lookup::{dictionaries, markup, mdict, stardict};
pub use marks::{annotations, bookmarks, migrate};
pub use retrieval::{rag, search};
pub use shelf::{chapters, fonts, repository, stats, tags};
pub use transfer::{backup, sync};

#[cfg(test)]
mod bench;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::Library;
use crate::error::AppResult;

/// Whether `path`'s extension is one of `candidates`, compared case-insensitively.
///
/// Shared by both exporters, which pick their format from the destination
/// extension: one function decides what the save dialog promised and what gets
/// written, so the two cannot disagree.
pub fn has_extension(path: &Path, candidates: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| candidates.iter().any(|candidate| candidate.eq_ignore_ascii_case(ext)))
}

/// English articles ignored when building a sort key.
const LEADING_ARTICLES: [&str; 3] = ["the ", "a ", "an "];

/// Lower-cased, article-stripped key used for `ORDER BY` on titles.
pub fn sort_key(title: &str) -> String {
    let mut key = title.trim().to_lowercase();
    for article in LEADING_ARTICLES {
        if let Some(rest) = key.strip_prefix(article) {
            key = rest.trim_start().to_string();
            break;
        }
    }
    key
}

/// Wall clock as Unix seconds. Falls back to the epoch rather than panicking.
pub fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Origin that serves book resources to the webview.
///
/// Tauri registers custom protocols at `<scheme>://localhost` on macOS, iOS and
/// Linux, but at `http://<scheme>.localhost` on Windows and Android. The Rust
/// side knows the target at compile time, so the frontend never has to guess
/// from a user agent.
pub const fn resource_origin() -> &'static str {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://fangce.localhost"
    } else {
        "fangce://localhost"
    }
}

/// Absolute URL for a book's cover, valid only when the book has one.
pub fn cover_url(book_id: &str) -> String {
    format!("{}/cover/{book_id}", resource_origin())
}

/// Absolute URL for a generated character portrait.
///
/// The name is slugged here as well as on the way in, so the URL a command hands
/// back is exactly the one the protocol resolves — a reader that pasted a name
/// with a slash in it would otherwise get a 404 from its own picture.
pub fn portrait_url(book_id: &str, name: &str) -> String {
    format!("{}/portrait/{book_id}/{}", resource_origin(), crate::ai::image::slug(name))
}

/// Absolute URL for an imported font's bytes.
///
/// Built here rather than in the renderer for the same reason as the cover URL:
/// the origin differs by platform and only this side knows the target.
pub fn font_url(id: &str) -> String {
    format!("{}/font/{id}", resource_origin())
}

/// Absolute URL for a book's source file, streamed by the reader over HTTP
/// Range requests so opening never transfers the whole file.
pub fn book_url(book_id: &str) -> String {
    format!("{}/book/{book_id}", resource_origin())
}

/// Deletes a book row and its files.
///
/// The row is authoritative: once it is gone the book is gone even if unlinking
/// a file fails, because leaving an orphan row would resurrect it on next boot.
pub fn delete_book(library: &Library, id: &str) -> AppResult<()> {
    let files = library.with(|conn| repository::delete(conn, id))?;
    for path in [files.book, files.cover].into_iter().flatten() {
        unlink_one(&path);
    }
    Ok(())
}

/// Deletes a batch of books in one transaction, then unlinks their files.
///
/// The shelf's batch bar can hand over every selected id at once; one
/// `delete_book` per id was one transaction per book, and the frontend
/// invalidated its whole book list once per book on top of that. Files are
/// unlinked only after the commit, so a batch that fails leaves neither a row
/// without its file nor a file without its row.
///
/// `on_progress` fires once per book, as its rows go — the same contract
/// `import_files` has, and the reason a fifty-book batch is a counter rather
/// than a frozen shelf. It fires inside the transaction, so every id is
/// checked first ([`repository::ensure_existing`]): the batch is all or
/// nothing, and a count shown for books a rollback is about to keep is a lie
/// the shelf would then have to take back.
pub fn delete_books(
    library: &Library,
    ids: &[String],
    on_progress: &mut dyn FnMut(usize, usize, &str),
) -> AppResult<()> {
    library.with(|conn| repository::ensure_existing(conn, ids))?;
    let files = library.with_tx(|tx| repository::delete_many(tx, ids, on_progress))?;
    unlink_all(files);
    Ok(())
}

/// Removes the files a batch of deleted books owned. A failure here is logged
/// rather than raised: the rows are already gone, and an orphan file is not
/// worth failing the delete over.
///
/// The unlink itself is parallel, because a batch is many files and the syscall
/// is I/O: two hundred sequential unlinks on a slow or network volume are
/// seconds of wall clock spent watching a counter that has finished counting.
/// Below a handful of files the threads cost more than they save, so small
/// batches stay on the calling thread.
fn unlink_all(sets: Vec<repository::DeletedFiles>) {
    let paths: Vec<PathBuf> =
        sets.into_iter().flat_map(|set| [set.book, set.cover].into_iter().flatten()).collect();
    if paths.len() < 8 {
        for path in &paths {
            unlink_one(path);
        }
        return;
    }
    let workers = std::thread::available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(1)
        .min(8)
        .min(paths.len());
    let chunk = paths.len().div_ceil(workers);
    std::thread::scope(|scope| {
        for slice in paths.chunks(chunk) {
            scope.spawn(move || {
                for path in slice {
                    unlink_one(path);
                }
            });
        }
    });
}

fn unlink_one(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        tracing::warn!(path = %path.display(), error = %err, "删除书籍文件失败");
    }
}

/// Absolute cover path for `id`, used by the resource protocol.
pub fn cover_file(library: &Library, id: &str) -> AppResult<Option<PathBuf>> {
    library.with(|conn| repository::cover_path(conn, id))
}

/// Paths of the book and cover files for `id`, without deleting anything.
pub fn book_files(library: &Library, id: &str) -> AppResult<(Option<PathBuf>, Option<PathBuf>)> {
    library.with(|conn| {
        let (book, cover): (String, Option<String>) = conn.query_row(
            "SELECT file_path, cover_path FROM books WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((Some(PathBuf::from(book)), cover.map(PathBuf::from)))
    })
}

/// Lower-case hex. Written out because `digest`'s output array does not
/// implement `LowerHex`.
pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Inverse of [`to_hex`]; `None` for odd lengths or non-hex characters.
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::error::AppError;

    #[test]
    fn articles_are_only_stripped_at_the_start() {
        assert_eq!(sort_key("The Rust Book"), "rust book");
        assert_eq!(sort_key("Anatomy of a Book"), "anatomy of a book");
    }

    #[test]
    fn sort_keys_are_trimmed_and_lowercased() {
        assert_eq!(sort_key("  Mixed CASE  "), "mixed case");
        assert_eq!(sort_key(""), "");
    }

    #[test]
    fn cover_urls_use_the_platform_origin() {
        let url = cover_url("abc");
        assert!(url.ends_with("/cover/abc"), "{url}");
        assert!(url.starts_with(resource_origin()), "{url}");
    }

    /// A library on disk with two real books in it: the rows and the files the
    /// delete path has to take away together.
    struct Shelf {
        dir: PathBuf,
        library: Library,
    }

    impl Shelf {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let library = crate::db::Library::open(&dir).expect("open library");
            Self { dir, library }
        }

        /// One book with its source file and its cover, both really written.
        fn add(&self, id: &str) {
            let book = self.dir.join(format!("{id}.epub"));
            let cover = self.dir.join(format!("{id}.png"));
            std::fs::write(&book, b"book bytes").expect("write book");
            std::fs::write(&cover, b"cover bytes").expect("write cover");
            self.library
                .with(|conn| {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                         file_size, cover_path, added_at, updated_at) \
                         VALUES (?1, ?2, ?2, 'epub', ?3, ?4, 9, ?5, 1, 1)",
                        rusqlite::params![
                            id,
                            id,
                            format!("hash-{id}"),
                            book.to_string_lossy(),
                            cover.to_string_lossy()
                        ],
                    )
                    .map_err(Into::into)
                })
                .expect("insert book");
        }

        fn files_gone(&self, id: &str) -> bool {
            !self.dir.join(format!("{id}.epub")).exists()
                && !self.dir.join(format!("{id}.png")).exists()
        }

        fn rows_left(&self) -> i64 {
            self.library
                .with(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
                        .map_err(Into::into)
                })
                .expect("count")
        }
    }

    impl Drop for Shelf {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// The whole batch path: pre-flight, one transaction, files gone, and a
    /// count for every book as its rows went.
    #[test]
    fn deleting_a_batch_unlinks_every_file_and_counts_each_book() {
        let shelf = Shelf::new("delete-batch");
        shelf.add("b1");
        shelf.add("b2");

        let mut seen: Vec<(usize, usize)> = Vec::new();
        delete_books(&shelf.library, &["b1".into(), "b2".into()], &mut |done, total, _| {
            seen.push((done, total));
        })
        .expect("delete batch");

        assert_eq!(seen, [(1, 2), (2, 2)]);
        assert!(shelf.files_gone("b1"));
        assert!(shelf.files_gone("b2"));
        assert_eq!(shelf.rows_left(), 0);
    }

    /// The pre-flight's whole point, pinned: a stale id fails the batch before
    /// the transaction starts, so nothing was reported as deleted that is about
    /// to be rolled back — and nothing was deleted at all.
    #[test]
    fn a_batch_with_a_stale_id_reports_nothing_and_deletes_nothing() {
        let shelf = Shelf::new("delete-stale");
        shelf.add("b1");
        shelf.add("b2");

        let mut seen: Vec<(usize, usize)> = Vec::new();
        let outcome = delete_books(
            &shelf.library,
            &["b1".into(), "ghost".into(), "b2".into()],
            &mut |done, total, _| seen.push((done, total)),
        );

        assert!(matches!(outcome, Err(AppError::NotFound(_))));
        assert!(seen.is_empty(), "预检必须先失败：进度一条都不该发出来");
        assert!(!shelf.files_gone("b1"), "整批回滚，文件必须还在");
        assert!(!shelf.files_gone("b2"), "整批回滚，文件必须还在");
        assert_eq!(shelf.rows_left(), 2);
    }

    /// The parallel unlink, on a batch past the sequential threshold: every
    /// file goes, whatever order the workers take them in.
    #[test]
    fn a_large_batch_unlinks_every_file_in_parallel() {
        let shelf = Shelf::new("delete-parallel");
        let ids: Vec<String> = (0..12).map(|i| format!("b{i}")).collect();
        for id in &ids {
            shelf.add(id);
        }

        delete_books(&shelf.library, &ids, &mut |_, _, _| {}).expect("delete batch");

        for id in &ids {
            assert!(shelf.files_gone(id), "{id} 的文件必须被删掉");
        }
        assert_eq!(shelf.rows_left(), 0);
    }
}
