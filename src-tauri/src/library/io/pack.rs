//! Book Pack: one book in a single portable file.
//!
//! `.ctz` is a ZIP holding the untouched source file plus the reading state
//! (progress, favourite, highlights). Optionally it also holds the book's AI
//! summaries and conversations in `ai.json` — derived data, but expensive to
//! regenerate and impossible to reproduce once a provider or prompt changes.
//! Chapters and the cover are deliberately *not* stored: the ordinary import
//! pipeline extracts both from the source, so a second copy inside the pack
//! could only drift out of sync.
//!
//! `.ctzx` is the same archive encrypted with AES-256-GCM under a key derived
//! from a password with Argon2id. Every primitive comes from a RustCrypto
//! crate; nothing here invents one.

use std::io::{Cursor, Read, Write};
use std::path::Path;

use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use aes_gcm::aead::{Aead, Generate, KeyInit, Payload};
use argon2::{Algorithm, Argon2, Params, Version};
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::annotations;
use crate::library::repository;
use crate::library::tags;

/// Extensions the import pipeline hands to this module.
pub const PACK_EXTENSIONS: [&str; 2] = ["ctz", "ctzx"];

/// Name of the manifest inside the archive. A ZIP cannot carry magic bytes, so
/// this file is what identifies an archive as a book pack.
const MANIFEST_ENTRY: &str = "pack.json";
const MANIFEST_FORMAT: &str = "fangce-book-pack";
const MANIFEST_VERSION: u32 = 2;

/// Entry holding the original file; the extension names the source format.
const SOURCE_PREFIX: &str = "source.";
/// Entry holding progress, favourite flag and highlights.
const READING_ENTRY: &str = "reading.json";
/// Optional entry holding AI summaries and conversations.
const AI_ENTRY: &str = "ai.json";

const ENCRYPTED_EXT: &str = "ctzx";
const ENCRYPTED_FORMAT: &str = "fangce-book-pack-enc";
const ENCRYPTED_VERSION: u32 = 1;

const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;

/// Argon2id work factors: the OWASP floor for interactive logins. Cheap enough
/// to stay well under a second, expensive enough to blunt offline guessing.
const ARGON2_KIB: u32 = 19 * 1024;
const ARGON2_PASSES: u32 = 2;
const ARGON2_LANES: u32 = 1;

/// Reading state that travels with a book.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// 0..1.
    pub progress: f64,
    pub favorite: bool,
    #[serde(default)]
    pub annotations: Vec<PackedAnnotation>,
    /// Labels the book carried. Shelf organisation still counts as state the
    /// reader built up by hand, so it travels with the book for the same
    /// reason the favourite flag does.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A highlight without the ids the database assigns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedAnnotation {
    pub chapter_idx: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub text: String,
    /// Ink colour and paint style; `default` keeps packs made before these
    /// existed readable, and older app versions ignore the extra fields.
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
    /// The reader's own note on this highlight. Carried with the pack because
    /// it is the one thing in a reading state that the book cannot regenerate.
    #[serde(default)]
    pub note: Option<String>,
}

/// The optional AI payload. Raw JSON columns are carried as strings, exactly
/// as the database holds them: a provider may add a field this build has never
/// seen, and the panel already drops what it cannot read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedAi {
    #[serde(default)]
    pub summaries: Vec<PackedSummary>,
    #[serde(default)]
    pub conversations: Vec<PackedConversation>,
}

/// One chapter's guide. `chars` and `model` travel with the text so the panel
/// can still say a summary is stale after a re-extracted chapter changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedSummary {
    pub idx: usize,
    pub summary: String,
    pub chars: usize,
    pub model: String,
    pub created_at: i64,
}

/// One conversation, with the original id kept only for re-import dedupe. A
/// landing library gives it a fresh id when that id is already spoken for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedConversation {
    pub source_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub messages: Vec<PackedMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedMessage {
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub citations: Option<String>,
    pub usage: Option<String>,
    pub tools: Option<String>,
    pub created_at: i64,
}

/// A pack's contents, pulled out of the archive.
#[derive(Debug)]
pub struct Unpacked {
    /// Bytes of the original book file.
    pub source: Vec<u8>,
    /// Extension of the original file, without the dot.
    pub source_ext: String,
    pub reading: Option<Reading>,
    /// Present only when the exporter was asked to carry AI records.
    pub ai: Option<PackedAi>,
}

/// `true` when `path` names a book pack rather than a raw book.
pub fn is_pack(path: &Path) -> bool {
    crate::library::has_extension(path, &PACK_EXTENSIONS)
}

/// Writes one book to `dest`.
///
/// The format follows the extension: `.ctzx` requires a password and encrypts,
/// anything else writes the plain archive. `include_ai` opts into carrying the
/// book's generated guides and conversations; the caller decides the privacy
/// default, not the format layer.
pub fn export(
    library: &Library,
    book_id: &str,
    dest: &Path,
    password: Option<&str>,
    include_ai: bool,
) -> AppResult<()> {
    let encrypted = crate::library::has_extension(dest, &[ENCRYPTED_EXT]);
    if encrypted && password.is_none() {
        return Err(AppError::InvalidArgument("加密书档需要设置密码".into()));
    }

    let book = library
        .with(|conn| repository::get(conn, book_id))?
        .ok_or_else(|| AppError::NotFound(book_id.to_string()))?;
    let (source_path, _) = crate::library::book_files(library, book_id)?;
    let source_path = source_path
        .ok_or_else(|| AppError::Message(format!("《{}》的源文件已丢失", book.title)))?;

    let source = std::fs::read(&source_path)?;
    let reading = library.with(|conn| {
        let annotations = annotations::list(conn, book_id)?
            .into_iter()
            .map(|annotation| PackedAnnotation {
                chapter_idx: annotation.chapter_idx,
                start_char: annotation.start_char,
                end_char: annotation.end_char,
                text: annotation.text,
                color: annotation.color,
                style: annotation.style,
                note: annotation.note,
            })
            .collect();
        Ok(Reading {
            progress: book.progress,
            favorite: book.favorite,
            annotations,
            tags: book.tags.clone(),
        })
    })?;

    let ai = if include_ai { Some(library.with(|conn| collect_ai(conn, book_id))?) } else { None };

    let archive = build(&source, book.format.extension(), &reading, ai.as_ref())?;
    let bytes = match password {
        Some(password) if encrypted => encrypt(&archive, password)?,
        _ => archive,
    };
    std::fs::write(dest, bytes)?;
    Ok(())
}

/// Reads the book's AI records whole. Conversations are read through the same
/// query the drawer uses, so what travels is what the reader could actually see.
fn collect_ai(conn: &Connection, book_id: &str) -> AppResult<PackedAi> {
    let mut stmt = conn.prepare(
        "SELECT idx, summary, chars, model, created_at \
           FROM chapter_summaries WHERE book_id = ?1 ORDER BY idx",
    )?;
    let summaries = stmt
        .query_map(params![book_id], |row| {
            Ok(PackedSummary {
                idx: row.get::<_, i64>(0)? as usize,
                summary: row.get(1)?,
                chars: row.get::<_, i64>(2)? as usize,
                model: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut conversations = Vec::new();
    for item in crate::library::assist::conversation::list(conn, Some(book_id))? {
        let full = crate::library::assist::conversation::get(conn, &item.id)?;
        let messages = full
            .messages
            .into_iter()
            .map(|message| PackedMessage {
                role: message.role,
                content: message.content,
                reasoning: message.reasoning,
                citations: serde_json::to_string(&message.citations).ok(),
                usage: message.usage.and_then(|value| serde_json::to_string(&value).ok()),
                tools: serde_json::to_string(&message.tools).ok(),
                created_at: message.created_at,
            })
            .collect();
        conversations.push(PackedConversation {
            source_id: item.id,
            title: item.title,
            created_at: item.created_at,
            updated_at: item.updated_at,
            messages,
        });
    }

    Ok(PackedAi { summaries, conversations })
}

/// Reads a pack, decrypting it first when the extension says it is encrypted.
pub fn unpack(path: &Path, password: Option<&str>) -> AppResult<Unpacked> {
    let raw = std::fs::read(path)?;
    let archive = if crate::library::has_extension(path, &[ENCRYPTED_EXT]) {
        let password = password
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::InvalidArgument("导入加密书档需要提供密码".into()))?;
        decrypt(&raw, password)?
    } else {
        raw
    };
    read(&archive)
}

/// Applies a pack's reading state to the book that was just imported.
///
/// Highlights already present are kept rather than duplicated, so re-importing
/// a pack over a shelf that already holds the book is idempotent.
pub fn apply_reading(tx: &Transaction<'_>, book_id: &str, reading: &Reading) -> AppResult<()> {
    // Skipped at zero: recording progress also stamps `last_read_at`, which
    // would drop an unread book onto the "recently read" shelf.
    if reading.progress > 0.0 {
        repository::set_progress(tx, book_id, reading.progress, None)?;
    }
    repository::set_favorite(tx, book_id, reading.favorite)?;

    // Adding rather than replacing: a pack can only know the labels it was
    // exported with, and the shelf it lands on may already have its own.
    if !reading.tags.is_empty() {
        tags::assign(tx, &[book_id.to_string()], &reading.tags, &[])?;
    }

    for packed in &reading.annotations {
        if !has_highlight(tx, book_id, packed)? {
            let created = annotations::create(
                tx,
                book_id,
                packed.chapter_idx,
                packed.start_char,
                packed.end_char,
                &packed.text,
                None,
                packed.color.as_deref(),
                packed.style.as_deref(),
            )?;
            // `create` takes no note, so the pack's note goes through the one
            // writer that owns them — after the row exists to hang it on.
            if let Some(note) = packed.note.as_deref() {
                annotations::set_note(tx, &created.id, Some(note))?;
            }
        }
    }
    Ok(())
}

/// Attaches a pack's AI records to the book that just landed.
///
/// Summaries are keyed by chapter index, so they are upserted. Conversations
/// are deduped by their original id when it is still free, and by title plus
/// creation time when the id collided with a local conversation — re-importing
/// the same pack must not multiply the transcript.
pub fn apply_ai(tx: &Transaction<'_>, book_id: &str, ai: &PackedAi) -> AppResult<()> {
    for summary in &ai.summaries {
        crate::library::assist::summary::restore(
            tx,
            book_id,
            summary.idx,
            &summary.summary,
            summary.chars,
            &summary.model,
            summary.created_at,
        )?;
    }

    for conversation in &ai.conversations {
        let seen: i64 = tx.query_row(
            "SELECT COUNT(*) FROM ai_conversations \
              WHERE book_id = ?1 AND title = ?2 AND created_at = ?3",
            rusqlite::params![book_id, conversation.title, conversation.created_at],
            |row| row.get(0),
        )?;
        if seen > 0 {
            continue;
        }

        let id = if conversation_id_free(tx, &conversation.source_id)? {
            conversation.source_id.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        tx.execute(
            "INSERT INTO ai_conversations (id, book_id, title, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                book_id,
                conversation.title,
                conversation.created_at,
                conversation.updated_at
            ],
        )?;

        for message in &conversation.messages {
            if message.role != "user" && message.role != "assistant" {
                return Err(AppError::Parse("书档里的对话角色非法".into()));
            }
            tx.execute(
                "INSERT INTO ai_messages \
                   (conversation_id, role, content, reasoning, citations, usage, created_at, tools) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    id,
                    message.role,
                    message.content,
                    message.reasoning,
                    message.citations,
                    message.usage,
                    message.created_at,
                    message.tools,
                ],
            )?;
        }
    }
    Ok(())
}

fn conversation_id_free(conn: &Connection, id: &str) -> AppResult<bool> {
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ai_conversations WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0),
    )?;
    Ok(used == 0)
}

/// Builds the plain archive in memory. A pack is one book, and the result is
/// written to disk in a single pass either way.
fn build(
    source: &[u8],
    source_ext: &str,
    reading: &Reading,
    ai: Option<&PackedAi>,
) -> AppResult<Vec<u8>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file(MANIFEST_ENTRY, options)?;
    serde_json::to_writer(
        &mut writer,
        &Manifest { format: MANIFEST_FORMAT.to_string(), version: MANIFEST_VERSION },
    )?;

    writer.start_file(format!("{SOURCE_PREFIX}{source_ext}"), options)?;
    writer.write_all(source)?;

    writer.start_file(READING_ENTRY, options)?;
    serde_json::to_writer(&mut writer, reading)?;

    if let Some(ai) = ai {
        writer.start_file(AI_ENTRY, options)?;
        serde_json::to_writer(&mut writer, ai)?;
    }

    Ok(writer.finish()?.into_inner())
}

fn read(archive: &[u8]) -> AppResult<Unpacked> {
    let mut zip = ZipArchive::new(Cursor::new(archive))?;
    // zip 9 decodes entry names lazily, so each one arrives as
    // `Result<Cow<str>, _>`. A name that is not valid UTF-8 cannot be one of
    // the entries this module looks for, so it is skipped.
    let names: Vec<String> =
        zip.file_names().filter_map(|name| name.ok()).map(|name| name.to_string()).collect();

    let manifest: Manifest = serde_json::from_reader(zip.by_name(MANIFEST_ENTRY)?)?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(AppError::UnsupportedFormat(manifest.format));
    }
    if manifest.version > MANIFEST_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "书档版本 {} 高于当前支持的 {MANIFEST_VERSION}",
            manifest.version
        )));
    }

    let source_name = names
        .iter()
        .find(|name| name.starts_with(SOURCE_PREFIX))
        .ok_or_else(|| AppError::Parse("书档缺少源文件".into()))?;
    let source_ext = source_name[SOURCE_PREFIX.len()..].to_string();
    if source_ext.is_empty() {
        return Err(AppError::Parse("书档源文件缺少扩展名".into()));
    }
    let mut source = Vec::new();
    zip.by_name(source_name)?.read_to_end(&mut source)?;

    let reading = match names.iter().any(|name| name == READING_ENTRY) {
        true => Some(serde_json::from_reader(zip.by_name(READING_ENTRY)?)?),
        false => None,
    };
    // A v1 pack has no AI entry; absence means "not carried", never "empty".
    let ai = match names.iter().any(|name| name == AI_ENTRY) {
        true => Some(serde_json::from_reader(zip.by_name(AI_ENTRY)?)?),
        false => None,
    };

    Ok(Unpacked { source, source_ext, reading, ai })
}

/// Whether this highlight is already on the shelf, so a re-import is a no-op.
fn has_highlight(conn: &Connection, book_id: &str, packed: &PackedAnnotation) -> AppResult<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM annotations
          WHERE book_id = ?1 AND chapter_idx = ?2 AND start_char = ?3 AND end_char = ?4",
        rusqlite::params![
            book_id,
            packed.chapter_idx as i64,
            packed.start_char as i64,
            packed.end_char as i64
        ],
        |row| row.get(0),
    )?;
    Ok(found > 0)
}

/// Contents of `pack.json`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
}

/// Plaintext header of a `.ctzx` file.
///
/// It is fed to GCM as additional data, so editing the KDF parameters or the
/// salt breaks authentication instead of silently weakening the file.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: String,
    version: u32,
    kdf: String,
    /// Argon2id memory cost in KiB.
    m: u32,
    /// Argon2id passes.
    t: u32,
    /// Argon2id lanes.
    p: u32,
    salt: String,
}

impl Header {
    fn new(salt: &[u8]) -> Self {
        Self {
            format: ENCRYPTED_FORMAT.to_string(),
            version: ENCRYPTED_VERSION,
            kdf: "argon2id".to_string(),
            m: ARGON2_KIB,
            t: ARGON2_PASSES,
            p: ARGON2_LANES,
            salt: crate::library::to_hex(salt),
        }
    }

    fn key(&self, password: &str) -> AppResult<[u8; 32]> {
        let salt = crate::library::from_hex(&self.salt)
            .ok_or_else(|| AppError::Parse("salt 非法".into()))?;
        let params = Params::new(self.m, self.t, self.p, None)
            .map_err(|err| AppError::Message(format!("密钥派生参数非法：{err}")))?;
        let mut key = [0_u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|err| AppError::Message(format!("密钥派生失败：{err}")))?;
        Ok(key)
    }
}

/// `N` fresh bytes from the OS CSPRNG.
///
/// `aes-gcm` 0.11 dropped its `OsRng` re-export (the `rand_core` it came from
/// no longer has one); `Generate::try_generate` is what replaced it, and it is
/// the same system RNG.
fn random<const N: usize>() -> AppResult<[u8; N]> {
    <[u8; N]>::try_generate().map_err(|err| AppError::Message(format!("随机数不可用：{err}")))
}

/// Encrypts a whole archive under one key, one nonce, one GCM tag.
///
/// The salt is fresh per export, so the key is too: a nonce is never reused
/// with the same key no matter how many packs the user writes.
fn encrypt(archive: &[u8], password: &str) -> AppResult<Vec<u8>> {
    let salt = random::<SALT_BYTES>()?;
    let nonce_bytes = random::<NONCE_BYTES>()?;
    // 0.11 dropped `Array::from_slice`; `TryFrom` is its replacement, and the
    // length is fixed by `NONCE_BYTES` so this cannot fail in practice.
    let nonce = Nonce::try_from(&nonce_bytes[..])
        .map_err(|_| AppError::Message("随机数长度非法".into()))?;

    let header = Header::new(&salt);
    let raw = serde_json::to_vec(&header)?;
    let cipher = Aes256Gcm::new_from_slice(&header.key(password)?)
        .map_err(|_| AppError::Message("密钥长度非法".into()))?;
    let sealed = cipher
        .encrypt(&nonce, Payload { msg: archive, aad: &raw })
        .map_err(|_| AppError::Message("书档加密失败".into()))?;

    let mut out = Vec::with_capacity(4 + raw.len() + nonce_bytes.len() + sealed.len());
    let length = u32::try_from(raw.len()).map_err(|_| AppError::Message("头部过长".into()))?;
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(&raw);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn decrypt(bytes: &[u8], password: &str) -> AppResult<Vec<u8>> {
    let (raw, rest) = split_header(bytes)?;
    let header: Header = serde_json::from_slice(raw)
        .map_err(|_| AppError::InvalidArgument("不是有效的加密书档".into()))?;
    if header.format != ENCRYPTED_FORMAT {
        return Err(AppError::UnsupportedFormat(header.format.to_string()));
    }
    if header.version > ENCRYPTED_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "加密书档版本 {} 高于当前支持的 {ENCRYPTED_VERSION}",
            header.version
        )));
    }
    if rest.len() <= NONCE_BYTES {
        return Err(AppError::Parse("加密书档内容不完整".into()));
    }

    let cipher = Aes256Gcm::new_from_slice(&header.key(password)?)
        .map_err(|_| AppError::Message("密钥长度非法".into()))?;
    let nonce = Nonce::try_from(&rest[..NONCE_BYTES])
        .map_err(|_| AppError::Parse("加密书档内容不完整".into()))?;
    // GCM cannot tell a wrong password from a corrupted file, and the message
    // must not tell the user which one it was.
    cipher
        .decrypt(&nonce, Payload { msg: &rest[NONCE_BYTES..], aad: raw })
        .map_err(|_| AppError::InvalidArgument("密码错误，或书档已损坏".into()))
}

/// Splits `header_len || header || nonce || ciphertext` at the length prefix.
fn split_header(bytes: &[u8]) -> AppResult<(&[u8], &[u8])> {
    let Some(prefix) = bytes.get(..4) else {
        return Err(AppError::Parse("加密书档过短".into()));
    };
    let length = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]);
    let end = 4 + length as usize;
    let header = bytes.get(4..end).ok_or_else(|| AppError::Parse("加密书档头部损坏".into()))?;
    Ok((header, &bytes[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::tools::ToolCallView;
    use crate::ai::usage::TokenUsage;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::assist::{conversation, summary};
    use crate::library::import::ImportOutcome;
    use crate::library::repository::{BookQuery, BookSummary};
    use std::path::PathBuf;

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
            crate::library::import::import_files(
                &self.library,
                &self.layout,
                paths,
                None,
                &|_, _, _| {},
            )
        }

        fn shelf(&self) -> Vec<BookSummary> {
            self.library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// A book on the shelf with progress, a favourite flag, one highlight
    /// (carrying a note) and one label.
    fn seed_book(harness: &Harness) -> String {
        let epub = fixture::write_epub(
            &harness.dir,
            "source.epub",
            &fixture::full_opf("三体", "刘慈欣"),
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        harness.import(&[epub]);
        let id = harness.shelf()[0].id.clone();

        harness
            .library
            .with(|conn| {
                repository::set_progress(conn, &id, 0.25, None)?;
                repository::set_favorite(conn, &id, true)?;
                let highlight = annotations::create(conn, &id, 0, 1, 3, "你好", None, None, None)?;
                annotations::set_note(conn, &highlight.id, Some("第三章的伏笔"))?;
                Ok(())
            })
            .expect("seed reading state");
        harness
            .library
            .with_tx(|tx| tags::assign(tx, std::slice::from_ref(&id), &["科幻".into()], &[]))
            .expect("seed tag");
        id
    }

    /// One generated guide and one conversation carrying a mind map. These are
    /// the two records a read-only book file could never bring back.
    fn seed_ai(harness: &Harness, id: &str) {
        harness
            .library
            .with(|conn| {
                summary::restore(conn, id, 0, "一段导读", 120, "test-model", 12_345)?;
                let chat = conversation::create(conn, Some(id))?;
                let mindmap = ToolCallView {
                    name: "mindmap".into(),
                    label: "画脑图".into(),
                    detail: "完成".into(),
                    ok: true,
                    sources: vec![],
                    mindmap: Some("# 导图".into()),
                    wordcloud: None,
                };
                conversation::append(
                    conn,
                    &chat.id,
                    "user",
                    "这本书讲什么？",
                    None,
                    &[],
                    None,
                    &[],
                )?;
                conversation::append(
                    conn,
                    &chat.id,
                    "assistant",
                    "讲的是三体。",
                    None,
                    &[],
                    Some(TokenUsage { input: 3, cached: 1, output: 9 }),
                    &[mindmap],
                )?;
                Ok(())
            })
            .expect("seed ai");
    }

    fn export_to(harness: &Harness, id: &str, name: &str, password: Option<&str>) -> PathBuf {
        let dest = harness.dir.join(name);
        export(&harness.library, id, &dest, password, false).expect("export");
        dest
    }

    /// Same archive, but opting into the optional AI payload.
    fn export_ai_to(harness: &Harness, id: &str, name: &str, password: Option<&str>) -> PathBuf {
        let dest = harness.dir.join(name);
        export(&harness.library, id, &dest, password, true).expect("export ai");
        dest
    }

    fn archive_with(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).expect("start");
            writer.write_all(bytes).expect("write");
        }
        writer.finish().expect("finish").into_inner()
    }

    fn manifest() -> Vec<u8> {
        serde_json::to_vec(&Manifest {
            format: MANIFEST_FORMAT.to_string(),
            version: MANIFEST_VERSION,
        })
        .expect("manifest")
    }

    #[test]
    fn a_plain_pack_round_trips_source_and_reading_state() {
        let harness = Harness::new("pack-plain");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctz", None);

        let unpacked = unpack(&pack, None).expect("unpack");
        assert_eq!(unpacked.source_ext, "epub");
        assert_eq!(unpacked.source, std::fs::read(harness.dir.join("source.epub")).expect("read"));
        let reading = unpacked.reading.expect("reading state must travel");
        assert_eq!(reading.progress, 0.25);
        assert!(reading.favorite);
        assert_eq!(reading.annotations.len(), 1);
        assert_eq!(reading.annotations[0].text, "你好");
        assert_eq!(reading.annotations[0].note.as_deref(), Some("第三章的伏笔"), "笔记要随档走");
        assert_eq!(reading.tags, vec!["科幻".to_string()]);
    }

    #[test]
    fn a_pack_imports_into_a_second_library_with_its_highlights() {
        let source = Harness::new("pack-source");
        let id = seed_book(&source);
        let pack = export_to(&source, &id, "book.ctz", None);

        let target = Harness::new("pack-target");
        target.import(&[pack]);

        let shelf = target.shelf();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].title, "三体");
        assert_eq!(shelf[0].authors, ["刘慈欣"]);
        assert_eq!(shelf[0].progress, 0.25);
        assert!(shelf[0].favorite);
        assert_eq!(shelf[0].tags, vec!["科幻".to_string()]);
        let restored =
            target.library.with(|conn| annotations::list(conn, &shelf[0].id)).expect("list");
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].text, "你好");
        assert_eq!(restored[0].note.as_deref(), Some("第三章的伏笔"), "导入要把笔记落到行上");
    }

    #[test]
    fn reimporting_the_same_pack_does_not_duplicate_highlights() {
        let harness = Harness::new("pack-idempotent");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctz", None);

        harness.import(&[pack]);
        let shelf = harness.shelf();
        let restored =
            harness.library.with(|conn| annotations::list(conn, &shelf[0].id)).expect("list");
        assert_eq!(restored.len(), 1, "同一条标注不得重复插入");
    }

    #[test]
    fn an_encrypted_pack_is_unreadable_without_the_password() {
        let harness = Harness::new("pack-enc-need-password");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctzx", Some("correct horse"));

        assert!(unpack(&pack, None).is_err());
        let plain = std::fs::read(export_to(&harness, &id, "plain.ctz", None)).expect("read");
        assert_ne!(std::fs::read(&pack).expect("read"), plain, "密文必须与明文不同");
    }

    #[test]
    fn an_encrypted_pack_round_trips_with_its_password() {
        let harness = Harness::new("pack-enc");
        let id = seed_book(&harness);
        seed_ai(&harness, &id);
        let pack = export_ai_to(&harness, &id, "book.ctzx", Some("correct horse"));

        let unpacked = unpack(&pack, Some("correct horse")).expect("decrypt");
        assert_eq!(unpacked.reading.expect("reading").progress, 0.25);
        assert!(unpacked.ai.expect("ai travels encrypted").summaries.len() == 1);
        assert!(unpack(&pack, Some("wrong horse")).is_err(), "错误密码必须被 GCM 拒绝");
    }

    #[test]
    fn tampering_with_the_header_breaks_authentication() {
        let harness = Harness::new("pack-tamper");
        let id = seed_book(&harness);
        let pack = export_to(&harness, &id, "book.ctzx", Some("pw"));

        let mut bytes = std::fs::read(&pack).expect("read");
        // Flip a bit inside the header: without AAD this would still decrypt.
        bytes[10] ^= 0x01;
        assert!(decrypt(&bytes, "pw").is_err(), "KDF 参数被篡改后必须拒绝解密");
    }

    #[test]
    fn a_pack_without_a_source_entry_is_rejected() {
        let broken = archive_with(&[(MANIFEST_ENTRY, manifest())]);
        assert!(read(&broken).is_err(), "缺少源文件的书档必须被拒绝");
    }

    #[test]
    fn a_foreign_archive_is_rejected_by_its_manifest() {
        let foreign = archive_with(&[(
            MANIFEST_ENTRY,
            serde_json::to_vec(&Manifest { format: "some-other-tool".into(), version: 1 })
                .expect("manifest"),
        )]);
        assert!(matches!(read(&foreign), Err(AppError::UnsupportedFormat(_))));
    }

    #[test]
    fn export_rejects_an_encrypted_destination_without_a_password() {
        let harness = Harness::new("pack-no-password");
        let id = seed_book(&harness);
        assert!(export(&harness.library, &id, &harness.dir.join("x.ctzx"), None, false).is_err());
    }

    #[test]
    fn a_plaintext_pack_carries_ai_only_when_asked() {
        let harness = Harness::new("pack-ai-opt-in");
        let id = seed_book(&harness);
        seed_ai(&harness, &id);

        let plain = unpack(&export_to(&harness, &id, "plain.ctz", None), None).expect("unpack");
        assert!(plain.ai.is_none(), "明文书档默认不得带上对话");

        let carried =
            unpack(&export_ai_to(&harness, &id, "with-ai.ctz", None), None).expect("unpack");
        let ai = carried.ai.expect("opt-in must carry ai");
        assert_eq!(ai.summaries.len(), 1);
        assert_eq!(ai.summaries[0].summary, "一段导读");
        assert_eq!(ai.summaries[0].created_at, 12_345);
        assert_eq!(ai.conversations.len(), 1);
        assert_eq!(ai.conversations[0].messages.len(), 2);
        assert!(
            ai.conversations[0].messages[1]
                .tools
                .as_deref()
                .is_some_and(|json| json.contains("导图")),
            "工具产物只在消息的 tools 里，必须一起带走"
        );
    }

    #[test]
    fn ai_records_rebind_to_the_imported_book_and_survive_reimport() {
        let source = Harness::new("pack-ai-source");
        let id = seed_book(&source);
        seed_ai(&source, &id);
        let pack = export_ai_to(&source, &id, "book.ctz", None);

        let target = Harness::new("pack-ai-target");
        target.import(std::slice::from_ref(&pack));
        let target_id = target.shelf()[0].id.clone();

        target
            .library
            .with(|conn| {
                let (text, chars, model, at): (String, i64, String, i64) = conn.query_row(
                    "SELECT summary, chars, model, created_at \
                       FROM chapter_summaries WHERE book_id = ?1 AND idx = 0",
                    params![target_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(text, "一段导读");
                assert_eq!(chars, 120);
                assert_eq!(model, "test-model");
                assert_eq!(at, 12_345, "导入不能把导读的生成时间改成现在");

                let chats = conversation::list(conn, Some(&target_id))?;
                assert_eq!(chats.len(), 1);
                let full = conversation::get(conn, &chats[0].id)?;
                assert_eq!(full.messages.len(), 2);
                assert_eq!(full.messages[1].content, "讲的是三体。");
                assert_eq!(full.messages[1].tools[0].mindmap.as_deref(), Some("# 导图"));
                assert_eq!(chats[0].created_at, full.summary.created_at);
                Ok(())
            })
            .expect("verify imported ai");

        // The same file twice must not grow a second transcript.
        target.import(&[pack]);
        target
            .library
            .with(|conn| {
                assert_eq!(conversation::list(conn, Some(&target_id))?.len(), 1);
                Ok(())
            })
            .expect("verify idempotency");
    }

    #[test]
    fn an_old_pack_without_an_ai_entry_still_imports() {
        let harness = Harness::new("pack-v1");
        let epub =
            fixture::write_epub(&harness.dir, "old.epub", &fixture::full_opf("旧书", "佚名"), &[]);
        let archive = archive_with(&[
            (
                MANIFEST_ENTRY,
                serde_json::to_vec(&Manifest { format: MANIFEST_FORMAT.to_string(), version: 1 })
                    .expect("manifest"),
            ),
            ("source.epub", std::fs::read(&epub).expect("read source")),
        ]);
        let path = harness.dir.join("old.ctz");
        std::fs::write(&path, archive).expect("write old pack");

        assert!(unpack(&path, None).expect("unpack").ai.is_none());
        harness.import(&[path]);
        assert_eq!(harness.shelf().len(), 1, "v1 书档仍要能导入");
    }

    #[test]
    fn pack_extensions_are_recognised_by_extension_alone() {
        assert!(is_pack(Path::new("/a/b.ctz")));
        assert!(is_pack(Path::new("/a/b.CTZX")));
        assert!(!is_pack(Path::new("/a/b.epub")));
    }

    #[test]
    fn hex_round_trips_and_rejects_malformed_input() {
        let bytes = [0_u8, 15, 16, 255];
        assert_eq!(crate::library::to_hex(&bytes), "000f10ff");
        assert_eq!(crate::library::from_hex("000f10ff"), Some(bytes.to_vec()));
        assert_eq!(crate::library::from_hex("0f1"), None);
        assert_eq!(crate::library::from_hex("zz"), None);
    }
}
