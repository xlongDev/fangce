//! Edge TTS: Microsoft's read-aloud service, the engine behind the voices no
//! platform ships locally.
//!
//! The reader's default voice is Yunjian, and Yunjian does not exist in
//! `AVSpeechSynthesisVoice` or any other OS list — it is a service voice
//! (`zh-CN-YunjianNeural`). Supporting "read in Yunjian" therefore means
//! speaking to that service, which is why this module exists at all.
//!
//! It runs on the Rust side deliberately. The webview cannot make this call
//! itself: the handshake needs a `Cookie` and an `Origin` the browser refuses
//! to let script set, and the `Sec-MS-GEC` token is a hash of the raw clock,
//! not of anything the renderer is trusted with. readest reached the same
//! conclusion and routes its own Edge client through Tauri IPC.
//!
//! Protocol notes that cost real debugging time, all verified against the live
//! service before this file was written:
//!
//! * `Sec-MS-GEC` is `SHA256(<Windows file-time ticks, rounded down to five
//!   minutes><trusted client token>)` in uppercase hex. The ticks value is
//!   ~1.3e17, so it is computed in integers here — a double cannot hold it.
//! * `Sec-MS-GEC-Version` must track a current Edge build. A stale version is
//!   answered with a bare `403` on the handshake and nothing else.
//! * The synthesis socket is on `api.msedgeservices.com` and the key travels
//!   as `Ocp-Apim-Subscription-Key`. Microsoft is retiring the legacy
//!   `speech.platform.bing.com` WebSocket — since 2026-10-10 it answers the
//!   upgrade with a bare `403` in one country after another — while the voice
//!   list on that same legacy host still answers, so `VOICES_URL` stays. The
//!   new host takes the *legacy* signature computed here; claiming the v2
//!   `Sec-MS-GEC-Version` without the v2 token is refused, so the version
//!   constant stays on the build the v1 algorithm was pinned to.
//! * A `Cookie: muid=<32 random hex>;` is required. Without it the handshake
//!   is also refused with `403`.
//! * One socket serves the whole reading session: the service answers
//!   back-to-back requests on it, and reconnecting per sentence would pay a
//!   full TCP + TLS + handshake — most of a second — on every clip of a
//!   chapter. See `SESSION`.
//! * Text frames and binary frames share one envelope: header lines, a blank
//!   line, then the body. The body of `audio.metadata` is the only place the
//!   per-word timings appear.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::{TcpStream, lookup_host};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request as WsRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, Response, StatusCode};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, client_async_tls};

use crate::error::{AppError, AppResult};

/// The public token every Edge client sends. It is not a secret — it ships in
/// the browser extension this endpoint belongs to — and the service takes it as
/// identification, not authentication.
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/// The Edge build whose signature the service currently accepts. Bumping this
/// is the fix when every handshake starts coming back `403`.
const CHROMIUM_VERSION: &str = "143.0.3650.75";

const VOICES_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const WSS_URL: &str = "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1";
/// The same host, spelled out because opening a socket needs an address and
/// `WSS_URL` is only a string.
const WSS_HOST: &str = "api.msedgeservices.com";

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

/// Header block the handshake needs, as `(name, value)` so it can be built
/// without a macro or a builder type.
const HANDSHAKE_HEADERS: [(&str, &str); 6] = [
    ("pragma", "no-cache"),
    ("cache-control", "no-cache"),
    ("origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"),
    ("accept-encoding", "gzip, deflate, br, zstd"),
    ("accept-language", "en-US,en;q=0.9"),
    ("user-agent", USER_AGENT),
];

/// Audio constraints. 24 kHz mono MP3 at 48 kbps is what the service's own
/// client asks for and what `decodeAudioData` handles everywhere.
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

/// Metadata offsets are in 100-nanosecond ticks.
const TICKS_PER_SECOND: f64 = 10_000_000.0;

/// One utterance per request. The cap is not the service's limit: it is the
/// reader's own guarantee that a request is a sentence and not a chapter, which
/// keeps a stalled request cheap to abandon and the audio small enough to hold
/// a couple of clips ahead of the voice.
const MAX_TEXT_CHARS: usize = 1_000;

/// How long one utterance may take. A socket that never answers has to surface
/// as a message the reader can act on, not as a player that never starts.
const SPEAK_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// Seconds to add to the local clock.
///
/// The signature is validated against the *service's* clock, so a machine whose
/// time has drifted is refused on every handshake and cannot recover on its
/// own. A refusal carries the server's own `Date`, which is enough to learn the
/// offset; `edge-tts` carries the same correction for the same reason.
static CLOCK_SKEW: AtomicI64 = AtomicI64::new(0);

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The synthesis socket, kept warm between utterances.
///
/// The service answers back-to-back requests on one socket, and charges every
/// *connection* a full TCP + TLS + handshake — most of a second — before the
/// first audio frame. Until 2026-10-13 each sentence opened its own, so a
/// chapter of a hundred sentences paid that a hundred times. The socket lives
/// here instead and requests take turns over it. Only a turn that ended
/// cleanly is put back; anything else — failure, timeout, cancellation —
/// drops the socket, because a half-read turn left in it would have its
/// frames misread as the next request's audio. See [`turn`].
static SESSION: OnceLock<Mutex<Option<WsStream>>> = OnceLock::new();

fn local_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn now_seconds() -> i64 {
    local_seconds() + CLOCK_SKEW.load(Ordering::Relaxed)
}

/// The `Sec-MS-GEC` token: Windows file-time ticks rounded down to the nearest
/// five minutes, hashed with the client token.
///
/// Rounded so that a request and its immediate retry sign identically, and
/// integral because the value exceeds what a double represents exactly.
pub fn sec_ms_gec(unix_seconds: i64) -> String {
    const WIN_EPOCH: i64 = 11_644_473_600;
    let ticks = (unix_seconds + WIN_EPOCH) / 300 * 300 * 10_000_000;
    let mut hasher = Sha256::new();
    hasher.update(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02X}")).collect()
}

/// A random `muid`, the cookie value the handshake requires. Reusing the UUID
/// crate keeps this from needing a random-number dependency of its own.
fn muid() -> String {
    uuid::Uuid::new_v4().simple().to_string().to_uppercase()
}

/// The `X-Timestamp` both requests carry. Not a standard HTTP date, and not
/// worth normalising: the service parses its own format.
fn timestamp() -> String {
    chrono::Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string()
}

/// One word the service reports, `at` seconds from the start of the clip.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
pub struct EdgeWord {
    pub at: f64,
    pub text: String,
}

/// One utterance: its audio, and where each word sits inside it.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeClip {
    /// 24 kHz mono MP3, base64.
    ///
    /// Base64 inside the same payload as the timings rather than a raw IPC body
    /// on a second call: the two are useless apart, and one round trip per
    /// sentence is what keeps the prefetch simple.
    pub audio: String,
    pub words: Vec<EdgeWord>,
}

/// A voice the service offers.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoice {
    /// The service's id, e.g. `zh-CN-YunjianNeural`. This is what crosses the
    /// wire on every request, and what the reader's pick is stored as.
    pub short_name: String,
    /// Display name, without the locale prefix and the `Neural` suffix.
    pub name: String,
    pub locale: String,
    /// What the voice is styled for ("Novel", "News", "Dialect"). Yunjian,
    /// Yunxi, Yunxia and Yunyang are all male Mandarin voices that differ only
    /// by this, so it is the one label worth showing.
    pub categories: String,
    /// `"Female"` or `"Male"`, straight from the service. The picker draws a
    /// gender mark beside every name: a reader choosing a voice for a novel is
    /// asking for a voice, and the Latin name says nothing about which one.
    /// Empty for a voice the service did not tag, which the picker draws as
    /// nothing rather than guessing.
    pub gender: String,
}

/// Why one attempt did not produce a clip.
#[derive(Debug)]
enum Attempt {
    /// Retrying cannot help.
    Failed(AppError),
    /// The handshake was rejected and the response carried the server's clock.
    Clock(i64),
}

impl From<AppError> for Attempt {
    fn from(err: AppError) -> Self {
        Attempt::Failed(err)
    }
}

fn http() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(LIST_TIMEOUT)
        // Bound to IPv4 on purpose: the host is dual-stack, and on a network
        // whose IPv6 route is broken reqwest's happy eyeballs still settles on
        // the address that connects and then resets, so most fetches fail.
        // ponytail: an IPv6-only network would need a per-address fallback,
        // which reqwest does not expose.
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        .build()
        .map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

/// Network failures are reported in the reader's own words: a raw `reqwest`
/// string names the URL and tells someone listening to a book nothing.
fn offline(what: &str, err: reqwest::Error) -> AppError {
    if err.is_timeout() || err.is_connect() {
        AppError::Message(format!("{what}失败：无法连接 Edge 语音服务，请检查网络"))
    } else {
        AppError::Message(format!("{what}失败：{err}"))
    }
}

/// Every voice the service offers, in the reader's own sort order: locale, then
/// name, with plain byte comparison so the list never reshuffles between runs.
pub async fn voices() -> AppResult<Vec<EdgeVoice>> {
    let url = format!("{VOICES_URL}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}");
    let response =
        http()?.get(&url).send().await.map_err(|err| offline("获取 Edge 语音列表", err))?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!("Edge 语音列表返回 {}", response.status().as_u16())));
    }
    let raw: Vec<RawVoice> = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("Edge 语音列表无法解析：{err}")))?;

    let mut voices: Vec<EdgeVoice> = raw
        .into_iter()
        .map(|voice| EdgeVoice {
            name: display_name(&voice.short_name, &voice.locale),
            short_name: voice.short_name,
            locale: voice.locale,
            categories: voice.tag.categories.join(" / "),
            gender: voice.gender,
        })
        .collect();
    voices.sort_by(|a, b| {
        (a.locale.as_str(), a.name.as_str()).cmp(&(b.locale.as_str(), b.name.as_str()))
    });
    Ok(voices)
}

/// `zh-CN-YunjianNeural` in `zh-CN` comes back as `Yunjian` — the service never
/// localises names, so the id is the only place the bare name exists.
fn display_name(short_name: &str, locale: &str) -> String {
    let tail = short_name
        .strip_prefix(locale)
        .and_then(|rest| rest.strip_prefix('-'))
        .unwrap_or(short_name);
    tail.strip_suffix("Neural").unwrap_or(tail).to_string()
}

/// Reads one utterance.
///
/// There is no rate here, and that is the whole design: every clip comes back at
/// the service's own pace and the reader's speed is applied to the samples as
/// they are scheduled (see `features/reader/timeStretch`). Sending it would make
/// every clip a function of the speed it was asked for, so one speed change
/// would throw away everything already synthesised and refetch it — which is the
/// stall this avoids. It also keeps the clip's word timings honest: they are
/// measured against rate-1.0 audio, and one timeline is what the highlight
/// reads.
pub async fn speak(text: &str, voice: &str) -> AppResult<EdgeClip> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::InvalidArgument("没有可朗读的文本".into()));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::InvalidArgument(format!(
            "单次朗读最长 {MAX_TEXT_CHARS} 字，请分段朗读"
        )));
    }
    check_voice(voice)?;

    let run = tokio::time::timeout(SPEAK_TIMEOUT, turn(text, voice));
    match run.await {
        Ok(Ok(clip)) => Ok(clip),
        // One correction, then give up: a second rejection is not a clock.
        Ok(Err(Attempt::Clock(server))) => {
            CLOCK_SKEW.store(server - local_seconds(), Ordering::Relaxed);
            tracing::info!(skew = server - local_seconds(), "corrected clock for Edge TTS");
            match tokio::time::timeout(SPEAK_TIMEOUT, turn(text, voice)).await {
                Ok(result) => result.map_err(|failure| match failure {
                    Attempt::Failed(err) => err,
                    Attempt::Clock(_) => refused_error(),
                }),
                Err(_) => Err(timeout_error()),
            }
        }
        Ok(Err(Attempt::Failed(err))) => Err(err),
        Err(_) => Err(timeout_error()),
    }
}

fn timeout_error() -> AppError {
    AppError::Message("Edge 语音请求超时，请检查网络后重试".into())
}

fn refused_error() -> AppError {
    AppError::Message("Edge 语音服务拒绝了握手，请稍后重试或切换到系统语音".into())
}

/// The voice id is interpolated into an SSML attribute, so it is validated
/// rather than escaped: a quote in here would inject markup, and no real id
/// contains anything but ASCII letters, digits and hyphens.
fn check_voice(voice: &str) -> AppResult<()> {
    let valid = !voice.is_empty()
        && voice.len() <= 64
        && voice.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        return Ok(());
    }
    Err(AppError::InvalidArgument(format!("无效的语音标识：{voice}")))
}

/// XML-escapes the three characters that could end an element early. The text
/// is book content, so `&` and `<` are routine rather than theoretical.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The service escapes the words it reports back; `&amp;` here is a real `&`.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The SSML for one utterance, with the reader's own locale on the `voice`.
///
/// No `rate` attribute. The service used to be asked to time-stretch, which was
/// the right call while the only alternative was `playbackRate` and its pitch
/// shift — but it tied every clip to the speed it was requested at. The renderer
/// stretches now (see `timeStretch`), so what the service returns is the one
/// canonical reading of the sentence, cacheable for any speed.
fn ssml(text: &str, voice: &str) -> String {
    let locale = voice.split('-').take(2).collect::<Vec<_>>().join("-");
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{locale}'>\
         <voice name='{voice}'><prosody pitch='+0Hz' volume='+0%'>{}</prosody></voice>\
         </speak>",
        escape(text)
    )
}

/// The `speech.config` frame. Word boundaries only: sentence boundaries would
/// arrive as a second, redundant cue list for a queue that is already
/// sentence-shaped.
fn speech_config() -> String {
    let config = serde_json::json!({
        "context": {
            "synthesis": {
                "audio": {
                    "metadataoptions": {
                        "sentenceBoundaryEnabled": "false",
                        "wordBoundaryEnabled": "true",
                    },
                    "outputFormat": OUTPUT_FORMAT,
                }
            }
        }
    });
    format!(
        "X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{config}",
        timestamp()
    )
}

/// The `ssml` frame. The trailing `Z` on `X-Timestamp` is on this request only;
/// it is not a typo here, it is what the service's own client sends.
fn ssml_frame(text: &str, voice: &str) -> String {
    format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{}",
        uuid::Uuid::new_v4().simple(),
        timestamp(),
        ssml(text, voice)
    )
}

/// One `key:value` line out of a frame header block.
fn header_value<'a>(head: &'a str, key: &str) -> Option<&'a str> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
}

/// Splits a frame into its header block and its body. Both frame kinds share
/// this envelope, so one splitter covers text and binary alike.
fn split_frame(raw: &[u8]) -> (&str, &[u8]) {
    let boundary = raw.windows(4).position(|window| window == b"\r\n\r\n").map(|at| at + 4);
    match boundary {
        Some(at) => {
            (std::str::from_utf8(&raw[..at]).unwrap_or(""), raw.get(at..).unwrap_or_default())
        }
        None => (std::str::from_utf8(raw).unwrap_or(""), &[]),
    }
}

/// A binary frame is `[u16 header length][header][audio]`; the length is
/// declared, so the split does not have to search for it.
fn split_binary(raw: &[u8]) -> Option<(&str, &[u8])> {
    let first = *raw.first()?;
    let second = *raw.get(1)?;
    let length = u16::from_be_bytes([first, second]) as usize;
    let head = std::str::from_utf8(raw.get(2..2 + length)?).ok()?;
    Some((head, raw.get(2 + length..)?))
}

/// The word timings out of one `audio.metadata` body.
fn parse_words(body: &[u8]) -> AppResult<Vec<EdgeWord>> {
    let envelope: MetadataEnvelope = serde_json::from_slice(body)?;
    Ok(envelope
        .metadata
        .into_iter()
        .filter(|item| item.kind == "WordBoundary")
        // `Data` is absent on the service's own bookkeeping frames
        // (`SessionEnd`), which are announced through the same channel.
        .filter_map(|item| item.data)
        .map(|data| EdgeWord {
            at: data.offset as f64 / TICKS_PER_SECOND,
            // Offsets are honest inside a single turn: the drift the service's
            // own client compensates for only accumulates across turns, and one
            // sentence is one turn here.
            text: unescape(&data.text.text),
        })
        .collect())
}

#[derive(Deserialize)]
struct MetadataEnvelope {
    #[serde(rename = "Metadata", default)]
    metadata: Vec<MetadataItem>,
}

#[derive(Deserialize)]
struct MetadataItem {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "Data", default)]
    data: Option<MetadataData>,
}

#[derive(Deserialize, Default)]
struct MetadataData {
    #[serde(rename = "Offset", default)]
    offset: u64,
    #[serde(rename = "text", default)]
    text: MetadataWord,
}

#[derive(Deserialize, Default)]
struct MetadataWord {
    #[serde(rename = "Text", default)]
    text: String,
}

#[derive(Deserialize)]
struct RawVoice {
    #[serde(rename = "ShortName")]
    short_name: String,
    #[serde(rename = "Locale")]
    locale: String,
    /// Absent on a voice the service has not tagged; `default` keeps one odd
    /// entry from failing the whole list.
    #[serde(rename = "Gender", default)]
    gender: String,
    #[serde(rename = "VoiceTag", default)]
    tag: RawTag,
}

#[derive(Deserialize, Default)]
struct RawTag {
    #[serde(rename = "ContentCategories", default)]
    categories: Vec<String>,
}

/// Opens the socket, trying every address the host resolves to.
///
/// `TcpStream::connect("host:port")` stops at the first address that completes a
/// TCP handshake, and an address can do that while being unusable one layer up:
/// on a network whose IPv6 route is broken the socket opens, the TLS handshake
/// is then reset, and the reader is told the connection broke without the
/// address that works ever being tried. Resolving here and running the whole
/// handshake per address is what lets that case fall through.
async fn connect() -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, Attempt> {
    // reqwest 0.13 turns on rustls's `aws_lc_rs` provider while
    // tokio-tungstenite's TLS keeps `ring` enabled; with both features on,
    // rustls refuses to guess and `client_async_tls` panics before the socket
    // is ever used — debug builds lose the invoke silently (the renderer waits
    // forever on a promise that is never answered), release builds abort the
    // process. Pin the default once; a second call is a no-op error we ignore.
    // ponytail: revisit if tokio-tungstenite ever grows an explicit-provider API.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let addresses = lookup_host((WSS_HOST, 443)).await.map_err(|err| {
        Attempt::Failed(AppError::Message(format!("无法解析 Edge 语音地址：{err}")))
    })?;
    let mut last: Option<WsError> = None;
    for address in addresses {
        let stream = match TcpStream::connect(address).await {
            Ok(stream) => stream,
            Err(err) => {
                last = Some(WsError::Io(err));
                continue;
            }
        };
        match client_async_tls(handshake_request()?, stream).await {
            Ok((socket, _)) => return Ok(socket),
            // A refusal is the service answering, so another address gets the
            // same answer; let it decide whether this was a clock after all.
            Err(err @ WsError::Http(_)) => return Err(classify(err)),
            Err(err) => last = Some(err),
        }
    }
    Err(Attempt::Failed(match last {
        Some(err) => socket_error(err),
        None => AppError::Message("Edge 语音地址没有解析到服务器".into()),
    }))
}

/// The handshake request. Rebuilt per address — `Request` is not `Clone`, and
/// the cookie is meant to be fresh per request anyway.
fn handshake_request() -> Result<WsRequest, Attempt> {
    let url = format!(
        "{WSS_URL}?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{CHROMIUM_VERSION}&ConnectionId={}",
        sec_ms_gec(now_seconds()),
        uuid::Uuid::new_v4().simple()
    );
    let mut request = url
        .into_client_request()
        .map_err(|err| Attempt::Failed(AppError::Message(format!("Edge 语音地址无效：{err}"))))?;
    {
        let headers = request.headers_mut();
        for (name, value) in HANDSHAKE_HEADERS {
            headers.insert(HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        // The service refuses the handshake outright without this cookie, and
        // the value is only ever echoed back, so a fresh random one per request
        // is both sufficient and the least identifying thing to send.
        let cookie = HeaderValue::from_str(&format!("muid={};", muid())).map_err(|err| {
            Attempt::Failed(AppError::Message(format!("无法生成握手凭据：{err}")))
        })?;
        headers.insert(HeaderName::from_static("cookie"), cookie);
    }
    Ok(request)
}

/// One utterance over the session socket.
///
/// The socket is *taken out* of the session for the request and only put back
/// once its turn ended cleanly. That is what makes the timeout in `speak`
/// safe: a request cancelled mid-turn drops its socket rather than returning
/// it with a half-read turn inside, which the next request would misread as
/// its own audio. A reused socket that dies mid-turn — the service dropping an
/// idle connection is the usual cause — gets one fresh connection and one
/// retry, because that is the service's doing, not the reader's.
async fn turn(text: &str, voice: &str) -> Result<EdgeClip, Attempt> {
    let mut slot = SESSION.get_or_init(|| Mutex::new(None)).lock().await;
    let warm = slot.is_some();
    let mut socket = match slot.take() {
        Some(socket) => socket,
        None => connect().await?,
    };
    match exchange(&mut socket, text, voice).await {
        Ok(clip) => {
            *slot = Some(socket);
            Ok(clip)
        }
        Err(failure) => {
            // The socket is dropped here, not returned: a failed turn leaves
            // unread frames, and a socket carrying them is worse than none.
            if !warm {
                return Err(failure);
            }
            let mut fresh = connect().await?;
            let clip = exchange(&mut fresh, text, voice).await?;
            *slot = Some(fresh);
            Ok(clip)
        }
    }
}

/// One `speech.config`, one `ssml`, then read the turn to its end.
///
/// The turn must end on `turn.end`. A socket that closes first — the service
/// dropping an idle connection, a route that gave up — has a partial clip
/// inside it, and returning that would play half a sentence; the caller drops
/// the socket instead.
async fn exchange(socket: &mut WsStream, text: &str, voice: &str) -> Result<EdgeClip, Attempt> {
    socket
        .send(Message::text(speech_config()))
        .await
        .map_err(|err| Attempt::Failed(socket_error(err)))?;
    socket
        .send(Message::text(ssml_frame(text, voice)))
        .await
        .map_err(|err| Attempt::Failed(socket_error(err)))?;

    let mut audio: Vec<u8> = Vec::new();
    let mut words: Vec<EdgeWord> = Vec::new();
    let mut ended = false;
    while let Some(message) = socket.next().await {
        match message.map_err(|err| Attempt::Failed(socket_error(err)))? {
            Message::Text(raw) => {
                let (head, body) = split_frame(raw.as_bytes());
                match header_value(head, "Path") {
                    Some("audio.metadata") => words.extend(parse_words(body)?),
                    Some("turn.end") => {
                        ended = true;
                        break;
                    }
                    _ => {}
                }
            }
            Message::Binary(raw) => {
                let Some((head, payload)) = split_binary(&raw) else { continue };
                if header_value(head, "Path") == Some("audio") {
                    audio.extend_from_slice(payload);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if !ended {
        return Err(Attempt::Failed(AppError::Message(
            "Edge 语音连接在合成途中断开，请重试".into(),
        )));
    }
    if audio.is_empty() {
        return Err(Attempt::Failed(AppError::Message(
            "Edge 语音没有返回音频，请重试或切换语音".into(),
        )));
    }
    Ok(EdgeClip { audio: STANDARD.encode(&audio), words })
}

/// A rejected handshake says which of the two failures this is: a version or
/// signature the service refuses, or a clock that has drifted. The response's
/// own `Date` is what tells them apart.
fn classify(err: WsError) -> Attempt {
    let WsError::Http(response) = &err else {
        return Attempt::Failed(socket_error(err));
    };
    // A rate limit is not a clock, and waiting is the answer to it: treating
    // one as the other spent a full second attempt on a request the service
    // had just asked us not to repeat, then showed the reader a message about
    // the handshake. It carries a `Date` like any other refusal, so it has to
    // be told apart before the clock is read out of it.
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Attempt::Failed(AppError::Message("Edge 语音请求过于频繁，请稍候再试".into()));
    }
    match server_seconds(response) {
        Some(server) => Attempt::Clock(server),
        None => Attempt::Failed(refused_error()),
    }
}

/// The server's clock, out of the `Date` a refusal carries.
fn server_seconds(response: &Response<Option<Vec<u8>>>) -> Option<i64> {
    let raw = response.headers().get("date")?.to_str().ok()?;
    chrono::DateTime::parse_from_rfc2822(raw).ok().map(|at| at.timestamp())
}

fn socket_error(err: WsError) -> AppError {
    match err {
        WsError::Http(ref response) => {
            let status = response.status().as_u16();
            tracing::warn!(status, "Edge TTS handshake refused");
            AppError::Message(format!("Edge 语音握手被拒绝（HTTP {status}）"))
        }
        other => {
            tracing::warn!(error = %other, "Edge TTS connection failed");
            AppError::Message(format!("Edge 语音连接中断：{other}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors generated from the reference implementation, so a change to the
    /// rounding or the hashing shows up here rather than as a live `403`.
    #[test]
    fn the_signature_matches_the_reference_implementation() {
        assert_eq!(
            sec_ms_gec(1_757_567_220),
            "05F5ADA786BE35CE66D0F65305E53A03B00CEC2726CF586DF32D62853D01BEF7"
        );
        assert_eq!(
            sec_ms_gec(1_757_567_400),
            "AF6A6255468F0BB81E458EE56B4D211669667B4E2075BE754D87DDF742891A6A"
        );
        assert_eq!(
            sec_ms_gec(0),
            "7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C"
        );
    }

    #[test]
    fn the_signature_only_changes_every_five_minutes() {
        assert_eq!(sec_ms_gec(1_757_567_220), sec_ms_gec(1_757_567_399));
        assert_ne!(sec_ms_gec(1_757_567_399), sec_ms_gec(1_757_567_400));
    }

    #[test]
    fn the_clock_correction_is_read_from_a_real_rejection_header() {
        // Captured verbatim from a live refusal.
        let raw = "Fri, 11 Sep 2026 04:56:00 GMT";
        let parsed = chrono::DateTime::parse_from_rfc2822(raw).expect("RFC 2822 with GMT");
        assert_eq!(parsed.timestamp(), 1_789_102_560);
    }

    #[test]
    fn a_rate_limit_is_not_a_clock() {
        // A 429 carries a `Date` like every other refusal, so reading the clock
        // first is what turned it into a pointless second attempt. It must be
        // told apart before that read — measured against the live service,
        // which answers a burst of connections with one.
        let response = Response::builder()
            .status(429)
            .header("date", "Tue, 13 Oct 2026 09:00:00 GMT")
            .body(None)
            .expect("response");
        match classify(WsError::Http(Box::new(response))) {
            Attempt::Failed(AppError::Message(text)) => {
                assert!(text.contains("频繁"), "{text}");
            }
            other => panic!("429 不能被当成别的：{other:?}"),
        }
    }

    #[test]
    fn book_text_cannot_break_out_of_the_ssml() {
        let markup = ssml("Tom & <Jerry>", "zh-CN-YunjianNeural");
        assert!(markup.contains("Tom &amp; &lt;Jerry&gt;"), "{markup}");
        assert_eq!(markup.matches("<voice").count(), 1);
        assert!(markup.starts_with("<speak version='1.0'"));
        // The reader's speed is applied to the samples, so the markup must not
        // carry one: a clip has to be the same clip at every speed.
        assert!(!markup.contains("rate="), "{markup}");
    }

    #[test]
    fn a_voice_id_is_checked_before_it_reaches_the_markup() {
        assert!(check_voice("zh-CN-YunjianNeural").is_ok());
        assert!(check_voice("en-US-EmmaMultilingualNeural").is_ok());
        assert!(check_voice("zh-CN-x'><script>").is_err(), "引号必须被拒绝");
        assert!(check_voice("").is_err());
        assert!(check_voice(&"a".repeat(65)).is_err());
    }

    #[test]
    fn frame_headers_are_read_without_the_body_confusing_them() {
        let (head, body) = split_frame(b"Path:audio.metadata\r\nX-Foo:1\r\n\r\n{\"Metadata\":[]}");
        assert_eq!(header_value(head, "Path"), Some("audio.metadata"));
        assert_eq!(header_value(head, "path"), Some("audio.metadata"), "大小写不敏感");
        assert_eq!(body, b"{\"Metadata\":[]}");
    }

    #[test]
    fn a_binary_frame_is_split_at_its_declared_length() {
        let head = b"Path:audio\r\nContent-Type:audio/mpeg";
        let mut raw = (head.len() as u16).to_be_bytes().to_vec();
        raw.extend_from_slice(head);
        raw.extend_from_slice(b"\xff\xfb\x90\x00");
        let (head, payload) = split_binary(&raw).expect("frame");
        assert_eq!(header_value(head, "Path"), Some("audio"));
        assert_eq!(payload, b"\xff\xfb\x90\x00");
    }

    #[test]
    fn word_boundaries_become_seconds() {
        let body = r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":0,"Duration":3000000,"text":{"Text":"你好","Length":2}}},{"Type":"WordBoundary","Data":{"Offset":21375000,"Duration":4000000,"text":{"Text":"一次","Length":2}}},{"Type":"SessionEnd","Data":{}}]}"#;
        let words = parse_words(body.as_bytes()).expect("parse");
        assert_eq!(words.len(), 2, "SessionEnd 不是词");
        assert_eq!(words[0].at, 0.0);
        assert_eq!(words[1].text, "一次");
        assert!((words[1].at - 2.1375).abs() < 1e-9, "100ns 刻度换算成秒");
    }

    #[test]
    fn escaped_words_come_back_as_written() {
        let body = r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":0,"Duration":1,"text":{"Text":"a &amp; b &lt;c&gt;"}}}]}"#;
        assert_eq!(parse_words(body.as_bytes()).expect("parse")[0].text, "a & b <c>");
    }

    #[test]
    fn the_handshake_carries_everything_the_service_refuses_without() {
        let request = handshake_request().expect("request");
        let query = request.uri().query().unwrap_or_default();
        // The key's query name moved with the host: the legacy
        // `TrustedClientToken` is what the retired `speech.platform.bing.com`
        // WebSocket wanted, and `api.msedgeservices.com` refuses the upgrade
        // without its own spelling.
        assert!(query.contains("Ocp-Apim-Subscription-Key="), "{query}");
        assert!(query.contains("Sec-MS-GEC-Version=1-"), "{query}");
        let value = |name: &str| {
            request
                .headers()
                .get(name)
                .unwrap_or_else(|| panic!("缺少 {name}"))
                .to_str()
                .expect("header")
                .to_string()
        };
        assert_eq!(value("origin"), "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
        assert!(value("cookie").starts_with("muid="), "{}", value("cookie"));
        assert!(value("user-agent").contains("Edg/"), "{}", value("user-agent"));
    }

    #[test]
    fn display_names_drop_the_locale_and_the_engine_suffix() {
        assert_eq!(display_name("zh-CN-YunjianNeural", "zh-CN"), "Yunjian");
        assert_eq!(display_name("zh-CN-liaoning-XiaobeiNeural", "zh-CN-liaoning"), "Xiaobei");
        assert_eq!(display_name("zh-TW-YunJheNeural", "zh-TW"), "YunJhe");
        assert_eq!(display_name("oddity", "zh-CN"), "oddity");
    }

    /// The live checks. Everything above tests this file's own arithmetic;
    /// these test that the arithmetic is still the service's arithmetic, which
    /// no offline fixture can answer — Microsoft moves the version gate.
    ///
    /// `cargo test --release edge -- --ignored --nocapture`
    ///
    /// Egress to the new host goes through a shared, quota'd proxy — the
    /// address it hands back for `api.msedgeservices.com` is a placeholder,
    /// not Akamai — and it answers a third connection inside a few seconds
    /// with the same `429` a real rate limit would. Waiting is also what the
    /// reader is told to do, so the checks do it too: bounded, so a real
    /// outage fails here instead of hanging, and only for the rate limit —
    /// anything else is the answer the check came for.
    fn waiting_out_the_egress_quota<T>(
        what: &str,
        mut call: impl FnMut() -> Result<T, AppError>,
    ) -> T {
        for attempt in 1..=4 {
            match call() {
                Ok(value) => return value,
                Err(AppError::Message(ref message)) if message.contains("频繁") => {
                    assert!(attempt < 4, "{what} 一直被限流：{message}");
                    std::thread::sleep(Duration::from_secs(2 * attempt as u64));
                }
                Err(failure) => panic!("{what}：{failure:?}"),
            }
        }
        unreachable!("循环只能以 return 或 panic 结束")
    }

    #[test]
    #[ignore = "hits the live Edge service"]
    fn the_service_still_lists_yunjian() {
        let voices =
            waiting_out_the_egress_quota("voice list", || tauri::async_runtime::block_on(voices()));
        assert!(voices.len() > 100, "只有 {} 个语音", voices.len());
        let yunjian = voices
            .iter()
            .find(|voice| voice.short_name == "zh-CN-YunjianNeural")
            .expect("Yunjian 必须还在列表里");
        assert_eq!(yunjian.name, "Yunjian");
        assert_eq!(yunjian.locale, "zh-CN");
    }

    #[test]
    #[ignore = "hits the live Edge service"]
    fn the_service_still_returns_audio_and_word_timings() {
        let clip = waiting_out_the_egress_quota("clip", || {
            tauri::async_runtime::block_on(speak(
                "你好，这是 方册 的语音引擎测试。",
                "zh-CN-YunjianNeural",
            ))
        });
        assert!(clip.audio.len() > 1_000, "音频太短：{}", clip.audio.len());
        assert!(!clip.words.is_empty(), "没有词边界");
        assert!(
            clip.words.windows(2).all(|pair| pair[0].at <= pair[1].at),
            "词边界必须按时间递增：{:?}",
            clip.words
        );
        let first = &clip.words[0];
        assert!(first.at < 0.5, "第一个词不该在 {}s 之后", first.at);
    }

    /// The session socket, proven against the service rather than against a
    /// fixture: the second clip rides the connection the first one opened, so
    /// its audio is a *different* clip's — a socket returned with a half-read
    /// turn inside would hand back the first sentence again.
    #[test]
    #[ignore = "hits the live Edge service"]
    fn one_socket_serves_more_than_one_utterance() {
        let first = waiting_out_the_egress_quota("first clip", || {
            tauri::async_runtime::block_on(speak(
                "第一句话，用来打开这条连接。",
                "zh-CN-YunjianNeural",
            ))
        });
        let second = waiting_out_the_egress_quota("second clip", || {
            tauri::async_runtime::block_on(speak(
                "第二句话，复用同一条连接。",
                "zh-CN-YunjianNeural",
            ))
        });
        assert!(first.audio.len() > 1_000, "第一句音频太短：{}", first.audio.len());
        assert!(second.audio.len() > 1_000, "第二句音频太短：{}", second.audio.len());
        assert_ne!(first.audio, second.audio, "第二句必须是它自己的音频");
    }
}
