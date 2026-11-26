//! `tts.*` commands: the Edge read-aloud engine.
//!
//! The renderer never reaches this service directly. The handshake needs
//! headers its own webview refuses to let script set, and the signature is a
//! hash of the raw clock, so both live behind the IPC boundary.

use tauri::{AppHandle, State};

use crate::ai::AiConfig;
use crate::error::AppResult;
use crate::state::AppState;
use crate::tts::{self, CUSTOM_VOICE_ID, EdgeClip, EdgeVoice};
use crate::tts_cache;

/// `tts.edgeVoices` — every voice the service offers, plus the reader's own
/// service when one is configured. The custom voice is an `EdgeVoice` too: the
/// renderer's catalogue, picker and cache-invalidation rules then need no
/// third shape to know about.
#[tauri::command]
#[specta::specta]
pub async fn tts_edge_voices(state: State<'_, AppState>) -> AppResult<Vec<EdgeVoice>> {
    let config = crate::ai::config(&state.library)?;
    let custom = tts::custom_voice(&config);
    match tts::voices().await {
        Ok(mut voices) => {
            if let Some(custom) = custom {
                voices.push(custom);
            }
            Ok(voices)
        }
        // A reader who configured their own service can still read offline.
        // Failing the whole catalogue here would hand them no usable voice
        // precisely when a local endpoint is the one that works.
        Err(err) => custom.map(|voice| vec![voice]).ok_or(err),
    }
}

/// `tts.edgeSpeak` — one utterance, with its word timings.
///
/// No rate: the clip comes back at the service's own pace and the renderer
/// stretches it to the reader's speed, so one clip answers for every speed.
/// The fixed `custom` voice id switches to the reader's own endpoint; every
/// other id is Microsoft's.
///
/// The disk cache is wrapped here rather than in `tts.rs`: those synthesis
/// functions stay pure and hold no `AppHandle`, which keeps both their tests
/// and the future export path able to call them directly.
#[tauri::command]
#[specta::specta]
pub async fn tts_edge_speak(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    voice: String,
) -> AppResult<EdgeClip> {
    let cache = tts_cache::dir(&app);
    if voice == CUSTOM_VOICE_ID {
        let config: AiConfig = crate::ai::config(&state.library)?;
        let key = tts_cache::custom_key(&config, &text);
        return tts_cache::cached(cache.as_deref(), &key, || tts::speak_custom(&text, &config))
            .await;
    }
    let key = tts_cache::edge_key(&voice, &text);
    tts_cache::cached(cache.as_deref(), &key, || tts::speak(&text, &voice)).await
}
