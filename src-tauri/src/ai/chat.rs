//! Streaming chat against an OpenAI-compatible endpoint.
//!
//! The whole protocol is `POST /chat/completions` with `stream: true` and a
//! body of newline-delimited `data:` frames. Hosted providers and every local
//! runtime worth supporting (Ollama, LM Studio, vLLM, llama.cpp server) speak
//! it, so there is exactly one client here and no vendor-specific code paths.
//!
//! SSE parsing is a pure function over bytes so it can be tested without a
//! socket, which is the only part with real branching.
//!
//! Three things are less universal than the format suggests, and each is handled
//! by being *optional* rather than by being assumed:
//!
//! - `stream_options.include_usage` — most providers honour it, a few strict
//!   gateways reject the field outright.
//! - `temperature` — reasoning models refuse anything but 1.
//! - the parameter that turns on a reasoning stream — every vendor named it
//!   differently.
//!
//! So a 400 whose body names one of the fields *we* added is retried once
//! without it ([`retry_without_rejected_field`]). Losing token counts is worth
//! far less than losing the answer.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{AppError, AppResult};

use super::usage::TokenUsage;

/// One turn in a conversation. `system` arrives separately, not as a message.
///
/// The two tool fields are what makes a multi-round exchange expressible: an
/// assistant turn that decided to call tools carries them, and each answer to
/// one comes back as a `tool` turn naming the call it answers. Both are skipped
/// when empty, so an ordinary conversation serialises exactly as it used to.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self { role, content: content.into(), tool_calls: Vec::new(), tool_call_id: None }
    }
}

#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// One call the model asked for, as it will be echoed back in the next request.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The raw JSON the model produced. Kept as text: re-serialising a parsed
    /// value would silently drop whatever the tool's schema did not expect, and
    /// the tool itself is the thing that should decide that.
    pub arguments: String,
}

/// One tool the model may call.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: FunctionDef,
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionDef {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: serde_json::Value,
}

/// A piece of a streamed answer.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// Incremental text, already decoded.
    Delta(String),
    /// Incremental reasoning, for the models that stream it separately.
    Reasoning(String),
    /// Token counts, sent by providers that honour `include_usage` — usually on
    /// the last frame, with an empty `choices` array.
    Usage(TokenUsage),
    /// A piece of a tool call. Arguments arrive split across frames and have to
    /// be accumulated before the call can be made (see [`absorb_tool_call`]).
    ToolCall(ToolCallDelta),
    /// The stream ended normally.
    Done,
    /// Provider reported a reason, e.g. `length` when it hit the token cap, or
    /// `tool_calls` when it is waiting for a tool's answer.
    Finish(Option<String>),
}

/// One frame's worth of a tool call.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ToolCallDelta {
    /// Which call this fragment belongs to. Models emit several in one turn.
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<FunctionDelta>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

/// Folds one fragment into the call it belongs to, growing the list as needed.
///
/// Every field arrives in pieces — the name is usually whole on the first frame,
/// the arguments never are — so each is appended rather than replaced. A call
/// whose index is new starts empty, which is what makes parallel calls work: the
/// model sends `index: 0`, `index: 1`, then interleaves the rest.
pub fn absorb_tool_call(calls: &mut Vec<ToolCall>, delta: &ToolCallDelta) {
    while calls.len() <= delta.index {
        calls.push(ToolCall { id: String::new(), name: String::new(), arguments: String::new() });
    }
    let Some(call) = calls.get_mut(delta.index) else { return };
    if let Some(id) = delta.id.as_deref()
        && !id.is_empty()
    {
        call.id = id.to_string();
    }
    let Some(function) = &delta.function else { return };
    if let Some(name) = function.name.as_deref() {
        call.name.push_str(name);
    }
    if let Some(arguments) = function.arguments.as_deref() {
        call.arguments.push_str(arguments);
    }
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

    let Chunk { choices, usage } = frame;

    let mut events = Vec::new();
    // Reasoning first: it is what the model thought *before* the words it is
    // saying, and the UI renders the two in that order.
    for choice in &choices {
        if let Some(text) = choice.delta.reasoning_content.as_deref()
            && !text.is_empty()
        {
            events.push(StreamEvent::Reasoning(text.to_string()));
        }
    }
    for choice in choices {
        if let Some(text) = choice.delta.content
            && !text.is_empty()
        {
            events.push(StreamEvent::Delta(text));
        }
        for call in choice.delta.tool_calls {
            events.push(StreamEvent::ToolCall(call));
        }
        if let Some(reason) = choice.finish_reason {
            events.push(StreamEvent::Finish(Some(reason)));
        }
    }
    // The usage frame usually carries an empty `choices` array, so this cannot
    // live inside the loop above.
    if let Some(usage) = usage.as_ref().and_then(TokenUsage::from_value) {
        events.push(StreamEvent::Usage(usage));
    }
    events
}

/// The subset of the response schema this client reads. Unknown fields are
/// ignored rather than rejected, so a provider can add whatever it likes.
#[derive(Debug, Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Value>,
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
    /// DeepSeek, Qwen, GLM, MiniMax and OpenRouter all stream thinking under one
    /// of these names; `content` is null while it does.
    #[serde(default, alias = "reasoning", alias = "thinking", alias = "thought")]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

/// Request body. `thinking` is flattened so the vendor's own parameter lands at
/// the top level without this struct knowing its name.
#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<WireMessage<'a>>,
    stream: bool,
    temperature: f64,
    max_tokens: u32,
    stream_options: StreamOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDef>>,
    #[serde(flatten)]
    thinking: Map<String, Value>,
}

/// One message as a provider reads it.
///
/// Deliberately not [`ChatMessage`]: that type also crosses IPC, where the
/// renderer speaks camelCase, while the wire speaks snake_case and nests a tool
/// call under `function`. One type serving both contracts sent `toolCalls` and
/// `toolCallId` to providers that only accept `tool_calls` and `tool_call_id` —
/// so the second round of every tool conversation was rejected, and it looked
/// like a broken model rather than a broken client.
#[derive(Debug, Serialize)]
struct WireMessage<'a> {
    role: Role,
    /// Omitted for an assistant turn that only asked for tools. OpenAI
    /// documents `content` as optional there, and a strict gateway rejects the
    /// empty string.
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<WireToolCall<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct WireToolCall<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    function: WireFunction<'a>,
}

#[derive(Debug, Serialize)]
struct WireFunction<'a> {
    name: &'a str,
    arguments: &'a str,
}

/// Projects the IPC-shaped messages onto the shape the wire expects.
fn wire_messages(messages: &[ChatMessage]) -> Vec<WireMessage<'_>> {
    messages
        .iter()
        .map(|message| WireMessage {
            role: message.role,
            content: (!(message.content.is_empty() && !message.tool_calls.is_empty()))
                .then_some(message.content.as_str()),
            tool_calls: message
                .tool_calls
                .iter()
                .map(|call| WireToolCall {
                    id: &call.id,
                    kind: "function",
                    function: WireFunction { name: &call.name, arguments: &call.arguments },
                })
                .collect(),
            tool_call_id: message.tool_call_id.as_deref(),
        })
        .collect()
}

#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// Non-streaming probe used by the settings page: one token, cheap, and enough
/// to prove the endpoint, key and model name are all correct together.
#[derive(Debug, Serialize)]
struct ProbeRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
}

/// Fields this client adds that a provider is allowed to refuse. Named in the
/// order they are dropped: token counts are the least important, and the
/// reasoning parameter is the most vendor-specific. `tools` is first because a
/// model that cannot call tools should still answer without them.
const OPTIONAL_FIELDS: [&str; 7] = [
    "tools",
    "stream_options",
    "max_tokens",
    "temperature",
    "thinking",
    "enable_thinking",
    "reasoning_effort",
];

/// What turns on a reasoning stream, per vendor — `None` when the endpoint
/// cannot be identified, because a guessed parameter is a 400 on some gateways
/// and a silently ignored field on others.
///
/// The returned name is the key that [`retry_without_rejected_field`] removes if
/// the provider rejects it.
pub fn thinking_params(base_url: &str) -> Option<(&'static str, Value)> {
    let host = base_url.to_ascii_lowercase();
    if host.contains("openai.com")
        || host.contains("openrouter.ai")
        || host.contains("googleapis.com")
    {
        return Some(("reasoning_effort", json!("high")));
    }
    if host.contains("dashscope")
        || host.contains("moonshot")
        || host.contains("siliconflow")
        || host.contains("bigmodel")
    {
        return Some(("enable_thinking", json!(true)));
    }
    if host.contains("deepseek")
        || host.contains("minimax")
        || host.contains("xiaomimimo")
        || host.contains("volces")
    {
        return Some(("thinking", json!({ "type": "enabled" })));
    }
    None
}

/// 小米 MiMo signs with `api-key` instead of `Authorization: Bearer`. One rule,
/// because one provider is enough of an exception to name.
fn uses_api_key_header(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("xiaomimimo")
}

/// Builds the request body. Split out so the optional-field retry can operate on
/// a plain `Value` without a second schema.
fn request_body(
    config: &super::AiConfig,
    messages: Vec<ChatMessage>,
    tools: Option<Vec<ToolDef>>,
) -> Value {
    // A reasoning model refuses any temperature but 1, and the thinking stream
    // is where its answer comes from — so the knob follows the switch.
    let temperature = if config.deep_thinking { 1.0 } else { config.temperature };
    let thinking = match config.deep_thinking.then(|| thinking_params(&config.base_url)).flatten() {
        Some((name, value)) => {
            let mut map = Map::new();
            map.insert(name.to_string(), value);
            map
        }
        None => Map::new(),
    };

    serde_json::to_value(ChatRequest {
        model: &config.model,
        messages: wire_messages(&messages),
        stream: true,
        temperature,
        max_tokens: config.max_tokens,
        stream_options: StreamOptions { include_usage: true },
        tools,
        thinking,
    })
    .unwrap_or(Value::Null)
}

/// If the provider's rejection names one of the fields this client added, that
/// field is the problem and can go. Returns it, preferring the last named one
/// (the vendor-specific parameter is the most likely culprit).
fn rejected_optional_field(body: &Value, error_text: &str) -> Option<&'static str> {
    let haystack = error_text.to_ascii_lowercase();
    OPTIONAL_FIELDS
        .iter()
        .rev()
        .find(|field| body.get(**field).is_some() && haystack.contains(*field))
        .copied()
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
    tools: Option<Vec<ToolDef>>,
    mut on_event: F,
) -> AppResult<()>
where
    // `false` means "stop": the reader pressed 停止, and returning here drops
    // the response, which is what closes the connection.
    F: FnMut(StreamEvent) -> bool,
{
    let url = super::completions_url(&config.base_url);
    let mut body = request_body(config, messages, tools);

    let response = retry_without_rejected_field(client, &url, config, &mut body).await?;

    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt as _;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(http_error)?;
        let text = String::from_utf8_lossy(&chunk);
        for event in feed(&mut buffer, &text) {
            let done = matches!(event, StreamEvent::Done);
            let keep_going = on_event(event);
            if done || !keep_going {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// POSTs `body`, dropping one rejected optional field and trying again.
///
/// Exactly one retry: a provider that refuses two different fields is a
/// configuration problem worth reporting, not something to negotiate with.
async fn retry_without_rejected_field(
    client: &reqwest::Client,
    url: &str,
    config: &super::AiConfig,
    body: &mut Value,
) -> AppResult<reqwest::Response> {
    let mut retried = false;
    loop {
        let mut request = client.post(url).json(&*body);
        request = sign(request, &config.base_url, &config.api_key);

        let response = request.send().await.map_err(http_error)?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }

        let text = response.text().await.unwrap_or_default();
        if status.as_u16() == 400
            && !retried
            && let Some(field) = rejected_optional_field(body, &text)
            && let Some(object) = body.as_object_mut()
        {
            tracing::info!(field, "接口拒绝了可选参数，去掉后重试");
            object.remove(field);
            retried = true;
            continue;
        }
        return Err(provider_error(status.as_u16(), &text));
    }
}

/// Applies the auth header this endpoint expects.
fn sign(
    request: reqwest::RequestBuilder,
    base_url: &str,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.is_empty() {
        return request;
    }
    if uses_api_key_header(base_url) {
        return request.header("api-key", api_key);
    }
    request.bearer_auth(api_key)
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
        messages: vec![ChatMessage::new(Role::User, "hi".to_string())],
        max_tokens: 1,
    };

    let mut retried = false;
    loop {
        let request = sign(client.post(&url).json(&body), &config.base_url, &config.api_key);
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

/// The model ids an endpoint offers, from `GET {base_url}/models`.
///
/// Read-only and cheap, so the settings form can fill a picker instead of asking
/// the reader to remember an id. Order is the provider's own — some sort by
/// release date and some alphabetically, and neither is wrong.
pub async fn list_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> AppResult<Vec<String>> {
    let url = format!("{base_url}/models");
    let request = sign(client.get(&url), base_url, api_key);
    let response = request.send().await.map_err(http_error)?;

    let status = response.status();
    if !status.is_success() {
        return Err(provider_error(status.as_u16(), &response.text().await.unwrap_or_default()));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("模型列表的响应无法解析：{err}")))?;
    let mut models: Vec<String> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    models.dedup();
    if models.is_empty() {
        return Err(AppError::Message(
            "接口没有返回任何模型，确认地址与 Key 后重试，或直接手填模型 ID".into(),
        ));
    }
    Ok(models)
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
        402 => "账户余额不足，无法发起对话",
        404 => "接口地址或模型名称不存在",
        429 => "触发了速率限制，稍后再试",
        status if status >= 500 => "服务端出错，稍后再试或换个模型",
        _ => "请求被拒绝",
    };
    // A provider that says the balance is out is worth passing on verbatim: the
    // status alone (400 or 403, depending on the vendor) does not.
    if body.to_ascii_lowercase().contains("insufficient_balance") {
        return AppError::Message("账户余额不足，无法发起对话。".into());
    }
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
    use crate::ai::AiConfig;

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
    fn reasoning_arrives_before_the_answer_and_under_any_of_its_names() {
        for field in ["reasoning_content", "reasoning", "thinking", "thought"] {
            let payload = format!(r#"{{"choices":[{{"delta":{{"{field}":"想一想"}}}}]}}"#);
            let (events, _) = collect(&[&format!("data: {payload}\n\n")]);
            assert_eq!(events, [StreamEvent::Reasoning("想一想".into())], "{field}");
        }

        // And the order matters: the thought precedes the words it produced.
        let (events, _) = collect(&[
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"答\"}}]}\n\n",
        ]);
        assert_eq!(events, [StreamEvent::Reasoning("想".into()), StreamEvent::Delta("答".into())]);
    }

    #[test]
    fn a_usage_only_frame_is_read_even_though_it_has_no_choices() {
        let payload = r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}"#;
        let (events, _) = collect(&[&format!("data: {payload}\n\n")]);
        assert_eq!(events, [StreamEvent::Usage(TokenUsage { input: 10, cached: 0, output: 2 })]);
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

        let broke = provider_error(400, r#"{"error":{"message":"insufficient_balance"}}"#);
        assert!(broke.to_string().contains("余额不足"), "{broke}");
    }

    #[test]
    fn a_huge_error_body_is_not_pasted_into_the_message() {
        let long = "x".repeat(5000);
        let body = format!("{{\"error\":{{\"message\":\"{long}\"}}}}");
        let error = provider_error(400, &body);
        assert!(error.to_string().len() < 300, "{error}");
    }

    #[test]
    fn the_request_body_carries_the_configured_numbers() {
        let config = AiConfig { temperature: 0.4, max_tokens: 2048, ..AiConfig::default() };
        let body = request_body(&config, vec![ChatMessage::new(Role::User, "hi")], None);

        assert_eq!(body["temperature"], json!(0.4));
        assert_eq!(body["max_tokens"], json!(2048));
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["messages"][0]["role"], json!("user"));
        assert!(body.get("thinking").is_none(), "没开深度思考就不该注入厂商参数");
    }

    #[test]
    fn deep_thinking_pins_the_temperature_and_injects_one_vendor_parameter() {
        let config = AiConfig {
            deep_thinking: true,
            temperature: 0.2,
            base_url: "https://api.deepseek.com/v1".into(),
            ..AiConfig::default()
        };
        let body = request_body(&config, vec![ChatMessage::new(Role::User, "hi")], None);
        assert_eq!(body["temperature"], json!(1.0), "推理模型只接受温度 1");
        assert_eq!(body["thinking"]["type"], json!("enabled"));
    }

    #[test]
    fn an_unidentified_endpoint_gets_no_thinking_parameter() {
        let config = AiConfig {
            deep_thinking: true,
            base_url: "http://127.0.0.1:1234/v1".into(),
            ..AiConfig::default()
        };
        let body = request_body(&config, vec![ChatMessage::new(Role::User, "hi")], None);
        assert!(body.get("thinking").is_none());
        assert!(body.get("enable_thinking").is_none());
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn each_vendor_gets_its_own_reasoning_switch() {
        let cases = [
            ("https://api.openai.com/v1", "reasoning_effort"),
            ("https://openrouter.ai/api/v1", "reasoning_effort"),
            ("https://generativelanguage.googleapis.com/v1beta/openai", "reasoning_effort"),
            ("https://dashscope.aliyuncs.com/compatible-mode/v1", "enable_thinking"),
            ("https://api.moonshot.cn/v1", "enable_thinking"),
            ("https://api.siliconflow.cn/v1", "enable_thinking"),
            ("https://open.bigmodel.cn/api/paas/v4", "enable_thinking"),
            ("https://api.deepseek.com/v1", "thinking"),
            ("https://api.minimaxi.com/v1", "thinking"),
            ("https://api.xiaomimimo.com/v1", "thinking"),
        ];
        for (url, expected) in cases {
            assert_eq!(thinking_params(url).map(|(name, _)| name), Some(expected), "{url}");
        }
        assert!(thinking_params("http://127.0.0.1:1234/v1").is_none());
    }

    #[test]
    fn a_rejection_names_the_field_to_drop() {
        let body = json!({
            "temperature": 0.7,
            "max_tokens": 100,
            "stream_options": { "include_usage": true },
            "thinking": { "type": "enabled" },
        });

        assert_eq!(
            rejected_optional_field(
                &body,
                r#"{"error":{"message":"Unrecognized request argument: stream_options"}}"#
            ),
            Some("stream_options")
        );
        assert_eq!(
            rejected_optional_field(
                &body,
                r#"{"error":{"message":"Unsupported value: 'temperature'"}}"#
            ),
            Some("temperature")
        );
        assert_eq!(
            rejected_optional_field(&body, r#"{"error":{"message":"thinking is not supported"}}"#),
            Some("thinking")
        );
    }

    #[test]
    fn a_rejection_about_something_else_drops_nothing() {
        let body = json!({ "temperature": 0.7, "stream_options": { "include_usage": true } });
        // The model name is not one of ours to drop, and 404 is not a 400.
        assert_eq!(
            rejected_optional_field(&body, r#"{"error":{"message":"model not found"}}"#),
            None
        );
        // A field named in the error but absent from the body is nothing to do.
        assert_eq!(rejected_optional_field(&json!({}), "thinking is not supported"), None);
    }

    #[test]
    fn frames_reach_the_caller_as_they_arrive() {
        // The reader's complaint was that answers appeared all at once. This
        // settles whose side that is on: the mock pauses between frames, so if
        // the callback sees them spread out, the pipeline streams and the
        // provider is buffering.
        use crate::ai::test_support::{direct_client, mock_chat_slow};
        use std::time::{Duration, Instant};

        let gap = Duration::from_millis(120);
        let mock = mock_chat_slow(
            vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"第一\"}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"第二\"}}]}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            gap,
        );
        let config = AiConfig { base_url: mock.base_url.clone(), ..AiConfig::default() };
        let client = direct_client();

        let mut arrivals: Vec<Instant> = Vec::new();
        let mut text = String::new();
        tauri::async_runtime::block_on(stream_chat(
            &client,
            &config,
            vec![ChatMessage::new(Role::User, "你好")],
            None,
            &mut |event| {
                arrivals.push(Instant::now());
                if let StreamEvent::Delta(chunk) = event {
                    text.push_str(&chunk);
                }
                true
            },
        ))
        .expect("stream");

        assert_eq!(text, "第一第二");
        assert!(arrivals.len() >= 2, "应当分多次到达：{}", arrivals.len());
        let spread = arrivals[arrivals.len() - 1] - arrivals[0];
        assert!(spread >= gap, "两次回调间隔 {spread:?} 小于帧间隔 {gap:?}，说明被缓冲了");
    }

    #[test]
    fn a_tool_round_is_written_in_the_wire_shape() {
        // The messages cross IPC in camelCase and the wire wants snake_case.
        // Sending `toolCalls` made every second round fail with a 400 that read
        // like the model was broken.
        let config = AiConfig::default();
        let mut asked = ChatMessage::new(Role::Assistant, "");
        asked.tool_calls = vec![ToolCall {
            id: "c1".into(),
            name: "wordcloud".into(),
            arguments: r#"{"scope":"chapter"}"#.into(),
        }];
        let mut reply = ChatMessage::new(Role::Tool, "统计完成");
        reply.tool_call_id = Some("c1".into());

        let body = request_body(&config, vec![asked, reply], None);
        let first = &body["messages"][0];
        let second = &body["messages"][1];

        assert_eq!(first["tool_calls"][0]["id"], json!("c1"));
        assert_eq!(first["tool_calls"][0]["type"], json!("function"));
        assert_eq!(first["tool_calls"][0]["function"]["name"], json!("wordcloud"));
        assert_eq!(
            first["tool_calls"][0]["function"]["arguments"],
            json!(r#"{"scope":"chapter"}"#)
        );
        assert!(first.get("content").is_none(), "只调工具的轮次不写空 content");
        assert!(first.get("toolCalls").is_none(), "camelCase 会被服务商拒掉");

        assert_eq!(second["role"], json!("tool"));
        assert_eq!(second["tool_call_id"], json!("c1"));
        assert!(second.get("toolCallId").is_none());
    }

    #[test]
    fn the_mimo_endpoint_signs_with_api_key_instead_of_bearer() {
        assert!(uses_api_key_header("https://api.xiaomimimo.com/v1"));
        assert!(!uses_api_key_header("https://api.deepseek.com/v1"));
    }

    #[test]
    fn a_tool_call_is_assembled_from_its_fragments() {
        let mut calls = Vec::new();
        // What a provider actually sends: the id and name once, the arguments in
        // pieces that only make sense once concatenated.
        for (index, arguments) in [(0, r#"{"query":"#), (0, r#""主角是谁"}"#)] {
            absorb_tool_call(
                &mut calls,
                &ToolCallDelta {
                    index,
                    id: Some("call-1".into()),
                    function: Some(FunctionDelta {
                        name: Some(
                            if arguments.starts_with('{') { "search_book" } else { "" }.into(),
                        ),
                        arguments: Some(arguments.into()),
                    }),
                },
            );
        }
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "search_book");
        assert_eq!(calls[0].arguments, r#"{"query":"主角是谁"}"#);
    }

    #[test]
    fn two_calls_in_one_turn_keep_their_own_arguments() {
        let mut calls = Vec::new();
        for delta in [
            ToolCallDelta {
                index: 0,
                id: Some("a".into()),
                function: Some(FunctionDelta {
                    name: Some("search_book".into()),
                    arguments: Some(r#"{"query":"甲"}"#.into()),
                }),
            },
            ToolCallDelta {
                index: 1,
                id: Some("b".into()),
                function: Some(FunctionDelta {
                    name: Some("read_chapter".into()),
                    arguments: Some(r#"{"chapter":3}"#.into()),
                }),
            },
        ] {
            absorb_tool_call(&mut calls, &delta);
        }
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].name, "read_chapter");
        assert_eq!(calls[1].arguments, r#"{"chapter":3}"#);
    }

    #[test]
    fn a_tool_call_frame_reaches_the_caller() {
        let payload = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_book","arguments":"{\"query\":\"甲\"}"}}]},"finish_reason":"tool_calls"}]}"#;
        let (events, _) = collect(&[&format!("data: {payload}\n\n")]);

        assert_eq!(events.len(), 2);
        match &events[0] {
            StreamEvent::ToolCall(call) => {
                assert_eq!(call.index, 0);
                assert_eq!(call.id.as_deref(), Some("c1"));
                assert_eq!(
                    call.function.as_ref().and_then(|f| f.name.as_deref()),
                    Some("search_book")
                );
            }
            other => panic!("期望 ToolCall，得到 {other:?}"),
        }
        assert_eq!(events[1], StreamEvent::Finish(Some("tool_calls".into())));
    }

    #[test]
    fn tools_travel_only_when_they_are_offered() {
        let config = AiConfig::default();
        let plain = request_body(&config, vec![ChatMessage::new(Role::User, "hi")], None);
        assert!(plain.get("tools").is_none(), "没有工具就不该出现这个字段");

        let with = request_body(
            &config,
            vec![ChatMessage::new(Role::User, "hi")],
            Some(vec![ToolDef {
                kind: "function",
                function: FunctionDef {
                    name: "search_book",
                    description: "检索",
                    parameters: json!({ "type": "object" }),
                },
            }]),
        );
        assert_eq!(with["tools"][0]["type"], json!("function"));
        assert_eq!(with["tools"][0]["function"]["name"], json!("search_book"));
    }

    #[test]
    fn a_tool_answer_carries_the_call_it_answers_and_nothing_else() {
        let message = ChatMessage {
            role: Role::Tool,
            content: "片段".into(),
            tool_calls: Vec::new(),
            tool_call_id: Some("c1".into()),
        };
        let value = serde_json::to_value(&message).expect("serialize");
        assert_eq!(value["role"], json!("tool"));
        assert_eq!(value["toolCallId"], json!("c1"));
        assert!(value.get("toolCalls").is_none(), "空的工具调用不序列化");

        // And an ordinary turn still serialises as the two fields it always had.
        let plain = serde_json::to_value(ChatMessage::new(Role::User, "hi")).expect("serialize");
        assert_eq!(plain, json!({ "role": "user", "content": "hi" }));
    }
}
