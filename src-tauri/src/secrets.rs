//! Credentials at rest.
//!
//! The AI key, the DeepL key and the WebDAV password live in the `settings` KV
//! table, which is a plain SQLite file: whatever can read the profile directory
//! can read them. This module seals the *fields* that hold a credential — the
//! same list a backup blanks, so "what is encrypted" and "what is redacted out
//! of a backup" cannot drift apart — and then the file on its own is not enough
//! to read them.
//!
//! The key is 32 bytes from the OS CSPRNG, held by the platform credential
//! store (Keychain Services / Credential Manager / Secret Service). There is
//! deliberately **no Argon2 step here**, unlike `.ctzx`: that one stretches a
//! human password, and stretching an already-uniform 256-bit key would spend
//! its 19 MiB of work on every save to buy nothing. The reader never sees a
//! prompt — the OS is what gates access, per application.
//!
//! Sealing is per field, and the row key plus the field name travel as GCM
//! additional data. A blob therefore only opens where it was written: swapping
//! `deeplKey` and `apiKey` inside the database file is an authentication
//! failure rather than a silently exchanged credential.
//!
//! A value written before this module existed carries no prefix and is handed
//! back untouched — see [`seal_existing`] for the one-shot pass that puts those
//! away.

#[cfg(not(test))]
use std::sync::Mutex;

use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use aes_gcm::aead::{Aead, Generate, KeyInit, Payload};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use keyring::Entry;
use rusqlite::OptionalExtension;
use serde_json::Value;

use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Service name in the platform credential store. The bundle identifier, so an
/// entry is attributable to this app in Keychain Access / 凭据管理器.
///
/// 🔴 Renaming this strands every sealed credential: the master key lives under
/// this name in the reader's keychain, and an AI key that no longer opens is an
/// error, not an empty string. It was changed with the 2026-10-21 rename (the
/// pre-release one, where identifier went `dev.xlong.colorreader` →
/// `dev.xlong.fangce`): before the first release there is no reader to strand,
/// and the two names must stay the same string — the data directory is derived
/// from the identifier, so they can only be renamed together.
const SERVICE: &str = "dev.xlong.fangce";

/// The rows and fields that hold a credential.
///
/// One list, two consumers: this module seals exactly these, and
/// `library::backup` blanks exactly these out of a backup's copy of the
/// database. Adding a credential to one and forgetting the other is how a
/// secret ends up either in the clear on disk or inside an exported archive,
/// so the two ask the same constant.
///
/// The WebDAV username is on the list although it is not itself a secret: half
/// a credential pair is useless for signing in and still names the account, so
/// it travels with the password everywhere the password goes.
pub const SECRET_FIELDS: [(&str, &[&str]); 2] = [
    // `profileKeys.*` is the one entry that is not a plain field: it names an
    // object whose *values* are all credentials (one API key per saved AI
    // profile). See [`for_each_secret`].
    ("ai.config", &["apiKey", "deeplKey", "embeddingApiKey", "imageApiKey", "profileKeys.*"]),
    ("sync.webdav", &["username", "password"]),
];

/// Marks a sealed value. Versioned so a future format can be told apart from
/// this one instead of being mistaken for a plaintext credential.
const PREFIX: &str = "v1:";
const NONCE_BYTES: usize = 12;
const KEY_BYTES: usize = 32;

/// The master key, read once per process.
///
/// A keychain read per save would be a syscall and an ACL check each time for a
/// value that cannot change under us, so the first successful load is kept.
/// Failures are *not* cached: a locked keychain that the reader unlocks should
/// start working without a restart.
#[cfg(not(test))]
static MASTER_KEY: Mutex<Option<[u8; KEY_BYTES]>> = Mutex::new(None);

/// `true` when `value` is a blob this module wrote, as opposed to a credential
/// stored before it existed.
pub fn is_sealed(value: &str) -> bool {
    value.starts_with(PREFIX)
}

/// The fields of `row` that hold a credential, or `None` when it holds none.
fn fields_of(row: &str) -> Option<&'static [&'static str]> {
    SECRET_FIELDS.iter().find(|(key, _)| *key == row).map(|(_, fields)| *fields)
}

/// Additional data for one field of one row.
///
/// Both halves are ASCII identifiers with no `:` in them, so the join is
/// unambiguous — no field name can be forged to collide with another pair.
fn aad(row: &str, field: &str) -> String {
    format!("{row}:{field}")
}

/// `N` fresh bytes from the OS CSPRNG.
///
/// Same call as `library::pack`'s private helper: `aes-gcm` 0.11 dropped its
/// `OsRng` re-export, and `Generate::try_generate` is what replaced it.
fn random<const N: usize>() -> AppResult<[u8; N]> {
    <[u8; N]>::try_generate().map_err(|err| AppError::Secrets(format!("随机数不可用：{err}")))
}

/// Account name of the one entry this app owns under [`SERVICE`].
#[cfg(not(test))]
const ACCOUNT: &str = "credentials-key";

/// The entry in the platform credential store.
#[cfg(not(test))]
fn entry() -> AppResult<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(|err| AppError::Secrets(store_reason(&err)))
}

/// Turns a credential-store failure into the sentence the reader sees.
///
/// `NoEntry` never reaches here — it is the ordinary "nothing stored yet", and
/// every caller treats it separately.
fn store_reason(err: &keyring::Error) -> String {
    match err {
        keyring::Error::NoDefaultStore => {
            "系统钥匙串不可用（本平台没有可用的凭据存储）".to_string()
        }
        other => format!("系统钥匙串不可用：{other}"),
    }
}

/// The master key, minting it on first use.
///
/// Minting is a write, so this is the one function in the module with a side
/// effect beyond the database — and it only ever runs when a credential is
/// actually being sealed or opened.
#[cfg(not(test))]
fn master_key() -> AppResult<[u8; KEY_BYTES]> {
    let mut cache = MASTER_KEY.lock().map_err(|_| AppError::poisoned("secrets"))?;
    if let Some(key) = *cache {
        return Ok(key);
    }

    let entry = entry()?;
    let key = match entry.get_secret() {
        Ok(bytes) => <[u8; KEY_BYTES]>::try_from(bytes.as_slice()).map_err(|_| {
            AppError::Secrets("系统钥匙串里的主密钥长度不对，请删除后重新填写凭据".into())
        })?,
        Err(keyring::Error::NoEntry) => {
            let fresh = random::<KEY_BYTES>()?;
            entry
                .set_secret(&fresh)
                .map_err(|err| AppError::Secrets(format!("主密钥未能写入系统钥匙串：{err}")))?;
            fresh
        }
        Err(err) => return Err(AppError::Secrets(store_reason(&err))),
    };

    *cache = Some(key);
    Ok(key)
}

/// A fixed key, because a unit test cannot own the platform credential store:
/// a headless CI box has no Secret Service, and a suite that needed one would
/// either hang on a prompt or fail there.
///
/// This leaves exactly one thing unpinned — the credential-store I/O itself —
/// and [`keychain_round_trip`] is the opt-in test for that. Every layer above
/// it still runs for real, including the whole seal/read/write path through a
/// live database.
#[cfg(test)]
fn master_key() -> AppResult<[u8; KEY_BYTES]> {
    Ok([0x5a; KEY_BYTES])
}

/// Seals one string.
///
/// A fresh random nonce per call: 96 random bits, and this app seals a handful
/// of values per install, so the birthday bound is not reachable. GCM forbids
/// a repeated nonce under one key, which is why the nonce travels with the blob
/// rather than being derived from the field.
fn seal(aad: &str, plaintext: &str, key: &[u8; KEY_BYTES]) -> AppResult<String> {
    let nonce_bytes = random::<NONCE_BYTES>()?;
    let nonce = Nonce::try_from(&nonce_bytes[..])
        .map_err(|_| AppError::Secrets("随机数长度非法".into()))?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Secrets("密钥长度非法".into()))?;
    let sealed = cipher
        .encrypt(&nonce, Payload { msg: plaintext.as_bytes(), aad: aad.as_bytes() })
        .map_err(|_| AppError::Secrets("凭据加密失败".into()))?;

    let mut blob = Vec::with_capacity(NONCE_BYTES + sealed.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&sealed);
    Ok(format!("{PREFIX}{}", STANDARD.encode(blob)))
}

/// Opens one sealed string.
fn open(aad: &str, sealed: &str, key: &[u8; KEY_BYTES]) -> AppResult<String> {
    let body = sealed
        .strip_prefix(PREFIX)
        .ok_or_else(|| AppError::Secrets("凭据不是本程序写入的格式".into()))?;
    let blob = STANDARD.decode(body).map_err(|_| AppError::Secrets("凭据已损坏".into()))?;
    if blob.len() <= NONCE_BYTES {
        return Err(AppError::Secrets("凭据已损坏".into()));
    }

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| AppError::Secrets("密钥长度非法".into()))?;
    let nonce = Nonce::try_from(&blob[..NONCE_BYTES])
        .map_err(|_| AppError::Secrets("凭据已损坏".into()))?;
    // GCM cannot say whether the key was wrong or the bytes were edited, and
    // the message must not pretend to know. Both mean the same thing to the
    // reader: the credential has to be typed in again.
    let plain = cipher
        .decrypt(&nonce, Payload { msg: &blob[NONCE_BYTES..], aad: aad.as_bytes() })
        .map_err(|_| {
            AppError::Secrets(
                "已加密的凭据打不开（主密钥已不在系统钥匙串里，或数据已损坏），请重新填写".into(),
            )
        })?;
    String::from_utf8(plain).map_err(|_| AppError::Secrets("凭据已损坏".into()))
}

/// Visits every credential slot of `row`, in place.
///
/// Two shapes of slot exist, and this is the only place that knows it:
///
/// - `"apiKey"` — a top-level string field.
/// - `"profileKeys.*"` — an object whose every value is a credential, so one
///   saved endpoint per id does not need a row of its own. The `*` is the
///   signal, not a wildcard to be resolved elsewhere.
///
/// `f` receives the *field path* the slot is addressed by (`"profileKeys.abc"`),
/// which is what travels as GCM additional data: a blob sealed for one profile
/// will not open for another, exactly as a blob sealed for `apiKey` will not
/// open for `deeplKey`.
///
/// A slot whose value is not a string is skipped rather than coerced — a
/// hand-edited row should not turn into an encryption failure on launch.
fn for_each_secret<F>(row: &str, value: &mut Value, mut f: F) -> AppResult<()>
where
    F: FnMut(&str, &mut Value) -> AppResult<()>,
{
    let Some(fields) = fields_of(row) else { return Ok(()) };
    let Some(object) = value.as_object_mut() else { return Ok(()) };

    for field in fields {
        match field.strip_suffix(".*") {
            Some(name) => {
                let Some(Value::Object(map)) = object.get_mut(name) else { continue };
                // Collected first: sealing mutates the values it is walking, and
                // the key is needed to address each slot.
                let keys: Vec<String> = map.keys().cloned().collect();
                for key in keys {
                    if let Some(slot) = map.get_mut(&key) {
                        f(&format!("{name}.{key}"), slot)?;
                    }
                }
            }
            None => {
                if let Some(slot) = object.get_mut(*field) {
                    f(field, slot)?;
                }
            }
        }
    }
    Ok(())
}

/// Seals every credential field of `row`, leaving everything else alone.
///
/// An empty value is left as it is: it means "no credential configured", and
/// sealing it would put a blob in the row for nothing — which also makes a
/// cleared key indistinguishable from a set one when reading the file by eye.
fn seal_fields(row: &str, value: &Value, key: &[u8; KEY_BYTES]) -> AppResult<Value> {
    let mut out = value.clone();
    for_each_secret(row, &mut out, |path, slot| {
        let Some(text) = slot.as_str() else { return Ok(()) };
        if text.is_empty() || is_sealed(text) {
            return Ok(());
        }
        *slot = Value::String(seal(&aad(row, path), text, key)?);
        Ok(())
    })?;
    Ok(out)
}

/// Opens every sealed field of `row`.
fn open_fields(row: &str, value: &Value, key: &[u8; KEY_BYTES]) -> AppResult<Value> {
    let mut out = value.clone();
    for_each_secret(row, &mut out, |path, slot| {
        let Some(text) = slot.as_str() else { return Ok(()) };
        if !is_sealed(text) {
            return Ok(());
        }
        *slot = Value::String(open(&aad(row, path), text, key)?);
        Ok(())
    })?;
    Ok(out)
}

/// `true` when any credential field of `row` is sealed.
///
/// Walks a copy: the traversal is the mutable one, and a read-only twin would be
/// the same twenty lines twice — the thing this module exists to avoid. A config
/// row is a couple of kilobytes and this runs a handful of times per session.
fn has_sealed(row: &str, value: &Value) -> bool {
    let mut copy = value.clone();
    let mut found = false;
    let _ = for_each_secret(row, &mut copy, |_, slot| {
        if slot.as_str().is_some_and(is_sealed) {
            found = true;
        }
        Ok(())
    });
    found
}

/// `true` when `row` still holds a credential in the clear.
///
/// Kept apart from [`seal_fields`] so a caller can ask *before* reaching for the
/// master key: saving an AI config for a local model that needs no key, or one
/// whose key is already sealed, must not mint a credential-store entry.
fn needs_sealing(row: &str, value: &Value) -> bool {
    let mut copy = value.clone();
    let mut found = false;
    let _ = for_each_secret(row, &mut copy, |_, slot| {
        if slot.as_str().is_some_and(|text| !text.is_empty() && !is_sealed(text)) {
            found = true;
        }
        Ok(())
    });
    found
}

/// Blanks every credential in `value`, for a backup's copy of the database.
///
/// Exported so `library::transfer::backup` blanks exactly what this module
/// seals. It used to keep its own loop over [`SECRET_FIELDS`], which is how the
/// `profileKeys.*` shape would have shipped as plaintext in an archive: it wrote
/// a literal `"profileKeys.*"` key and left the real map alone.
pub fn blank_secrets(row: &str, value: &mut Value) {
    let _ = for_each_secret(row, value, |_, slot| {
        *slot = Value::String(String::new());
        Ok(())
    });
}

/// The raw `settings` row, exactly as stored — credentials still sealed.
fn raw_row(library: &Library, row: &str) -> AppResult<Option<String>> {
    library.with(|conn| {
        Ok(conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [row], |row| row.get(0))
            .optional()?)
    })
}

/// The parsed row, or `None` when it has never been written.
///
/// One parse and one "已损坏" message for all three callers: a row that cannot
/// be read back is the same problem whichever one noticed it, and the reader
/// needs the same advice either way.
fn stored_row(library: &Library, row: &str) -> AppResult<Option<Value>> {
    let Some(raw) = raw_row(library, row)? else { return Ok(None) };
    let value = serde_json::from_str(&raw)
        .map_err(|err| AppError::Message(format!("设置「{row}」已损坏，请重新填写：{err}")))?;
    Ok(Some(value))
}

/// Reads a `settings` row, opening the credentials it holds.
///
/// `Ok(None)` when the row has never been written. A field that is sealed but
/// cannot be opened is an **error**, not a blank: handing back an empty string
/// would look like "no credential configured" and the next save of that screen
/// would write the blank over the real one, destroying the credential. Failing
/// keeps the reader's key where it is and tells them to retype it.
pub fn read_json(library: &Library, row: &str) -> AppResult<Option<Value>> {
    let Some(value) = stored_row(library, row)? else { return Ok(None) };
    if !has_sealed(row, &value) {
        // Nothing sealed means the credential store is never touched — the
        // common case for a reader who has not configured any credential.
        return Ok(Some(value));
    }
    Ok(Some(open_fields(row, &value, &master_key()?)?))
}

/// Writes a `settings` row, sealing the credentials it holds.
///
/// The master key is only reached for when something actually needs sealing, so
/// a screen with no credentials configured never creates a credential-store
/// entry — which for a reader on a local model with no key would otherwise
/// happen on the first save for no reason at all.
pub fn write_json(library: &Library, row: &str, value: &Value) -> AppResult<()> {
    let stored = if needs_sealing(row, value) {
        seal_fields(row, value, &master_key()?)?
    } else {
        value.clone()
    };
    let json = serde_json::to_string(&stored)?;
    library.with(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at",
            rusqlite::params![row, json, crate::library::now_seconds()],
        )?;
        Ok(())
    })
}

/// Seals every credential still stored in clear text, and reports how many
/// rows it rewrote.
///
/// Rows written before this module existed are plaintext. Nothing breaks if
/// they stay that way — [`read_json`] hands them back as they are — but they
/// would only be sealed the next time the reader happened to save that screen,
/// and a WebDAV password is often typed once and never touched again. This is
/// the pass that closes the window instead of waiting for that.
///
/// It reads the rows first and returns 0 without touching the credential store
/// when there is nothing to do, which is every launch after the first.
pub fn seal_existing(library: &Library) -> AppResult<usize> {
    let mut rewrote = 0;
    for (row, _) in SECRET_FIELDS {
        let Some(value) = stored_row(library, row)? else { continue };
        if !needs_sealing(row, &value) {
            continue;
        }
        write_json(library, row, &value)?;
        rewrote += 1;
    }
    Ok(rewrote)
}

/// `Ok(())` when credentials can be sealed here *and* every sealed value opens;
/// `Err(reason)` otherwise, as a **complete sentence** the settings page shows
/// verbatim — it is the only place that knows which of the two problems it
/// found, and a page that re-framed it would say "无法加密保存" about a
/// credential that is encrypted and merely unopenable.
///
/// The point is to say so *before* the reader types a key into a field that
/// cannot be saved, rather than after. It mints nothing: a store with no key
/// yet is fine, because the first save will create one.
pub fn check(library: &Library) -> Result<(), String> {
    if let Err(err) = Entry::store_status() {
        return Err(format!("{}，凭据只能以明文保存在本机", store_reason(err)));
    }

    // A row that will not parse is not this function's problem: the page that
    // reads it will say so with more context than "凭据不可用" could.
    let mut sealed: Vec<(&str, Value)> = Vec::new();
    for (row, _) in SECRET_FIELDS {
        let Ok(Some(raw)) = raw_row(library, row).map_err(|err| err.to_string()) else { continue };
        if let Ok(value) = serde_json::from_str::<Value>(&raw)
            && has_sealed(row, &value)
        {
            sealed.push((row, value));
        }
    }
    if sealed.is_empty() {
        return Ok(());
    }

    let key = master_key().map_err(|err| err.to_string())?;
    for (row, value) in sealed {
        open_fields(row, &value, &key).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A fixed key, so the pure half of the module is testable without a
    /// credential store. The real store is exercised by [`keychain_round_trip`].
    fn key() -> [u8; KEY_BYTES] {
        [7_u8; KEY_BYTES]
    }

    fn other_key() -> [u8; KEY_BYTES] {
        [9_u8; KEY_BYTES]
    }

    #[test]
    fn a_sealed_value_comes_back_verbatim() {
        let sealed = seal("ai.config:apiKey", "sk-秘密", &key()).expect("seal");
        assert!(is_sealed(&sealed));
        assert!(!sealed.contains("sk-秘密"), "明文不许留在信封里：{sealed}");
        assert_eq!(open("ai.config:apiKey", &sealed, &key()).expect("open"), "sk-秘密");
    }

    #[test]
    fn sealing_twice_gives_two_different_blobs() {
        // A repeated nonce under one key breaks GCM outright, so this is the
        // property the random nonce exists for, not a nicety.
        let first = seal("ai.config:apiKey", "same", &key()).expect("seal");
        let second = seal("ai.config:apiKey", "same", &key()).expect("seal");
        assert_ne!(first, second);
        assert_eq!(open("ai.config:apiKey", &first, &key()).expect("open"), "same");
        assert_eq!(open("ai.config:apiKey", &second, &key()).expect("open"), "same");
    }

    #[test]
    fn a_blob_only_opens_where_it_was_written() {
        let sealed = seal("ai.config:apiKey", "sk-秘密", &key()).expect("seal");
        // Swapped field, swapped row, and a wrong key: all three have to fail,
        // and the row/field halves are what a hand-edited database file would
        // actually try.
        assert!(open("ai.config:deeplKey", &sealed, &key()).is_err(), "换个字段名不许开");
        assert!(open("sync.webdav:apiKey", &sealed, &key()).is_err(), "换个行不许开");
        assert!(open("ai.config:apiKey", &sealed, &other_key()).is_err(), "换个密钥不许开");
    }

    #[test]
    fn an_edited_blob_does_not_open() {
        let sealed = seal("ai.config:apiKey", "sk-秘密", &key()).expect("seal");
        let body = sealed.strip_prefix(PREFIX).expect("prefix");
        let mut bytes = STANDARD.decode(body).expect("decode");
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let tampered = format!("{PREFIX}{}", STANDARD.encode(&bytes));
        assert!(open("ai.config:apiKey", &tampered, &key()).is_err());
    }

    #[test]
    fn a_plaintext_value_is_left_alone() {
        // The upgrade path: a row written before this module existed has no
        // prefix, and reading it must not need a key at all.
        let legacy = json!({ "apiKey": "sk-明文", "model": "gpt-4o-mini" });
        assert!(!has_sealed("ai.config", &legacy));
        assert_eq!(open_fields("ai.config", &legacy, &key()).expect("open"), legacy);
    }

    #[test]
    fn sealing_covers_the_credential_fields_and_nothing_else() {
        let row = json!({
            "baseUrl": "https://api.example.com/v1",
            "apiKey": "sk-a",
            "deeplKey": "dl-b",
            "model": "gpt-4o-mini",
            "systemPrompt": "你是阅读助手",
        });
        let sealed = seal_fields("ai.config", &row, &key()).expect("seal");

        for field in ["apiKey", "deeplKey"] {
            let text = sealed[field].as_str().expect("string");
            assert!(is_sealed(text), "{field} 必须被封装");
            assert!(!text.contains("sk-a") && !text.contains("dl-b"), "{field} 漏了明文");
        }
        // The endpoint, the model and the prompt are configuration, not
        // credentials: sealing them would make the row unreadable by eye for no
        // gain, and `set_config` validates the first two on every save.
        assert_eq!(sealed["baseUrl"], row["baseUrl"]);
        assert_eq!(sealed["model"], row["model"]);
        assert_eq!(sealed["systemPrompt"], row["systemPrompt"]);

        assert_eq!(open_fields("ai.config", &sealed, &key()).expect("open"), row);
    }

    #[test]
    fn sealing_is_idempotent() {
        let row = json!({ "apiKey": "sk-a" });
        let once = seal_fields("ai.config", &row, &key()).expect("seal");
        let twice = seal_fields("ai.config", &once, &key()).expect("seal");
        assert_eq!(once, twice, "再存一次不该把已封装的再套一层");
    }

    #[test]
    fn an_empty_credential_is_not_sealed() {
        // "Cleared" has to stay distinguishable from "configured", both for the
        // reader looking at the row and for the next save that reads it back.
        let row = json!({ "apiKey": "", "deeplKey": "dl-b" });
        let sealed = seal_fields("ai.config", &row, &key()).expect("seal");
        assert_eq!(sealed["apiKey"], "");
        assert!(is_sealed(sealed["deeplKey"].as_str().expect("string")));
    }

    #[test]
    fn every_credential_field_is_covered_by_the_list() {
        // The invariant the whole module rests on: a field a backup blanks is a
        // field this seals. Asserting it here means a new credential added to
        // `SECRET_FIELDS` without a sealing path is caught, rather than shipped
        // as a plaintext row.
        let rows: Vec<&str> = SECRET_FIELDS.iter().map(|(row, _)| *row).collect();
        assert!(rows.contains(&"ai.config"));
        assert!(rows.contains(&"sync.webdav"));
        for (row, fields) in SECRET_FIELDS {
            assert!(!fields.is_empty(), "{row} 没有任何凭据字段");
            for field in fields {
                // A `.*` field is an object of credentials; anything else is one
                // string. Both shapes must come back sealed, and the `.*` shape
                // is exactly what a blind `json!({field: "secret"})` would miss.
                let value = match field.strip_suffix(".*") {
                    Some(name) => json!({ name: { "one": "secret", "two": "secret" } }),
                    None => json!({ *field: "secret" }),
                };
                let sealed = seal_fields(row, &value, &key()).expect("seal");
                match field.strip_suffix(".*") {
                    Some(name) => {
                        for entry in sealed[name].as_object().expect("object").values() {
                            assert!(
                                is_sealed(entry.as_str().expect("string")),
                                "{row}.{name}.* 没有被封装"
                            );
                        }
                    }
                    None => assert!(
                        is_sealed(sealed[*field].as_str().expect("string")),
                        "{row}.{field} 没有被封装"
                    ),
                }
                // And the same list blanks it out of a backup.
                let mut blanked = value.clone();
                blank_secrets(row, &mut blanked);
                assert!(
                    !serde_json::to_string(&blanked).expect("json").contains("secret"),
                    "{row}.{field} 没有被备份脱敏"
                );
            }
        }
    }

    #[test]
    fn a_map_of_credentials_seals_and_opens_per_key() {
        let row = json!({
            "baseUrl": "https://api.example.com/v1",
            "apiKey": "sk-active",
            "profileKeys": { "a": "sk-a", "b": "sk-b" },
        });
        let sealed = seal_fields("ai.config", &row, &key()).expect("seal");

        assert_eq!(sealed["baseUrl"], row["baseUrl"], "非凭据字段不该被藏起来");
        for id in ["a", "b"] {
            let text = sealed["profileKeys"][id].as_str().expect("string");
            assert!(is_sealed(text), "profileKeys.{id} 必须被封装");
            assert!(!text.contains("sk-"), "profileKeys.{id} 漏了明文");
        }
        assert_eq!(open_fields("ai.config", &sealed, &key()).expect("open"), row);
    }

    #[test]
    fn one_profiles_blob_does_not_open_as_another() {
        // The same reason the row/field halves exist: swapping two keys inside
        // the database file must be an authentication failure, not a silent
        // exchange of credentials.
        let sealed = seal("ai.config:profileKeys.a", "sk-a", &key()).expect("seal");
        assert!(open("ai.config:profileKeys.b", &sealed, &key()).is_err());
        assert!(open("ai.config:apiKey", &sealed, &key()).is_err());
        assert_eq!(open("ai.config:profileKeys.a", &sealed, &key()).expect("open"), "sk-a");
    }

    #[test]
    fn a_row_without_credentials_passes_through() {
        let row = json!({ "deviceId": "abc" });
        assert_eq!(seal_fields("sync.device_id", &row, &key()).expect("seal"), row);
        assert_eq!(open_fields("sync.device_id", &row, &key()).expect("open"), row);
        assert!(!has_sealed("sync.device_id", &row));
    }

    /// A real database in a temp directory, so the tests below exercise the
    /// whole path — `settings` row, seal, read back — rather than the pure
    /// helpers alone.
    struct Harness {
        dir: std::path::PathBuf,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let layout = crate::db::Layout::create(dir.join("data")).expect("layout");
            let library = Library::open(&layout.data_dir).expect("open library");
            Self { dir, library }
        }

        /// The row exactly as it sits on disk, bypassing every reader here.
        fn raw(&self, row: &str) -> Option<String> {
            self.library
                .with(|conn| {
                    Ok(conn
                        .query_row("SELECT value FROM settings WHERE key = ?1", [row], |row| {
                            row.get(0)
                        })
                        .optional()?)
                })
                .expect("read raw")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn a_credential_written_through_the_store_is_not_readable_in_the_file() {
        let harness = Harness::new("secrets-round-trip");
        let config = json!({
            "baseUrl": "https://api.example.com/v1",
            "apiKey": "sk-do-not-leak",
            "model": "gpt-4o-mini",
        });

        write_json(&harness.library, "ai.config", &config).expect("write");

        // The assertion this whole module exists for: the file on disk does not
        // contain the credential, and does not contain it anywhere else either.
        let raw = harness.raw("ai.config").expect("row written");
        assert!(!raw.contains("sk-do-not-leak"), "明文落盘了：{raw}");
        assert!(raw.contains("v1:"), "凭据没有被封装：{raw}");
        assert!(raw.contains("gpt-4o-mini"), "非凭据字段不该被藏起来：{raw}");

        assert_eq!(read_json(&harness.library, "ai.config").expect("read"), Some(config));
    }

    #[test]
    fn reading_a_row_nobody_wrote_is_none() {
        let harness = Harness::new("secrets-absent");
        assert_eq!(read_json(&harness.library, "ai.config").expect("read"), None);
    }

    #[test]
    fn a_cleared_credential_stays_cleared() {
        let harness = Harness::new("secrets-cleared");
        let set = json!({ "apiKey": "sk-a", "model": "m" });
        write_json(&harness.library, "ai.config", &set).expect("write");

        let cleared = json!({ "apiKey": "", "model": "m" });
        write_json(&harness.library, "ai.config", &cleared).expect("write");

        let raw = harness.raw("ai.config").expect("row");
        assert!(!raw.contains("v1:"), "清空后不该留下一个空凭据的信封：{raw}");
        assert_eq!(read_json(&harness.library, "ai.config").expect("read"), Some(cleared));
    }

    #[test]
    fn a_credential_the_key_no_longer_opens_is_an_error_not_a_blank() {
        let harness = Harness::new("secrets-wrong-key");
        write_json(&harness.library, "ai.config", &json!({ "apiKey": "sk-a", "model": "m" }))
            .expect("write");

        // What a lost or replaced credential-store entry looks like from here:
        // the blob is intact, the key is not.
        let raw = harness.raw("ai.config").expect("row");
        let value: Value = serde_json::from_str(&raw).expect("parse");
        let broken = open_fields("ai.config", &value, &other_key());
        assert!(broken.is_err());

        // And the property that makes the error the right answer: a blank would
        // be written back over the real credential by the next save.
        let blank = json!({ "apiKey": "", "model": "m" });
        write_json(&harness.library, "ai.config", &blank).expect("write");
        assert_eq!(read_json(&harness.library, "ai.config").expect("read"), Some(blank));
    }

    #[test]
    fn the_upgrade_pass_seals_what_was_already_there() {
        let harness = Harness::new("secrets-upgrade");
        // Exactly the shape a version before this module wrote.
        let legacy = json!({ "apiKey": "sk-legacy", "model": "m" });
        harness
            .library
            .with(|conn| {
                Ok(conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('ai.config', ?1, 1)",
                    [serde_json::to_string(&legacy)?],
                )?)
            })
            .expect("seed legacy row");

        assert_eq!(seal_existing(&harness.library).expect("seal"), 1);
        let raw = harness.raw("ai.config").expect("row");
        assert!(!raw.contains("sk-legacy"), "升级后仍是明文：{raw}");
        assert_eq!(read_json(&harness.library, "ai.config").expect("read"), Some(legacy));

        // Second launch: nothing left to do, and no credential store touched.
        assert_eq!(seal_existing(&harness.library).expect("seal"), 0);
    }

    #[test]
    fn the_upgrade_pass_leaves_a_row_with_no_credential_alone() {
        let harness = Harness::new("secrets-upgrade-empty");
        harness
            .library
            .with(|conn| {
                Ok(conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('sync.webdav', \
                     '{\"url\":\"https://dav.example.com\",\"username\":\"\",\"password\":\"\"}', 1)",
                    [],
                )?)
            })
            .expect("seed row");

        // Zero, not one: a row whose credentials are all empty must not mint a
        // credential-store entry on every upgrade.
        assert_eq!(seal_existing(&harness.library).expect("seal"), 0);
    }

    /// The one test that touches the real credential store, so it is opt-in:
    /// `cargo test --manifest-path src-tauri/Cargo.toml keychain -- --ignored`.
    ///
    /// It writes and then deletes its own entry, which means it needs a real
    /// desktop session (a headless CI box has no Secret Service).
    ///
    /// Deliberately **not** [`ACCOUNT`]: that is where the real master key
    /// lives, and a test that deleted it would take the reader's credentials
    /// with it.
    #[test]
    #[ignore = "needs a real OS credential store: cargo test keychain -- --ignored"]
    fn keychain_round_trip() {
        let entry = Entry::new(SERVICE, "probe-account").expect("credential store");
        entry.delete_credential().ok();
        entry.set_secret(&[1_u8, 2, 3, 4]).expect("write");
        assert_eq!(entry.get_secret().expect("read"), vec![1_u8, 2, 3, 4]);
        entry.delete_credential().expect("clean up");
        assert!(matches!(entry.get_secret(), Err(keyring::Error::NoEntry)));
    }
}
