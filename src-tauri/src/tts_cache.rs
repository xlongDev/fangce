//! Disk cache for synthesised speech.
//!
//! Every utterance costs a network round trip and, on a long book, a rate
//! limit. A reader who goes back a chapter, replays a sentence or resumes an
//! export should not pay that twice. This module puts the finished clip — the
//! MP3 bytes *and* the word timings, since losing the latter turns word-level
//! highlighting into a whole-sentence wash — on disk, keyed by everything that
//! can change the sound.
//!
//! Two decisions are deliberate and worth keeping:
//!
//! * The cache lives under `app_cache_dir()`, not `app_data_dir()`. Backup
//!   walks the whole data directory recursively; putting a few hundred MB of
//!   audio there would bloat every backup. Cache is disposable by definition.
//! * The reader's speed is *not* in the key. Synthesis always happens at rate
//!   1.0 (see `tts::speak`), and stretching is done on the samples at playout,
//!   so a clip is valid at every speed the reader can pick.
//!
//! Cache writes are best effort: a full disk or a locked directory must never
//! stop a reader from hearing the book. See [`cached`].

use std::future::Future;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::ai::AiConfig;
use crate::error::{AppError, AppResult};
use crate::tts::EdgeClip;

/// Directory under the OS cache directory. Versioned so a future change to the
/// entry format can start clean instead of parsing old bytes.
const CACHE_DIR: &str = "tts-cache-v1";

/// Where the cache lives. Kept as the only function that needs an `AppHandle`
/// so everything else here can be tested with a plain temporary directory.
///
/// `None` means the cache is unavailable; synthesis still goes ahead. A
/// missing cache must never be the reason a reader cannot hear a book.
pub fn dir(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_cache_dir() {
        Ok(path) => Some(path.join(CACHE_DIR)),
        Err(err) => {
            tracing::warn!(error = %err, "语音缓存目录不可用，本次不使用缓存");
            None
        }
    }
}

/// Hashes one field with its byte length first, so `(a, bc)` and `(ab, c)`
/// cannot collide through the delimiter.
fn feed(hasher: &mut Sha256, part: &str) {
    hasher.update((part.len() as u64).to_le_bytes());
    hasher.update(part.as_bytes());
}

fn finish(hasher: Sha256) -> String {
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Key for a Microsoft voice. Only the id and the text change the audio.
pub fn edge_key(voice: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    feed(&mut hasher, "edge-v1");
    feed(&mut hasher, voice);
    feed(&mut hasher, text);
    finish(hasher)
}

/// Key for the reader's own `/audio/speech` service.
///
/// `custom` is a fixed id in settings (`tts::CUSTOM_VOICE_ID`) — the actual
/// voice, model and endpoint live in the config. Hashing just the id would let
/// a voice change serve the previous voice's audio. The API key is deliberately
/// absent: it decides whether the request is allowed, not what comes back.
pub fn custom_key(config: &AiConfig, text: &str) -> String {
    let mut hasher = Sha256::new();
    feed(&mut hasher, "custom-v1");
    feed(&mut hasher, config.tts_base_url.trim());
    feed(&mut hasher, config.tts_model.trim());
    feed(&mut hasher, config.tts_voice.trim());
    feed(&mut hasher, text);
    finish(hasher)
}

fn entry(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.json"))
}

/// Looks up one clip. A missing or half-written entry is a miss, not an error:
/// the caller synthesises again and overwrites it.
pub fn read(dir: &Path, key: &str) -> Option<EdgeClip> {
    let bytes = std::fs::read(entry(dir, key)).ok()?;
    match serde_json::from_slice::<EdgeClip>(&bytes) {
        Ok(clip) if !clip.audio.is_empty() => Some(clip),
        Ok(_) => {
            tracing::warn!(key, "缓存里的音频是空的，按未命中处理");
            None
        }
        Err(err) => {
            tracing::warn!(key, error = %err, "语音缓存条目损坏，忽略并重新合成");
            None
        }
    }
}

/// Writes one clip atomically: full contents first, then a rename. A crash or
/// a full disk leaves at worst an orphan `.part`, never a truncated entry that
/// would be read back as a broken clip.
///
/// The `.part` name carries a random suffix so two callers synthesising the
/// same text at once (a replay and an export, say) never write to one file.
pub fn write(dir: &Path, key: &str, clip: &EdgeClip) -> AppResult<()> {
    if clip.audio.is_empty() {
        return Err(AppError::Message("拒绝把空音频写入缓存".into()));
    }
    std::fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(clip)?;
    let part = dir.join(format!("{key}.{}.part", uuid::Uuid::new_v4().simple()));
    std::fs::write(&part, &bytes)?;
    if let Err(err) = std::fs::rename(&part, entry(dir, key)) {
        let _ = std::fs::remove_file(&part);
        return Err(err.into());
    }
    Ok(())
}

/// Reads a clip, synthesising and caching it on a miss.
///
/// A failed cache write is logged and swallowed: the clip is still returned,
/// because the reader's ability to hear a sentence outranks the convenience of
/// having it next time.
pub async fn cached<F, Fut>(dir: Option<&Path>, key: &str, synthesize: F) -> AppResult<EdgeClip>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<EdgeClip>>,
{
    if let Some(clip) = dir.and_then(|path| read(path, key)) {
        return Ok(clip);
    }
    let clip = synthesize().await?;
    if let Some(path) = dir
        && let Err(err) = write(path, key, &clip)
    {
        tracing::warn!(error = %err, "语音缓存写入失败，本次照常播放");
    }
    Ok(clip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::EdgeWord;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("fangce-tts-cache-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn clip() -> EdgeClip {
        EdgeClip { audio: "QUJD".into(), words: vec![EdgeWord { at: 1.25, text: "你好".into() }] }
    }

    fn custom_config() -> AiConfig {
        AiConfig {
            tts_base_url: "https://tts.example.com/v1".into(),
            tts_api_key: "first-key".into(),
            tts_model: "tts-1".into(),
            tts_voice: "nova".into(),
            ..AiConfig::default()
        }
    }

    #[test]
    fn the_key_is_stable_and_separates_everything_that_changes_audio() {
        let same = edge_key("zh-CN-YunjianNeural", "你好");
        assert_eq!(same, edge_key("zh-CN-YunjianNeural", "你好"));
        assert_ne!(same, edge_key("zh-CN-YunxiNeural", "你好"), "换音色必须换 key");
        assert_ne!(same, edge_key("zh-CN-YunjianNeural", "你好。"), "换文本必须换 key");
        // Length prefixes keep neighbouring field values from being confused.
        assert_ne!(edge_key("v|a", "b"), edge_key("v", "a|b"));

        let config = custom_config();
        let key = custom_key(&config, "你好");
        assert_eq!(key, custom_key(&config, "你好"));
        assert_ne!(
            key,
            custom_key(&AiConfig { tts_voice: "onyx".into(), ..config.clone() }, "你好")
        );
        assert_ne!(
            key,
            custom_key(&AiConfig { tts_model: "tts-2".into(), ..config.clone() }, "你好")
        );
        assert_ne!(
            key,
            custom_key(
                &AiConfig { tts_base_url: "https://tts.example.com/v2".into(), ..config.clone() },
                "你好"
            )
        );
        assert_eq!(
            key,
            custom_key(&AiConfig { tts_api_key: "another-key".into(), ..config }, "你好"),
            "key 只决定鉴权，不改变声音"
        );
        assert_ne!(key, edge_key("custom", "你好"), "两路不能共用命名空间");
    }

    #[test]
    fn a_clip_round_trips_with_its_word_timings() {
        let dir = scratch();
        let key = edge_key("v", "你好");
        let original = clip();
        write(&dir, &key, &original).expect("write");
        let loaded = read(&dir, &key).expect("read");
        assert_eq!(loaded.audio, original.audio);
        assert_eq!(loaded.words, original.words);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_entry_is_a_miss_not_a_failure() {
        let dir = scratch();
        let key = edge_key("v", "你好");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(entry(&dir, &key), b"{\"audio\":").expect("broken entry");
        assert!(read(&dir, &key).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_clip_is_never_written() {
        let dir = scratch();
        let key = edge_key("v", "你好");
        let empty = EdgeClip { audio: String::new(), words: vec![] };
        assert!(write(&dir, &key, &empty).is_err());
        assert!(!entry(&dir, &key).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_hit_never_calls_the_synthesizer() {
        let dir = scratch();
        let key = edge_key("v", "你好");
        let calls = Arc::new(AtomicUsize::new(0));
        let first = {
            let calls = calls.clone();
            tauri::async_runtime::block_on(cached(Some(&dir), &key, || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok(clip()) }
            }))
            .expect("first synthesis")
        };
        let second = {
            let calls = calls.clone();
            tauri::async_runtime::block_on(cached(Some(&dir), &key, || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(AppError::Message("命中缓存后不该再合成".into())) }
            }))
            .expect("cached read")
        };
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.audio, second.audio);
        std::fs::remove_dir_all(&dir).ok();
    }
}
