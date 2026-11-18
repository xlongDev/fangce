//! Batch export: many selected books into one file.
//!
//! Four shapes, because they answer different questions. `originals` is the
//! books as they were imported; `packs` and `encrypted` are the same portable
//! book packs the single-book dialog writes, wrapped in one ZIP so a batch
//! still has one destination; `catalog` is the shelf CSV restricted to the
//! picked rows, which the settings page can import back.
//!
//! A missing source file is skipped, not fatal: one stale row must not cost the
//! other books their export. The count comes back so the caller can say so.

use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::shelf::repository;
use crate::library::{has_extension, pack, repository as books};

/// What the one destination file should contain.
#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchExportKind {
    Originals,
    Packs,
    Encrypted,
    Catalog,
}

/// What actually made it into the file.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportSummary {
    pub exported: usize,
    pub skipped: usize,
}

pub fn export(
    library: &Library,
    ids: &[String],
    dest: &Path,
    kind: BatchExportKind,
    password: Option<&str>,
    include_ai: bool,
) -> AppResult<BatchExportSummary> {
    match kind {
        BatchExportKind::Originals => originals(library, ids, dest),
        BatchExportKind::Packs => packs(library, ids, dest, false, None, include_ai),
        BatchExportKind::Encrypted => packs(library, ids, dest, true, password, include_ai),
        BatchExportKind::Catalog => catalog(library, ids, dest),
    }
}

fn catalog(library: &Library, ids: &[String], dest: &Path) -> AppResult<BatchExportSummary> {
    if !has_extension(dest, &["csv"]) {
        return Err(AppError::InvalidArgument("书单请导出为 .csv".into()));
    }
    let mut books_found = Vec::with_capacity(ids.len());
    let mut skipped = 0;
    for id in ids {
        match library.with(|conn| books::get(conn, id))? {
            Some(book) => books_found.push(book),
            None => skipped += 1,
        }
    }
    std::fs::write(dest, super::catalog::render(&books_found))?;
    Ok(BatchExportSummary { exported: books_found.len(), skipped })
}

/// One `.ctz` / `.ctzx` per book, all inside one ZIP. A pack's format is for a
/// single book, so wrapping is the only way to keep "one destination" true for
/// a batch. `Stored` again: each member is already compressed (and encrypted
/// members are random bytes), so deflating the outer archive buys nothing.
fn packs(
    library: &Library,
    ids: &[String],
    dest: &Path,
    encrypted: bool,
    password: Option<&str>,
    include_ai: bool,
) -> AppResult<BatchExportSummary> {
    if !has_extension(dest, &["zip"]) {
        return Err(AppError::InvalidArgument("书籍打包请导出为 .zip".into()));
    }
    let mut zip = ZipWriter::new(File::create(dest)?);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let (mut exported, mut skipped) = (0, 0);
    let extension = if encrypted { "ctzx" } else { "ctz" };

    for (index, id) in ids.iter().enumerate() {
        let Some(book) = library.with(|conn| books::get(conn, id))? else {
            skipped += 1;
            continue;
        };
        // Do the same preflight as `originals` before building a pack: a stale
        // file_path is one book's problem, not the whole batch's.
        let (path, _) = match library.with(|conn| repository::source(conn, id)) {
            Ok(found) => found,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !std::fs::metadata(&path).map(|meta| meta.is_file()).unwrap_or(false) {
            skipped += 1;
            continue;
        }

        let bytes = pack::archive(library, id, encrypted, password, include_ai)?;
        zip.start_file(entry_name(index + 1, &book.title, extension), options)?;
        zip.write_all(&bytes)?;
        exported += 1;
    }
    zip.finish()?;
    Ok(BatchExportSummary { exported, skipped })
}

fn originals(library: &Library, ids: &[String], dest: &Path) -> AppResult<BatchExportSummary> {
    if !has_extension(dest, &["zip"]) {
        return Err(AppError::InvalidArgument("书籍打包请导出为 .zip".into()));
    }
    let mut zip = ZipWriter::new(File::create(dest)?);
    // ponytail: the sources are already compressed; Stored avoids re-zipping a
    // 200 MB PDF. Add Deflated if massive uncompressed sources ever matter.
    // No zip64 here either: one source over 4 GB makes `finish` fail. Add
    // `large_file(true)` when a reader actually has one.
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let (mut exported, mut skipped) = (0, 0);

    for (index, id) in ids.iter().enumerate() {
        let Some(book) = library.with(|conn| books::get(conn, id))? else {
            skipped += 1;
            continue;
        };
        let (path, format) = match library.with(|conn| repository::source(conn, id)) {
            Ok(found) => found,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let mut source = match File::open(&path) {
            Ok(file) => file,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        zip.start_file(entry_name(index + 1, &book.title, format.extension()), options)?;
        // A failure here means the source broke mid-read. Unlike a missing
        // file, that would leave a truncated member in the archive, so it is
        // reported rather than counted and hidden.
        io::copy(&mut source, &mut zip)?;
        exported += 1;
    }
    zip.finish()?;
    Ok(BatchExportSummary { exported, skipped })
}

/// The index makes names unique without a dedupe map, and keeps the archive in
/// shelf order. Control characters and path separators never reach a zip entry.
fn entry_name(index: usize, title: &str, extension: &str) -> String {
    let clean: String = title
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .take(80)
        .collect();
    let clean = clean.trim();
    format!("{index:04}-{}.{extension}", if clean.is_empty() { "未命名" } else { clean })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use std::io::Read;
    use std::path::PathBuf;
    use zip::ZipArchive;

    struct Shelf {
        dir: PathBuf,
        library: Library,
    }

    impl Shelf {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, library }
        }

        fn add(&self, id: &str, title: &str) -> PathBuf {
            let path = self.dir.join(format!("{id}.epub"));
            std::fs::write(&path, format!("bytes-{id}")).expect("source bytes");
            self.library
                .with(|conn| {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, \
                         file_path, file_size, added_at, updated_at) \
                         VALUES (?1, ?2, ?2, 'epub', ?3, ?4, 9, 1700000000, 1700000000)",
                        rusqlite::params![
                            id,
                            title,
                            format!("hash-{id}"),
                            path.to_string_lossy().into_owned()
                        ],
                    )
                    .map_err(Into::into)
                })
                .expect("insert book");
            path
        }
    }

    impl Drop for Shelf {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn a_catalog_batch_writes_only_the_picked_rows() {
        let shelf = Shelf::new("batch-catalog");
        shelf.add("b1", "活着");
        shelf.add("b2", "旁边那本");
        let dest = shelf.dir.join("picked.csv");
        let ids = vec!["b1".to_string(), "gone".to_string()];

        let summary = export(&shelf.library, &ids, &dest, BatchExportKind::Catalog, None, false)
            .expect("export");

        assert_eq!(summary.exported, 1);
        assert_eq!(summary.skipped, 1);
        let text = std::fs::read_to_string(&dest).expect("read back");
        assert!(text.contains("\n活着,"), "{text}");
        assert!(!text.contains("旁边那本"), "{text}");
    }

    #[test]
    fn an_originals_batch_skips_a_missing_source_and_names_by_order() {
        let shelf = Shelf::new("batch-originals");
        shelf.add("b1", "活着");
        let missing = shelf.add("b2", "书架上还在");
        std::fs::remove_file(&missing).expect("remove source");
        let dest = shelf.dir.join("books.zip");
        let ids = vec!["b1".to_string(), "b2".to_string()];

        let summary = export(&shelf.library, &ids, &dest, BatchExportKind::Originals, None, false)
            .expect("export");

        assert_eq!(summary.exported, 1);
        assert_eq!(summary.skipped, 1);
        let mut archive = ZipArchive::new(File::open(&dest).expect("open zip")).expect("zip");
        assert_eq!(archive.len(), 1);
        let names =
            archive.file_names().map(|name| name.expect("name").to_string()).collect::<Vec<_>>();
        assert_eq!(names, ["0001-活着.epub"]);
        let mut bytes = Vec::new();
        archive.by_index(0).expect("entry").read_to_end(&mut bytes).expect("read");
        assert_eq!(bytes, b"bytes-b1");
    }

    #[test]
    fn a_pack_batch_wraps_readable_plain_and_password_protected_packs() {
        let shelf = Shelf::new("batch-packs");
        shelf.add("b1", "活着");
        let ids = vec!["b1".to_string()];

        let plain_path = shelf.dir.join("plain.zip");
        let plain = export(&shelf.library, &ids, &plain_path, BatchExportKind::Packs, None, false)
            .expect("plain export");
        assert_eq!(plain.exported, 1);
        assert_eq!(plain.skipped, 0);
        let mut archive =
            ZipArchive::new(File::open(&plain_path).expect("open plain zip")).expect("plain zip");
        let names =
            archive.file_names().map(|name| name.expect("name").to_string()).collect::<Vec<_>>();
        assert_eq!(names, ["0001-活着.ctz"]);
        let mut bytes = Vec::new();
        archive.by_index(0).expect("entry").read_to_end(&mut bytes).expect("read");
        let inner = shelf.dir.join("inner.ctz");
        std::fs::write(&inner, &bytes).expect("write inner pack");
        let unpacked = pack::unpack(&inner, None).expect("unpack plain");
        assert_eq!(unpacked.source, b"bytes-b1");
        assert!(unpacked.ai.is_none());

        let secret_path = shelf.dir.join("secret.zip");
        let secret = export(
            &shelf.library,
            &ids,
            &secret_path,
            BatchExportKind::Encrypted,
            Some("correct horse"),
            true,
        )
        .expect("encrypted export");
        assert_eq!(secret.exported, 1);
        let mut archive = ZipArchive::new(File::open(&secret_path).expect("open secret zip"))
            .expect("secret zip");
        let names =
            archive.file_names().map(|name| name.expect("name").to_string()).collect::<Vec<_>>();
        assert_eq!(names, ["0001-活着.ctzx"]);
        let mut bytes = Vec::new();
        archive.by_index(0).expect("entry").read_to_end(&mut bytes).expect("read");
        let inner = shelf.dir.join("inner.ctzx");
        std::fs::write(&inner, &bytes).expect("write inner pack");
        assert!(pack::unpack(&inner, Some("wrong")).is_err());
        let unpacked = pack::unpack(&inner, Some("correct horse")).expect("unpack encrypted");
        assert_eq!(unpacked.source, b"bytes-b1");
        assert!(unpacked.ai.is_some());
    }
}
