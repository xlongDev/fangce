//! `ai.*` commands: configuration and streaming chat.
//!
//! Chat runs entirely on the Rust side and pushes deltas out as events, so a
//! long answer never blocks the UI thread and never waits for a full response
//! body to arrive.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::ai::chat::{self, ChatMessage, Role};
use crate::ai::{AiConfig, is_ready};
use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::guide;
use crate::state::AppState;

/// Streamed chunks for one request.
pub const AI_STREAM_EVENT: &str = "ai://stream";

/// Said whenever a command needs a model that has not been configured yet.
pub(crate) const NOT_CONFIGURED: &str = "还没有配置 AI 模型，先到设置里填写接口地址与模型名称";

/// Connect and per-read timeouts.
///
/// A local model can take tens of seconds to load its weights on the first
/// request, so the read timeout is generous; the connect timeout is not, because
/// a refused connection is known within milliseconds.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// One chunk of a streamed answer.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelta {
    /// Echoed back so a reopened panel can ignore a stream it no longer owns.
    pub request_id: String,
    /// Present on incremental text.
    pub text: Option<String>,
    /// Present on incremental reasoning, for models that stream it separately.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning: Option<String>,
    /// Set on the final event; `null` while streaming.
    pub done: bool,
    /// Provider's stop reason when it reports one.
    pub finish_reason: Option<String>,
    /// Set only on the final event when the stream failed.
    pub error: Option<String>,
    /// RAG sources, present on the final event of a retrieval-backed answer.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub citations: Vec<crate::library::rag::RagHit>,
    /// Token counts, present on the final event when the provider reports them.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<crate::ai::usage::TokenUsage>,
    /// One finished tool call, so the panel can draw a row for it while the
    /// answer is still being written.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool: Option<crate::ai::tools::ToolCallView>,
}

/// `ai.getConfig`
#[tauri::command]
#[specta::specta]
pub fn ai_get_config(state: State<'_, AppState>) -> AppResult<AiConfig> {
    crate::ai::config(&state.library)
}

/// `ai.setConfig`
#[tauri::command]
#[specta::specta]
pub fn ai_set_config(state: State<'_, AppState>, config: AiConfig) -> AppResult<AiConfig> {
    // Returns the stored form: it is trimmed, clamped and normalized, and the UI
    // should show what is actually persisted rather than what it typed.
    crate::ai::set_config(&state.library, &config)
}

/// `ai.defaults` — a fully populated default config, so the settings page can
/// offer "恢复默认" without keeping a second copy of the numbers that drifts.
#[tauri::command]
#[specta::specta]
pub fn ai_defaults() -> AiConfig {
    AiConfig::default()
}

/// `ai.defaultSystemPrompt` — the built-in prompt, so the settings page can
/// restore it without keeping a second copy that drifts from this one.
#[tauri::command]
#[specta::specta]
pub fn ai_default_system_prompt() -> String {
    crate::ai::DEFAULT_SYSTEM_PROMPT.to_string()
}

/// `ai.listModels` — `GET {baseUrl}/models`, for the model picker.
///
/// Deliberately does not save: listing models must not persist a half-typed key.
#[tauri::command]
#[specta::specta]
pub async fn ai_list_models(config: AiConfig) -> AppResult<Vec<String>> {
    let base_url = crate::net::secure_base_url(&config.base_url, "接口地址")?;
    chat::list_models(&client()?, &base_url, config.api_key.trim()).await
}

/// `ai.test` — proves endpoint, key and model name work *together*.
///
/// Deliberately does not save: pressing "测试连接" must not persist a half-typed
/// key. The UI saves explicitly.
#[tauri::command]
#[specta::specta]
pub async fn ai_test(config: AiConfig) -> AppResult<()> {
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument("先填写接口地址与模型名称".into()));
    }
    // Validate the shape locally first: a malformed URL should not need a round
    // trip to be reported. Built by cloning so a new field never has to be added
    // here as well — that omission is how a key ends up unnormalized.
    let mut checked = config.clone();
    checked.base_url = crate::net::secure_base_url(&config.base_url, "接口地址")?;
    checked.model = config.model.trim().to_string();
    checked.api_key = config.api_key.trim().to_string();
    if checked.model.is_empty() {
        return Err(AppError::InvalidArgument("模型名称不能为空".into()));
    }
    chat::probe(&client()?, &checked).await
}

/// A local runtime that answered, and the models worth pointing embeddings at.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEmbeddingEndpoint {
    /// What to put in 向量接口地址.
    pub base_url: String,
    /// "Ollama" / "LM Studio", for the button's label.
    pub name: String,
    /// Embedding-shaped model ids. When none matched, this is the whole list —
    /// a reader who named their model something unexpected can still pick it.
    pub models: Vec<String>,
    /// `true` when nothing matched and `models` is unfiltered.
    pub fallback: bool,
}

/// The local runtimes worth asking, and the port each listens on.
///
/// Both speak the OpenAI-compatible `/v1/models`, which is why this is two
/// addresses rather than two adapters.
const LOCAL_RUNTIMES: [(&str, &str); 2] =
    [("Ollama", "http://127.0.0.1:11434/v1"), ("LM Studio", "http://127.0.0.1:1234/v1")];

/// `true` for ids that look like embedding models.
///
/// A heuristic, and deliberately a generous one: the cost of a false positive is
/// one failed index build the reader can fix by typing a different name, and the
/// cost of a false negative is a list where the right model is buried among
/// chat models. `bge`, `gte`, `e5`, `m3` and `minilm` cover every family the
/// local runtimes ship as of this writing.
fn looks_like_embedding(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    ["embed", "bge", "gte-", "e5-", "e5_", "m3", "minilm", "jina"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// `ai.probeLocalEmbeddings` — finds a local runtime and its embedding models.
///
/// This is the cheap answer to "I want embeddings to run locally": the reader
/// already has, or can install in one download, a runtime that embeds better
/// than anything this app could bundle — and shipping a 47 MB model plus an
/// ONNX runtime to duplicate that is a trade this app does not need to make.
/// Probing the two default ports is what turns "configure it yourself" into one
/// button.
///
/// Returns every runtime that answered; an empty list means none did, which is
/// not an error — most readers have none installed.
#[tauri::command]
#[specta::specta]
pub async fn ai_probe_local_embeddings() -> AppResult<Vec<LocalEmbeddingEndpoint>> {
    let client = client()?;
    let mut found = Vec::new();

    for (name, base_url) in LOCAL_RUNTIMES {
        // Short: a refused connection is known in milliseconds, and a runtime
        // that is loading its weights should not hold the button for ten
        // seconds.
        let response = client
            .get(format!("{base_url}/models"))
            .timeout(Duration::from_millis(1500))
            .send()
            .await;
        let Ok(response) = response else { continue };
        if !response.status().is_success() {
            continue;
        }
        let Ok(body) = response.json::<Value>().await else { continue };
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
        if models.is_empty() {
            continue;
        }

        let matching: Vec<String> =
            models.iter().filter(|id| looks_like_embedding(id)).cloned().collect();
        let fallback = matching.is_empty();
        if fallback {
            // Sorted so the picker is stable between presses.
            models.sort();
        }
        found.push(LocalEmbeddingEndpoint {
            base_url: base_url.to_string(),
            name: name.to_string(),
            models: if fallback { models } else { matching },
            fallback,
        });
    }

    Ok(found)
}

/// What a running OC Ferry exposes for the reader to adopt.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcFerryDiscovery {
    /// `http://127.0.0.1:41980/v1` — the reader's `base_url`.
    pub base_url: String,
    /// Bearer key the reader must send; OC Ferry refuses without it.
    pub api_key: String,
    /// Vetted model ids, e.g. `"OC · <name>"`. The reader adopts the first; the
    /// user can type any other id into the model field.
    pub models: Vec<String>,
}

/// What every portrait is asked not to be.
///
/// A local SD checkpoint draws extra fingers and watermarks without being told
/// twice; a hosted model is better but not reliable about text. One list, in
/// English, because that is what both were trained on.
const PORTRAIT_NEGATIVE: &str = "lowres, blurry, bad anatomy, extra fingers, extra limbs,      watermark, signature, text, logo, jpeg artifacts";

/// `ai.characterPortrait` — draws a portrait for one character and returns its URL.
///
/// Two model calls, in this order: the chat model writes the prompt, the image
/// backend draws it. The chat model is the right tool for the first — the reader
/// typed a name and a line of description, and a picture needs a paragraph — and
/// it is also the only place the two prompt families can be produced without a
/// per-vendor template table.
#[tauri::command]
#[specta::specta]
pub async fn ai_character_portrait(
    state: State<'_, AppState>,
    book_id: String,
    name: String,
    appearance: String,
) -> AppResult<String> {
    let config = crate::ai::config(&state.library)?;
    let backend = crate::ai::image::Backend::parse(&config.image_backend).ok_or_else(|| {
        AppError::InvalidArgument("还没有配置文生图后端，先到设置里选一个".into())
    })?;
    // The prompt has to be written by something; a machine with no chat model
    // cannot get past the first of the two calls.
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }
    if backend == crate::ai::image::Backend::OpenAiCompat && config.image_model.trim().is_empty() {
        return Err(AppError::InvalidArgument("这个文生图后端需要一个模型名".into()));
    }

    let subject = portrait_subject(&state.library, &book_id, &name, &appearance)?;
    let client = client()?;
    let prompt =
        crate::ai::image::write_prompt(&client, &config, backend.prompt_style(), &subject).await?;
    let bytes = crate::ai::image::draw(
        &client,
        &config,
        &crate::ai::image::PortraitRequest {
            prompt: &prompt,
            negative: PORTRAIT_NEGATIVE,
            // Portrait proportions. A1111 draws exactly this; a hosted service
            // rounds it to its nearest supported size.
            width: 512,
            height: 768,
        },
    )
    .await?;

    let path = crate::ai::image::portrait_path(&state.layout.covers_dir, &book_id, &name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes)?;

    tracing::info!(book = %book_id, name = %name, backend = backend.as_str(), "立绘已生成");
    Ok(crate::library::portrait_url(&book_id, &name))
}

/// `ai.characterPortraitUrl` — where an existing portrait lives, if there is one.
///
/// A separate call from the one that draws: the panel asks this on every open,
/// and it must not start a generation.
#[tauri::command]
#[specta::specta]
pub fn ai_character_portrait_url(
    state: State<'_, AppState>,
    book_id: String,
    name: String,
) -> Option<String> {
    let path = crate::ai::image::portrait_path(&state.layout.covers_dir, &book_id, &name);
    path.is_file().then(|| crate::library::portrait_url(&book_id, &name))
}

/// What the chat model is told about the character.
///
/// The reader's own words come first — they have a picture in mind and the book
/// does not. The graph fills in the rest, which is why this is cheap: the
/// evidence was extracted once, when the graph was built.
fn portrait_subject(
    library: &Library,
    book_id: &str,
    name: &str,
    appearance: &str,
) -> AppResult<String> {
    let mut out = format!("名字：{name}\n");
    if let Some(entity) = library.with(|conn| crate::library::graph::entity(conn, book_id, name))? {
        out.push_str(&format!("类型：{}\n", entity.kind));
    }
    if !appearance.trim().is_empty() {
        out.push_str(&format!("读者写的形象：{}\n", appearance.trim()));
    }

    let relations =
        library.with(|conn| crate::library::graph::query(conn, book_id, Some(name), None))?;
    let evidence: Vec<&str> = relations
        .relations
        .iter()
        .map(|relation| relation.evidence.trim())
        .filter(|text| !text.is_empty())
        .take(6)
        .collect();
    if !evidence.is_empty() {
        out.push_str("书里的片段：\n");
        for line in evidence {
            out.push_str(&format!("- {line}\n"));
        }
    }
    Ok(out)
}

/// `ai.cancel` — asks the turn with this request id to stop.
///
/// Fire and forget: the answer that already arrived stays on screen, and the
/// stream's own `done` event is what tells the panel it is over. Returns nothing
/// because there is nothing to report — an id that is already finished is not
/// an error, it is the reader pressing stop a moment too late.
#[tauri::command]
#[specta::specta]
pub fn ai_cancel(state: State<'_, AppState>, request_id: String) {
    state.ai_runs.cancel(&request_id);
}

/// `ai.detectOcFerry` — points the reader's single AI slot at a running OC Ferry.
///
/// OC Ferry is an Electron app that ferries OpenCode's free models to a local
/// OpenAI-compatible port (127.0.0.1:41980) and protects it with a bearer key
/// read from its own data dir. It rejects any request carrying an `Origin`
/// header, so this must run from the Rust side (where no `Origin` is attached),
/// never from the webview. The reader only has one AI endpoint, so we return
/// the endpoint, key and the vetted model ids for the settings form to adopt.
#[tauri::command]
#[specta::specta]
pub async fn ai_detect_oc_ferry() -> AppResult<OcFerryDiscovery> {
    const PORT: u16 = 41980;

    let data_dir = oc_ferry_data_dir()
        .ok_or_else(|| AppError::Message("找不到 OC Ferry 的数据目录，请确认它已安装。".into()))?;
    let api_key = std::fs::read_to_string(data_dir.join("api-key"))
        .map_err(|_| {
            AppError::Message("找不到 OC Ferry 的 api-key，请确认它已启动过一次。".into())
        })?
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err(AppError::Message("OC Ferry 的 api-key 为空，请确认它已启动过一次。".into()));
    }

    let base_url = format!("http://127.0.0.1:{PORT}/v1");
    let response = client()?
        .get(format!("{base_url}/models"))
        .bearer_auth(&api_key)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|err| {
            AppError::Message(format!(
                "连不上本机 OC Ferry（127.0.0.1:{PORT}）：{err}。请确认它的托盘程序正在运行。",
            ))
        })?;

    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "OC Ferry 返回 {}，请确认它已启动且未被占用。",
            response.status()
        )));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("OC Ferry 的响应无法解析：{err}")))?;
    let models: Vec<String> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if models.is_empty() {
        return Err(AppError::Message(
            "OC Ferry 已连上，但暂未判定出可用模型（可能还在检测，或免费池为空）。".into(),
        ));
    }

    Ok(OcFerryDiscovery { base_url, api_key, models })
}

/// OC Ferry's per-user data directory, mirroring its README:
/// macOS `~/Library/Application Support/OC Ferry`, Windows `%APPDATA%\OC Ferry`,
/// Linux `$XDG_CONFIG_HOME/OC Ferry` (falling back to `~/.config/OC Ferry`).
/// `FERRY_DATA_DIR` overrides all of the above, as it does for OC Ferry itself.
fn oc_ferry_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("FERRY_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    let sub = "OC Ferry";
    if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support").join(sub))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join(sub))
    } else if cfg!(target_os = "linux") {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            Some(PathBuf::from(xdg).join(sub))
        } else {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join(sub))
        }
    } else {
        None
    }
}

/// `ai.chat` — streams an answer to [`AI_STREAM_EVENT`].
///
/// Returns as soon as the request is accepted; the answer arrives as a series
/// of events and is terminated by one with `done: true`, which also carries
/// `error` when the stream failed part way through.
#[tauri::command]
#[specta::specta]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    messages: Vec<ChatMessage>,
) -> AppResult<()> {
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }
    if messages.is_empty() {
        return Err(AppError::InvalidArgument("没有要发送的内容".into()));
    }

    let result = run_stream(
        &app,
        &state,
        StreamArgs {
            request_id: &request_id,
            config: &config,
            messages,
            citations: Vec::new(),
            tools: None,
            book_id: None,
            max_chapter: None,
            context: None,
        },
    )
    .await;
    if let Err(err) = result {
        let mut delta = blank(&request_id);
        delta.done = true;
        delta.error = Some(err.to_string());
        emit(&app, delta);
        return Err(err);
    }
    Ok(())
}

/// `ai.agentChat` — the reading assistant with tools: the model decides what to
/// look up instead of being handed six chunks up front.
///
/// This is what the panel's 检索全书库 toggle uses. The tools are offered on
/// every round, and a model that cannot call them simply answers — which is why
/// there is no separate "no tool support" switch to maintain.
///
/// `history` is the conversation so far, already trimmed by the renderer.
/// `max_chapter` keeps a spoiler-safe search inside the reader's position.
#[tauri::command]
#[specta::specta]
pub async fn ai_agent_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    question: String,
    book_id: Option<String>,
    history: Vec<ChatMessage>,
    max_chapter: Option<usize>,
) -> AppResult<()> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::InvalidArgument("没有要发送的内容".into()));
    }
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }

    // The contents travel with the request. Read off the async runtime: for a
    // PDF the first `ensure` decodes the whole document, and that is not work to
    // do on a thread other commands are waiting on.
    let context = match book_id.clone() {
        Some(id) => {
            let library = state.library.clone();
            tauri::async_runtime::spawn_blocking(move || book_context_for(&library, &id))
                .await
                .ok()
                .flatten()
        }
        None => None,
    };

    let mut messages = history;
    messages.push(ChatMessage::new(Role::User, question));

    let result = run_stream(
        &app,
        &state,
        StreamArgs {
            request_id: &request_id,
            config: &config,
            messages,
            citations: Vec::new(),
            tools: Some(crate::ai::tools::definitions()),
            book_id: book_id.as_deref(),
            max_chapter,
            context: context.as_deref(),
        },
    )
    .await;

    if let Err(err) = result {
        let mut delta = blank(&request_id);
        delta.done = true;
        delta.error = Some(err.to_string());
        emit(&app, delta);
        return Err(err);
    }
    Ok(())
}

/// Everything one streamed turn needs.
pub(crate) struct StreamArgs<'a> {
    pub request_id: &'a str,
    pub config: &'a AiConfig,
    pub messages: Vec<ChatMessage>,
    pub citations: Vec<crate::library::rag::RagHit>,
    /// Offered to the model. `None` for the surfaces that ask exactly one thing
    /// and cannot act on a tool call anyway.
    pub tools: Option<Vec<chat::ToolDef>>,
    /// The book being read, for the tools that look inside it.
    pub book_id: Option<&'a str>,
    /// The reader's position, for a spoiler-safe search.
    pub max_chapter: Option<usize>,
    /// Appended to the system message — the book in hand, for the agent.
    pub context: Option<&'a str>,
}

/// A delta with every optional field empty, so each event only fills the one it
/// carries. Written once because nine literals drifting apart is how a field
/// gets forgotten on one path.
pub(crate) fn blank(request_id: &str) -> AiDelta {
    AiDelta {
        request_id: request_id.to_string(),
        text: None,
        reasoning: None,
        done: false,
        finish_reason: None,
        error: None,
        citations: Vec::new(),
        usage: None,
        tool: None,
    }
}

/// Streams one answer to [`AI_STREAM_EVENT`], running whatever tools the model
/// asks for, and returns what the turn produced.
///
/// The turn ends with exactly one `done` event carrying the citations and the
/// total usage — including the rounds spent on tools, which is the number a
/// reader on a paid endpoint actually cares about.
pub(crate) async fn run_stream(
    app: &AppHandle,
    state: &crate::state::AppState,
    args: StreamArgs<'_>,
) -> AppResult<crate::ai::agent::AgentOutcome> {
    let library = &state.library;
    let client = client()?;
    let request_id = args.request_id.to_string();
    let cancel = state.ai_runs.begin(&request_id);
    let ctx = crate::ai::tools::ToolContext {
        library,
        client: &client,
        config: args.config,
        book_id: args.book_id,
        max_chapter: args.max_chapter,
        cancelled: &|| cancel.load(std::sync::atomic::Ordering::Relaxed),
    };

    let mut sink = |event: crate::ai::agent::AgentEvent| {
        use crate::ai::agent::AgentEvent;
        let mut delta = blank(&request_id);
        match event {
            AgentEvent::Text(text) => delta.text = Some(text),
            AgentEvent::Reasoning(reasoning) => delta.reasoning = Some(reasoning),
            AgentEvent::Tool(view) => delta.tool = Some(view),
        }
        emit(app, delta);
    };

    let messages = with_system_extra(args.config, args.messages, args.context);
    let cancel = state.ai_runs.begin(&request_id);
    let result =
        crate::ai::agent::run(&client, args.config, messages, args.tools, &ctx, &mut sink, &|| {
            cancel.load(std::sync::atomic::Ordering::Relaxed)
        })
        .await;
    // Dropped before the `?`: a turn that failed must not leave its flag behind
    // for the next request that happens to reuse the id.
    state.ai_runs.end(&request_id);
    let outcome = result?;

    let mut done = blank(&request_id);
    done.done = true;
    done.citations = args.citations;
    done.usage = outcome.usage;
    emit(app, done);

    tracing::info!(
        request_id = %request_id,
        chars = outcome.text.chars().count(),
        tools = outcome.tool_calls,
        "AI 回答完成"
    );
    Ok(outcome)
}

/// `ai.digest` — streams a reading guide for one book.
///
/// The cache is consulted first, and a hit is replayed as a single delta: the
/// panel then has exactly one code path whether or not a guide already existed.
/// `refresh` skips the cache and writes a new one over the old.
///
/// Only a complete answer is cached. A stream that failed half way through is
/// left out, so the next open regenerates instead of showing the stump forever.
#[tauri::command]
#[specta::specta]
pub async fn ai_digest(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    book_id: String,
    refresh: bool,
) -> AppResult<()> {
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }

    if !refresh && let Some(cached) = state.library.with(|conn| guide::cached(conn, &book_id))? {
        replay(&app, &request_id, cached);
        return Ok(());
    }

    let material = state.library.with(|conn| guide::material(conn, &book_id))?;
    // The guide carries its own instructions, and `with_system_extra` leaves a
    // conversation alone when it already opens with one: the reader's general
    // assistant prompt must not reshape this.
    let messages = vec![
        ChatMessage::new(Role::System, guide::PROMPT.to_string()),
        ChatMessage::new(Role::User, material),
    ];

    let result = run_stream(
        &app,
        &state,
        StreamArgs {
            request_id: &request_id,
            config: &config,
            messages,
            citations: Vec::new(),
            tools: None,
            book_id: Some(&book_id),
            max_chapter: None,
            context: None,
        },
    )
    .await;

    match result {
        Ok(outcome) => {
            // Not `guide`: that name is the module this writes through.
            let written = outcome.text.trim();
            if written.is_empty() {
                return Err(AppError::Message("模型没有返回内容".into()));
            }
            state.library.with(|conn| guide::store(conn, &book_id, written))?;
            Ok(())
        }
        Err(err) => {
            let mut delta = blank(&request_id);
            delta.done = true;
            delta.error = Some(err.to_string());
            emit(&app, delta);
            Err(err)
        }
    }
}

/// `ai.guide_status` — the ids of every book whose guide is already cached, so
/// a batch run can skip them and price the rest before generating anything.
#[tauri::command]
#[specta::specta]
pub fn ai_guide_status(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    state.library.with(guide::cached_ids)
}

/// Emits a stored answer as "one delta, then done", which is what a stream that
/// arrived instantly looks like.
fn replay(app: &AppHandle, request_id: &str, text: String) {
    let mut first = blank(request_id);
    first.text = Some(text);
    emit(app, first);

    let mut done = blank(request_id);
    done.done = true;
    emit(app, done);
}

/// Prepends the configured system prompt, unless the caller already sent one,
/// and appends `extra` to it.
///
/// Separate from [`crate::ai::system_message`] because that one is the reader's
/// own prompt: the library detail the agent needs must not appear in the
/// settings page as if the reader had written it, and must not be saved.
pub(crate) fn with_system_extra(
    config: &AiConfig,
    messages: Vec<ChatMessage>,
    extra: Option<&str>,
) -> Vec<ChatMessage> {
    let mut system = crate::ai::system_message(config);
    if let Some(extra) = extra.filter(|text| !text.is_empty()) {
        system = if system.is_empty() { extra.to_string() } else { format!("{system}\n\n{extra}") };
    }
    if system.is_empty() || messages.first().is_some_and(|first| first.role == Role::System) {
        return messages;
    }
    let mut all = Vec::with_capacity(messages.len() + 1);
    all.push(ChatMessage::new(Role::System, system));
    all.extend(messages);
    all
}

/// The title and contents of the book the reader has open.
///
/// `None` rather than an error: a missing contents list costs the model a little
/// context, and the reader still gets an answer about the chapter in hand.
fn book_context_for(library: &Library, book_id: &str) -> Option<String> {
    let title = library
        .with(|conn| crate::library::repository::get(conn, book_id))
        .ok()
        .flatten()
        .map(|book| book.title)
        .unwrap_or_else(|| "当前这本书".to_string());
    let chapters = crate::library::chapters::ensure(library, book_id).ok()?;
    let titles: Vec<String> = chapters.into_iter().map(|chapter| chapter.title).collect();
    Some(crate::ai::book_context(&title, &titles))
}

pub(crate) fn client() -> AppResult<reqwest::Client> {
    build(None)
}

/// The same client, following only the redirects `policy` allows. A book
/// source's host allowlist has to hold for every hop: a 302 is an address
/// chosen by somebody other than the reader.
pub(crate) fn client_restricted(policy: reqwest::redirect::Policy) -> AppResult<reqwest::Client> {
    build(Some(policy))
}

fn build(redirect: Option<reqwest::redirect::Policy>) -> AppResult<reqwest::Client> {
    let mut builder =
        reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT);
    if let Some(policy) = redirect {
        builder = builder.redirect(policy);
    }
    builder.build().map_err(|err| AppError::Message(format!("无法创建 HTTP 客户端：{err}")))
}

pub(crate) fn emit(app: &AppHandle, delta: AiDelta) {
    // A closed window just stops listening; dropping the event is correct.
    let _ = app.emit(AI_STREAM_EVENT, delta);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stream_event_is_namespaced() {
        assert!(AI_STREAM_EVENT.starts_with("ai://"));
    }

    #[test]
    fn a_system_prompt_is_prepended_exactly_once() {
        let config = AiConfig { system_prompt: "S".into(), ..AiConfig::default() };
        let messages = vec![ChatMessage::new(Role::User, "Q")];

        let with = with_system_extra(&config, messages.clone(), None);
        assert_eq!(with.len(), 2);
        assert_eq!(with[0].content, "S");

        // Already carrying one: leave it alone rather than doubling up.
        let mut already = vec![ChatMessage::new(Role::System, "mine")];
        already.extend(messages);
        assert_eq!(with_system_extra(&config, already, None).len(), 2);
    }

    #[test]
    fn an_empty_system_prompt_adds_nothing() {
        let config = AiConfig { system_prompt: "  ".into(), ..AiConfig::default() };
        let messages = vec![ChatMessage::new(Role::User, "Q")];
        assert_eq!(with_system_extra(&config, messages, None).len(), 1);
    }

    #[test]
    fn the_appended_prompt_rides_along_as_one_system_message() {
        let config = AiConfig {
            system_prompt: "主".into(),
            system_prompt_extra: "附".into(),
            ..AiConfig::default()
        };
        let messages = vec![ChatMessage::new(Role::User, "Q")];
        let with = with_system_extra(&config, messages, None);
        assert_eq!(with.len(), 2, "两段提示词合成一条，不是两条");
        assert_eq!(with[0].content, "主\n\n附");
    }

    #[test]
    fn the_book_context_joins_the_reader_s_own_prompt() {
        // The agent needs the contents, and the reader's prompt must survive
        // alongside them. It used to be applied per caller, and the two paths
        // that were not the agent quietly stopped sending it.
        let config = AiConfig { system_prompt: "主".into(), ..AiConfig::default() };
        let messages = vec![ChatMessage::new(Role::User, "Q")];
        let with = with_system_extra(&config, messages, Some("目录：1. 开端"));

        assert_eq!(with.len(), 2, "系统消息仍是一条");
        assert_eq!(with[0].content, "主\n\n目录：1. 开端");
    }

    #[test]
    fn an_empty_book_context_leaves_the_prompt_as_it_was() {
        let config = AiConfig { system_prompt: "主".into(), ..AiConfig::default() };
        let messages = vec![ChatMessage::new(Role::User, "Q")];
        let with = with_system_extra(&config, messages, Some(""));

        assert_eq!(with[0].content, "主", "空串不该留下一个多余的空行");
    }

    #[test]
    fn deltas_serialize_in_camel_case() {
        let mut delta = blank("r1");
        delta.text = Some("hi".into());
        let value = serde_json::to_value(delta).expect("serialize");

        assert_eq!(value["requestId"], "r1");
        assert_eq!(value["text"], "hi");
        assert_eq!(value["done"], serde_json::json!(false));
        assert!(value.get("citations").is_none(), "空引用不序列化");
        assert!(value.get("usage").is_none(), "没有用量就不该出现这个字段");
        assert!(value.get("reasoning").is_none(), "没有思考过程就不该出现这个字段");
        assert!(value.get("tool").is_none(), "没有工具调用就不该出现这个字段");
    }

    #[test]
    fn a_final_delta_carries_the_usage_it_was_given() {
        let mut delta = blank("r1");
        delta.done = true;
        delta.usage = Some(crate::ai::usage::TokenUsage { input: 10, cached: 4, output: 2 });
        let value = serde_json::to_value(delta).expect("serialize");

        assert_eq!(value["usage"]["input"], serde_json::json!(10));
        assert_eq!(value["usage"]["cached"], serde_json::json!(4));
        assert_eq!(value["usage"]["output"], serde_json::json!(2));
    }

    #[test]
    fn embedding_models_are_recognised_by_name() {
        for id in [
            "nomic-embed-text:latest",
            "bge-m3:latest",
            "bge-large-zh-v1.5",
            "gte-large",
            "e5-small",
            "text-embedding-3-small",
            "all-MiniLM-L6-v2",
            "jina-embeddings-v3",
        ] {
            assert!(looks_like_embedding(id), "{id} 应当被认成嵌入模型");
        }
        for id in ["qwen2.5:7b", "llama3.2:latest", "deepseek-r1:14b", "gpt-4o-mini"] {
            assert!(!looks_like_embedding(id), "{id} 不是嵌入模型");
        }
    }

    #[test]
    fn a_tool_row_travels_on_its_own_event() {
        let mut delta = blank("r1");
        delta.tool = Some(crate::ai::tools::ToolCallView {
            name: "search_book".into(),
            label: "检索「主角」".into(),
            detail: "3 段".into(),
            ok: true,
            sources: Vec::new(),
            mindmap: None,
            wordcloud: None,
        });
        let value = serde_json::to_value(delta).expect("serialize");

        assert_eq!(value["tool"]["name"], "search_book");
        assert_eq!(value["tool"]["label"], "检索「主角」");
        assert_eq!(value["done"], serde_json::json!(false), "工具行不是结束事件");
    }
}
