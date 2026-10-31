//! Streaming chat against an OpenAI-compatible endpoint.
//!
//! The whole protocol is `POST /chat/completions` with `stream: true` and a
//! body of newline-delimited `data:` frames. Hosted providers and every local
//! runtime worth supporting (Ollama, LM Studio, vLLM, llama.cpp server) speak
//! it, so there is exactly one client here and no vendor-specific code paths.
//!
//! SSE parsing is a pure function over bytes so it can be tested without a
//! socket, which is the only part with real branching.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// One turn in a conversation. `system` arrives separately, not as a message.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// A piece of a streamed answer.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// Incremental text, already decoded.
    Delta(String),
    /// The stream ended normally.
    Done,
    /// Provider reported a reason, e.g. `length` when it hit the token cap.
    Finish(Option<String>),
}

/// One SSE line, decoded.
#[derive(Debug, Clone, PartialEq)]
enum Frame {
    /// A `data:` payload, verbatim.
    Data(String),
    /// A blank line, or `event:` / `id:` / `retry:` / a `:comment`. Kept as
    /// distinct variants only so the parser can be tested line by line; the
    /// stream itself ignores everything that is not `data:`.
    Ignored,
}

fn parse_line(line: &str) -> Frame {
    let line = line.strip_suffix('\r').unwrap_or(line);
    match line.split_once(':') {
        Some(("data", rest)) => Frame::Data(rest.trim_start_matches(' ').to_string()),
        _ => Frame::Ignored,
    }
}

/// Splits a chunk of an SSE body into events.
///
/// `buffer` holds the trailing partial line between calls; SSE frames are
/// separated by a blank line, but the network has no obligation to deliver one
/// frame per read, so the parser has to be resumable.
pub fn feed(buffer: &mut String, chunk: &str) -> Vec<StreamEvent> {
    buffer.push_str(chunk);

    // Only consume up to the last newline: the tail may be a partial line.
    let ready_end = buffer.rfind('\n').map_or(0, |index| index + 1);
    let ready: String = buffer.drain(..ready_end).collect();

    let mut events: Vec<StreamEvent> = Vec::new();
    for line in ready.split('\n') {
        // Every OpenAI-compatible endpoint sends one JSON object per `data:`
        // line. The SSE spec allows several per event, joined by newlines, but
        // no provider does that and handling it would mean parsing a
        // concatenation that is not valid JSON anyway.
        if let Frame::Data(payload) = parse_line(line) {
            events.extend(decode_data(&payload));
        }
    }
    events
}

/// Turns one `data:` payload into stream events.
fn decode_data(payload: &str) -> Vec<StreamEvent> {
    if payload.trim() == "[DONE]" {
        return vec![StreamEvent::Done];
    }

    let Ok(frame) = serde_json::from_str::<Chunk>(payload) else {
        // A frame we do not understand is not a reason to kill the stream:
        // providers add fields and send keep-alive comments that parse as junk.
        tracing::debug!(payload, "跳过无法解析的 SSE 帧");
        return Vec::new();
    };

    let Chunk { choices } = frame;

    let mut events = Vec::new();
    for choice in choices {
        if let Some(text) = choice.delta.content
            && !text.is_empty()
        {
            events.push(StreamEvent::Delta(text));
        }
        if let Some(reason) = choice.finish_reason {
            events.push(StreamEvent::Finish(Some(reason)));
        }
    }
    events
}

/// The subset of the response schema this client reads. Unknown fields are
/// ignored rather than rejected, so a provider can add whatever it likes.
#[derive(Debug, Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
}

/// Request body. Kept minimal: temperature and max tokens are the two knobs a
/// reader actually wants, everything else stays at the provider's default.
#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

/// Non-streaming probe used by the settings page: one token, cheap, and enough
/// to prove the endpoint, key and model name are all correct together.
#[derive(Debug, Serialize)]
struct ProbeRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
}

/// Sends one request and streams the answer, invoking `on_event` per frame.
///
/// Errors are mapped to sentences a user can act on. The provider's own message
/// is included when it is short: it usually names the actual problem ("model
/// not found"), and swallowing it leaves people guessing.
pub async fn stream_chat<F>(
    client: &reqwest::Client,
    config: &super::AiConfig,
    messages: Vec<ChatMessage>,
    mut on_event: F,
) -> AppResult<()>
where
    F: FnMut(StreamEvent),
{
    let url = super::completions_url(&config.base_url);
    let body = ChatRequest {
        model: &config.model,
        messages,
        stream: true,
        temperature: None,
        max_tokens: None,
    };

    let mut request = client.post(&url).json(&body);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }

    let response = request.send().await.map_err(http_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(provider_error(status.as_u16(), &response.text().await.unwrap_or_default()));
    }

    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt as _;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(http_error)?;
        let text = String::from_utf8_lossy(&chunk);
        for event in feed(&mut buffer, &text) {
            let done = matches!(event, StreamEvent::Done);
            on_event(event);
            if done {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// How long to wait before retrying a probe that met a 429.
const PROBE_RETRY_DELAY: Duration = Duration::from_millis(1500);

/// One-shot check that the endpoint answers at all.
///
/// A shared local endpoint can be momentarily full — OC Ferry caps its
/// forwarding port at four concurrent chats, and another client (WorkBuddy,
/// say) often holds some of them — so a single 429 is retried once after a
/// short pause before it is reported. The pause lives here, not in
/// `provider_error`, because it is "try again in a moment", not how a status
/// should read.
pub async fn probe(client: &reqwest::Client, config: &super::AiConfig) -> AppResult<()> {
    let url = super::completions_url(&config.base_url);
    let body = ProbeRequest {
        model: &config.model,
        messages: vec![ChatMessage { role: Role::User, content: "hi".to_string() }],
        max_tokens: 1,
    };

    let mut retried = false;
    loop {
        let mut request = client.post(&url).json(&body);
        if !config.api_key.is_empty() {
            request = request.bearer_auth(&config.api_key);
        }
        let response = request.send().await.map_err(http_error)?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let text = response.text().await.unwrap_or_default();
        // One retry only: ride out a momentarily full port, but do not hammer a
        // provider that is genuinely refusing us.
        if status.as_u16() == 429 && !retried {
            retried = true;
            tokio::time::sleep(PROBE_RETRY_DELAY).await;
            continue;
        }
        return Err(provider_error(status.as_u16(), &text));
    }
}

fn http_error(err: reqwest::Error) -> AppError {
    if err.is_timeout() {
        return AppError::Message("请求超时，检查网络或本地模型是否已启动".into());
    }
    if err.is_connect() {
        return AppError::Message("连不上接口地址，检查地址是否正确、本地模型是否已启动".into());
    }
    // `reqwest` error strings can embed the URL, which may contain a key as a
    // query parameter. Only the category is reported.
    AppError::Message(format!("网络请求失败：{err}"))
}

/// Maps an HTTP status to something the settings page can act on.
pub(crate) fn provider_error(status: u16, body: &str) -> AppError {
    let message = match status {
        401 | 403 => "API Key 被拒绝，检查 Key 是否正确或已过期",
        404 => "接口地址或模型名称不存在",
        429 => "触发了速率限制，稍后再试",
        status if status >= 500 => "服务端出错，稍后再试或换个模型",
        _ => "请求被拒绝",
    };
    // The provider's message usually names the real problem ("model not found"),
    // so it is worth showing when it is short. A multi-kilobyte HTML error page
    // is not worth showing, so long ones are dropped.
    match extract_error_message(body) {
        Some(text) if !text.is_empty() && text.len() <= 200 => {
            AppError::Message(format!("{message}：{text}"))
        }
        _ => AppError::Message(format!("{message}（HTTP {status}）")),
    }
}

/// Pulls `error.message` out of an OpenAI-style error body.
fn extract_error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let text = value.get("error")?.get("message")?.as_str()?;
    Some(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(chunks: &[&str]) -> (Vec<StreamEvent>, String) {
        let mut buffer = String::new();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(feed(&mut buffer, chunk));
        }
        (events, buffer)
    }

    #[test]
    fn a_complete_frame_yields_its_delta() {
        let payload = r#"{"choices":[{"delta":{"content":"你好"}}]}"#;
        let (events, rest) = collect(&[&format!("data: {payload}\n\n")]);
        assert_eq!(events, [StreamEvent::Delta("你好".into())]);
        assert!(rest.is_empty(), "完整帧不该留下残余");
    }

    #[test]
    fn a_frame_split_inside_a_line_waits_for_the_blank_line() {
        let mut buffer = String::new();
        let whole = r#"data: {"choices":[{"delta":{"content":"世界"}}]}"#;

        let (head, tail) = whole.split_at(20);
        assert!(feed(&mut buffer, head).is_empty(), "半行不该产生事件");
        assert_eq!(buffer, head);

        assert!(feed(&mut buffer, tail).is_empty(), "还没有空行，事件不能提前发出");
        assert_eq!(feed(&mut buffer, "\n\n"), [StreamEvent::Delta("世界".into())]);
    }

    #[test]
    fn carriage_returns_and_keepalive_comments_are_tolerated() {
        let payload = r#"{"choices":[{"delta":{"content":"a"}}]}"#;
        let (events, _) = collect(&[&format!(": ping\r\n\r\ndata: {payload}\r\n\r\n")]);
        assert_eq!(events, [StreamEvent::Delta("a".into())]);
    }

    #[test]
    fn the_done_sentinel_ends_the_stream() {
        let (events, _) = collect(&["data: [DONE]\n\n"]);
        assert_eq!(events, [StreamEvent::Done]);
    }

    #[test]
    fn a_finish_reason_is_reported() {
        let payload = r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#;
        let (events, _) = collect(&[&format!("data: {payload}\n\n")]);
        assert_eq!(events, [StreamEvent::Finish(Some("length".into()))]);
    }

    #[test]
    fn unparseable_frames_are_skipped_not_fatal() {
        let (events, _) = collect(&[
            "data: not json\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
        ]);
        assert_eq!(events, [StreamEvent::Delta("ok".into())]);
    }

    #[test]
    fn empty_deltas_are_not_emitted() {
        let (events, _) = collect(&["data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\n"]);
        assert!(events.is_empty(), "空增量会引发无意义的重渲染");
    }

    #[test]
    fn several_frames_in_one_chunk_are_all_emitted() {
        let (events, rest) = collect(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"上\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"下\"}}]}\n\n",
        ]);
        assert_eq!(events, [StreamEvent::Delta("上".into()), StreamEvent::Delta("下".into())]);
        assert!(rest.is_empty());
    }

    #[test]
    fn status_codes_map_to_actionable_sentences() {
        let unauthorized = provider_error(401, r#"{"error":{"message":"Incorrect API key"}}"#);
        assert!(unauthorized.to_string().contains("API Key"), "{unauthorized}");
        assert!(unauthorized.to_string().contains("Incorrect API key"));

        let missing = provider_error(404, r#"{"error":{"message":"model not found"}}"#);
        assert!(missing.to_string().contains("模型名称"), "{missing}");

        let limited = provider_error(429, "");
        assert!(limited.to_string().contains("速率限制"), "{limited}");

        let down = provider_error(503, "");
        assert!(down.to_string().contains("服务端"), "{down}");
    }

    #[test]
    fn a_huge_error_body_is_not_pasted_into_the_message() {
        let long = "x".repeat(5000);
        let body = format!("{{\"error\":{{\"message\":\"{long}\"}}}}");
        let error = provider_error(400, &body);
        assert!(error.to_string().len() < 300, "{error}");
    }

    #[test]
    fn the_request_body_omits_optional_knobs() {
        let body = ChatRequest {
            model: "m",
            messages: vec![ChatMessage { role: Role::User, content: "hi".into() }],
            stream: true,
            temperature: None,
            max_tokens: None,
        };
        let json = serde_json::to_value(&body).expect("serialize");
        assert!(json.get("temperature").is_none(), "未设置的旋钮不该出现在请求里");
        assert_eq!(json["stream"], serde_json::json!(true));
        assert_eq!(json["messages"][0]["role"], serde_json::json!("user"));
    }
}
