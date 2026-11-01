//! Whole-library backup: the data directory in one ZIP.
//!
//! WebDAV sync carries reading progress, highlights and bookmarks — the book
//! files themselves, the dictionaries, the fonts, the AI key and the reading
//! history all live in the data directory and travel nowhere. Moving to a new
//! machine therefore means re-importing every book by hand, which is what this
//! module exists to avoid.
//!
//! The archive is the data directory verbatim: one manifest plus every file
//! under it. Nothing is re-encoded, so a restore is a copy rather than a
//! re-import — no re-parsing, no re-chunking, no re-hashing, and the shelf
//! comes back with its covers, tags and reading time already in it.
//!
//! A restore cannot replace the database of the process that is running it, so
//! it happens in two steps: [`stage`] unpacks the archive into a sibling
//! directory, the app restarts, and [`apply_pending`] swaps the directories
//! over during setup — before the database is opened. The displaced library is
//! renamed to `<data dir>-previous`, never deleted: whether a restore was the
//! right call is only known afterwards, and that directory is the one copy
//! left.
//!
//! The one thing that does not travel verbatim is the credentials in `settings`:
//! the AI key, the DeepL key and the WebDAV login are blanked on the way in,
//! because "put the backup in my cloud drive" should not also mean "publish
//! every credential this machine has". Re-typing a key costs a reader a
//! minute; the endpoint, the model names and the collection URL all still
//! travel with them, so nothing else has to be set up again.

use std::fs::{self, File};
use std::io::copy;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::{DB_FILE, Library};
use crate::error::{AppError, AppResult};
use crate::library::now_seconds;
use crate::secrets::SECRET_FIELDS;

/// Identifies the archive: a ZIP has no magic of its own, so this entry is
/// what tells a backup from any other `.zip`.
const MANIFEST_ENTRY: &str = "backup.json";
const MANIFEST_FORMAT: &str = "fangce-backup";
const MANIFEST_VERSION: u32 = 1;

/// Sibling directory a restore is unpacked into.
const STAGING: &str = "-restore";
/// The same directory while it is still being written. Only a complete one is
/// renamed into place, so a restore cut short never gets applied.
const STAGING_TMP: &str = "-restore.tmp";
/// Sibling directory holding the library a restore displaced.
const PREVIOUS: &str = "-previous";

/// What one backup or restore moved.
#[derive(specta::Type, Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    /// Files written, manifest excluded.
    pub files: u64,
    /// Bytes before compression.
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    created_at: i64,
}

/// Writes the whole data directory to `dest` as one ZIP.
///
/// The database is checkpointed first: recent commits live in the write-ahead
/// log rather than in the database file, so without this the archived copy
/// would silently miss whatever had not been folded back in yet.
pub fn export(library: &Library, data_dir: &Path, dest: &Path) -> AppResult<BackupSummary> {
    library.with(|conn| {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    })?;

    let files = walk(data_dir)?;
    let mut writer = ZipWriter::new(File::create(dest)?);

    writer.start_file(MANIFEST_ENTRY, options(CompressionMethod::Deflated))?;
    serde_json::to_writer(
        &mut writer,
        &Manifest {
            format: MANIFEST_FORMAT.to_string(),
            version: MANIFEST_VERSION,
            created_at: now_seconds(),
        },
    )?;

    let mut summary = BackupSummary { files: 0, bytes: 0 };
    for (name, path) in &files {
        let size = fs::metadata(path)?.len();
        // Book files are archives already (epub, cbz) or mostly compressed
        // (pdf); deflating gigabytes of them costs minutes and buys nothing.
        // The database is the one member worth compressing.
        let method =
            if name == DB_FILE { CompressionMethod::Deflated } else { CompressionMethod::Stored };
        writer.start_file(name.as_str(), options(method))?;
        // One member is not a byte-for-byte copy: the database goes in with its
        // credentials blanked (see [`SECRET_FIELDS`]).
        let redacted = if name == DB_FILE { Some(redacted_db(library)?) } else { None };
        let mut source = File::open(redacted.as_deref().unwrap_or(path.as_path()))?;
        copy(&mut source, &mut writer)?;
        if let Some(tmp) = redacted {
            let _ = fs::remove_file(&tmp);
        }
        summary.files += 1;
        summary.bytes += size;
    }
    writer.finish()?;
    Ok(summary)
}

/// A standalone copy of the database with the credentials in `settings` blanked.
///
/// `VACUUM INTO` rather than `fs::copy`: it folds the WAL back in and hands
/// over a single file with no sidecars, so the caller has exactly one path to
/// read and one to delete. The live database is opened read-through it and
/// never written — the reader's own keys stay in place, only the archive's
/// copy loses them.
fn redacted_db(library: &Library) -> AppResult<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    let tmp = std::env::temp_dir().join(format!("fangce-backup-{}-{nanos}.db", std::process::id()));
    let _ = fs::remove_file(&tmp);
    library.with(|conn| {
        // `VACUUM INTO` takes the target as SQL text, so a quote in the path
        // would end the literal. The temp directory is the only thing we do not
        // choose here, so double it rather than trust it.
        let target = tmp.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!("VACUUM INTO '{target}'"))?;
        Ok(())
    })?;

    let conn = rusqlite::Connection::open(&tmp)?;
    // Back to a rollback journal so the writes below land in this one file and
    // the archive never has to ship a sidecar to go with it.
    conn.pragma_update(None, "journal_mode", "DELETE")?;
    for (key, _) in SECRET_FIELDS {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
            .optional()?;
        let Some(raw) = stored else { continue };
        let mut value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|err| AppError::Message(format!("设置「{key}」已损坏，未能脱敏：{err}")))?;
        // The walk lives in `secrets` so "what is encrypted" and "what a backup
        // blanks" cannot drift — including the `profileKeys.*` shape, which a
        // loop of its own here used to write out as a literal `"profileKeys.*"`
        // key while leaving the real map in the archive.
        crate::secrets::blank_secrets(key, &mut value);
        conn.execute(
            "UPDATE settings SET value = ?2 WHERE key = ?1",
            rusqlite::params![key, serde_json::to_string(&value)?],
        )?;
    }
    // Closed before the caller reads it: a WAL checkpoint happens here.
    drop(conn);
    Ok(tmp)
}

/// Unpacks a backup beside the data directory, ready for the next start.
///
/// Nothing is replaced yet — [`apply_pending`] does that on the way up.
pub fn stage(data_dir: &Path, archive: &Path) -> AppResult<BackupSummary> {
    let mut zip = ZipArchive::new(File::open(archive)?)?;

    let manifest: Manifest = serde_json::from_reader(
        zip.by_name(MANIFEST_ENTRY)
            .map_err(|_| AppError::Message("这个文件不是 方册 书库备份".into()))?,
    )?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(AppError::UnsupportedFormat(manifest.format));
    }
    if manifest.version > MANIFEST_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "备份版本 {} 高于当前支持的 {MANIFEST_VERSION}",
            manifest.version
        )));
    }
    if !zip.file_names().any(|name| name.is_ok_and(|name| name == DB_FILE)) {
        return Err(AppError::Message("备份里没有书库数据库".into()));
    }

    let tmp = sibling(data_dir, STAGING_TMP);
    let staging = sibling(data_dir, STAGING);
    for dir in [&tmp, &staging] {
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
    }
    fs::create_dir_all(&tmp)?;

    let mut summary = BackupSummary { files: 0, bytes: 0 };
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        // The manifest has said everything it has to say; unpacking it would
        // drop a stray `backup.json` into the data directory.
        // zip 9 decodes names lazily, so this is a `Result`; a name that does
        // not decode is certainly not the manifest we wrote.
        if entry.is_dir() || entry.name().is_ok_and(|name| name == MANIFEST_ENTRY) {
            continue;
        }
        // `enclosed_name` is what keeps an entry named `../../x` inside.
        let Some(name) = entry.enclosed_name() else { continue };
        let out = tmp.join(name);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&out)?;
        summary.bytes += copy(&mut entry, &mut file)?;
        summary.files += 1;
    }

    // Renamed only once every entry is on disk: a restore interrupted here
    // leaves the `.tmp` behind, and the next start discards it.
    fs::rename(&tmp, &staging)?;
    Ok(summary)
}

/// Swaps in a restore staged by [`stage`].
///
/// Runs from setup, before the database is open, because a process cannot
/// replace the database file it holds. Returns whether anything was restored.
pub fn apply_pending(data_dir: &Path) -> AppResult<bool> {
    let tmp = sibling(data_dir, STAGING_TMP);
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }

    let staging = sibling(data_dir, STAGING);
    if !staging.exists() {
        return Ok(false);
    }

    let previous = sibling(data_dir, PREVIOUS);
    if previous.exists() {
        fs::remove_dir_all(&previous)?;
    }
    fs::rename(data_dir, &previous)?;
    // Both are same-volume renames, which is as close to atomic as swapping a
    // directory gets. The second one failing would otherwise leave the app
    // starting with no data directory at all, so the original is put back.
    if let Err(err) = fs::rename(&staging, data_dir) {
        let _ = fs::rename(&previous, data_dir);
        return Err(err.into());
    }

    tracing::info!(previous = %previous.display(), "已从备份恢复书库");
    Ok(true)
}

/// Every file under `data_dir`, as its archive name.
///
/// The WAL sidecars are left out: the checkpoint folded their content into the
/// database, and `-shm` is shared memory that means nothing once the process
/// that created it is gone.
fn walk(root: &Path) -> AppResult<Vec<(String, PathBuf)>> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else { continue };
            let name = relative.to_string_lossy().replace('\\', "/");
            if name.ends_with("-wal") || name.ends_with("-shm") {
                continue;
            }
            found.push((name, path));
        }
    }
    Ok(found)
}

// ponytail: no zip64. A member over 4 GB makes `finish` fail, and these are
// book files plus one SQLite database — a realistic library is hundreds of MB.
// Add `SimpleFileOptions::large_file(true)` if anyone actually hits it.
fn options(method: CompressionMethod) -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(method)
}

/// The directory next to `dir` carrying `suffix`, on the same volume — which is
/// what makes the swap in [`apply_pending`] a rename rather than a copy.
fn sibling(dir: &Path, suffix: &str) -> PathBuf {
    match dir.file_name().map(|name| name.to_string_lossy().into_owned()) {
        Some(name) => dir.with_file_name(format!("{name}{suffix}")),
        // A data directory without a name is not a case worth more than this.
        None => dir.join(suffix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture::temp_dir;

    fn data(tag: &str) -> (PathBuf, Library) {
        let dir = temp_dir(tag);
        Layout::create(dir.clone()).expect("layout");
        let library = Library::open(&dir).expect("open library");
        (dir, library)
    }

    #[test]
    fn a_round_trip_restores_every_file_and_the_database() {
        let (dir, library) = data("backup-source");
        let books = dir.join("books");
        fs::write(books.join("one.epub"), b"book bytes").expect("write book");
        fs::create_dir_all(dir.join("covers")).expect("covers");
        fs::write(dir.join("covers/one.png"), b"cover bytes").expect("write cover");
        // A row the restore has to carry across.
        library
            .with(|conn| Ok(conn.execute("INSERT INTO tags (name) VALUES ('科幻')", [])?))
            .expect("insert");

        let archive = dir.parent().unwrap().join("backup.zip");
        let exported = export(&library, &dir, &archive).expect("export");
        assert!(archive.exists());
        // The database, the book and the cover — but not the WAL sidecars.
        assert_eq!(exported.files, 3, "{exported:?}");

        // A second, empty library: what a fresh install on the new machine
        // looks like before the restore lands.
        let (target, _) = data("backup-target");
        fs::write(target.join(DB_FILE), b"stale database").expect("stale db");
        let staged = stage(&target, &archive).expect("stage");
        assert_eq!(staged.files, exported.files);

        assert!(apply_pending(&target).expect("apply"));
        assert_eq!(fs::read_to_string(target.join("books/one.epub")).expect("book"), "book bytes");
        assert_eq!(
            fs::read_to_string(target.join("covers/one.png")).expect("cover"),
            "cover bytes"
        );
        // The database that came back is the archived one, not the stale one.
        let restored = Library::open(&target).expect("reopen");
        let tags: Vec<String> = restored
            .with(|conn| {
                let mut statement = conn.prepare("SELECT name FROM tags")?;
                let names = statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(names)
            })
            .expect("read tags");
        assert_eq!(tags, vec!["科幻".to_string()]);

        // The displaced library is kept, not dropped.
        assert!(sibling(&target, PREVIOUS).join(DB_FILE).exists());
        // And the staging directory is gone, so the next start is a no-op.
        assert!(!sibling(&target, STAGING).exists());
        assert!(!apply_pending(&target).expect("second apply"));
    }

    #[test]
    fn a_backup_travels_the_settings_but_not_the_credentials() {
        let (dir, library) = data("backup-secrets");
        crate::ai::set_config(
            &library,
            &crate::ai::AiConfig {
                api_key: "sk-do-not-leak".into(),
                model: "gpt-4o-mini".into(),
                ..Default::default()
            },
        )
        .expect("ai config");
        crate::library::sync::set_config(
            &library,
            &crate::library::sync::SyncConfig {
                url: "https://dav.example.com/dav".into(),
                username: "reader".into(),
                password: "hunter2".into(),
            },
        )
        .expect("sync config");

        let archive = dir.parent().unwrap().join("backup-secrets.zip");
        export(&library, &dir, &archive).expect("export");

        // Read the archived database back the way a restore would.
        let mut zip = ZipArchive::new(File::open(&archive).expect("open zip")).expect("zip");
        let mut bytes = Vec::new();
        {
            use std::io::Read;
            zip.by_name(DB_FILE).expect("database member").read_to_end(&mut bytes).expect("read");
        }
        let unpacked = dir.parent().unwrap().join("backup-secrets.db");
        fs::write(&unpacked, &bytes).expect("unpack");
        let conn = rusqlite::Connection::open(&unpacked).expect("open archived");
        let setting = |key: &str| -> serde_json::Value {
            let raw: String = conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
                .expect("row");
            serde_json::from_str(&raw).expect("json")
        };

        let ai = setting("ai.config");
        assert_eq!(ai["apiKey"], "", "the key must not travel");
        assert_eq!(ai["deeplKey"], "", "nor the translation key");
        // Everything that is not a secret still has to be there, or restoring
        // means re-entering the whole provider setup instead of one field.
        assert_eq!(ai["model"], "gpt-4o-mini");
        assert_eq!(ai["baseUrl"], "https://api.openai.com/v1");

        let sync = setting("sync.webdav");
        assert_eq!(sync["username"], "", "half a credential pair is useless anyway");
        assert_eq!(sync["password"], "", "the password must not travel");
        assert_eq!(sync["url"], "https://dav.example.com/dav");

        // And the live library keeps its own keys: only the archive is redacted.
        assert_eq!(crate::ai::config(&library).expect("local ai").api_key, "sk-do-not-leak");
    }

    #[test]
    fn a_zip_that_is_not_a_backup_is_refused() {
        let (dir, _library) = data("backup-refuse");
        let not_a_backup = dir.parent().unwrap().join("random.zip");
        let mut writer = ZipWriter::new(File::create(&not_a_backup).expect("create"));
        writer.start_file("hello.txt", options(CompressionMethod::Stored)).expect("start");
        std::io::Write::write_all(&mut writer, b"hello").expect("write");
        writer.finish().expect("finish");

        assert!(stage(&dir, &not_a_backup).is_err());
        assert!(!sibling(&dir, STAGING).exists());
    }
}
