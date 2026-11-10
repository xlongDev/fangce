//! WebDAV sync for reading progress, highlights and bookmarks.
//!
//! One JSON document (`state.json`) lives in a user-chosen WebDAV collection.
//! Books are keyed by `content_hash`, so the same book file on two machines
//! maps to the same entry with no central registry. Highlights and bookmarks
//! are keyed by their own UUID, which the creating device mints once and every
//! other device adopts verbatim, so the same key identifies the same item
//! everywhere. Each is last-writer-wins by its own `updated_at`, ties go to the
//! remote, and a deletion beats a live copy at the same timestamp so a remove
//! is never undone by a stale record. Every decision is reported back so "not a
//! blind overwrite" is visible in the UI. A remote document that fails to parse
//! aborts the sync: overwriting a corrupt-but-recoverable state file with ours
//! would destroy the other device's data.
//!
//! Password lives in SQLite next to the AI key, for the same reason: the
//! renderer must never hold backend-owned secrets. Both are sealed at rest
//! under a key the OS credential store holds — see `crate::secrets`.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::{annotations, bookmarks};
use crate::secrets;

/// Where the state document lives and how to sign in.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// WebDAV collection, e.g. `https://dav.example.com/dav/方册`.
    pub url: String,
    /// Empty means the server needs no authentication.
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

const KEY: &str = "sync.webdav";
const DEVICE_KEY: &str = "sync.device_id";
const STATE_FILE: &str = "state.json";

/// Persisted config, or blanks when nothing has been saved yet.
pub fn config(library: &Library) -> AppResult<SyncConfig> {
    match secrets::read_json(library, KEY)? {
        Some(value) => serde_json::from_value(value)
            .map_err(|err| AppError::Message(format!("同步配置已损坏，请重新填写：{err}"))),
        None => Ok(SyncConfig::default()),
    }
}

/// Writes the config back after trimming; the URL shape is validated here.
pub fn set_config(library: &Library, next: &SyncConfig) -> AppResult<SyncConfig> {
    let stored = SyncConfig {
        url: normalize_url(&next.url)?,
        username: next.username.trim().to_string(),
        password: next.password.clone(),
    };
    secrets::write_json(library, KEY, &serde_json::to_value(&stored)?)?;
    Ok(stored)
}

/// Same transport rule as the AI endpoint: TLS everywhere, loopback may use
/// plain HTTP because a local WebDAV server is still a legitimate setup.
pub(crate) fn normalize_url(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::InvalidArgument("服务器地址不能为空".into()));
    }
    let is_loopback_http = trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://[::1]");
    if !trimmed.starts_with("https://") && !is_loopback_http {
        return Err(AppError::InvalidArgument(
            "服务器地址必须是 https，本机服务可用 http://localhost".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// The stable id this installation signs state writes with.
pub fn device_id(library: &Library) -> AppResult<String> {
    library.with(|conn| {
        let stored: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [DEVICE_KEY], |row| row.get(0))
            .optional()?;
        if let Some(id) = stored {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![DEVICE_KEY, id, crate::library::now_seconds()],
        )?;
        Ok(id)
    })
}

/// One book's synced position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBook {
    pub progress: f64,
    /// Unix seconds of the last write to this entry.
    pub updated_at: i64,
    /// Device that produced this entry, for human inspection only.
    pub device_id: String,
    /// Book title so devices without the book can still show something.
    #[serde(default)]
    pub title: String,
}

/// State-document layout version. v2 added the annotation and bookmark maps;
/// a v1 file (progress only) still parses because the new maps default empty.
pub const STATE_VERSION: u32 = 2;

/// The cloud document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub version: u32,
    pub device_id: String,
    pub updated_at: i64,
    /// Keyed by `content_hash`; a BTreeMap keeps the serialized form stable.
    pub books: BTreeMap<String, RemoteBook>,
    /// Keyed by annotation UUID. Absent in a v1 document.
    #[serde(default)]
    pub annotations: BTreeMap<String, annotations::SyncAnnotation>,
    /// Keyed by bookmark UUID. Absent in a v1 document.
    #[serde(default)]
    pub bookmarks: BTreeMap<String, bookmarks::SyncBookmark>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            device_id: String::new(),
            updated_at: 0,
            books: BTreeMap::new(),
            annotations: BTreeMap::new(),
            bookmarks: BTreeMap::new(),
        }
    }
}

/// What the local database knows about one read book.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalBook {
    pub content_hash: String,
    pub title: String,
    /// 0..1.
    pub progress: f64,
    /// Unix seconds.
    pub updated_at: i64,
}

/// What the merge decided for one book. Struct variants so the serialized
/// form is a flat `{ decision, title, progress }` object.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "decision")]
pub enum Change {
    /// Only the local side knew this position; it went up.
    Uploaded { title: String, progress: f64 },
    /// The remote entry was newer and has been applied to the local database.
    Downloaded { title: String, progress: f64 },
    /// The remote holds a book this device has not imported; left untouched.
    RemoteOnly { title: String, progress: f64 },
    /// Both sides agree.
    Unchanged { title: String, progress: f64 },
}

impl Change {
    pub fn title(&self) -> &str {
        match self {
            Change::Uploaded { title, .. }
            | Change::Downloaded { title, .. }
            | Change::RemoteOnly { title, .. }
            | Change::Unchanged { title, .. } => title,
        }
    }
}

/// Pure merge: the union of both sides with per-book last-writer-wins.
///
/// Ties go to the remote so two devices syncing in the same second converge
/// instead of flip-flopping. The returned state is what should be PUT back.
pub fn merge(
    local: &[LocalBook],
    remote: Option<RemoteState>,
    device_id: &str,
    now: i64,
) -> (RemoteState, Vec<Change>) {
    let mut state = remote.unwrap_or_default();
    state.version = STATE_VERSION;
    state.device_id = device_id.to_string();
    state.updated_at = now;

    let mut changes = Vec::new();
    for book in local {
        let entry = RemoteBook {
            progress: book.progress.clamp(0.0, 1.0),
            updated_at: book.updated_at,
            device_id: device_id.to_string(),
            title: book.title.clone(),
        };
        match state.books.get(&book.content_hash) {
            None => {
                state.books.insert(book.content_hash.clone(), entry);
                changes
                    .push(Change::Uploaded { title: book.title.clone(), progress: book.progress });
            }
            Some(cloud) => {
                // Position equality decides first: comparing wall clocks when
                // both sides agree would churn an upload on every sync.
                let same = (cloud.progress - book.progress).abs() < f64::EPSILON;
                if same {
                    changes.push(Change::Unchanged {
                        title: book.title.clone(),
                        progress: book.progress,
                    });
                } else if cloud.updated_at >= book.updated_at {
                    changes.push(Change::Downloaded {
                        title: book.title.clone(),
                        progress: cloud.progress,
                    });
                } else {
                    state.books.insert(book.content_hash.clone(), entry);
                    changes.push(Change::Uploaded {
                        title: book.title.clone(),
                        progress: book.progress,
                    });
                }
            }
        }
    }

    // Books the local library has never seen stay in the state for the device
    // that does have them.
    for (hash, cloud) in &state.books {
        if !local.iter().any(|book| &book.content_hash == hash) {
            changes.push(Change::RemoteOnly {
                title: if cloud.title.is_empty() { hash.clone() } else { cloud.title.clone() },
                progress: cloud.progress,
            });
        }
    }
    changes.sort_by(|a, b| a.title().cmp(b.title()));
    (state, changes)
}

/// Reads every book the user has actually opened.
///
/// `books_live`, not `books`: pushing the position of a book that is in the
/// trash would resurrect it on the other device, which is the one thing a
/// device-local delete must not do.
pub fn local_books(conn: &rusqlite::Connection) -> AppResult<Vec<LocalBook>> {
    let mut stmt = conn.prepare(
        "SELECT content_hash, title, progress, last_read_at FROM books_live
          WHERE last_read_at IS NOT NULL ORDER BY title",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(LocalBook {
            content_hash: row.get(0)?,
            title: row.get(1)?,
            progress: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

/// Applies one downloaded position; `false` when the book is not imported here.
pub fn apply_downloaded(
    conn: &rusqlite::Connection,
    hash: &str,
    book: &RemoteBook,
) -> AppResult<bool> {
    let changed = conn.execute(
        "UPDATE books SET progress = ?1, last_read_at = ?2, updated_at = ?3
          WHERE content_hash = ?4",
        rusqlite::params![
            book.progress.clamp(0.0, 1.0),
            book.updated_at,
            crate::library::now_seconds(),
            hash
        ],
    )?;
    Ok(changed > 0)
}

/// Counts of what a merge did to one kind of item, for the sync report.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
}

/// Everything one `sync.now` did: the per-book decisions plus highlight and
/// bookmark tallies. The latter are counts, not lists — a library can hold
/// hundreds of highlights and listing each would drown the panel.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub books: Vec<Change>,
    pub annotations: Tally,
    pub bookmarks: Tally,
}

/// Every `content_hash` this device has imported.
///
/// The table, not the view: a trashed book still occupies its hash, and the
/// merge uses this set to decide which remote entries can be applied at all.
pub fn local_hashes(conn: &rusqlite::Connection) -> AppResult<BTreeSet<String>> {
    let mut stmt = conn.prepare("SELECT content_hash FROM books")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<BTreeSet<_>>>()?)
}

/// Last-writer-wins by `updated_at`; a tie goes to the remote, except that a
/// deletion beats a live copy at the same timestamp, so a removal is never
/// undone by a stale record that happens to share its second.
fn local_wins(local_at: i64, local_deleted: bool, remote_at: i64, remote_deleted: bool) -> bool {
    local_at > remote_at || (local_at == remote_at && local_deleted && !remote_deleted)
}

/// Pure merge of the highlight maps: union by id, last-writer-wins, deletions
/// carried as tombstones.
///
/// Returns the state to upload, what the merge did, and the writes to apply
/// locally. A highlight is only written locally when its book is imported here;
/// otherwise the entry stays in the state for the device that does have it.
///
/// ponytail: identity is the UUID, not the anchored range, so highlighting the
/// same passage on two devices offline yields two entries. Folding by
/// (book, chapter, range) would dedupe it at the cost of a second key model;
/// not worth it until someone actually reports the duplicate.
pub fn merge_annotations(
    local: Vec<annotations::SyncAnnotation>,
    remote: BTreeMap<String, annotations::SyncAnnotation>,
    local_hashes: &BTreeSet<String>,
) -> (
    BTreeMap<String, annotations::SyncAnnotation>,
    Tally,
    Vec<annotations::SyncAnnotation>,
    Vec<String>,
) {
    let mut state = remote;
    let mut tally = Tally::default();
    let mut upsert = Vec::new();
    let mut delete = Vec::new();
    let mut seen = HashSet::new();

    for entry in local {
        seen.insert(entry.id.clone());
        match state.get(&entry.id) {
            None => {
                tally.uploaded += 1;
                state.insert(entry.id.clone(), entry);
            }
            Some(cloud) => {
                if entry.same_payload(cloud) {
                    // Nothing to move; keep the later clock so the next
                    // comparison is not decided by a stale timestamp.
                    if entry.updated_at > cloud.updated_at {
                        state.insert(entry.id.clone(), entry);
                    }
                } else if local_wins(
                    entry.updated_at,
                    entry.deleted,
                    cloud.updated_at,
                    cloud.deleted,
                ) {
                    tally.uploaded += 1;
                    state.insert(entry.id.clone(), entry);
                } else if cloud.deleted {
                    tally.deleted += 1;
                    delete.push(cloud.id.clone());
                } else {
                    tally.downloaded += 1;
                    upsert.push(cloud.clone());
                }
            }
        }
    }

    // Remote-only entries: downloaded when the book is here, otherwise left in
    // the state untouched. A tombstone for something this device never had
    // needs no local action either way.
    for (id, cloud) in &state {
        if seen.contains(id) || cloud.deleted {
            continue;
        }
        if local_hashes.contains(&cloud.book) {
            tally.downloaded += 1;
            upsert.push(cloud.clone());
        }
    }

    (state, tally, upsert, delete)
}

/// Pure merge of the bookmark maps. Same rules as [`merge_annotations`].
pub fn merge_bookmarks(
    local: Vec<bookmarks::SyncBookmark>,
    remote: BTreeMap<String, bookmarks::SyncBookmark>,
    local_hashes: &BTreeSet<String>,
) -> (BTreeMap<String, bookmarks::SyncBookmark>, Tally, Vec<bookmarks::SyncBookmark>, Vec<String>) {
    let mut state = remote;
    let mut tally = Tally::default();
    let mut upsert = Vec::new();
    let mut delete = Vec::new();
    let mut seen = HashSet::new();

    for entry in local {
        seen.insert(entry.id.clone());
        match state.get(&entry.id) {
            None => {
                tally.uploaded += 1;
                state.insert(entry.id.clone(), entry);
            }
            Some(cloud) => {
                if entry.same_payload(cloud) {
                    if entry.updated_at > cloud.updated_at {
                        state.insert(entry.id.clone(), entry);
                    }
                } else if local_wins(
                    entry.updated_at,
                    entry.deleted,
                    cloud.updated_at,
                    cloud.deleted,
                ) {
                    tally.uploaded += 1;
                    state.insert(entry.id.clone(), entry);
                } else if cloud.deleted {
                    tally.deleted += 1;
                    delete.push(cloud.id.clone());
                } else {
                    tally.downloaded += 1;
                    upsert.push(cloud.clone());
                }
            }
        }
    }

    for (id, cloud) in &state {
        if seen.contains(id) || cloud.deleted {
            continue;
        }
        if local_hashes.contains(&cloud.book) {
            tally.downloaded += 1;
            upsert.push(cloud.clone());
        }
    }

    (state, tally, upsert, delete)
}

fn state_url(dir_url: &str) -> String {
    format!("{dir_url}/{STATE_FILE}")
}

/// Cumulative collection URLs to MKCOL, first missing ancestor first.
pub(crate) fn collection_urls(dir_url: &str) -> Vec<String> {
    let Some(host_end) = dir_url.find("://") else { return Vec::new() };
    let Some(path_start) = dir_url[host_end + 3..].find('/') else { return Vec::new() };
    let path_start = host_end + 3 + path_start;
    let (base, path) = dir_url.split_at(path_start);
    let mut urls = Vec::new();
    let mut current = String::from(base);
    for segment in path.trim_start_matches('/').split('/') {
        if segment.is_empty() {
            continue;
        }
        current.push('/');
        current.push_str(segment);
        urls.push(current.clone());
    }
    urls
}

fn http() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

/// GET + MKCOL + PUT against WebDAV, with basic auth when a username is set.
struct Dav<'a> {
    client: reqwest::Client,
    config: &'a SyncConfig,
}

impl Dav<'_> {
    fn new(config: &SyncConfig) -> AppResult<Dav<'_>> {
        Ok(Dav { client: http()?, config })
    }

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.auth(self.client.get(url))
    }

    fn auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.config.username.is_empty() {
            builder
        } else {
            builder.basic_auth(&self.config.username, Some(&self.config.password))
        }
    }

    /// Fetches the state document; `None` when it does not exist yet.
    async fn pull(&self) -> AppResult<Option<RemoteState>> {
        let url = state_url(&self.config.url);
        let response = self.get(&url).send().await.map_err(net_error)?;
        match response.status() {
            reqwest::StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => {
                let body = response.text().await.map_err(net_error)?;
                // A document we cannot understand must never be overwritten.
                serde_json::from_str(&body).map(Some).map_err(|err| {
                    AppError::Message(format!("云端状态文件无法解析，已中止同步：{err}"))
                })
            }
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                Err(AppError::InvalidArgument("WebDAV 用户名或密码不对".into()))
            }
            status => Err(AppError::Message(format!("读取云端状态失败：HTTP {status}"))),
        }
    }

    /// Creates any missing ancestor collections, then PUTs the document.
    async fn push(&self, state: &RemoteState) -> AppResult<()> {
        for url in collection_urls(&self.config.url) {
            // An existing collection answers 405; any other failure surfaces
            // for real at PUT time.
            let method =
                reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL is a valid HTTP method");
            let _ = self.auth(self.client.request(method, &url)).send().await;
        }
        let body = serde_json::to_string(state)?;
        let response = self
            .get(&state_url(&self.config.url))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(net_error)?;
        match response.status() {
            status if status.is_success() => Ok(()),
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                Err(AppError::InvalidArgument("WebDAV 用户名或密码不对".into()))
            }
            status => Err(AppError::Message(format!("上传云端状态失败：HTTP {status}"))),
        }
    }
}

fn net_error(err: reqwest::Error) -> AppError {
    AppError::Message(format!("WebDAV 请求失败：{err}"))
}

/// Proves the server is reachable and the credentials work. Does not save.
pub async fn test_connection(config: &SyncConfig) -> AppResult<()> {
    let checked = SyncConfig { url: normalize_url(&config.url)?, ..config.clone() };
    let dav = Dav::new(&checked)?;
    // 404 is a success here: reachable, authorized, no state yet.
    dav.pull().await.map(|_| ())
}

/// The full sync cycle: pull, merge progress + highlights + bookmarks, apply
/// what the remote won, push.
pub async fn run(library: &Library, config: &SyncConfig) -> AppResult<SyncReport> {
    let checked = SyncConfig { url: normalize_url(&config.url)?, ..config.clone() };
    let dav = Dav::new(&checked)?;
    let device = device_id(library)?;
    let remote = dav.pull().await?;

    let (state, report) = {
        // One lock, four reads. The merge picks a winner per row by timestamp,
        // so those rows have to come from one snapshot: reading them in
        // separate turns lets a concurrent local edit land between two of them
        // and get merged against a half-updated picture.
        let (local, hashes, local_annotations, local_bookmarks) = library.with(|conn| {
            Ok((
                local_books(conn)?,
                local_hashes(conn)?,
                annotations::for_sync(conn)?,
                bookmarks::for_sync(conn)?,
            ))
        })?;

        let (mut state, books) = merge(&local, remote, &device, crate::library::now_seconds());

        let (annotations_state, annotation_tally, annotation_upserts, annotation_deletes) =
            merge_annotations(local_annotations, std::mem::take(&mut state.annotations), &hashes);
        state.annotations = annotations_state;

        let (bookmarks_state, bookmark_tally, bookmark_upserts, bookmark_deletes) =
            merge_bookmarks(local_bookmarks, std::mem::take(&mut state.bookmarks), &hashes);
        state.bookmarks = bookmarks_state;

        // Books, highlights and bookmarks are one logical state. Applied
        // statement by statement, a failure on any single row would commit the
        // rows before it and drop the rest — and the next pull would then
        // re-apply that winning half on top of local rows that never lost.
        library.with_tx(|tx| {
            for (hash, book) in &state.books {
                apply_downloaded(tx, hash, book)?;
            }
            for entry in &annotation_upserts {
                annotations::apply_remote(tx, entry)?;
            }
            for id in &annotation_deletes {
                annotations::remove(tx, id)?;
            }
            for entry in &bookmark_upserts {
                bookmarks::apply_remote(tx, entry)?;
            }
            for id in &bookmark_deletes {
                bookmarks::remove(tx, id)?;
            }
            Ok(())
        })?;

        (state, SyncReport { books, annotations: annotation_tally, bookmarks: bookmark_tally })
    };
    dav.push(&state).await?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(hash: &str, title: &str, progress: f64, at: i64) -> LocalBook {
        LocalBook { content_hash: hash.into(), title: title.into(), progress, updated_at: at }
    }

    #[test]
    fn a_local_only_position_goes_up() {
        let (state, changes) = merge(&[book("h1", "三体", 0.5, 100)], None, "dev", 200);
        assert_eq!(state.version, STATE_VERSION);
        assert_eq!(state.device_id, "dev");
        assert_eq!(state.books["h1"].progress, 0.5);
        assert_eq!(changes, vec![Change::Uploaded { title: "三体".into(), progress: 0.5 }]);
    }

    #[test]
    fn a_newer_cloud_entry_wins_and_is_reported() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.8,
                updated_at: 300,
                device_id: "other".into(),
                title: "三体".into(),
            },
        );
        let (state, changes) = merge(&[book("h1", "三体", 0.5, 100)], Some(state), "dev", 400);
        assert_eq!(state.books["h1"].progress, 0.8, "云端较新时本地不得覆盖");
        assert_eq!(changes, vec![Change::Downloaded { title: "三体".into(), progress: 0.8 }]);
    }

    #[test]
    fn a_newer_local_entry_wins() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.2,
                updated_at: 50,
                device_id: "other".into(),
                title: "三体".into(),
            },
        );
        let (state, changes) = merge(&[book("h1", "三体", 0.6, 100)], Some(state), "dev", 400);
        assert_eq!(state.books["h1"].progress, 0.6);
        assert_eq!(changes, vec![Change::Uploaded { title: "三体".into(), progress: 0.6 }]);
    }

    #[test]
    fn a_tie_goes_to_the_cloud_so_devices_converge() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.4,
                updated_at: 100,
                device_id: "other".into(),
                title: "三体".into(),
            },
        );
        let (_, changes) = merge(&[book("h1", "三体", 0.6, 100)], Some(state), "dev", 400);
        assert_eq!(changes, vec![Change::Downloaded { title: "三体".into(), progress: 0.4 }]);
    }

    #[test]
    fn identical_sides_are_unchanged_even_when_the_local_clock_is_newer() {
        let mut state = RemoteState::default();
        state.books.insert(
            "h1".into(),
            RemoteBook {
                progress: 0.5,
                updated_at: 100,
                device_id: "dev".into(),
                title: "三体".into(),
            },
        );
        // Same position, different wall clock: no upload churn.
        let (_, changes) = merge(&[book("h1", "三体", 0.5, 150)], Some(state), "dev", 400);
        assert_eq!(changes, vec![Change::Unchanged { title: "三体".into(), progress: 0.5 }]);
    }

    #[test]
    fn cloud_books_missing_locally_stay_listed() {
        let mut state = RemoteState::default();
        state.books.insert(
            "elsewhere".into(),
            RemoteBook {
                progress: 0.9,
                updated_at: 100,
                device_id: "other".into(),
                title: "只在那台设备上".into(),
            },
        );
        let (state, changes) = merge(&[], Some(state), "dev", 200);
        assert_eq!(state.books["elsewhere"].progress, 0.9, "别的设备的书不能被抹掉");
        assert_eq!(
            changes,
            vec![Change::RemoteOnly { title: "只在那台设备上".into(), progress: 0.9 }]
        );
    }

    #[test]
    fn the_state_file_sits_in_the_configured_collection() {
        assert_eq!(state_url("https://dav.x.com/dav/CR"), "https://dav.x.com/dav/CR/state.json");
    }

    #[test]
    fn every_missing_ancestor_is_created_in_order() {
        assert_eq!(
            collection_urls("https://dav.x.com/dav/CR"),
            ["https://dav.x.com/dav", "https://dav.x.com/dav/CR"]
        );
        assert!(collection_urls("https://dav.x.com").is_empty());
        assert!(collection_urls("not a url").is_empty());
    }

    #[test]
    fn urls_obey_the_tls_rule() {
        assert!(normalize_url("https://dav.x.com/dav/").is_ok());
        assert!(normalize_url("http://localhost:8080/dav").is_ok());
        assert!(normalize_url("http://dav.x.com").is_err());
        assert!(normalize_url("  ").is_err());
    }

    fn ann(id: &str, at: i64) -> annotations::SyncAnnotation {
        annotations::SyncAnnotation {
            id: id.into(),
            book: "h".into(),
            chapter_idx: 0,
            start_char: 0,
            end_char: 3,
            text: "hi".into(),
            cfi: None,
            color: None,
            style: None,
            note: None,
            updated_at: at,
            deleted: false,
        }
    }

    fn grave(id: &str, at: i64) -> annotations::SyncAnnotation {
        annotations::SyncAnnotation {
            id: id.into(),
            book: String::new(),
            chapter_idx: 0,
            start_char: 0,
            end_char: 0,
            text: String::new(),
            cfi: None,
            color: None,
            style: None,
            note: None,
            updated_at: at,
            deleted: true,
        }
    }

    fn imported() -> BTreeSet<String> {
        ["h".to_string()].into_iter().collect()
    }

    fn none() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn a_local_only_highlight_is_uploaded() {
        let (state, tally, upsert, delete) =
            merge_annotations(vec![ann("a", 100)], BTreeMap::new(), &imported());
        assert_eq!(state["a"].updated_at, 100);
        assert_eq!(tally, Tally { uploaded: 1, downloaded: 0, deleted: 0 });
        assert!(upsert.is_empty(), "自己的东西不需要写回本地");
        assert!(delete.is_empty());
    }

    #[test]
    fn a_newer_remote_highlight_is_applied_locally() {
        let mut cloud = ann("a", 200);
        cloud.note = Some("云端写的".into());
        let (state, tally, upsert, delete) = merge_annotations(
            vec![ann("a", 100)],
            BTreeMap::from([("a".to_string(), cloud)]),
            &imported(),
        );
        assert_eq!(state["a"].note.as_deref(), Some("云端写的"));
        assert_eq!(tally, Tally { uploaded: 0, downloaded: 1, deleted: 0 });
        assert_eq!(upsert.len(), 1);
        assert_eq!(upsert[0].id, "a");
        assert!(delete.is_empty());
    }

    #[test]
    fn a_local_edit_wins_over_an_older_remote_copy() {
        let mut mine = ann("a", 300);
        mine.note = Some("本地改过".into());
        let mut cloud = ann("a", 200);
        cloud.note = Some("旧的".into());
        let (state, tally, upsert, _) =
            merge_annotations(vec![mine], BTreeMap::from([("a".to_string(), cloud)]), &imported());
        assert_eq!(state["a"].note.as_deref(), Some("本地改过"));
        assert_eq!(tally.uploaded, 1);
        assert!(upsert.is_empty());
    }

    #[test]
    fn identical_highlights_do_not_churn() {
        // Same payload, only the clock differs: nothing to move, but the later
        // clock is kept so a future comparison is not decided by a stale stamp.
        let (state, tally, upsert, delete) = merge_annotations(
            vec![ann("a", 100)],
            BTreeMap::from([("a".to_string(), ann("a", 250))]),
            &imported(),
        );
        assert_eq!(state["a"].updated_at, 250);
        assert_eq!(tally, Tally::default());
        assert!(upsert.is_empty() && delete.is_empty());
    }

    #[test]
    fn a_remote_tombstone_removes_the_local_highlight() {
        let (state, tally, upsert, delete) = merge_annotations(
            vec![ann("a", 100)],
            BTreeMap::from([("a".to_string(), grave("a", 300))]),
            &imported(),
        );
        assert!(state["a"].deleted, "墓碑要留在状态里，否则下次又会被拉回来");
        assert_eq!(tally, Tally { uploaded: 0, downloaded: 0, deleted: 1 });
        assert_eq!(delete, vec!["a".to_string()]);
        assert!(upsert.is_empty());
    }

    #[test]
    fn a_tombstone_beats_a_live_copy_at_the_same_timestamp() {
        let (state, tally, _, delete) = merge_annotations(
            vec![ann("a", 100)],
            BTreeMap::from([("a".to_string(), grave("a", 100))]),
            &imported(),
        );
        assert!(state["a"].deleted, "平局时删除必须获胜，否则删了又活");
        assert_eq!(tally.deleted, 1);
        assert_eq!(delete, vec!["a".to_string()]);
    }

    #[test]
    fn a_local_tombstone_propagates() {
        let (state, tally, upsert, delete) = merge_annotations(
            vec![grave("a", 300)],
            BTreeMap::from([("a".to_string(), ann("a", 100))]),
            &imported(),
        );
        assert!(state["a"].deleted);
        assert_eq!(tally.uploaded, 1, "本地删除要传上去");
        assert!(upsert.is_empty() && delete.is_empty(), "本地早已删过，不需要再删");
    }

    #[test]
    fn a_remote_highlight_for_an_unimported_book_is_kept_but_not_applied() {
        let mut cloud = ann("a", 200);
        cloud.book = "elsewhere".into();
        let (state, tally, upsert, _) =
            merge_annotations(Vec::new(), BTreeMap::from([("a".to_string(), cloud)]), &none());
        assert!(state.contains_key("a"), "别的设备的书上的标注不能被抹掉");
        assert!(upsert.is_empty(), "书没导入，写不进去");
        assert_eq!(tally, Tally::default(), "没有真的应用就不该报数");
    }

    #[test]
    fn a_v1_document_without_the_new_maps_still_parses() {
        let json = r#"{"version":1,"deviceId":"other","updatedAt":5,
            "books":{"h":{"progress":0.4,"updatedAt":9,"deviceId":"other","title":"三体"}}}"#;
        let parsed: RemoteState = serde_json::from_str(json).expect("v1 文档必须还能解析");
        assert!(parsed.annotations.is_empty());
        assert!(parsed.bookmarks.is_empty());
        assert_eq!(parsed.books["h"].progress, 0.4);
    }

    #[test]
    fn a_state_document_round_trips_through_json() {
        let (state, ..) =
            merge_annotations(vec![ann("a", 100), grave("b", 50)], BTreeMap::new(), &imported());
        let json = serde_json::to_string(&state).expect("serialize");
        assert_eq!(
            serde_json::from_str::<BTreeMap<String, annotations::SyncAnnotation>>(&json)
                .expect("parse"),
            state,
            "序列化必须稳定可逆"
        );
    }

    #[test]
    fn bookmarks_merge_the_same_way() {
        let bm = |id: &str, at: i64| bookmarks::SyncBookmark {
            id: id.into(),
            book: "h".into(),
            chapter_idx: 1,
            fraction: 0.5,
            label: "pin".into(),
            updated_at: at,
            deleted: false,
        };
        let (state, tally, upsert, _) =
            merge_bookmarks(vec![bm("k", 100)], BTreeMap::new(), &imported());
        assert_eq!(tally.uploaded, 1);
        assert!(upsert.is_empty());
        assert!(state.contains_key("k"));

        let remote_grave = bookmarks::SyncBookmark {
            id: "k".into(),
            book: String::new(),
            chapter_idx: 0,
            fraction: 0.0,
            label: String::new(),
            updated_at: 300,
            deleted: true,
        };
        let (_, tally, _, delete) = merge_bookmarks(
            vec![bm("k", 100)],
            BTreeMap::from([("k".to_string(), remote_grave)]),
            &imported(),
        );
        assert_eq!(tally.deleted, 1);
        assert_eq!(delete, vec!["k".to_string()]);
    }

    /// A real database, so the credential assertions below run the same path a
    /// save from the settings page does.
    struct Harness {
        dir: std::path::PathBuf,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let layout = crate::db::Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&layout.data_dir).expect("open");
            Self { dir, library }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn the_saved_credentials_are_not_in_the_row_in_the_clear() {
        let harness = Harness::new("sync-credentials");
        let saved = set_config(
            &harness.library,
            &SyncConfig {
                url: "https://dav.example.com/dav/方册/".into(),
                username: "reader@example.com".into(),
                password: "app-password".into(),
            },
        )
        .expect("save");
        assert_eq!(saved.url, "https://dav.example.com/dav/方册", "尾斜杠要去掉");

        // The round trip alone cannot tell sealing from not sealing — a
        // plaintext row reads back just as well. This is what fails if
        // `set_config` ever stops routing through `secrets`.
        let raw: String = harness
            .library
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT value FROM settings WHERE key = 'sync.webdav'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("raw row");
        assert!(!raw.contains("app-password"), "密码明文落盘了：{raw}");
        assert!(!raw.contains("reader@example.com"), "账号也一起封装：{raw}");

        let config = config(&harness.library).expect("config");
        assert_eq!(config.username, "reader@example.com");
        assert_eq!(config.password, "app-password");
    }
}
