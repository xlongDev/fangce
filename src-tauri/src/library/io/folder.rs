//! Find books inside a folder the reader picked, for one batch import.
//!
//! This is deliberately *not* a Calibre library: no `metadata.db`, no external
//! names to trust. The only untrusted part is the directory tree itself, so
//! symlinks are dropped without following and every path is canonicalised and
//! checked to still sit under the picked root before it reaches `book.import`.
//!
//! One file per book, same rule as the Calibre scan: `三体.epub` and
//! `三体.azw3` are different bytes, so hash-dedupe would not see them and both
//! would land on the shelf. The format order is shared with that scan so the
//! two entry points cannot disagree about which copy wins.

use std::path::{Path, PathBuf};

use crate::document::BookFormat;
use crate::error::{AppError, AppResult};
use crate::library::calibre::FORMAT_ORDER;

/// A picked folder is often a downloads directory. Walking without a cap can
/// answer with tens of thousands of paths, which is neither a shelf nor a
/// useful batch. shortcut: stop after this many books; upgrade to a paged scan
/// (with a UI count) only if a reader actually needs larger folders.
const MAX_BOOKS: usize = 2000;

/// Every path returned is absolute: `book.import` copies it into the library
/// from an arbitrary working directory.
pub fn scan(root: &Path) -> AppResult<Vec<String>> {
    let root_real = root
        .canonicalize()
        .map_err(|_| AppError::Message("找不到这个文件夹，或没有读取权限".into()))?;
    if !root_real.is_dir() {
        return Err(AppError::Message("选中的不是文件夹".into()));
    }

    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    walk(&root_real, &root_real, &mut found);
    // Best format first, then a stable path order so the same folder always
    // offers the same batch.
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    found.truncate(MAX_BOOKS);

    let mut seen = std::collections::HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    for (_, path) in found {
        let key = book_key(&path);
        if seen.insert(key) {
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    paths.sort();
    Ok(paths)
}

/// Every import source — a picked folder, a native drop, a mixed drop — goes
/// through here: files stay as they are, folders become the books under them.
pub fn expand(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .flat_map(|raw| {
            let path = Path::new(raw);
            if !path.is_dir() {
                return vec![raw.clone()];
            }
            match scan(path) {
                Ok(books) => books,
                // Keep the folder itself so `book.import` reports a failed
                // outcome instead of the batch silently losing that drop.
                Err(err) => {
                    tracing::warn!(folder = %path.display(), error = %err, "扫描导入文件夹失败");
                    vec![raw.clone()]
                }
            }
        })
        .collect()
}

/// Depth-first walk. `symlink_metadata` does not follow: a symlinked directory
/// is not a directory here and a symlinked book is not a file, so neither can
/// lead outside the folder the reader picked.
fn walk(root: &Path, dir: &Path, found: &mut Vec<(usize, PathBuf)>) {
    if found.len() >= MAX_BOOKS * 2 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            let Ok(real) = path.canonicalize() else {
                continue;
            };
            if real.starts_with(root) {
                walk(root, &real, found);
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Some(format) = BookFormat::from_path(&path) else {
            continue;
        };
        let Ok(real) = path.canonicalize() else {
            continue;
        };
        if !real.starts_with(root) {
            continue;
        }
        let rank =
            FORMAT_ORDER.iter().position(|known| *known == format.as_str()).unwrap_or(usize::MAX);
        found.push((rank, real));
    }
}

/// What makes two files "the same book": same directory and same name without
/// a known extension. `.fb2.zip` keeps its whole double extension as the name,
/// so strip that one explicitly rather than calling two copies of one novel a
/// shelf full of duplicates.
fn book_key(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let plain_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let stem = if name.to_ascii_lowercase().ends_with(".fb2.zip") {
        &name[..name.len() - ".fb2.zip".len()]
    } else {
        &plain_stem
    };
    path.with_file_name(stem.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::document::fixture::temp_dir;

    fn book(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"not a real book").unwrap();
    }

    fn paths(root: &Path) -> Vec<String> {
        scan(root)
            .unwrap()
            .into_iter()
            .map(|p| PathBuf::from(p).file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn finds_books_in_nested_folders() {
        let root = temp_dir("folder-nested");
        book(&root, "a.txt");
        let nested = root.join("作者");
        std::fs::create_dir(&nested).unwrap();
        book(&nested, "b.epub");
        assert_eq!(paths(&root), vec!["a.txt", "b.epub"]);
    }

    #[test]
    fn unknown_extensions_are_not_books() {
        let root = temp_dir("folder-extensions");
        book(&root, "cover.jpg");
        book(&root, "notes.pdf.bak");
        assert!(scan(&root).unwrap().is_empty());
    }

    #[test]
    fn one_format_per_book_epub_wins() {
        let root = temp_dir("folder-one-format");
        book(&root, "三体.epub");
        book(&root, "三体.azw3");
        let all = scan(&root).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].ends_with("三体.epub"));
    }

    #[test]
    fn fb2_zip_and_epub_of_one_book_are_one_path() {
        let root = temp_dir("folder-fb2zip");
        book(&root, "三体.fb2.zip");
        book(&root, "三体.epub");
        let all = scan(&root).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].ends_with("三体.epub"));
    }

    #[test]
    fn same_name_in_different_folders_are_two_books() {
        let root = temp_dir("folder-two-stems");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        book(&a, "书.epub");
        book(&b, "书.epub");
        assert_eq!(paths(&root).len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("folder-symlinks");
        let outside = temp_dir("folder-outside");
        book(&outside, "secret.epub");
        symlink(outside.join("secret.epub"), root.join("linked.epub")).unwrap();
        symlink(&outside, root.join("linked-dir")).unwrap();
        assert!(scan(&root).unwrap().is_empty());
    }

    #[test]
    fn expand_mixed_files_and_folders_into_one_batch() {
        let root = temp_dir("folder-expand");
        let loose = root.join("loose.epub");
        book(&root, "loose.epub");
        let nested = root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        book(&nested, "inside.txt");
        let dir = nested.to_string_lossy().into_owned();
        let file = loose.to_string_lossy().into_owned();

        let expanded = expand(&[file.clone(), dir, file.clone()]);
        assert_eq!(expanded.len(), 3);
        assert_eq!(expanded[0], file);
        assert_eq!(expanded[2], file);
        assert!(expanded[1].ends_with("inside.txt"));
    }

    #[test]
    fn a_missing_or_non_directory_root_is_an_error() {
        let root = temp_dir("folder-missing");
        assert!(scan(&root.join("gone")).is_err());
        let file = root.join("a.txt");
        book(&root, "a.txt");
        assert!(scan(&file).is_err());
    }
}
