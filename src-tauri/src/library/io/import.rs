//! The import pipeline: hash, dedupe, copy, extract cover, record.
//!
//! One failure never aborts the batch. Each file reports its own outcome so the
//! UI can say "3 imported, 1 duplicate, 1 failed" instead of losing the run.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::{Layout, Library};
use crate::document::{self, BookFormat, detect_format};
use crate::error::{AppError, AppResult};
use crate::library::pack;
use crate::library::repository::{self, NewBook};

/// What happened to one file in the batch.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportOutcome {
    Imported {
        path: String,
        id: String,
        title: String,
    },
    /// The same bytes are already on the shelf.
    Duplicate {
        path: String,
        id: String,
        title: String,
    },
    Failed {
        path: String,
        message: String,
    },
}

impl ImportOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, ImportOutcome::Imported { .. } | ImportOutcome::Duplicate { .. })
    }
}

/// How many files are imported at once.
///
/// Each file is hashed, parsed and copied — three operations that spend most of
/// their time waiting on the disk or on one core, and that share nothing. Doing
/// them one file after another leaves the other cores idle for the whole batch;
/// this is the same pool size readest uses. Measured on a four-book batch
/// (14.8 M characters): 447 ms one file at a time, 182 ms with the pool — the
/// slowest single book is what the batch now costs, which is where it flattens.
/// The bench that produced those numbers is in `library/bench.rs`.
///
/// The writes do *not* overlap: `Library` owns one connection behind a mutex, so
/// the transactions queue up. That is deliberate — the point of the pool is the
/// parsing and the copying, and a second writer would only buy `SQLITE_BUSY`.
const IMPORT_CONCURRENCY: usize = 4;

/// Imports every path, reporting progress as each file finishes.
///
/// `password` is only consulted by `.ctzx` packs; every other format ignores
/// it, so a mixed batch works with one prompt.
///
/// Outcomes come back in the order the paths were given, whatever order the
/// workers finished in — the summary the UI draws counts them, and the progress
/// counter is the only thing that is allowed to be out of order.
pub fn import_files(
    library: &Library,
    layout: &Layout,
    paths: &[PathBuf],
    password: Option<&str>,
    on_progress: &(dyn Fn(usize, usize, &str) + Sync),
) -> Vec<ImportOutcome> {
    let total = paths.len();
    if total == 0 {
        return Vec::new();
    }
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let finished: Mutex<Vec<(usize, ImportOutcome)>> = Mutex::new(Vec::with_capacity(total));

    std::thread::scope(|scope| {
        for _ in 0..IMPORT_CONCURRENCY.min(total) {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else { break };
                    let outcome = match guarded(|| import_one(library, layout, path, password)) {
                        Ok(result) => result,
                        Err(err) => {
                            tracing::warn!(file = %path.display(), error = %err, "导入失败");
                            ImportOutcome::Failed {
                                path: path.to_string_lossy().to_string(),
                                message: err.to_string(),
                            }
                        }
                    };
                    // The book's transaction has committed by now, so a shelf
                    // refetch this event triggers will see it. The counter is
                    // the only number that crosses threads, and it is shared by
                    // every worker on purpose: what it must report is "how many
                    // are done", not "which one this was".
                    {
                        let mut finished = finished.lock().unwrap_or_else(|err| err.into_inner());
                        finished.push((index, outcome));
                    }
                    let count = done.fetch_add(1, Ordering::Relaxed) + 1;
                    on_progress(count, total, &path.to_string_lossy());
                }
            });
        }
    });

    let mut finished = finished.into_inner().unwrap_or_else(|err| err.into_inner());
    finished.sort_by_key(|(index, _)| *index);
    finished.into_iter().map(|(_, outcome)| outcome).collect()
}

/// Runs one file's pipeline with a panic turned into that file's failure.
///
/// Everything below here parses bytes the reader handed us: a mobi's
/// HUFF-CDIC tables, a zip central directory, the font tables inside a PDF, a
/// dictionary bundle. One out-of-range index in any of them is a panic, and in
/// a release build — where `panic = "unwind"` is what makes this answer
/// possible at all (see the `compile_error!` in `document/pdf.rs`) — a panic
/// that reaches the runtime takes the whole application with it. That is not
/// hypothetical: a Chinese PDF whose Type0 font declares an encoding
/// pdf-extract does not know took the app down on 2026-10-11.
///
/// The guard sits here, at the boundary, rather than in each parser: one
/// wrapper covers all seven formats and anything added later, where seven
/// copies are seven chances to forget one. The parsers keep returning
/// `Result` for the failures they can describe; this is only for the ones they
/// cannot.
fn guarded<T>(run: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(result) => result,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned());
            // The reason goes to the log, where a developer will look; the
            // reader gets a sentence that says what happened and what to try.
            tracing::error!(panic = ?detail, "导入时解析器 panic，已降级为该文件失败");
            Err(AppError::Parse("解析这个文件时出了内部错误，已跳过。换一个版本再试。".into()))
        }
    }
}

/// Successful result of importing a single file.
enum Imported {
    Created(String, String),
    AlreadyPresent(String, String),
}

impl Imported {
    fn id(&self) -> &str {
        match self {
            Imported::Created(id, _) | Imported::AlreadyPresent(id, _) => id,
        }
    }
}

fn import_one(
    library: &Library,
    layout: &Layout,
    path: &Path,
    password: Option<&str>,
) -> AppResult<ImportOutcome> {
    let path_text = path.to_string_lossy().to_string();
    let outcome = if pack::is_pack(path) {
        import_pack(library, layout, path, password)?
    } else {
        import_book(library, layout, path)?
    };
    Ok(match outcome {
        Imported::Created(id, title) => ImportOutcome::Imported { path: path_text, id, title },
        Imported::AlreadyPresent(id, title) => {
            ImportOutcome::Duplicate { path: path_text, id, title }
        }
    })
}

/// Unpacks a book pack, then runs the ordinary pipeline on what was inside.
///
/// The source is staged inside the library's own book directory rather than in
/// a system temp folder: the pipeline hashes, parses and copies from a path, so
/// a staging file keeps all three untouched and stays on the same filesystem.
fn import_pack(
    library: &Library,
    layout: &Layout,
    path: &Path,
    password: Option<&str>,
) -> AppResult<Imported> {
    let unpacked = pack::unpack(path, password)?;
    let staged =
        layout.books_dir.join(format!("unpack-{}.{}", uuid::Uuid::new_v4(), unpacked.source_ext));
    std::fs::write(&staged, &unpacked.source)?;

    let outcome = import_book(library, layout, &staged);
    // The pipeline has copied what it needs; the staging copy is always ours
    // to remove, on the happy path and on every failure.
    if let Err(err) = std::fs::remove_file(&staged) {
        tracing::warn!(path = %staged.display(), error = %err, "清理解包临时文件失败");
    }

    let imported = outcome?;
    if let Some(reading) = &unpacked.reading {
        library.with_tx(|tx| pack::apply_reading(tx, imported.id(), reading))?;
    }
    Ok(imported)
}

fn import_book(library: &Library, layout: &Layout, path: &Path) -> AppResult<Imported> {
    let format = detect_format(path)?;
    let hash = sha256_file(path)?;

    // Cheap pre-check so the common case (re-importing the same file) never
    // touches the disk. The chapters are still re-extracted: they are derived
    // data, and a parser fix (e.g. keeping images) must reach old books when
    // the user re-imports the same file.
    if let Some((id, title)) = library.with(|conn| repository::find_by_hash(conn, &hash))? {
        // A trashed book still owns its `content_hash`, so re-importing the same
        // file has to bring it back: the UNIQUE index would refuse a second row,
        // and answering 「已在书架上」 about a book the shelf is not showing would
        // be a lie. Restoring keeps the highlights and the position that made
        // the trash worth having.
        library.with(|conn| repository::restore(conn, &id))?;
        if format == BookFormat::Pdf {
            // The same deferral as the fresh-import path below, for the same
            // reason: re-extracting here would put the 974 ms back on the
            // re-import. Marking it pending reaches the same place — the
            // background pass replaces the text, so a parser fix still lands.
            library.with(|conn| repository::set_chapters_pending(conn, &id, true))?;
        } else {
            match document::read_chapters(path, format) {
                Ok(raw) => {
                    library.with_tx(|tx| crate::library::chapters::replace(tx, &id, &raw))?
                }
                Err(err) => {
                    tracing::warn!(path = %path.display(), error = %err, "重复导入时刷新章节失败");
                }
            }
        }
        // The format label is derived data too, and for the same reason: a
        // book imported before `.azw3` was named separately sits on the shelf
        // as MOBI, and re-importing the file is the only way the user has to
        // fix it. Cheap enough to do on every duplicate.
        library.with(|conn| repository::set_format(conn, &id, format))?;
        return Ok(Imported::AlreadyPresent(id, title));
    }

    let metadata = document::read_metadata(path, format)?;
    let file_size = i64::try_from(fs::metadata(path)?.len()).unwrap_or(i64::MAX);
    let id = uuid::Uuid::new_v4().to_string();

    // A PDF's chapter index *is* its page count, and the metadata parse above
    // already had the document open, so the index costs nothing. Its text is
    // the opposite: one full per-page decode, 98% of the whole import path
    // (measured — 974 ms of 2.1 s on a 756-page / 21 MB file), for something
    // nothing on the shelf reads yet. The reader paints pages with pdf.js;
    // only search, TTS and the assistant want the words. So the index goes in
    // now, `chapters_pending` records that the text is owed, and
    // `chapters::backfill` pays it after the import has answered.
    let deferred = format == BookFormat::Pdf;
    let chapters = if deferred {
        document::pdf::page_index(metadata.page_count.unwrap_or(0))
    } else {
        // Chapter extraction is best-effort: a book can sit on the shelf even
        // if the spine is empty, and the reader will re-attempt lazily.
        document::read_chapters(path, format).unwrap_or_else(|err| {
            tracing::warn!(path = %path.display(), error = %err, "章节提取失败，将以空章节入库");
            Vec::new()
        })
    };

    // Files are copied into the library directory so deleting or moving the
    // original never breaks the shelf.
    let stored = layout.books_dir.join(format!("{id}.{}", format.extension()));
    fs::copy(path, &stored)?;

    let cover_path = match &metadata.cover {
        Some(cover) => {
            let target = layout
                .covers_dir
                .join(format!("{id}.{}", document::safe_image_extension(&cover.extension)));
            fs::write(&target, &cover.bytes)?;
            Some(target)
        }
        None => None,
    };

    let stored_text = stored.to_string_lossy().to_string();
    let cover_text = cover_path.as_ref().map(|path| path.to_string_lossy().to_string());

    let inserted = library.with_tx(|tx| {
        repository::insert(
            tx,
            &NewBook {
                id: &id,
                title: &metadata.title,
                subtitle: metadata.subtitle.as_deref(),
                description: metadata.description.as_deref(),
                language: metadata.language.as_deref(),
                publisher: metadata.publisher.as_deref(),
                identifier: metadata.identifier.as_deref(),
                format,
                content_hash: &hash,
                file_path: &stored_text,
                file_size,
                cover_path: cover_text.as_deref(),
                authors: &metadata.authors,
            },
        )?;
        crate::library::chapters::insert(tx, &id, &chapters)?;
        if deferred {
            repository::set_chapters_pending(tx, &id, true)?;
        }
        Ok(())
    });

    match inserted {
        Ok(()) => Ok(Imported::Created(id, metadata.title)),
        Err(err) => {
            cleanup(&stored, cover_path.as_deref());
            // A concurrent import may have won the race; the UNIQUE constraint
            // on content_hash decides either way.
            if is_unique_violation(&err)
                && let Some((existing, title)) =
                    library.with(|conn| repository::find_by_hash(conn, &hash))?
            {
                // Same reason as the pre-check above: the row that won the race
                // may be sitting in the trash.
                library.with(|conn| repository::restore(conn, &existing))?;
                return Ok(Imported::AlreadyPresent(existing, title));
            }
            Err(err)
        }
    }
}

fn cleanup(book: &Path, cover: Option<&Path>) {
    if let Err(err) = fs::remove_file(book) {
        tracing::warn!(path = %book.display(), error = %err, "清理已复制的书籍文件失败");
    }
    if let Some(cover) = cover
        && let Err(err) = fs::remove_file(cover)
    {
        tracing::warn!(path = %cover.display(), error = %err, "清理已提取的封面失败");
    }
}

fn is_unique_violation(error: &AppError) -> bool {
    matches!(error, AppError::Database(rusqlite::Error::SqliteFailure(_, Some(message)))
        if message.contains("UNIQUE"))
}

/// Streams the file through SHA-256; books are far too large to hash in memory.
fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(crate::library::to_hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::repository::{BookQuery, LibraryFilter, LibrarySort};

    struct Harness {
        dir: PathBuf,
        layout: Layout,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, layout, library }
        }

        fn import(&self, paths: &[PathBuf]) -> Vec<ImportOutcome> {
            import_files(&self.library, &self.layout, paths, None, &|_, _, _| {})
        }

        fn shelve(&self) -> Vec<repository::BookSummary> {
            self.library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list")
        }

        fn chapters(&self, id: &str) -> Vec<crate::library::chapters::ChapterMeta> {
            self.library.with(|conn| crate::library::chapters::list(conn, id)).expect("chapters")
        }

        /// Whether the book still owes its chapter text.
        fn pending(&self, id: &str) -> bool {
            self.library.with(|conn| repository::chapters_pending(conn, id)).expect("flag")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn opf() -> String {
        fixture::full_opf("三体", "刘慈欣")
    }

    fn epub(dir: &Path, name: &str, title: &str) -> PathBuf {
        fixture::write_epub(
            dir,
            name,
            &fixture::full_opf(title, "刘慈欣"),
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        )
    }

    /// A real, parseable PDF of `pages.len()` pages.
    fn pdf(dir: &Path, name: &str, pages: &[&str]) -> PathBuf {
        fixture::write_pdf(dir, name, pages, Some("规范"))
    }

    /// Synthetic MOBI bytes. The same bytes can be handed over under either
    /// Kindle extension, which is what makes the re-label path testable.
    fn mobi_bytes(title: &str) -> Vec<u8> {
        crate::document::mobi::synth::book_bytes(
            title,
            "某作者",
            "<html><body><h1>第一章</h1><p>第一段</p></body></html>",
        )
    }

    #[test]
    fn an_epub_lands_on_the_shelf_with_metadata_and_cover() {
        let harness = Harness::new("import-epub");
        let source = epub(&harness.dir, "source.epub", "三体");

        let outcomes = harness.import(&[source]);
        let imported = match &outcomes[0] {
            ImportOutcome::Imported { id, title, .. } => (id.clone(), title.clone()),
            other => panic!("期望导入成功，实际 {other:?}"),
        };
        assert_eq!(imported.1, "三体");

        let books = harness.shelve();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title, "三体");
        assert_eq!(books[0].authors, ["刘慈欣"]);
        assert_eq!(books[0].format, crate::document::BookFormat::Epub);
        // The URL carries the row's version, so a cover replaced later is a
        // URL the webview has not cached.
        assert_eq!(
            books[0].cover_url.as_deref(),
            Some(crate::library::cover_url(&imported.0, books[0].updated_at).as_str())
        );

        // The cover bytes must be on disk, not just referenced.
        let (_, cover) = crate::library::book_files(&harness.library, &imported.0).expect("files");
        let cover = cover.expect("封面文件必须存在");
        assert_eq!(std::fs::read(cover).expect("read"), fixture::png_bytes());
    }

    #[test]
    fn the_original_file_is_copied_into_the_library_directory() {
        let harness = Harness::new("import-copy");
        let source = epub(&harness.dir, "source.epub", "三体");
        harness.import(std::slice::from_ref(&source));

        let books = harness.shelve();
        let (stored, _) =
            crate::library::book_files(&harness.library, &books[0].id).expect("files");
        let stored = stored.expect("书籍文件必须存在");
        assert!(stored.starts_with(&harness.layout.books_dir));
        assert_ne!(stored, source, "必须复制而不是原地引用");
    }

    #[test]
    fn importing_the_same_bytes_twice_is_reported_as_a_duplicate() {
        let harness = Harness::new("import-dupe");
        let first = epub(&harness.dir, "a.epub", "三体");
        let second = epub(&harness.dir, "b.epub", "三体");

        harness.import(&[first]);
        let outcomes = harness.import(&[second]);

        assert!(matches!(&outcomes[0], ImportOutcome::Duplicate { .. }), "{:?}", outcomes[0]);
        assert_eq!(harness.shelve().len(), 1, "重复导入不得产生第二行记录");
    }

    #[test]
    fn the_same_bytes_twice_in_one_batch_still_lands_once() {
        // The race the import pool opens. Two workers hash the same file at the
        // same time, both miss `find_by_hash`, and only the UNIQUE index on
        // `content_hash` decides — so the loser has to answer "duplicate", not
        // "failed", and has to take the copy it already made with it.
        let harness = Harness::new("import-dupe-batch");
        let first = epub(&harness.dir, "a.epub", "三体");
        let second = epub(&harness.dir, "b.epub", "三体");

        let outcomes = harness.import(&[first, second]);
        assert_eq!(outcomes.len(), 2);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ImportOutcome::Imported { .. }))
                .count(),
            1,
            "{outcomes:?}"
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, ImportOutcome::Duplicate { .. }))
                .count(),
            1,
            "{outcomes:?}"
        );
        assert_eq!(harness.shelve().len(), 1, "同一份字节不得产生两行记录");
        assert_eq!(
            std::fs::read_dir(&harness.layout.books_dir).expect("read").count(),
            1,
            "落败的那一次必须清掉自己复制的文件"
        );
    }

    #[test]
    fn every_kindle_extension_is_shelved_under_its_own_name() {
        // One container, one parser, four names. The bytes are identical in
        // every case — only the extension differs — so this pins exactly the
        // property the split is for: the label follows the file's name, and
        // nothing downstream of `from_path` is allowed to notice.
        for (ext, format) in [
            ("mobi", crate::document::BookFormat::Mobi),
            ("azw", crate::document::BookFormat::Azw),
            ("azw3", crate::document::BookFormat::Azw3),
            ("prc", crate::document::BookFormat::Prc),
        ] {
            let harness = Harness::new(&format!("import-{ext}"));
            let source = harness.dir.join(format!("source.{ext}"));
            std::fs::write(&source, mobi_bytes("长日将尽")).expect("write");

            let outcomes = harness.import(&[source]);
            assert!(outcomes[0].is_success(), "{ext}: {:?}", outcomes[0]);

            let books = harness.shelve();
            assert_eq!(books.len(), 1, "{ext}");
            assert_eq!(books[0].title, "长日将尽", "{ext}");
            // The shelf card prints `format.to_uppercase()`, so this value is
            // the string a reader actually sees.
            assert_eq!(books[0].format, format, "{ext} 的货架标签");

            let (stored, _) =
                crate::library::book_files(&harness.library, &books[0].id).expect("files");
            let stored = stored.expect("书籍文件必须存在");
            assert_eq!(
                stored.extension().and_then(|e| e.to_str()),
                Some(ext),
                "{ext} 的落盘扩展名"
            );
        }
    }

    #[test]
    fn re_importing_the_same_bytes_under_a_new_extension_relabels_the_book() {
        // The same bytes, so the pipeline reports a duplicate and keeps the copy
        // it already has — but the label follows the name it was handed this
        // time. A book imported before these extensions had labels of their own
        // has to be able to catch up without being deleted, since deleting it
        // takes the reading progress and every highlight with it.
        let bytes = mobi_bytes("长日将尽");

        for (ext, format) in [
            ("azw", crate::document::BookFormat::Azw),
            ("azw3", crate::document::BookFormat::Azw3),
            ("prc", crate::document::BookFormat::Prc),
        ] {
            let harness = Harness::new(&format!("import-relabel-{ext}"));
            let as_mobi = harness.dir.join("source.mobi");
            let renamed = harness.dir.join(format!("source.{ext}"));
            std::fs::write(&as_mobi, &bytes).expect("write");
            std::fs::write(&renamed, &bytes).expect("write");

            harness.import(&[as_mobi]);
            assert_eq!(
                harness.shelve()[0].format,
                crate::document::BookFormat::Mobi,
                "{ext}：先按 .mobi 导入"
            );

            let outcomes = harness.import(&[renamed]);
            assert!(
                matches!(&outcomes[0], ImportOutcome::Duplicate { .. }),
                "{ext}: {:?}",
                outcomes[0]
            );

            let books = harness.shelve();
            assert_eq!(books.len(), 1, "{ext}：重新导入不得产生第二行记录");
            assert_eq!(books[0].format, format, "{ext}：重贴标签后的格式");
        }
    }

    #[test]
    fn a_different_file_with_the_same_title_is_a_separate_book() {
        let harness = Harness::new("import-same-title");
        let a = epub(&harness.dir, "a.epub", "三体");
        // Same title, different bytes: the hash distinguishes them.
        let b = {
            let mut opf = opf();
            opf.push_str("<!-- different -->");
            fixture::write_epub(&harness.dir, "b.epub", &opf, &[])
        };

        let outcomes = harness.import(&[a, b]);
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.iter().all(ImportOutcome::is_success), "{outcomes:?}");
        assert_eq!(harness.shelve().len(), 2);
    }

    #[test]
    fn a_pdf_lands_with_its_page_index_and_owes_its_text() {
        // The regression this guards. Importing a PDF used to decode every
        // page's content stream before the shelf heard about it — measured at
        // 974 ms of a 2.1 s import for a 756-page file, 98% of the whole path.
        // The index is all the reader needs to page through the book, so that
        // is what the import stores; the words are owed, and paid after.
        let harness = Harness::new("import-pdf-defer");
        let source = pdf(&harness.dir, "book.pdf", &["Text of page one", "Text of page two"]);

        let outcomes = harness.import(&[source]);
        let id = match &outcomes[0] {
            ImportOutcome::Imported { id, .. } => id.clone(),
            other => panic!("期望导入成功，实际 {other:?}"),
        };

        // The index is exact — one numbered chapter per page — and empty.
        let index = harness.chapters(&id);
        assert_eq!(index.len(), 2, "{index:?}");
        assert_eq!(index[0].title, "第 1 页");
        assert!(index.iter().all(|chapter| chapter.chars == 0), "导入期不得抽正文：{index:?}");
        assert!(harness.pending(&id), "PDF 导入后必须标记待补正文");

        // `ensure_text` is the path the search index takes, and it is the one
        // that has to heal a book whose background pass never ran.
        let meta = crate::library::chapters::ensure_text(&harness.library, &id).expect("ensure");
        assert_eq!(meta.len(), 2);
        assert!(meta.iter().all(|chapter| chapter.chars > 0), "{meta:?}");
        assert!(!harness.pending(&id), "补完正文必须清掉标记");

        let body = harness
            .library
            .with(|conn| crate::library::chapters::content(conn, &id, 0))
            .expect("content")
            .expect("some");
        assert!(
            body.paragraphs.iter().any(|line| line.contains("page one")),
            "{:?}",
            body.paragraphs
        );
    }

    #[test]
    fn backfilling_a_deferred_pdf_fills_the_index_in_place() {
        // The path the importer's background task takes, without `ensure` in
        // front of it: same rows, same numbering, text added.
        let harness = Harness::new("import-pdf-backfill");
        let source = pdf(&harness.dir, "book.pdf", &["Alpha", "Beta"]);
        let outcomes = harness.import(&[source]);
        let ImportOutcome::Imported { id, .. } = &outcomes[0] else {
            panic!("期望导入成功，实际 {:?}", outcomes[0]);
        };

        crate::library::chapters::backfill(&harness.library, id).expect("backfill");

        let index = harness.chapters(id);
        assert_eq!(index.len(), 2, "{index:?}");
        assert_eq!(index[0].title, "第 1 页", "补齐正文不得改动页码");
        assert!(index.iter().all(|chapter| chapter.chars > 0), "{index:?}");
        assert!(!harness.pending(id));

        // Running it twice must not duplicate rows.
        crate::library::chapters::backfill(&harness.library, id).expect("backfill again");
        assert_eq!(harness.chapters(id).len(), 2);
    }

    #[test]
    fn re_importing_a_pdf_asks_for_its_text_again() {
        // A parser fix has to reach books already on the shelf, and for a
        // deferred book that means asking for the text once more — the re-import
        // itself stays cheap.
        let harness = Harness::new("import-pdf-reimport");
        let source = pdf(&harness.dir, "book.pdf", &["Alpha"]);
        let outcomes = harness.import(&[source]);
        let ImportOutcome::Imported { id, .. } = &outcomes[0] else {
            panic!("期望导入成功，实际 {:?}", outcomes[0]);
        };
        crate::library::chapters::backfill(&harness.library, id).expect("backfill");
        assert!(!harness.pending(id));

        let again = harness.import(&[harness.dir.join("book.pdf")]);
        assert!(matches!(&again[0], ImportOutcome::Duplicate { .. }), "{:?}", again[0]);
        assert!(harness.pending(id), "重复导入 PDF 必须重新排队补正文");
        assert_eq!(harness.shelve().len(), 1);
    }

    #[test]
    fn the_readers_toc_does_not_pay_the_debt() {
        // The regression. `ensure` once ran `backfill`, so opening a freshly
        // imported PDF did the whole 974 ms extraction in front of "正在打开…"
        // — the import delay moved one click later rather than removed, and
        // the reader got slower the moment the import got faster.
        //
        // The TOC is the page index and nothing else. A deferred book's index
        // is already complete, so `ensure` must answer from the rows it has.
        let harness = Harness::new("import-pdf-toc-cheap");
        let source = pdf(&harness.dir, "book.pdf", &["Alpha", "Beta"]);
        let outcomes = harness.import(&[source]);
        let ImportOutcome::Imported { id, .. } = &outcomes[0] else {
            panic!("期望导入成功，实际 {:?}", outcomes[0]);
        };
        assert!(harness.pending(id), "前提：导入确实把正文欠着");

        let meta = crate::library::chapters::ensure(&harness.library, id).expect("ensure");
        assert_eq!(meta.len(), 2, "目录照样是完整的：{meta:?}");
        assert!(harness.pending(id), "读目录不许顺手补正文 —— 那会把整次抽取挡在打开之前");

        // The chapter read is still the one that pays it.
        crate::library::chapters::content_ready(&harness.library, id, 0)
            .expect("chapter")
            .expect("some");
        assert!(!harness.pending(id));
    }

    #[test]
    fn reading_a_chapter_pays_the_debt_before_serving_it() {
        // The race this guards. The reader asks for the TOC and the current
        // chapter *in parallel*, and the chapter read is the faster of the two
        // — so it arrives while the text is still owed. Handing it the empty
        // index would give the reader a blank body it caches for a minute:
        // nothing for TTS to read, and a highlight made in the meantime
        // anchored at offset 0, which is a wrong position rather than a
        // missing one. The chapter read is where the debt gets paid.
        let harness = Harness::new("import-pdf-chapter-ready");
        let source = pdf(&harness.dir, "book.pdf", &["Alpha", "Beta"]);
        let outcomes = harness.import(&[source]);
        let ImportOutcome::Imported { id, .. } = &outcomes[0] else {
            panic!("期望导入成功，实际 {:?}", outcomes[0]);
        };
        assert!(harness.pending(id), "前提：导入确实把正文欠着");

        // No `ensure`, no `backfill` — straight at the chapter, as the reader does.
        let body = crate::library::chapters::content_ready(&harness.library, id, 0)
            .expect("chapter")
            .expect("some");
        assert!(
            body.paragraphs.iter().any(|line| line.contains("Alpha")),
            "读章节必须先还清正文：{:?}",
            body.paragraphs
        );
        assert!(!harness.pending(id), "还清了就得把标记清掉");

        // An index that has no such page is still `None` — paying the debt must
        // not invent rows.
        assert!(
            crate::library::chapters::content_ready(&harness.library, id, 99)
                .expect("chapter")
                .is_none()
        );
    }

    #[test]
    fn an_epub_still_extracts_its_chapters_at_import() {
        // The deferral is PDF-only on purpose: every other format's renderer
        // reads the extracted text, so there would be nothing to show.
        let harness = Harness::new("import-epub-eager");
        let source = fixture::write_epub(
            &harness.dir,
            "source.epub",
            &fixture::full_opf("三体", "刘慈欣"),
            &[
                ("OEBPS/images/cover.png", &fixture::png_bytes()),
                (
                    "OEBPS/text/ch1.xhtml",
                    "<html><body><h1>Chapter One</h1><p>Body text.</p></body></html>".as_bytes(),
                ),
            ],
        );
        let outcomes = harness.import(&[source]);
        let ImportOutcome::Imported { id, .. } = &outcomes[0] else {
            panic!("期望导入成功，实际 {:?}", outcomes[0]);
        };

        assert!(harness.chapters(id).iter().any(|chapter| chapter.chars > 0));
        assert!(!harness.pending(id), "非 PDF 不该被标记待补");
    }

    #[test]
    fn a_comic_archive_lands_with_one_chapter_per_page() {
        let harness = Harness::new("import-cbz");
        let bytes = fixture::png_bytes();
        let source = fixture::write_zip(
            &harness.dir,
            "book.cbz",
            &[("002.png", &bytes), ("001.png", &bytes), ("003.png", &bytes)],
        );

        let outcomes = harness.import(&[source]);
        assert!(matches!(&outcomes[0], ImportOutcome::Imported { .. }), "{:?}", outcomes[0]);

        let books = harness.shelve();
        assert_eq!(books[0].format, crate::document::BookFormat::Cbz);
        // No metadata block in a CBZ, so the file name is the title.
        assert_eq!(books[0].title, "book");
        let chapters = harness
            .library
            .with(|conn| crate::library::chapters::list(conn, &books[0].id))
            .expect("chapters");
        assert_eq!(chapters.len(), 3, "{chapters:?}");
        assert_eq!(chapters[0].title, "第 1 页");
    }

    #[test]
    fn unsupported_formats_fail_without_stopping_the_batch() {
        let harness = Harness::new("import-bad");
        let good = epub(&harness.dir, "good.epub", "三体");
        let bad = harness.dir.join("bad.doc");
        std::fs::write(&bad, b"not a book").expect("write");

        let outcomes = harness.import(&[bad, good]);
        assert!(matches!(&outcomes[0], ImportOutcome::Failed { .. }), "{:?}", outcomes[0]);
        assert!(matches!(&outcomes[1], ImportOutcome::Imported { .. }), "{:?}", outcomes[1]);
        assert_eq!(harness.shelve().len(), 1);
    }

    #[test]
    fn a_locked_pack_fails_the_file_without_stopping_the_batch() {
        let harness = Harness::new("import-locked-pack");
        let source = epub(&harness.dir, "source.epub", "三体");
        harness.import(&[source]);
        let id = harness.shelve()[0].id.clone();

        let locked = harness.dir.join("locked.ctzx");
        pack::export(&harness.library, &id, &locked, Some("pw")).expect("export");

        let outcomes = harness.import(&[locked]);
        let ImportOutcome::Failed { message, .. } = &outcomes[0] else {
            panic!("缺少密码必须报失败，实际 {:?}", outcomes[0]);
        };
        assert!(message.contains("密码"), "{message}");
    }

    #[test]
    fn a_missing_file_is_reported_not_thrown() {
        let harness = Harness::new("import-missing");
        let outcomes = harness.import(&[harness.dir.join("nope.epub")]);
        assert!(matches!(&outcomes[0], ImportOutcome::Failed { .. }));
        assert!(harness.shelve().is_empty());
    }

    #[test]
    fn progress_is_reported_once_per_file() {
        let harness = Harness::new("import-progress");
        let a = epub(&harness.dir, "a.epub", "A");
        let b = epub(&harness.dir, "b.epub", "B");

        // The counter is shared by the workers, so it arrives out of order —
        // what it must not do is skip or repeat a number.
        let seen: Mutex<Vec<(usize, usize)>> = Mutex::new(Vec::new());
        import_files(&harness.library, &harness.layout, &[a, b], None, &|done, total, _| {
            seen.lock().expect("progress").push((done, total));
        });
        let mut seen = seen.into_inner().expect("progress");
        seen.sort_unstable();
        assert_eq!(seen, [(1, 2), (2, 2)]);
    }

    #[test]
    fn plain_text_books_import_using_their_file_name() {
        let harness = Harness::new("import-txt");
        let path = harness.dir.join("三体.txt");
        std::fs::write(&path, "正文内容").expect("write");

        harness.import(&[path]);
        let books = harness.shelve();
        assert_eq!(books[0].title, "三体");
        assert!(books[0].authors.is_empty());
        assert!(books[0].cover_url.is_none());
    }

    #[test]
    fn favorites_and_recent_filters_apply_after_import() {
        let harness = Harness::new("import-filter");
        let a = epub(&harness.dir, "a.epub", "A");
        harness.import(&[a]);

        let books = harness.shelve();
        let id = &books[0].id;
        harness.library.with(|conn| repository::set_favorite(conn, id, true)).expect("favorite");

        let favorites = harness
            .library
            .with(|conn| {
                repository::list(
                    conn,
                    &BookQuery { filter: LibraryFilter::Favorites, ..Default::default() },
                )
            })
            .expect("list");
        assert_eq!(favorites.len(), 1);

        let recent = harness
            .library
            .with(|conn| {
                repository::list(
                    conn,
                    &BookQuery {
                        filter: LibraryFilter::Recent,
                        sort: LibrarySort::RecentlyRead,
                        ..Default::default()
                    },
                )
            })
            .expect("list");
        assert!(recent.is_empty(), "没有读过就不该出现在最近里");
    }

    #[test]
    fn a_panicking_parser_becomes_one_failed_file() {
        // The bug this guards: a release build unwinds nothing, so a panic
        // inside any of the seven parsers ends the process — one malformed
        // book out of a batch of thirty takes the shelf with it.
        let err = guarded(|| -> AppResult<()> { panic!("模拟解析器越界") })
            .expect_err("must not panic out");
        assert!(matches!(err, AppError::Parse(_)), "{err:?}");
        // The reader gets a sentence, not a Rust panic payload.
        assert!(err.to_string().contains("内部错误"), "{err}");

        // And an ordinary failure still comes through untouched.
        let plain = guarded(|| -> AppResult<()> { Err(AppError::Parse("容器损坏".into())) })
            .expect_err("propagated");
        assert_eq!(plain.to_string(), "parse error: 容器损坏");
        let ok: usize = guarded(|| Ok(7)).expect("ordinary success");
        assert_eq!(ok, 7);
    }

    #[test]
    fn one_bad_file_does_not_cost_the_batch_the_good_ones() {
        let harness = Harness::new("import-guard-batch");
        let good = epub(&harness.dir, "good.epub", "三体");
        // Not a zip at all: whatever the parsers do with it, it cannot take
        // the file after it in the batch with it.
        let junk = harness.dir.join("junk.epub");
        std::fs::write(&junk, b"not a book").expect("write");

        let outcomes = harness.import(&[junk, good]);
        assert_eq!(outcomes.len(), 2);
        assert!(!outcomes[0].is_success(), "第一个应当失败");
        assert!(outcomes[1].is_success(), "第二个仍然要进来");
        assert_eq!(harness.shelve().len(), 1);
    }

    /// Deleting is the reversible half: the shelf stops listing the book, and
    /// the bytes stay where they are until the bin is emptied. The files are
    /// what a misclick used to cost, and the reason the delete became a move.
    #[test]
    fn deleting_a_book_keeps_its_files_until_the_bin_is_emptied() {
        let harness = Harness::new("import-delete");
        let source = epub(&harness.dir, "a.epub", "三体");
        harness.import(&[source]);

        let books = harness.shelve();
        let id = books[0].id.clone();
        let (book, cover) = crate::library::book_files(&harness.library, &id).expect("files");
        assert!(book.as_deref().map(Path::exists).unwrap_or(false));

        crate::library::delete_book(&harness.library, &id).expect("trash");

        assert!(harness.shelve().is_empty(), "书架不该再列出它");
        assert!(book.as_deref().map(Path::exists).unwrap_or(false), "回收站里的书文件必须还在");
        assert!(cover.as_deref().map(Path::exists).unwrap_or(false), "封面也必须还在");

        crate::library::purge_book(&harness.library, &id).expect("purge");

        assert!(!book.as_deref().map(Path::exists).unwrap_or(false), "彻底删除才动文件");
        assert!(!cover.as_deref().map(Path::exists).unwrap_or(false), "封面也一样");
    }

    /// The UNIQUE index on `content_hash` still belongs to a trashed book, so a
    /// re-import has to bring that row back rather than insert a second one.
    #[test]
    fn re_importing_a_trashed_book_restores_it() {
        let harness = Harness::new("import-restore");
        let first = epub(&harness.dir, "a.epub", "三体");
        let second = epub(&harness.dir, "b.epub", "三体");
        harness.import(&[first]);

        let id = harness.shelve()[0].id.clone();
        crate::library::delete_book(&harness.library, &id).expect("trash");
        assert!(harness.shelve().is_empty());

        let outcomes = harness.import(&[second]);

        assert!(matches!(&outcomes[0], ImportOutcome::Duplicate { .. }), "{:?}", outcomes[0]);
        let back = harness.shelve();
        assert_eq!(back.len(), 1, "重复导入不该多出一行");
        assert_eq!(back[0].id, id, "回来的是原来那一本，不是新的一本");
    }

    #[test]
    fn hashing_streams_without_loading_the_file() {
        let dir = fixture::temp_dir("hash");
        let path = dir.join("big.txt");
        std::fs::write(&path, vec![b'a'; 200 * 1024]).expect("write");

        let hash = sha256_file(&path).expect("hash");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, sha256_file(&path).expect("stable"), "同一内容必须得到同一哈希");
        std::fs::remove_dir_all(&dir).ok();
    }
}
