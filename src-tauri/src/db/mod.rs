//! SQLite access: connection setup, PRAGMAs and the shared handle.
//!
//! There is exactly one connection, guarded by a mutex. That serializes
//! everything — reads included — which is the right trade for a single-user
//! library: it removes `SQLITE_BUSY` between our own commands entirely, and
//! every query here is a statement-sized read or one batched write.
//!
//! WAL is on for crash recovery and cheaper commits, not for concurrency: a
//! single connection cannot read while its own write transaction is open.
//! The invariant to keep is therefore about duration, not parallelism —
//! nothing slow belongs inside a [`Library::with`] closure. Parse, hash and
//! network first, then take the lock for the writes.

pub mod migrations;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, Transaction};

use crate::error::{AppError, AppResult};

/// File name of the library database inside the per-user data directory.
pub const DB_FILE: &str = "library.sqlite3";

/// Directory holding the imported source files.
const BOOKS_DIR: &str = "books";

/// Directory holding extracted cover images.
const COVERS_DIR: &str = "covers";

/// Directory holding imported dictionaries, one subdirectory per bundle.
const DICTIONARIES_DIR: &str = "dictionaries";

/// Directory holding fonts the reader imported for the reading surface.
const FONTS_DIR: &str = "fonts";

/// Freelist worth compacting, in bytes.
///
/// SQLite never gives freed pages back to the filesystem: after migration 18
/// dropped the 1.1 GB trigram index the file stayed 1.4 GB with almost all of
/// it on the freelist. `VACUUM` rewrites the database into a fresh file — on
/// that library it took 1.2 s and left 258 MB — so it is worth doing, but only
/// when there is something to win. Below this the check costs nothing and a
/// startup that just deleted three books is not made to rewrite the database.
const COMPACT_THRESHOLD_BYTES: i64 = 64 * 1024 * 1024;

/// Resolved locations under the data directory.
#[derive(Debug, Clone)]
pub struct Layout {
    pub data_dir: PathBuf,
    pub books_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub dictionaries_dir: PathBuf,
    pub fonts_dir: PathBuf,
}

impl Layout {
    /// Ensures every subdirectory exists. Called once during startup.
    pub fn create(data_dir: PathBuf) -> AppResult<Self> {
        let books_dir = data_dir.join(BOOKS_DIR);
        let covers_dir = data_dir.join(COVERS_DIR);
        let dictionaries_dir = data_dir.join(DICTIONARIES_DIR);
        let fonts_dir = data_dir.join(FONTS_DIR);
        std::fs::create_dir_all(&books_dir)?;
        std::fs::create_dir_all(&covers_dir)?;
        std::fs::create_dir_all(&dictionaries_dir)?;
        std::fs::create_dir_all(&fonts_dir)?;
        Ok(Self { data_dir, books_dir, covers_dir, dictionaries_dir, fonts_dir })
    }
}

/// The shared library database.
///
/// Cloning is cheap: every clone talks to the same connection, so a command can
/// hand one to a blocking task without borrowing application state.
#[derive(Clone)]
pub struct Library {
    conn: Arc<Mutex<Connection>>,
}

impl Library {
    /// Opens (or creates) the database, applies pending migrations and tunes
    /// the connection.
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        let path = data_dir.join(DB_FILE);
        let mut conn = Connection::open(&path)?;

        // `execute_batch` rather than `pragma_update` because these pragmas take
        // keyword values that bind awkwardly as parameters.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA temp_store = MEMORY;",
        )?;

        let mode: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(AppError::Message(format!("无法启用 WAL 模式，当前日志模式为 {mode}")));
        }

        let version = migrations::migrate(&mut conn)?;
        tracing::info!(path = %path.display(), schema = version, "书库数据库已就绪");

        // After the migration, not inside it: `VACUUM` may not run in a
        // transaction, and the migration that freed a gigabyte committed
        // already. Never fatal — a database with holes in it still works, and a
        // full disk must not stop the reader from opening.
        if let Err(err) = compact_if_fragmented(&conn) {
            tracing::warn!(error = %err, "回收空闲页失败，数据库照常使用");
        }

        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Opens an existing database for a second process, without migrating it.
    ///
    /// The `fangce --mcp` path. The app owns this schema, and a tool server
    /// that migrated the file out from under a running app would be two writers
    /// agreeing on nothing — so this one never migrates and never compacts.
    ///
    /// `writable` is the connection's own ceiling, and it is deliberately
    /// stricter than the tool grant: a connection opened read-only refuses
    /// every write at the SQLite level (`PRAGMA query_only`), so a grant layer
    /// that lets something through by mistake still cannot change a row. The
    /// default grant is read-only, so the default connection is too.
    ///
    /// ⚠️ This was `query_only` unconditionally at first, which made every
    /// write tool answer `attempt to write a readonly database` — the unit
    /// tests used [`Library::open`] and never noticed. `writable: true` is what
    /// a granted connection gets; there is a test for both ends.
    ///
    /// `journal_mode` is not set here on purpose. WAL is a property of the file
    /// once it has been set, and setting it again is a write.
    pub fn open_existing(data_dir: &Path, writable: bool) -> AppResult<Self> {
        let path = data_dir.join(DB_FILE);
        if !path.exists() {
            return Err(AppError::Message(format!(
                "书库还没有建立：{} 不存在。先用方册打开一次，再启动工具服务。",
                path.display()
            )));
        }
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA temp_store = MEMORY;",
        )?;
        if !writable {
            conn.execute_batch("PRAGMA query_only = ON;")?;
        }
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Runs `f` with the shared connection.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self.lock()?;
        f(&guard)
    }

    /// Runs `f` inside a single transaction. Changes commit only when `f`
    /// returns `Ok`.
    pub fn with_tx<T>(&self, f: impl FnOnce(&Transaction<'_>) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.lock()?;
        let tx = guard.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::poisoned("library"))
    }
}

/// Where the app keeps its data, resolved without a running Tauri app.
///
/// `--mcp` runs in a bare process: no window, no webview, no `App` to ask.
/// Tauri's `app_data_dir()` is `<OS data dir>/<bundle identifier>`, and that
/// rule is reproduced here rather than guessed at — a tool server that read a
/// different directory than the app writes would be worse than no tool server.
///
/// `FANGCE_DATA_DIR` overrides it, which is what a second library (a test one,
/// a portable install) needs.
pub fn data_dir() -> AppResult<PathBuf> {
    if let Some(dir) = std::env::var_os("FANGCE_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    // Must match `identifier` in `tauri.conf.json` — the same string
    // `secrets.rs` keeps for the keychain entry, and for the same reason: it is
    // this app's name on this machine.
    const IDENTIFIER: &str = "dev.xlong.fangce";

    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
    });

    let base = base.ok_or_else(|| AppError::Message("找不到用户数据目录".into()))?;
    Ok(base.join(IDENTIFIER))
}

/// Rewrites the database when a large share of its file is free pages.
///
/// Called once at startup. A library whose index was just dropped is the case
/// this exists for; a library that has been deleting books for a year is the
/// same case, slower.
fn compact_if_fragmented(conn: &Connection) -> AppResult<()> {
    let free: i64 = conn.pragma_query_value(None, "freelist_count", |row| row.get(0))?;
    let page: i64 = conn.pragma_query_value(None, "page_size", |row| row.get(0))?;
    let reclaimable = free.saturating_mul(page);
    if reclaimable < COMPACT_THRESHOLD_BYTES {
        return Ok(());
    }
    let started = std::time::Instant::now();
    conn.execute_batch("VACUUM")?;
    tracing::info!(
        freed_mb = reclaimable / 1024 / 1024,
        took_ms = started.elapsed().as_millis() as u64,
        "回收了空闲页"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Harness {
        dir: PathBuf,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let library = Library::open(&dir).expect("open library");
            Self { dir, library }
        }

        fn keys(&self) -> Vec<String> {
            self.library
                .with(|conn| {
                    let mut stmt = conn.prepare("SELECT key FROM settings ORDER BY key")?;
                    let rows = stmt.query_map([], |row| row.get(0))?;
                    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
                })
                .expect("read back")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// The contract every `with_tx` caller leans on — sync's apply pass most of
    /// all, where books, highlights and bookmarks have to land together or not
    /// at all. Pins that a write made before the error does not survive it.
    /// The two ends of [`Library::open_existing`], and the reason `writable`
    /// exists at all.
    ///
    /// The tool server's first version opened every connection `query_only`,
    /// including the one behind a granted write — every write tool answered
    /// `attempt to write a readonly database` in production while the unit
    /// tests, which used [`Library::open`], stayed green.
    #[test]
    fn a_second_handle_writes_only_when_it_was_opened_for_writing() {
        let dir = crate::document::fixture::temp_dir("db-second-handle");
        {
            let app = Library::open(&dir).expect("open");
            app.with(|conn| {
                Ok(conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 1)",
                    [],
                )?)
            })
            .expect("seed");
        }

        let read_only = Library::open_existing(&dir, false).expect("read-only handle");
        let refused = read_only.with(|conn| {
            Ok(conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES ('k2', 'v', 1)",
                [],
            )?)
        });
        assert!(refused.is_err(), "只读句柄必须拒绝写入：{refused:?}");
        drop(read_only);

        let writable = Library::open_existing(&dir, true).expect("writable handle");
        writable
            .with(|conn| {
                Ok(conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('k3', 'v', 1)",
                    [],
                )?)
            })
            .expect("被授予写权限的句柄必须能写");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_transaction_leaves_nothing_behind() {
        let h = Harness::new("db-tx-rollback");
        h.library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('a', '1', 1)",
                    [],
                )?;
                Ok(())
            })
            .expect("seed");

        let failed: AppResult<()> = h.library.with_tx(|tx| {
            tx.execute("INSERT INTO settings (key, value, updated_at) VALUES ('b', '2', 1)", [])?;
            Err(AppError::Message("中途失败".into()))
        });
        assert!(failed.is_err());

        assert_eq!(h.keys(), vec!["a".to_string()]);
    }
}
