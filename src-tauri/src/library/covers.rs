//! Managing the covers this app downloaded from a catalogue (Douban / NeoDB).
//!
//! There is no extra database table for this. A cover's whole life is encoded
//! in its filename inside `covers_dir` and the book row that points at it:
//!
//! - `{id}.dl.{ext}`      — a downloaded cover the library currently uses.
//! - `{id}.prev.{ext}`    — the picture that was displaced when a download
//!   replaced it; this is the 「原书自带封面」 a retire falls back to.
//! - `{id}.retired.{ts}.{ext}` — a downloaded cover the reader took off the
//!   shelf but kept. The timestamps keep more than one retirement per book.
//!
//! Retiring is therefore not deletion: it renames the `.dl.` file to `.retired.`
//! and points the book back at its `.prev.` picture (or clears the column when
//! there was none). Restoring renames one back and points the book at it again.
//! Purging is the only irreversible step, and it only ever touches `.retired.`
//! files. Every path is re-checked to stay inside `covers_dir` — a name that
//! came from the filesystem is not a licence to delete anywhere on the disk.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// A downloaded cover as the manager shows it. `key` is the file name: the
/// stable handle every mutating command takes, so the UI never has to invent an
/// id for a file.
#[derive(specta::Type, Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCover {
    /// File name inside `covers_dir`, e.g. `b1.dl.jpg` or `b1.retired.1699.jpg`.
    pub key: String,
    pub book_id: String,
    pub book_title: Option<String>,
    pub bytes: i64,
    /// `true` once this cover has been retired (a `.retired.` file).
    pub retired: bool,
    /// Unix seconds from the file name's timestamp, or the file's mtime for an
    /// active cover. Used only to order the retired list.
    pub at: i64,
    /// Resource-protocol URL that renders this exact file, retired ones
    /// included. The version is the timestamp so a reused key refetches.
    pub url: String,
    /// The book's own cover that this download replaced (`{id}.prev.{ext}`),
    /// shown next to the download so the two can be compared at a glance.
    /// `None` when the book had no cover of its own.
    pub original_url: Option<String>,
    /// Size of that original cover, for the side-by-side caption.
    pub original_bytes: Option<i64>,
    /// Pixel width/height decoded from the image header, when it is a format
    /// we can read without a decoder. `None` for an unrecognised header.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// A suspiciously small or tiny-dimension image — a placeholder the
    /// catalogue served instead of a real cover. Flagged, never auto-deleted.
    pub placeholder: bool,
    /// Where the log says this cover came from, and when. Best-effort: older
    /// downloads predate provider recording, so `None` is common and honest.
    pub source: Option<CoverSource>,
}

/// Everything the cover manager needs in one read: what is in use, what is
/// retired, and the cover-related slice of the operation log.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverManagerData {
    /// Downloaded covers currently pointed at by a book.
    pub active: Vec<ManagedCover>,
    /// Retired covers, newest retirement first.
    pub retired: Vec<ManagedCover>,
    /// Sum of `active` sizes — matches the stats card's 补充封面 number.
    pub active_bytes: i64,
    /// Space the retired covers still take; purging reclaims it.
    pub retired_bytes: i64,
    /// Cover-related operation log rows, newest first.
    pub history: Vec<CoverHistoryRow>,
    /// `.dl.` files no book points at any more — bytes on disk that the stats
    /// card deliberately does not count. Found by scanning the directory, not
    /// the database (see [`find_orphans`]).
    pub orphans: Vec<ManagedCover>,
    /// Sum of orphan sizes — what 一键清理 reclaims.
    pub orphan_bytes: i64,
    /// Groups of in-use covers with identical bytes. Every group has at least
    /// two members. Only reported, never auto-merged (see module note).
    pub duplicate_groups: Vec<CoverDuplicateGroup>,
    /// Total bytes that could be reclaimed by merging every duplicate group
    /// down to one copy each.
    pub duplicate_bytes: i64,
}

/// A set of cover files with identical bytes, so all but one are redundant.
/// Only active (in-use) covers are grouped: any two live books showing the
/// same picture could share a single file. Retired copies are not grouped —
/// they are already one click away from the bin and carry their own history.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverDuplicateGroup {
    /// First 12 hex digits of the content hash, shown as a short label.
    pub hash: String,
    /// In-use covers sharing these bytes. Every key is a real `.dl.` file.
    pub keys: Vec<String>,
    /// Titles of the books whose covers these are.
    pub titles: Vec<String>,
    /// Bytes each copy takes.
    pub bytes_each: i64,
    /// Bytes freed if all but one copy are removed: `(n - 1) * bytes_each`.
    pub reclaimable: i64,
}

/// Where a cover came from, as far as the log actually says. The fill writes
/// only 「从目录补全了 N 本」 and never records which catalogue served each
/// picture, so naming Douban vs NeoDB here would be a guess. We show the real
/// operation summary and its time; a `None` cover has no surviving log row.
#[derive(specta::Type, Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoverSource {
    /// The operation's own summary, e.g. 「从目录补全了 1 本」.
    pub label: String,
    /// Unix seconds of that operation.
    pub at: i64,
}

/// Result of a cleanup sweep: how many files went and how many bytes that
/// reclaimed. Kept separate from [`CoverOpResult`] because orphan cleanup is
/// irreversible and the UI reports the space, not a skip count.
#[derive(specta::Type, Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub files: usize,
    pub bytes: i64,
}

/// One line of the cover history. Reuses `operations`; `undoable` is the same
/// calculation the settings page uses, so 「撤销」 here and there agree.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverHistoryRow {
    pub id: i64,
    pub call_id: String,
    pub at: i64,
    pub action: String,
    pub summary: String,
    pub book_id: Option<String>,
    pub book_title: Option<String>,
    pub undoable: bool,
}

/// How many of a batch landed. Skips are not errors: a cover fixed by a newer
/// write, or a book already purged, should not fail the other nine.
#[derive(specta::Type, Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoverOpResult {
    pub done: usize,
    pub skipped: usize,
}

/// Actions that are unambiguously about a cover change. The settings page's
/// `isCoverOperation` mirrors this list (plus the `fill_metadata` summary rule
/// below) so 「撤销」 and the log jump agree across both places.
pub const COVER_ACTIONS: [&str; 7] = [
    "cover",
    "update_metadata_cover",
    "cover_retire",
    "cover_restore",
    "cover_purge",
    "cover_orphan_cleanup",
    "cover_dedupe",
];

/// Marker in a retired cover's filename. Chosen to be impossible in a UUID id
/// and to read plainly when browsing the directory.
const RETIRED: &str = ".retired.";

/// A file this small, or with the smaller edge this short, is almost certainly
/// a catalogue placeholder rather than a book cover. Flagged in the UI only:
/// some real covers are small, and deleting them is never automatic.
const PLACEHOLDER_BYTES: i64 = 3 * 1024;
const PLACEHOLDER_EDGE: u32 = 120;

fn is_active_download(key: &str) -> bool {
    key.contains(".dl.")
}

fn key_of(path: &Path) -> Option<String> {
    path.file_name()?.to_str().map(str::to_string)
}

/// The book id is the segment before the `.dl.` / `.retired.` marker. Both
/// markers are checked so the same helper serves active and retired keys.
fn book_id_of(key: &str) -> Option<&str> {
    let marker = if key.contains(RETIRED) {
        RETIRED
    } else if key.contains(".dl.") {
        ".dl."
    } else {
        return None;
    };
    key.split(marker).next().filter(|part| !part.is_empty())
}

fn file_time(path: &Path) -> i64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn retired_time(key: &str) -> i64 {
    key.split(RETIRED)
        .nth(1)
        .and_then(|rest| rest.split('.').next())
        .and_then(|stamp| stamp.parse::<i64>().ok())
        .unwrap_or(0)
}

fn title_of(conn: &rusqlite::Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT title FROM books WHERE id = ?1", params![id], |row| row.get(0)).ok()
}

/// The first twelve hex digits of a content hash, for grouping identical
/// covers. Covers are small (a few hundred KB at most), so hashing the bytes
/// we already read for the dimension probe costs nothing measurable.
fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(12);
    for byte in digest.iter().take(6) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Read the pixel dimensions straight out of an image header — no decoder, no
/// new dependency, just the few bytes the formats put at fixed offsets. A
/// header we do not recognise yields `None` and the card simply omits the
/// size; it is never a reason to fail the whole list.
fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    // PNG: IHDR width/height are big-endian at offsets 16 and 20.
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) && bytes.len() >= 24 {
        let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return (w > 0 && h > 0).then_some((w, h));
    }
    // GIF: logical screen width/height, little-endian at 6 and 8.
    if bytes.starts_with(b"GIF8") && bytes.len() >= 10 {
        let w = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
        let h = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
        return (w > 0 && h > 0).then_some((w, h));
    }
    // JPEG: walk the marker segments until a SOFn (start-of-frame) appears.
    // Width/height sit after the 2-byte length and 1-byte precision.
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                i += 2;
                continue;
            }
            if marker == 0xd9 || marker == 0xda {
                break;
            }
            let len = u16::from_be_bytes(bytes[i + 2..i + 4].try_into().ok()?) as usize;
            let is_sof = matches!(
                marker,
                0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
            );
            if is_sof && len >= 7 {
                let h = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
                let w = u16::from_be_bytes(bytes[i + 7..i + 9].try_into().ok()?) as u32;
                return (w > 0 && h > 0).then_some((w, h));
            }
            i += 2 + len;
        }
    }
    // WebP: lossy VP8 and lossless VP8L carry the size at different offsets.
    if bytes.len() >= 30 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        match &bytes[12..16] {
            b"VP8X" if bytes.len() >= 30 => {
                let w = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
                let h = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
                return Some((w, h));
            }
            b"VP8 " if bytes.len() >= 30 => {
                let w = u16::from_le_bytes(bytes[26..28].try_into().ok()?) as u32 & 0x3fff;
                let h = u16::from_le_bytes(bytes[28..30].try_into().ok()?) as u32 & 0x3fff;
                return (w > 0 && h > 0).then_some((w, h));
            }
            _ => {}
        }
    }
    None
}

/// Everything the UI labels on a cover card, read from the file bytes we
/// already have in hand. A file under the placeholder threshold is flagged
/// only when its header also decodes small — a tiny PNG mistaken for a cover
/// is the thing worth surfacing, not a truncated 2 KB JPEG we cannot read.
fn cover_probe(bytes: &[u8], size: i64) -> (Option<u32>, Option<u32>, bool) {
    let (w, h) = image_size(bytes).unzip();
    let small = w.is_some_and(|w| w < PLACEHOLDER_EDGE) || h.is_some_and(|h| h < PLACEHOLDER_EDGE);
    let placeholder = size < PLACEHOLDER_BYTES && (small || w.is_none());
    (w, h, placeholder)
}

/// Resolve a file name the UI handed back, refusing anything that is not a
/// plain file name inside `covers_dir`. Without this, `../` in a key could
/// delete a file elsewhere on disk.
fn guarded(covers_dir: &Path, key: &str) -> AppResult<PathBuf> {
    if key.is_empty() || key.contains('/') || key.contains('\\') || key == "." || key == ".." {
        return Err(AppError::InvalidArgument("无效的封面文件名".into()));
    }
    let path = covers_dir.join(key);
    if path.parent() != Some(covers_dir) {
        return Err(AppError::InvalidArgument("封面不在书库目录内".into()));
    }
    Ok(path)
}

/// Recover original (`{id}.prev.{ext}`) covers that an older build deleted.
///
/// The pre-fix `move_aside` dropped the retained original when a book was
/// re-downloaded after an undo, so existing libraries can have a downloaded
/// cover with no companion picture — the card's 「原文件」 side renders as a
/// placeholder. The book's own cover still lives inside its source file, so
/// re-extract it once. `list` then picks the file up on the next read.
///
/// Runs on the blocking task before `list`; the DB lock is taken only for the
/// short metadata query, never while a book file is being parsed.
pub fn heal_originals(library: &crate::db::Library, covers_dir: &Path, books_dir: &Path) -> usize {
    // Which books have a managed cover but no `.prev.` companion? Do the
    // directory walk first; nothing here needs the lock.
    let mut needs: HashSet<String> = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(covers_dir) {
        for entry in entries.flatten() {
            let Some(key) = key_of(&entry.path()) else { continue };
            if key.contains(".prev.") {
                continue;
            }
            if let Some(id) = book_id_of(&key) {
                needs.insert(id.to_string());
            }
        }
    }
    if needs.is_empty() {
        return 0;
    }

    // One short read under the lock: source path + format for the affected
    // books. Parsing the book files happens after the lock is released.
    let sources: Vec<(String, String, crate::document::BookFormat)> = library
        .with(|conn| {
            let mut out = Vec::new();
            for id in &needs {
                if let Ok((path, format)) = crate::library::shelf::repository::source(conn, id) {
                    out.push((id.clone(), path, format));
                }
            }
            Ok(out)
        })
        .unwrap_or_default();

    let mut healed = 0;
    for (id, file_path, format) in sources {
        // `file_path` is absolute for a book inside the library; a relative
        // legacy value is resolved against books_dir rather than the cwd.
        let source = PathBuf::from(&file_path);
        let source = if source.is_absolute() { source } else { books_dir.join(source) };
        let Ok(metadata) = crate::document::read_metadata(&source, format) else {
            continue;
        };
        let Some(cover) = metadata.cover else { continue };
        let extension = crate::document::safe_image_extension(&cover.extension);
        let target = covers_dir.join(format!("{id}.prev.{extension}"));
        // Never overwrite: a healthy `.prev.` may be the picture a pending undo
        // needs to restore. Only fill the hole the old bug left behind.
        if target.exists() {
            continue;
        }
        if std::fs::write(&target, &cover.bytes).is_ok() {
            healed += 1;
        }
    }
    healed
}

/// List active + retired covers and the cover history. Files are walked on the
/// calling (blocking) task; the database half is one short read under the lock.
pub fn list(conn: &rusqlite::Connection, covers_dir: &Path) -> AppResult<CoverManagerData> {
    // The library points at a handful of covers; walking the directory is the
    // authoritative way to find retired ones and orphans, which no row
    // references any more. The original (`.prev.`) pictures are read in the
    // same walk: one pass collects them by book id, then each cover picks up
    // its own. Collect the walked files once so the `.prev.` pairing cannot
    // miss a companion just because the directory listed the download first.
    let files: Vec<_> = std::fs::read_dir(covers_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            let key = key_of(&path)?;
            let bytes = entry.metadata().ok()?.len() as i64;
            Some((path, key, bytes))
        })
        .collect();

    // `{id}.prev.{ext}` is the book's own picture a download displaced. It is
    // not a cover the manager acts on — only a companion image for the card.
    let mut originals: HashMap<String, (String, i64)> = HashMap::new();
    for (_, key, bytes) in &files {
        if let Some((id, _)) = key.split_once(".prev.").filter(|(id, _)| !id.is_empty()) {
            originals.insert(id.to_string(), (key.clone(), *bytes));
        }
    }

    // Which `.dl.` files are still in use? One query builds the set of paths
    // the library points at, so an un-referenced download is an orphan rather
    // than a ghost card. Titles and the last cover operation per book come
    // from the same short read under the lock.
    let referenced: HashSet<PathBuf> = conn
        .prepare("SELECT cover_path FROM books WHERE cover_path IS NOT NULL")?
        .query_map([], |row| row.get::<_, String>(0))?
        .flatten()
        .map(PathBuf::from)
        .collect();

    let cover_source = cover_sources(conn)?;

    let mut active = Vec::new();
    let mut retired = Vec::new();
    let mut orphans = Vec::new();
    for (path, key, bytes) in files {
        let Some(book_id) = book_id_of(&key) else { continue };
        // Only files shaped like a cover we manage. Imported covers are
        // `{id}.{ext}` and must never appear as downloadable.
        let (is_retired, at) = if key.contains(RETIRED) {
            (true, retired_time(&key))
        } else if is_active_download(&key) {
            (false, file_time(&path))
        } else {
            continue;
        };
        // An active file the row no longer points at is an orphan left by an
        // old undo. Keep it out of the active list but report it for cleanup.
        if !is_retired && !referenced.contains(&path) {
            let cover = build_cover(conn, &path, &key, book_id, bytes, false, at, &originals, None);
            orphans.push(cover);
            continue;
        }
        let source = cover_source.get(book_id).cloned();
        let cover =
            build_cover(conn, &path, &key, book_id, bytes, is_retired, at, &originals, source);
        if is_retired {
            retired.push(cover);
        } else {
            active.push(cover);
        }
    }
    active.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.key.cmp(&b.key)));
    retired.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.key.cmp(&b.key)));
    orphans.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.key.cmp(&b.key)));
    let active_bytes = active.iter().map(|cover| cover.bytes).sum();
    let retired_bytes = retired.iter().map(|cover| cover.bytes).sum();
    let orphan_bytes = orphans.iter().map(|cover| cover.bytes).sum();

    let (duplicate_groups, duplicate_bytes) = find_duplicates(&active, covers_dir);

    let history = cover_history(conn)?;
    Ok(CoverManagerData {
        active,
        retired,
        active_bytes,
        retired_bytes,
        history,
        orphans,
        orphan_bytes,
        duplicate_groups,
        duplicate_bytes,
    })
}

/// Build one card. Bytes are read from disk for the dimension probe and the
/// content hash; a file that vanished mid-scan simply gets no probe fields.
#[allow(clippy::too_many_arguments)]
fn build_cover(
    conn: &rusqlite::Connection,
    path: &Path,
    key: &str,
    book_id: &str,
    bytes: i64,
    retired: bool,
    at: i64,
    originals: &HashMap<String, (String, i64)>,
    source: Option<CoverSource>,
) -> ManagedCover {
    let content = std::fs::read(path).unwrap_or_default();
    let (width, height, placeholder) = cover_probe(&content, bytes);
    let original = originals.get(book_id).map(|(prev_key, original_bytes)| {
        (crate::library::managed_cover_url(prev_key, at), *original_bytes)
    });
    ManagedCover {
        url: crate::library::managed_cover_url(key, at),
        original_url: original.as_ref().map(|(url, _)| url.clone()),
        original_bytes: original.as_ref().map(|(_, bytes)| *bytes),
        key: key.to_string(),
        book_id: book_id.to_string(),
        book_title: title_of(conn, book_id),
        bytes,
        retired,
        at,
        width,
        height,
        placeholder,
        source,
    }
}

/// The last cover-related operation for each book, for the source label.
/// Walked newest-first and only kept on first sight, so one pass yields the
/// most recent event per book without a query per cover.
fn cover_sources(conn: &rusqlite::Connection) -> AppResult<HashMap<String, CoverSource>> {
    let placeholders = COVER_ACTIONS.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT book_id, summary, at FROM operations \
          WHERE book_id IS NOT NULL \
            AND (action IN ({placeholders}) \
                 OR (action = 'fill_metadata' AND summary LIKE '%封面%')) \
            AND action <> 'undo' \
          ORDER BY at DESC, id DESC"
    );
    let params = rusqlite::params_from_iter(
        COVER_ACTIONS.iter().map(|action| action as &dyn rusqlite::ToSql),
    );
    let mut statement = conn.prepare(&sql)?;
    let mut out = HashMap::new();
    for row in statement.query_map(params, |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
    })? {
        let (id, summary, at) = row?;
        out.entry(id).or_insert(CoverSource { label: summary, at });
    }
    Ok(out)
}

/// Group active covers by content hash. Only groups of two or more are
/// reported, with the space a merge would free. Merging is deliberately NOT
/// offered as an automatic action: each `.dl.` file is the undo anchor for its
/// own book, and one shared file would make retiring one book break another.
fn find_duplicates(active: &[ManagedCover], covers_dir: &Path) -> (Vec<CoverDuplicateGroup>, i64) {
    // Read each file once, cache its hash by key. The bytes were already read
    // in `build_cover`, but returning them from there would bloat the card;
    // covers are small and a second read here keeps the data shape clean.
    let mut by_hash: HashMap<String, Vec<&ManagedCover>> = HashMap::new();
    for cover in active {
        let Ok(content) = std::fs::read(covers_dir.join(&cover.key)) else { continue };
        by_hash.entry(content_hash(&content)).or_default().push(cover);
    }
    let mut groups: Vec<CoverDuplicateGroup> = Vec::new();
    let mut total = 0;
    for (hash, mut members) in by_hash {
        if members.len() < 2 {
            continue;
        }
        members.sort_by(|a, b| a.key.cmp(&b.key));
        let bytes_each = members[0].bytes;
        let reclaimable = bytes_each * (members.len() as i64 - 1);
        total += reclaimable;
        groups.push(CoverDuplicateGroup {
            hash,
            keys: members.iter().map(|c| c.key.clone()).collect(),
            // Positionally aligned with `keys`: the UI picks a keeper by index,
            // so a missing title must leave a slot rather than shift the rest.
            titles: members
                .iter()
                .map(|c| c.book_title.clone().unwrap_or_else(|| c.key.clone()))
                .collect(),
            bytes_each,
            reclaimable,
        });
    }
    groups.sort_by_key(|group| std::cmp::Reverse(group.reclaimable));
    (groups, total)
}

fn cover_path_of(conn: &rusqlite::Connection, id: &str) -> AppResult<Option<PathBuf>> {
    let found = conn
        .query_row("SELECT cover_path FROM books WHERE id = ?1", params![id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten();
    Ok(found.map(PathBuf::from))
}

/// The cover slice of the operation log, reusing the settings page's query so
/// 「撤销」 and `undoable` mean exactly the same thing in both places.
fn cover_history(conn: &rusqlite::Connection) -> AppResult<Vec<CoverHistoryRow>> {
    let placeholders = COVER_ACTIONS.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    // `fill_metadata` is a mixed bag: 「补了封面」 is a cover change, but
    // 「从目录补全了 N 本」 and 「批量改出版社」 are not. The settings page uses
    // the same `summary.contains("封面")` rule, so the two histories agree.
    let sql = format!(
        "SELECT o.id, o.call_id, o.at, o.action, o.summary, o.book_id, o.book_title, \
                EXISTS (SELECT 1 FROM operations u \
                         WHERE u.call_id = o.call_id AND u.action = 'undo') \
           FROM operations o \
          WHERE (o.action IN ({placeholders}) \
                 OR (o.action = 'fill_metadata' AND o.summary LIKE '%封面%')) \
            AND o.action <> 'undo' \
          ORDER BY o.at DESC, o.id DESC LIMIT 200"
    );
    let params = rusqlite::params_from_iter(
        COVER_ACTIONS.iter().map(|action| action as &dyn rusqlite::ToSql),
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params, |row| {
        Ok(CoverHistoryRow {
            id: row.get(0)?,
            call_id: row.get(1)?,
            at: row.get(2)?,
            action: row.get(3)?,
            summary: row.get(4)?,
            book_id: row.get(5)?,
            book_title: row.get(6)?,
            // A row is undoable when it carries a before-image. `cover_retire`
            // and `cover_restore` are recorded without one: they have their own
            // inverse (restore / retire), not a generic undo.
            undoable: !row.get::<_, bool>(7)?
                && matches!(
                    row.get::<_, String>(3)?.as_str(),
                    "cover" | "update_metadata_cover" | "fill_metadata"
                ),
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(crate::error::AppError::from)
}

/// A retired filename that does not exist yet. A book can hold several retired
/// covers, and a restore may push the current one aside; either way a plain
/// `now_seconds()` can collide with an entry made in the same second, so probe
/// forward until the name is free rather than overwrite a file.
fn unique_retired_path(covers_dir: &Path, id: &str, extension: &str) -> PathBuf {
    let base = crate::library::now_seconds();
    let mut stamp = base;
    loop {
        let path = covers_dir.join(format!("{id}{RETIRED}{stamp}.{extension}"));
        if !path.exists() {
            return path;
        }
        stamp += 1;
    }
}

/// The `{id}.prev.{ext}` picture a retire falls back to, if any.
fn previous_of(covers_dir: &Path, id: &str) -> Option<PathBuf> {
    let prefix = format!("{id}.prev.");
    std::fs::read_dir(covers_dir).ok()?.flatten().map(|entry| entry.path()).find(|path| {
        path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix))
    })
}

/// Take a downloaded cover off its book, keeping the file as `.retired.`.
/// The book falls back to the original cover displaced by the download.
pub fn retire(
    conn: &rusqlite::Connection,
    covers_dir: &Path,
    keys: &[String],
) -> AppResult<CoverOpResult> {
    let mut done = 0;
    let mut skipped = 0;
    for key in keys {
        let path = guarded(covers_dir, key)?;
        let Some(id) = book_id_of(key) else {
            skipped += 1;
            continue;
        };
        if !is_active_download(key) || !path.is_file() {
            skipped += 1;
            continue;
        }
        // Only retire what the row still points at. A stale file is an orphan,
        // not something the reader asked to take off a book.
        match cover_path_of(conn, id)? {
            Some(referenced) if referenced == path => {}
            _ => {
                skipped += 1;
                continue;
            }
        }
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
        let retired = unique_retired_path(covers_dir, id, extension);
        std::fs::rename(&path, &retired)?;
        match previous_of(covers_dir, id) {
            Some(prev) => crate::library::repository::set_cover(conn, id, &prev.to_string_lossy())?,
            None => crate::library::repository::clear_cover(conn, id)?,
        }
        crate::library::ops::record(
            conn,
            crate::library::ops::Source::Ui,
            "cover_retire",
            &[id.to_string()],
            "把下载的封面从书上取下，移入封面回收站",
        )?;
        done += 1;
    }
    Ok(CoverOpResult { done, skipped })
}

/// Put a retired cover back onto its book. The current downloaded cover, if
/// any, is retired first so nothing is overwritten or lost.
pub fn restore(
    conn: &rusqlite::Connection,
    covers_dir: &Path,
    keys: &[String],
) -> AppResult<CoverOpResult> {
    let mut done = 0;
    let mut skipped = 0;
    for key in keys {
        let path = guarded(covers_dir, key)?;
        let Some(id) = book_id_of(key) else {
            skipped += 1;
            continue;
        };
        if !key.contains(RETIRED) || !path.is_file() {
            skipped += 1;
            continue;
        }
        if title_of(conn, id).is_none() {
            // Book purged — there is nothing to put the cover back onto.
            skipped += 1;
            continue;
        }
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
        let active = covers_dir.join(format!("{id}.dl.{extension}"));
        if active.exists() {
            // Keep the cover currently in use as another retired entry rather
            // than overwriting it — restoring is not a licence to destroy.
            let aside = unique_retired_path(covers_dir, id, extension);
            std::fs::rename(&active, &aside)?;
        }
        std::fs::rename(&path, &active)?;
        crate::library::repository::set_cover(conn, id, &active.to_string_lossy())?;
        crate::library::ops::record(
            conn,
            crate::library::ops::Source::Ui,
            "cover_restore",
            &[id.to_string()],
            "从封面回收站恢复了下载的封面",
        )?;
        done += 1;
    }
    Ok(CoverOpResult { done, skipped })
}

/// Permanently delete retired covers. Only `.retired.` files qualify; an
/// active cover or an imported picture can never reach this code path.
pub fn purge(
    conn: &rusqlite::Connection,
    covers_dir: &Path,
    keys: &[String],
) -> AppResult<CoverOpResult> {
    let mut done = 0;
    let mut skipped = 0;
    for key in keys {
        let path = guarded(covers_dir, key)?;
        let Some(id) = book_id_of(key) else {
            skipped += 1;
            continue;
        };
        if !key.contains(RETIRED) || !path.is_file() {
            skipped += 1;
            continue;
        }
        std::fs::remove_file(&path)?;
        crate::library::ops::record(
            conn,
            crate::library::ops::Source::Ui,
            "cover_purge",
            &[id.to_string()],
            "永久删除了封面回收站里的封面",
        )?;
        done += 1;
    }
    Ok(CoverOpResult { done, skipped })
}

/// Count unreferenced `.dl.` files without building any cards — the cheap
/// version the storage card uses for its 「发现无主封面」 hint.
/// A safe, human-readable name for an exported cover: the book's title plus
/// the original extension. Path separators and the usual reserved characters
/// become `_`, so a title can never turn into a path or an illegal file name on
/// any platform. Falls back to 「封面」 when the title is missing or all-punct.
pub fn export_name(title: Option<&str>, key: &str) -> String {
    // The extension is the last dotted segment of the managed key — `.dl.` and
    // `.retired.{ts}.` both sit before it. Only accept a plain alphanumeric
    // ext so a malformed key cannot smuggle odd characters into the name.
    let ext = key
        .rsplit('.')
        .next()
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("jpg");
    let mut safe = String::new();
    for ch in title.unwrap_or("").chars() {
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
            safe.push('_');
        } else {
            safe.push(ch);
        }
    }
    let trimmed = safe.trim().trim_matches('.').trim();
    let stem: String = trimmed.chars().take(120).collect();
    if stem.is_empty() { format!("封面.{ext}") } else { format!("{stem}.{ext}") }
}

/// Resolve every key to its export name while the DB lock is held (a short
/// read only). The caller copies files after dropping the lock. Keys that are
/// not plain file names are skipped — the same rule `guarded` applies to every
/// other cover command.
pub fn export_plan(conn: &rusqlite::Connection, keys: &[String]) -> Vec<(String, String)> {
    keys.iter()
        .filter_map(|key| {
            if key.is_empty()
                || key.contains('/')
                || key.contains('\\')
                || key == "."
                || key == ".."
            {
                return None;
            }
            let id = book_id_of(key)?;
            let title = title_of(conn, id);
            Some((key.clone(), export_name(title.as_deref(), key)))
        })
        .collect()
}

/// Add ` (2)`, ` (3)`, … when a name is taken, so exporting twice (or two books
/// with the same title) never overwrites an earlier file in the same folder.
pub fn unique_export_name(base: &str, dest: &Path) -> String {
    if !dest.join(base).exists() {
        return base.to_string();
    }
    let (stem, ext) = base.rsplit_once('.').unwrap_or((base, ""));
    for n in 2.. {
        let candidate =
            if ext.is_empty() { format!("{stem} ({n})") } else { format!("{stem} ({n}).{ext}") };
        if !dest.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!("the loop always finds a free suffix")
}

pub fn orphan_stats(conn: &rusqlite::Connection, covers_dir: &Path) -> AppResult<(i64, i64)> {
    let referenced: HashSet<PathBuf> = conn
        .prepare("SELECT cover_path FROM books WHERE cover_path IS NOT NULL")?
        .query_map([], |row| row.get::<_, String>(0))?
        .flatten()
        .map(PathBuf::from)
        .collect();
    let mut count = 0i64;
    let mut bytes = 0i64;
    for entry in std::fs::read_dir(covers_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let Some(key) = key_of(&path) else { continue };
        if !is_active_download(&key) || !path.is_file() || referenced.contains(&path) {
            continue;
        }
        count += 1;
        bytes += entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
    }
    Ok((bytes, count))
}

/// Permanently delete un-referenced `.dl.` files (orphans). This is the one
/// irreversible sweep, so each key is re-checked against the database at the
/// moment of deletion: a file the reader just put back on a book between the
/// list and this call is skipped, never unlinked. Only files shaped like an
/// active download qualify — retired covers keep their own bin and history.
pub fn cleanup_orphans(
    conn: &rusqlite::Connection,
    covers_dir: &Path,
    keys: &[String],
) -> AppResult<CleanupResult> {
    // The authoritative set of paths the library still points at. One read,
    // not a query per file.
    let referenced: HashSet<PathBuf> = conn
        .prepare("SELECT cover_path FROM books WHERE cover_path IS NOT NULL")?
        .query_map([], |row| row.get::<_, String>(0))?
        .flatten()
        .map(PathBuf::from)
        .collect();

    let mut files = 0;
    let mut bytes = 0;
    for key in keys {
        let path = guarded(covers_dir, key)?;
        if !is_active_download(key) || !path.is_file() || referenced.contains(&path) {
            continue;
        }
        let Some(id) = book_id_of(key) else { continue };
        let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
        std::fs::remove_file(&path)?;
        crate::library::ops::record(
            conn,
            crate::library::ops::Source::Ui,
            "cover_orphan_cleanup",
            &[id.to_string()],
            "清理了一张无主封面",
        )?;
        files += 1;
        bytes += size;
    }
    Ok(CleanupResult { files, bytes })
}

/// Merge a duplicate group down to one physical copy using **hard links**.
///
/// The tempting alternative — delete the redundant file and point its book at
/// the keeper — silently breaks two flows: undo deletes the file a fill wrote
/// (`ops::discard_downloaded_cover`), and retire renames one book's file
/// (`retire`). Both would reach across books and corrupt the survivor. A hard
/// link keeps every book's own path and its own undo anchor, so both flows are
/// untouched; the bytes simply share one inode and the disk reclaims a copy.
///
/// Each redundant file is re-read and byte-compared with the keeper before it
/// is replaced: a stale UI list must never let two different pictures merge.
/// `keeper` must be one of `keys`, and every key is re-checked as a real,
/// referenced `.dl.` file at deletion time.
pub fn dedupe(
    conn: &rusqlite::Connection,
    covers_dir: &Path,
    keeper: &str,
    keys: &[String],
) -> AppResult<CleanupResult> {
    let keeper_path = guarded(covers_dir, keeper)?;
    if !is_active_download(keeper) || !keeper_path.is_file() {
        return Err(AppError::InvalidArgument("保留的封面不存在".into()));
    }
    let keeper_bytes = std::fs::read(&keeper_path)?;

    // Paths the library still points at — a file put back between list and
    // here is skipped, never touched.
    let referenced: HashSet<PathBuf> = conn
        .prepare("SELECT cover_path FROM books WHERE cover_path IS NOT NULL")?
        .query_map([], |row| row.get::<_, String>(0))?
        .flatten()
        .map(PathBuf::from)
        .collect();

    let mut files = 0;
    let mut bytes = 0;
    for key in keys {
        if key == keeper {
            continue;
        }
        let path = guarded(covers_dir, key)?;
        if !is_active_download(key) || !path.is_file() || !referenced.contains(&path) {
            continue;
        }
        if std::fs::read(&path)? != keeper_bytes {
            continue;
        }
        let Some(id) = book_id_of(key) else { continue };

        // Link to a temp name in the same directory, then rename over the old
        // file. A direct remove-then-link would leave the book with no cover if
        // the link failed; this way the original survives until the swap is
        // ready. The temp name matches no managed pattern, so a crash mid-way
        // leaves only a stray file the next cleanup can ignore.
        let tmp = covers_dir.join(format!("{key}.dedupe-tmp"));
        let _ = std::fs::remove_file(&tmp);
        if std::fs::hard_link(&keeper_path, &tmp).is_err() {
            // Filesystem without hard-link support (rare) — leave it alone.
            let _ = std::fs::remove_file(&tmp);
            continue;
        }
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            continue;
        }
        let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
        crate::library::ops::record(
            conn,
            crate::library::ops::Source::Ui,
            "cover_dedupe",
            &[id.to_string()],
            "合并了重复的封面",
        )?;
        files += 1;
        bytes += size;
    }
    Ok(CleanupResult { files, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Library;
    use crate::document::BookFormat;
    use crate::library::repository::{self, NewBook};

    fn harness(tag: &str) -> (std::path::PathBuf, Library) {
        let dir = crate::document::fixture::temp_dir(tag);
        let library = Library::open(&dir).expect("open");
        library
            .with_tx(|tx| {
                repository::insert(
                    tx,
                    &NewBook {
                        id: "b1",
                        title: "三体",
                        subtitle: None,
                        description: None,
                        language: Some("zh"),
                        publisher: None,
                        identifier: None,
                        format: BookFormat::Epub,
                        content_hash: "b1",
                        file_path: "/books/x.epub",
                        file_size: 1,
                        cover_path: None,
                        authors: &[],
                    },
                )
            })
            .expect("seed");
        (dir, library)
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).expect("write cover");
    }

    #[test]
    fn retire_keeps_the_file_and_falls_back_to_the_original_cover() {
        let (dir, library) = harness("covers-retire");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"downloaded");
        write(&covers.join("b1.prev.jpg"), b"original");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");

        let result =
            library.with(|conn| retire(conn, &covers, &["b1.dl.jpg".into()])).expect("retire");
        assert_eq!(result, CoverOpResult { done: 1, skipped: 0 });
        assert!(!covers.join("b1.dl.jpg").exists());
        let retired: Vec<_> = std::fs::read_dir(&covers)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(retired.iter().any(|name| name.contains(".retired.")), "file kept: {retired:?}");
        let current = library.with(|conn| repository::cover_path(conn, "b1")).expect("cover");
        assert_eq!(current, Some(covers.join("b1.prev.jpg")), "book fell back to the original");
    }

    #[test]
    fn retire_with_no_original_clears_the_cover() {
        let (dir, library) = harness("covers-retire-bare");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.png"), b"downloaded");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.png").to_str().unwrap())
            })
            .expect("point at download");

        library.with(|conn| retire(conn, &covers, &["b1.dl.png".into()])).expect("retire");
        let current = library.with(|conn| repository::cover_path(conn, "b1")).expect("cover");
        assert_eq!(current, None);
    }

    #[test]
    fn list_separates_active_from_retired_and_ignores_orphans() {
        let (dir, library) = harness("covers-list");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"active");
        write(&covers.join("b1.retired.100.jpg"), b"retired");
        write(&covers.join("b2.dl.jpg"), b"orphan"); // no book, no row -> ignored
        write(&covers.join("b1.jpg"), b"imported"); // imported cover -> ignored
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");

        let data = library.with(|conn| list(conn, &covers)).expect("list");
        assert_eq!(data.active.len(), 1, "only the referenced download is active");
        assert_eq!(data.active[0].key, "b1.dl.jpg");
        assert_eq!(data.retired.len(), 1);
        assert_eq!(data.retired[0].key, "b1.retired.100.jpg");
        assert_eq!(data.active_bytes, 6);
        assert_eq!(data.retired_bytes, 7);
    }

    #[test]
    fn list_exposes_the_original_cover_next_to_a_download() {
        let (dir, library) = harness("covers-original");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"downloaded");
        write(&covers.join("b1.prev.jpg"), b"original");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");

        let data = library.with(|conn| list(conn, &covers)).expect("list");
        let active = &data.active[0];
        let original = active.original_url.as_ref().expect("original url present");
        assert!(original.contains("/managed-cover/b1.prev.jpg"), "{original}");
        assert_eq!(active.original_bytes, Some(b"original".len() as i64));
        // The original is a companion image, never listed as its own cover.
        assert_eq!(data.active.len(), 1);
        assert!(data.retired.is_empty());
    }

    #[test]
    fn heal_recovers_a_lost_original_from_the_source_book() {
        let (dir, library) = harness("covers-heal");
        let covers = dir.join("covers");
        let books = dir.join("books");
        std::fs::create_dir_all(&covers).expect("covers dir");
        std::fs::create_dir_all(&books).expect("books dir");
        // A real EPUB with an embedded cover under OEBPS/images/cover.png.
        let source = crate::document::fixture::write_epub(
            &books,
            "b1.epub",
            &crate::document::fixture::full_opf("三体", "刘慈欣"),
            &[("OEBPS/images/cover.png", &crate::document::fixture::png_bytes())],
        );
        library
            .with(|conn| {
                conn.execute(
                    "UPDATE books SET file_path = ?1 WHERE id = 'b1'",
                    params![source.to_str().expect("path")],
                )?;
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");
        write(&covers.join("b1.dl.jpg"), b"downloaded");
        // The `.prev.` is gone — exactly what the old move_aside bug left.

        let healed = heal_originals(&library, &covers, &books);
        assert_eq!(healed, 1, "the missing original was regenerated");

        let prev: Vec<_> = std::fs::read_dir(&covers)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".prev."))
            .collect();
        assert_eq!(prev.len(), 1, "one original restored: {prev:?}");
        assert!(
            std::fs::read(covers.join(&prev[0])).expect("original bytes")
                == crate::document::fixture::png_bytes()
        );

        // Running it again is a no-op — a healthy original is never overwritten.
        assert_eq!(heal_originals(&library, &covers, &books), 0);
        let data = library.with(|conn| list(conn, &covers)).expect("list");
        assert!(data.active[0].original_url.is_some(), "card now shows the original");
    }

    #[test]
    fn list_leaves_original_empty_when_the_book_had_no_cover() {
        let (dir, library) = harness("covers-no-original");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"downloaded");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");

        let data = library.with(|conn| list(conn, &covers)).expect("list");
        assert_eq!(data.active[0].original_url, None);
        assert_eq!(data.active[0].original_bytes, None);
    }

    #[test]
    fn history_keeps_only_real_cover_changes() {
        let (_dir, library) = harness("covers-history");
        library
            .with(|conn| {
                crate::library::ops::record(
                    conn,
                    crate::library::ops::Source::Ui,
                    "cover",
                    &["b1".into()],
                    "换了封面",
                )?;
                crate::library::ops::record(
                    conn,
                    crate::library::ops::Source::Ui,
                    "cover_purge",
                    &["b1".into()],
                    "永久删除了封面",
                )?;
                crate::library::ops::record(
                    conn,
                    crate::library::ops::Source::Ui,
                    "fill_metadata",
                    &["b1".into()],
                    "补了封面",
                )?;
                crate::library::ops::record(
                    conn,
                    crate::library::ops::Source::Ui,
                    "fill_metadata",
                    &["b1".into()],
                    "从目录补全了 1 本",
                )?;
                crate::library::ops::record(
                    conn,
                    crate::library::ops::Source::Ui,
                    "fill_metadata",
                    &["b1".into()],
                    "批量改出版社：统一",
                )?;
                crate::library::ops::record(
                    conn,
                    crate::library::ops::Source::Ui,
                    "update_metadata",
                    &["b1".into()],
                    "改了出版社",
                )?;
                Ok::<(), crate::error::AppError>(())
            })
            .expect("record");

        let history = library.with(cover_history).expect("history");
        let summaries: Vec<_> = history.iter().map(|row| row.summary.as_str()).collect();
        assert!(summaries.contains(&"换了封面"));
        assert!(summaries.contains(&"永久删除了封面"), "purge is a cover change");
        assert!(summaries.contains(&"补了封面"), "a fill that did add a cover stays");
        assert!(!summaries.contains(&"从目录补全了 1 本"), "plain fill is not a cover change");
        assert!(!summaries.contains(&"批量改出版社：统一"));
        assert!(!summaries.contains(&"改了出版社"));
    }

    #[test]
    fn restore_puts_the_cover_back_and_preserves_the_current_one() {
        let (dir, library) = harness("covers-restore");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.retired.100.jpg"), b"old download");
        write(&covers.join("b1.dl.jpg"), b"new download");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");

        let result = library
            .with(|conn| restore(conn, &covers, &["b1.retired.100.jpg".into()]))
            .expect("restore");
        assert_eq!(result, CoverOpResult { done: 1, skipped: 0 });
        let current = library.with(|conn| repository::cover_path(conn, "b1")).expect("cover");
        assert_eq!(current, Some(covers.join("b1.dl.jpg")));
        // The cover that was in use did not vanish — it moved to retired.
        let keys: Vec<_> = library
            .with(|conn| list(conn, &covers))
            .expect("list")
            .retired
            .into_iter()
            .map(|c| c.key)
            .collect();
        assert!(keys.iter().any(|k| k.contains(".retired.") && k != "b1.retired.100.jpg"));
    }

    #[test]
    fn purge_only_removes_retired_files() {
        let (dir, library) = harness("covers-purge");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.retired.100.jpg"), b"retired");
        write(&covers.join("b1.dl.jpg"), b"active");

        let result = library
            .with(|conn| purge(conn, &covers, &["b1.retired.100.jpg".into()]))
            .expect("purge");
        assert_eq!(result.done, 1);
        assert!(!covers.join("b1.retired.100.jpg").exists());
        assert!(covers.join("b1.dl.jpg").exists(), "an active cover is never purged");
    }

    #[test]
    fn a_key_cannot_escape_the_covers_directory() {
        let (dir, library) = harness("covers-guard");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        let escaped = library.with(|conn| purge(conn, &covers, &["../books/secret.jpg".into()]));
        assert!(matches!(escaped, Err(AppError::InvalidArgument(_))));
    }

    fn insert_book(library: &Library, id: &str) {
        library
            .with_tx(|tx| {
                repository::insert(
                    tx,
                    &NewBook {
                        id,
                        title: "另一本",
                        subtitle: None,
                        description: None,
                        language: None,
                        publisher: None,
                        identifier: None,
                        format: BookFormat::Epub,
                        content_hash: id,
                        file_path: "/books/other.epub",
                        file_size: 1,
                        cover_path: None,
                        authors: &[],
                    },
                )
            })
            .expect("insert second book");
    }

    #[test]
    fn list_reports_unreferenced_downloads_as_orphans_not_active_cards() {
        let (dir, library) = harness("covers-orphan-list");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"in use");
        write(&covers.join("b2.dl.jpg"), b"orphan bytes");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("point at download");

        let data = library.with(|conn| list(conn, &covers)).expect("list");
        assert_eq!(data.active.len(), 1, "only the referenced download is active");
        assert_eq!(data.active[0].key, "b1.dl.jpg");
        assert_eq!(data.orphans.len(), 1, "the stray download is reported");
        assert_eq!(data.orphans[0].key, "b2.dl.jpg");
        assert_eq!(data.orphan_bytes, b"orphan bytes".len() as i64);
    }

    #[test]
    fn cleanup_only_removes_files_still_unreferenced_at_delete_time() {
        let (dir, library) = harness("covers-orphan-cleanup");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"reclaimed");
        write(&covers.join("b2.dl.jpg"), b"kept");

        // Between list and cleanup, b1 gets its cover back — cleanup must skip
        // it even though the UI still lists it as an orphan.
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())
            })
            .expect("reprotect");
        let result = library
            .with(|conn| cleanup_orphans(conn, &covers, &["b1.dl.jpg".into(), "b2.dl.jpg".into()]))
            .expect("cleanup");
        assert_eq!(result, CleanupResult { files: 1, bytes: b"kept".len() as i64 });
        assert!(covers.join("b1.dl.jpg").exists(), "a now-referenced file survives");
        assert!(!covers.join("b2.dl.jpg").exists());
    }

    #[test]
    fn duplicates_are_reported_for_identical_in_use_covers() {
        let (dir, library) = harness("covers-dup-report");
        insert_book(&library, "b2");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        let png = crate::document::fixture::png_bytes();
        write(&covers.join("b1.dl.png"), &png);
        write(&covers.join("b2.dl.png"), &png);
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.png").to_str().unwrap())?;
                repository::set_cover(conn, "b2", covers.join("b2.dl.png").to_str().unwrap())
            })
            .expect("point both at downloads");

        let data = library.with(|conn| list(conn, &covers)).expect("list");
        assert_eq!(data.duplicate_groups.len(), 1, "one duplicate group");
        let group = &data.duplicate_groups[0];
        assert_eq!(group.keys, vec!["b1.dl.png", "b2.dl.png"]);
        assert_eq!(group.reclaimable, group.bytes_each);
        assert_eq!(data.duplicate_bytes, group.bytes_each);
    }

    #[test]
    fn dedupe_hard_links_the_keeper_without_breaking_either_book() {
        let (dir, library) = harness("covers-dedupe");
        insert_book(&library, "b2");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        let png = crate::document::fixture::png_bytes();
        write(&covers.join("b1.dl.png"), &png);
        write(&covers.join("b2.dl.png"), &png);
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.png").to_str().unwrap())?;
                repository::set_cover(conn, "b2", covers.join("b2.dl.png").to_str().unwrap())
            })
            .expect("point both at downloads");

        let result = library
            .with(|conn| {
                dedupe(conn, &covers, "b1.dl.png", &["b1.dl.png".into(), "b2.dl.png".into()])
            })
            .expect("dedupe");
        assert_eq!(result.files, 1, "one redundant copy merged");
        // Both paths still exist — undo and retire work per book as before.
        assert!(covers.join("b1.dl.png").exists());
        assert!(covers.join("b2.dl.png").exists());
        assert_eq!(
            std::fs::read(covers.join("b2.dl.png")).expect("still readable"),
            png,
            "the merged file keeps its bytes"
        );
        let b2_path = library.with(|conn| repository::cover_path(conn, "b2")).expect("b2 path");
        assert_eq!(b2_path, Some(covers.join("b2.dl.png")), "b2 keeps its own path");
    }

    #[test]
    fn dedupe_refuses_to_merge_different_pictures() {
        let (dir, library) = harness("covers-dedupe-diff");
        insert_book(&library, "b2");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        write(&covers.join("b1.dl.jpg"), b"picture one");
        write(&covers.join("b2.dl.jpg"), b"picture two");
        library
            .with(|conn| {
                repository::set_cover(conn, "b1", covers.join("b1.dl.jpg").to_str().unwrap())?;
                repository::set_cover(conn, "b2", covers.join("b2.dl.jpg").to_str().unwrap())
            })
            .expect("point both at downloads");

        let result = library
            .with(|conn| {
                dedupe(conn, &covers, "b1.dl.jpg", &["b1.dl.jpg".into(), "b2.dl.jpg".into()])
            })
            .expect("dedupe");
        assert_eq!(result.files, 0, "different bytes are never merged");
        assert_eq!(std::fs::read(covers.join("b2.dl.jpg")).expect("b2 intact"), b"picture two");
    }

    #[test]
    fn image_size_reads_png_and_gif_headers() {
        // A PNG signature plus an IHDR with 400x600 — the only bytes the probe
        // reads. The fixture helper's PNG is signature-only, so build one here.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&0u32.to_be_bytes()); // IHDR length
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&400u32.to_be_bytes());
        png.extend_from_slice(&600u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((400, 600)));
        // A hand-built GIF header: 2x3, little-endian.
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 2, 0, 3, 0];
        assert_eq!(image_size(&gif), Some((2, 3)));
        assert_eq!(image_size(b"not an image"), None);
    }

    #[test]
    fn tiny_dimensions_are_flagged_as_placeholder() {
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 2, 0, 3, 0];
        let (w, h, placeholder) = cover_probe(&gif, 50);
        assert_eq!((w, h), (Some(2), Some(3)));
        assert!(placeholder, "a 2x3 image under 3 KB is a placeholder");
    }

    #[test]
    fn export_name_uses_the_title_and_stays_a_plain_file_name() {
        assert_eq!(export_name(Some("三体"), "b1.dl.jpg"), "三体.jpg");
        assert_eq!(export_name(Some(" Dune "), "b1.retired.1234.png"), "Dune.png");
        // Reserved characters and path separators never reach the file name.
        assert_eq!(export_name(Some("a/b:c*d?"), "b1.dl.webp"), "a_b_c_d_.webp");
        // A missing / punctuation-only title falls back instead of exporting a
        // file called just ".jpg".
        assert_eq!(export_name(None, "b1.dl.jpg"), "封面.jpg");
        assert_eq!(export_name(Some("  ...  "), "b1.dl.jpg"), "封面.jpg");
    }

    #[test]
    fn export_plan_reads_titles_and_unique_export_name_never_overwrites() {
        let (dir, library) = harness("covers-export");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).expect("covers dir");
        let plan = library
            .with(|conn| {
                Ok::<_, AppError>(export_plan(
                    conn,
                    &["b1.dl.jpg".to_string(), "../escape.jpg".to_string()],
                ))
            })
            .expect("plan");
        assert_eq!(plan, vec![("b1.dl.jpg".to_string(), "三体.jpg".to_string())]);

        let dest = dir.join("export");
        std::fs::create_dir_all(&dest).expect("export dir");
        assert_eq!(unique_export_name("三体.jpg", &dest), "三体.jpg");
        write(&dest.join("三体.jpg"), b"first");
        assert_eq!(unique_export_name("三体.jpg", &dest), "三体 (2).jpg");
        write(&dest.join("三体 (2).jpg"), b"second");
        assert_eq!(unique_export_name("三体.jpg", &dest), "三体 (3).jpg");
        std::fs::remove_dir_all(&dir).ok();
    }
}
