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

/// Book metadata from the outside world.
///
/// Not under `io/`: it neither reads nor writes the library, it asks somebody
/// else a question. The write, when the reader accepts an answer, is the same
/// `repository::update_metadata` every other edit uses.
pub mod duplicates;
pub mod metadata;

/// The record of what changed.
///
/// The one module that belongs to no subdirectory: every domain writes through
/// it, so filing it under `shelf/` or `io/` would say it belongs to that one.
pub mod ops;

pub use assist::{conversation, graph, guide, ocr, summary};
pub use io::{calibre, characters, clippings, export, import, pack, source};
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
///
/// 🔴 `version` is not decoration. The path is the same for every picture a
/// book ever has — replacing a cover writes a new file behind the same id — and
/// a webview that has already decoded `…/cover/<id>` will keep showing those
/// bytes. The number comes from `updated_at`, which `set_cover` bumps, so a
/// replaced cover gets a URL the browser has never seen. Without it the file on
/// disk changes and the shelf does not.
pub fn cover_url(book_id: &str, version: i64) -> String {
    format!("{}/cover/{book_id}?v={version}", resource_origin())
}

/// Moves the picture a replacement is about to take away, so 撤销 can put it
/// back.
///
/// `None` for no previous picture, and — the case that matters — for a path
/// outside the covers directory: an imported cover is the reader's own file,
/// and replacing what the shelf shows must not move it.
///
/// A rename rather than a copy: one file, not two, and the old path is free for
/// a same-format replacement that would otherwise overwrite the bytes.
///
/// One book keeps **one** previous picture (`{id}.prev.<ext>`), not a stack of
/// them: 撤销 is one step, and a copy per replacement would grow the covers
/// directory forever. Replacing twice forgets the first picture, which is the
/// honest limit of what a single undo can promise.
pub fn move_aside(
    previous: Option<&str>,
    covers_dir: &Path,
    id: &str,
) -> Option<(PathBuf, PathBuf)> {
    let old = PathBuf::from(previous?);
    if old.parent() != Some(covers_dir) || !old.exists() {
        return None;
    }
    forget_backups(covers_dir, id);
    let extension = old.extension().and_then(|value| value.to_str()).unwrap_or("jpg");
    let kept = covers_dir.join(format!("{id}.prev.{extension}"));
    std::fs::rename(&old, &kept).ok().map(|()| (old, kept))
}

/// Removes whatever `{id}.prev.*` is lying around — the picture kept for a
/// single undo, and the last thing to clean up when a book is purged.
pub fn forget_backups(covers_dir: &Path, id: &str) {
    let prefix = format!("{id}.prev.");
    let Ok(entries) = std::fs::read_dir(covers_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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

/// Moves a book to the trash.
///
/// Nothing is unlinked and nothing cascades: the row, the file, the cover, the
/// chapters, the highlights, the notes and the reading position all stay, and
/// only `deleted_at` changes. `books_live` is what makes the book disappear from
/// every read surface at once, and clearing the timestamp is the whole undo.
///
/// The file is what makes this worth doing. Deleting used to unlink the book's
/// copy immediately, so a misclick cost the notes and the position too — the
/// one thing in this app that could not be undone.
pub fn delete_book(library: &Library, id: &str) -> AppResult<()> {
    library.with(|conn| repository::trash(conn, id))
}

/// Moves a batch of books to the trash in one transaction.
///
/// The shelf's batch bar can hand over every selected id at once; one
/// `delete_book` per id was one transaction per book, and the frontend
/// invalidated its whole book list once per book on top of that.
///
/// `on_progress` fires once per book, as its row is stamped — the same contract
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
    library.with_tx(|tx| repository::trash_many(tx, ids, on_progress))
}

/// Brings books back out of the trash, in one transaction.
///
/// A restore has no progress contract and no all-or-nothing question worth
/// asking: it writes one timestamp and cannot fail on a book that exists.
pub fn restore_books(library: &Library, ids: &[String]) -> AppResult<()> {
    library.with_tx(|tx| repository::restore_many(tx, ids))
}

/// Deletes one book **and its files**, for good.
///
/// The row is authoritative: once it is gone the book is gone even if unlinking
/// a file fails, because leaving an orphan row would resurrect it on next boot.
/// Only reachable from the bin — the shelf's own delete goes to the trash.
pub fn purge_book(library: &Library, id: &str) -> AppResult<()> {
    let files = library.with(|conn| repository::purge(conn, id))?;
    for path in [files.book, files.cover].into_iter().flatten() {
        unlink_one(&path);
    }
    Ok(())
}

/// Purges a batch in one transaction, then unlinks their files.
///
/// Files are unlinked only after the commit, so a batch that fails leaves
/// neither a row without its file nor a file without its row.
pub fn purge_books(
    library: &Library,
    ids: &[String],
    on_progress: &mut dyn FnMut(usize, usize, &str),
) -> AppResult<()> {
    library.with(|conn| repository::ensure_existing(conn, ids))?;
    let files = library.with_tx(|tx| repository::purge_many(tx, ids, on_progress))?;
    unlink_all(files);
    Ok(())
}

/// Empties the bin: every trashed book and every file they own, gone.
///
/// One transaction for the rows and one unlink pass for the files, so an
/// interrupted empty leaves neither a row whose file is gone nor a file whose
/// row is.
pub fn empty_trash(library: &Library) -> AppResult<Vec<String>> {
    let (ids, files) = library.with_tx(repository::empty_trash)?;
    unlink_all(files);
    Ok(ids)
}

/// Rewrites the same two fields on a batch of books, in one transaction.
///
/// One transaction rather than one per book: the batch bar hands over a
/// selection, and a half-applied batch is a shelf where thirty books have the
/// new publisher and twenty do not — a state nobody asked for and nothing can
/// undo. `ensure_existing` first, so a stale id fails before anything is
/// written.
pub fn set_metadata_fields(
    library: &Library,
    ids: &[String],
    patch: &repository::BookFieldsPatch,
) -> AppResult<usize> {
    library.with_tx(|tx| {
        repository::ensure_existing(tx, ids)?;
        repository::update_fields_many(tx, ids, patch)
    })
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
        let url = cover_url("abc", 42);
        assert!(url.starts_with(resource_origin()), "{url}");
        assert!(url.contains("/cover/abc"), "{url}");
    }

    /// The version is what makes a replacement visible, so it has to be in the
    /// URL — and two versions of one book's cover must not collide.
    #[test]
    fn a_cover_url_carries_its_version() {
        assert_ne!(cover_url("abc", 1), cover_url("abc", 2));
        assert!(cover_url("abc", 7).ends_with("/cover/abc?v=7"));
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

        /// What the shelf and every other read surface answers for.
        fn live_rows(&self) -> i64 {
            self.library
                .with(|conn| {
                    conn.query_row("SELECT COUNT(*) FROM books_live", [], |row| row.get(0))
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

    /// Deleting is a move, not a removal: the rows, the file and the cover all
    /// stay, and only the live view stops answering for them.
    #[test]
    fn deleting_a_batch_trashes_every_book_and_counts_each_one() {
        let shelf = Shelf::new("delete-batch");
        shelf.add("b1");
        shelf.add("b2");

        let mut seen: Vec<(usize, usize)> = Vec::new();
        delete_books(&shelf.library, &["b1".into(), "b2".into()], &mut |done, total, _| {
            seen.push((done, total));
        })
        .expect("delete batch");

        assert_eq!(seen, [(1, 2), (2, 2)]);
        assert!(!shelf.files_gone("b1"), "回收站里的书文件必须还在");
        assert!(!shelf.files_gone("b2"), "回收站里的书文件必须还在");
        assert_eq!(shelf.rows_left(), 2, "行不能删，只能打时间戳");
        assert_eq!(shelf.live_rows(), 0, "书架上不该再有它们");
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
        assert_eq!(shelf.live_rows(), 2, "回滚后一本书都不该进回收站");
    }

    /// The undo: one timestamp cleared and the book is back, files and all.
    #[test]
    fn restoring_puts_the_book_back_on_the_shelf() {
        let shelf = Shelf::new("restore");
        shelf.add("b1");
        delete_book(&shelf.library, "b1").expect("trash");
        assert_eq!(shelf.live_rows(), 0);

        restore_books(&shelf.library, &["b1".into()]).expect("restore");

        assert_eq!(shelf.live_rows(), 1);
        assert!(!shelf.files_gone("b1"), "恢复的书必须还能打开");
    }

    /// The irreversible half: rows and files both go, and only here.
    #[test]
    fn purging_removes_the_row_and_both_files() {
        let shelf = Shelf::new("purge");
        shelf.add("b1");
        delete_book(&shelf.library, "b1").expect("trash");

        purge_book(&shelf.library, "b1").expect("purge");

        assert!(shelf.files_gone("b1"));
        assert_eq!(shelf.rows_left(), 0);
    }

    /// The parallel unlink, on a batch past the sequential threshold: every
    /// file goes, whatever order the workers take them in.
    #[test]
    fn a_large_purge_unlinks_every_file_in_parallel() {
        let shelf = Shelf::new("purge-parallel");
        let ids: Vec<String> = (0..12).map(|i| format!("b{i}")).collect();
        for id in &ids {
            shelf.add(id);
        }
        delete_books(&shelf.library, &ids, &mut |_, _, _| {}).expect("trash batch");

        purge_books(&shelf.library, &ids, &mut |_, _, _| {}).expect("purge batch");

        for id in &ids {
            assert!(shelf.files_gone(id), "{id} 的文件必须被删掉");
        }
        assert_eq!(shelf.rows_left(), 0);
    }

    /// Emptying the bin takes only what is in it: a live book on the shelf is
    /// not "in the trash" merely because the reader pressed the button.
    #[test]
    fn emptying_the_bin_leaves_live_books_alone() {
        let shelf = Shelf::new("empty-trash");
        shelf.add("kept");
        shelf.add("gone");
        delete_book(&shelf.library, "gone").expect("trash");

        let purged = empty_trash(&shelf.library).expect("empty");

        assert_eq!(purged, ["gone"], "清空的是回收站里那一本");
        assert_eq!(shelf.live_rows(), 1, "书架上的那本必须还在");
        assert!(shelf.files_gone("gone"));
        assert!(!shelf.files_gone("kept"), "书架上的书文件不能动");
    }
}
