//! `tts.*` commands: the Edge read-aloud engine.
//!
//! The renderer never reaches this service directly. The handshake needs
//! headers its own webview refuses to let script set, and the signature is a
//! hash of the raw clock, so both live behind the IPC boundary.

use tauri::State;

use crate::ai::AiConfig;
use crate::error::AppResult;
use crate::state::AppState;
use crate::tts::{self, CUSTOM_VOICE_ID, EdgeClip, EdgeVoice};

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
#[tauri::command]
#[specta::specta]
pub async fn tts_edge_speak(
    state: State<'_, AppState>,
    text: String,
    voice: String,
) -> AppResult<EdgeClip> {
    if voice == CUSTOM_VOICE_ID {
        let config: AiConfig = crate::ai::config(&state.library)?;
        return tts::speak_custom(&text, &config).await;
    }
    tts::speak(&text, &voice).await
}
