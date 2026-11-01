//! AI provider configuration.
//!
//! One shape covers both hosted and local models: Ollama, LM Studio, vLLM and
//! friends all speak the OpenAI `/v1/chat/completions` wire format, so "OpenAI
//! compatible" is not a vendor lock-in, it is the de facto protocol. Users point
//! `base_url` at whatever they run.
//!
//! The API key is stored in SQLite, never in the renderer: a key in a webview's
//! localStorage is readable by anything that can read the profile directory, and
//! the backend needs it anyway because the backend makes the call. Since
//! 2026-10-13 it is also sealed at rest under a key the OS credential store
//! holds (`crate::secrets`), so the database file on its own is not enough.

pub mod agent;
pub mod chat;
pub mod embeddings;
pub mod lookup;
pub mod rerank;
pub mod tools;
pub mod usage;
pub mod vision;
pub mod wordcloud;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::db::Library;
use crate::error::{AppError, AppResult};

/// One saved endpoint, so switching between a local model and a cloud one does
/// not mean retyping three fields.
///
/// 🔴 **A profile is a snapshot, not a runtime branch.** The flat `base_url` /
/// `api_key` / `model` on [`AiConfig`] stay the single source of truth every
/// consumer reads — RAG, OCR, translation, the reading guide and the graph all
/// call `ai::config()` and take it from there. Switching a profile copies the
/// snapshot back into those flat fields; nothing else in the app learns that
/// profiles exist.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}

/// What a million tokens cost, in yuan. All three zero means "not set", and the
/// usage bar then shows tokens without a price.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPrice {
    /// Input tokens served from the provider's prompt cache.
    #[serde(default)]
    pub input_cached: f64,
    /// Input tokens that missed the cache — the ordinary input price.
    #[serde(default)]
    pub input_miss: f64,
    #[serde(default)]
    pub output: f64,
}

/// Where chat completions are sent and how they are signed.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// Origin only, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    /// Empty for local endpoints that need no key.
    pub api_key: String,
    pub model: String,
    /// Models pulled in from a detected OC Ferry, for in-app switching. Empty for
    /// a hand-typed endpoint. Persisted so the switcher survives a restart.
    #[serde(default)]
    pub imported_models: Vec<String>,
    /// Prepended to every conversation; keeps answers in the reader's voice.
    #[serde(default)]
    pub system_prompt: String,
    /// Embedding model for RAG. Empty disables library-wide retrieval; the chat
    /// assistant works without it.
    #[serde(default)]
    pub embedding_model: String,
    /// Where embeddings are computed. Empty means "the chat endpoint", which is
    /// what most hosted providers want — one key, one base URL, two models.
    ///
    /// Set it to run the two halves in different places, which is the whole
    /// reason a reader would want a local vector model: chat on a hosted model,
    /// embeddings on Ollama in the next process, no key and no per-token bill
    /// for the part that reads the entire book.
    #[serde(default)]
    pub embedding_base_url: String,
    /// Key for [`Self::embedding_base_url`]; empty falls back to `api_key`, and
    /// a local runtime needs neither.
    #[serde(default)]
    pub embedding_api_key: String,
    /// Reranker for retrieval, Cohere-compatible `/rerank`. Empty disables the
    /// second-stage ranking. Same endpoint and key as chat.
    #[serde(default)]
    pub rerank_model: String,
    /// DeepL auth key for the selection toolbar's instant translation; `:fx`
    /// marks a free-tier key. Empty falls back to the chat model for
    /// translation.
    #[serde(default)]
    pub deepl_key: String,

    /// Saved endpoints. Seeded from the flat fields on first save, so the
    /// switcher is never empty.
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    #[serde(default)]
    pub active_profile_id: String,
    /// The key of every saved profile, by id — including the active one, which
    /// is also mirrored into `api_key` so nothing that reads it has to know
    /// profiles exist. A **credential**: sealed at rest, blanked out of backups
    /// (see `crate::secrets::SECRET_FIELDS`).
    #[serde(default)]
    pub profile_keys: HashMap<String, String>,

    /// Sampling temperature. Sent on every request; a model that rejects it is
    /// retried without it (see `chat::stream_chat`).
    ///
    /// `f64` rather than `f32` because JSON numbers are doubles: a `f32` 0.4
    /// widens to 0.4000000059604645 on the wire, which is a number no reader
    /// typed and no provider documents.
    #[serde(default = "default_temperature")]
    pub temperature: f64,
    /// Upper bound on one answer.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// How many past exchanges travel with a new question. Trimmed in the
    /// renderer, which is where the conversation lives.
    #[serde(default = "default_context_turns")]
    pub context_turns: u32,
    /// How many model↔tool round trips one question may take. Stored now; the
    /// agent loop that reads it lands with the tool work.
    #[serde(default = "default_max_tool_rounds")]
    pub max_tool_rounds: u32,
    /// Appended after the main prompt. A place to say "这本是网络小说，别端着"
    /// without losing the built-in voice.
    #[serde(default)]
    pub system_prompt_extra: String,
    /// Ask the provider for a reasoning stream. Vendor-specific: the parameter
    /// that turns it on is not the same one anywhere (see
    /// `chat::thinking_params`), and a provider that cannot be identified gets
    /// no parameter at all rather than a guess.
    #[serde(default)]
    pub deep_thinking: bool,

    /// Show the token/cost bar under an answer.
    #[serde(default = "default_true")]
    pub show_token_usage: bool,
    #[serde(default)]
    pub token_price: TokenPrice,
    /// Questions offered above the input box before the first one is asked.
    #[serde(default = "default_quick_questions")]
    pub quick_questions: Vec<String>,

    /// Keep retrieval to chapters at or before the reader's position.
    #[serde(default)]
    pub spoiler_safe: bool,
    /// How many chunks retrieval hands the model.
    #[serde(default = "default_rag_top_k")]
    pub rag_top_k: usize,
}

fn default_temperature() -> f64 {
    0.7
}
fn default_max_tokens() -> u32 {
    4096
}
fn default_context_turns() -> u32 {
    8
}
fn default_max_tool_rounds() -> u32 {
    8
}
fn default_rag_top_k() -> usize {
    6
}
fn default_true() -> bool {
    true
}
fn default_quick_questions() -> Vec<String> {
    DEFAULT_QUICK_QUESTIONS.iter().map(|q| (*q).to_string()).collect()
}

/// What the quick-question row offers before the reader edits it. Phrased as
/// things a reader actually wonders, and answerable from one chapter or the
/// whole book — the two scopes the assistant has.
pub const DEFAULT_QUICK_QUESTIONS: [&str; 4] =
    ["这章讲了什么", "概括这本书", "本章有哪些人物", "这一段想说什么"];

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            model: "gpt-4o-mini".to_string(),
            imported_models: Vec::new(),
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            embedding_model: String::new(),
            embedding_base_url: String::new(),
            embedding_api_key: String::new(),
            rerank_model: String::new(),
            deepl_key: String::new(),
            profiles: Vec::new(),
            active_profile_id: String::new(),
            profile_keys: HashMap::new(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            context_turns: default_context_turns(),
            max_tool_rounds: default_max_tool_rounds(),
            system_prompt_extra: String::new(),
            deep_thinking: false,
            show_token_usage: default_true(),
            token_price: TokenPrice::default(),
            quick_questions: default_quick_questions(),
            spoiler_safe: false,
            rag_top_k: default_rag_top_k(),
        }
    }
}

/// The default prompt shipped before 2026-10-31. Kept only so a config saved
/// with it can adopt [`DEFAULT_SYSTEM_PROMPT`] on read instead of freezing the
/// old wording forever; a prompt the reader actually edited is left alone.
const LEGACY_DEFAULT_SYSTEM_PROMPT: &str = "你是一个阅读助手。只依据用户给出的原文回答问题；\
     原文没有提到的内容就说不知道，不要编造。回答使用原文所用的语言。";

/// The reading assistant's default voice, prepended to every conversation unless
/// a feature supplies its own system message (the reading guide does). Kept
/// general — grounding, brevity, in-context explanation, faithful translation —
/// because the same text serves selection lookups, translation, chapter Q&A and
/// library-wide retrieval.
pub(crate) const DEFAULT_SYSTEM_PROMPT: &str = "你是一位随读者翻阅的阅读助手。请遵守：\n\
     1. 只依据用户给出的原文或检索到的上下文作答；原文没有提到或你无法确定的，直接说明，绝不编造情节、人物或引文。\n\
     2. 先给结论，再简述依据；保持简洁，不大段复述原文。\n\
     3. 解释词语或概念时，紧扣它在当前上下文里的用法，不要泛泛而谈。\n\
     4. 翻译时只给出忠实、通顺的译文，不加解释或评论，除非用户要求。\n\
     5. 默认用原文或提问所用的语言回答；用户指定语言时，按用户指定。\n\
     6. 直接作答，不要用「根据你提供的原文」之类的开场白。";

const KEY: &str = "ai.config";

/// Persisted config, or the defaults when nothing has been saved yet.
///
/// The credentials in it are sealed at rest (see `crate::secrets`); the
/// endpoint, model and prompt are not, because they are configuration rather
/// than secrets and reading them back by eye is how the row stays debuggable.
pub fn config(library: &Library) -> AppResult<AiConfig> {
    match crate::secrets::read_json(library, KEY)? {
        Some(value) => {
            let mut config: AiConfig = serde_json::from_value(value)
                .map_err(|err| AppError::Message(format!("AI 配置已损坏，请重新填写：{err}")))?;
            // A config saved with the old default wording adopts the new default
            // on read. An intentionally empty prompt stays empty: `with_system`
            // treats that as "add nothing", which is a choice, not an old default.
            if config.system_prompt == LEGACY_DEFAULT_SYSTEM_PROMPT {
                config.system_prompt = DEFAULT_SYSTEM_PROMPT.to_string();
            }
            Ok(config)
        }
        None => Ok(AiConfig::default()),
    }
}

/// Writes the config back, normalized.
///
/// `api_key` is validated by the caller's test call, not here: any non-empty
/// string is a syntactically valid key. Everything that has a range is clamped
/// rather than rejected — a slider that lands on 2.01 should save as 2.0, not
/// fail with a message about a number the reader never typed.
pub fn set_config(library: &Library, next: &AiConfig) -> AppResult<AiConfig> {
    let base = crate::net::secure_base_url(&next.base_url, "接口地址")?;
    let model = next.model.trim().to_string();
    if model.is_empty() {
        return Err(AppError::InvalidArgument("模型名称不能为空".into()));
    }

    let mut stored = next.clone();
    stored.base_url = base;
    stored.api_key = next.api_key.trim().to_string();
    stored.model = model;
    stored.embedding_model = next.embedding_model.trim().to_string();
    // Only validated when it is set: an empty one is not a URL, it is "use the
    // chat endpoint".
    stored.embedding_base_url = if next.embedding_base_url.trim().is_empty() {
        String::new()
    } else {
        crate::net::secure_base_url(&next.embedding_base_url, "向量接口地址")?
    };
    stored.embedding_api_key = next.embedding_api_key.trim().to_string();
    stored.rerank_model = next.rerank_model.trim().to_string();
    stored.deepl_key = next.deepl_key.trim().to_string();
    stored.temperature = next.temperature.clamp(0.0, 2.0);
    stored.max_tokens = next.max_tokens.clamp(64, 32_000);
    stored.context_turns = next.context_turns.clamp(1, 40);
    stored.max_tool_rounds = next.max_tool_rounds.clamp(1, 16);
    stored.rag_top_k = next.rag_top_k.clamp(1, 20);
    stored.quick_questions = clean_questions(&next.quick_questions);
    stored.system_prompt_extra = next.system_prompt_extra.trim_end().to_string();
    stored.token_price = TokenPrice {
        input_cached: next.token_price.input_cached.max(0.0),
        input_miss: next.token_price.input_miss.max(0.0),
        output: next.token_price.output.max(0.0),
    };

    // The active profile is kept in step with the flat fields, and its key is
    // remembered under its id — otherwise switching away and back loses the key
    // the reader typed for it. This is the **only** place the two are synced.
    let mut profiles = next.profiles.clone();
    let active = if next.active_profile_id.trim().is_empty() {
        profile_id(&stored.base_url, &stored.model)
    } else {
        next.active_profile_id.trim().to_string()
    };
    let entry = AiProfile {
        id: active.clone(),
        name: profile_name(&profiles, &active, &stored.base_url),
        base_url: stored.base_url.clone(),
        model: stored.model.clone(),
    };
    match profiles.iter_mut().find(|profile| profile.id == active) {
        Some(slot) => *slot = entry,
        None => profiles.push(entry),
    }
    // Twelve is a switcher, not a bookmark manager. The active one survives the
    // cut: a saved config whose `active_profile_id` names nothing would lose its
    // key on the next save.
    if profiles.len() > 12 {
        profiles.truncate(12);
        if !profiles.iter().any(|profile| profile.id == active) {
            profiles.pop();
            profiles.push(AiProfile {
                id: active.clone(),
                name: profile_name(&profiles, &active, &stored.base_url),
                base_url: stored.base_url.clone(),
                model: stored.model.clone(),
            });
        }
    }
    stored.profiles = profiles;
    stored.active_profile_id = active.clone();
    // The active profile's key follows the flat field in *both* directions:
    // typing one records it, clearing it removes it. A `remove` that was really
    // a no-op is how a cleared key came back the next time the profile was
    // switched to.
    if stored.api_key.is_empty() {
        stored.profile_keys.remove(&active);
    } else {
        stored.profile_keys.insert(active, stored.api_key.clone());
    }

    crate::secrets::write_json(library, KEY, &serde_json::to_value(&stored)?)?;
    Ok(stored)
}

/// Trims, drops blanks and duplicates, and caps the list. Duplicates would make
/// two identical chips that do different nothing.
fn clean_questions(questions: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for question in questions {
        let text = question.trim();
        if text.is_empty() || out.iter().any(|kept| kept == text) {
            continue;
        }
        out.push(text.to_string());
        if out.len() == 12 {
            break;
        }
    }
    out
}

/// A stable id for a profile, derived from what identifies it: the endpoint and
/// the model. Retyping the same endpoint does not fork a second entry.
fn profile_id(base_url: &str, model: &str) -> String {
    format!("{}|{}", host_of(base_url), model)
}

/// `https://api.deepseek.com/v1` → `api.deepseek.com`; loopback → `本地`.
fn host_of(base_url: &str) -> String {
    let without_scheme = base_url.split("://").nth(1).unwrap_or(base_url);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    let host = host.split(':').next().unwrap_or(host);
    if host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0" || host == "[::1]" {
        "本地".to_string()
    } else {
        host.to_string()
    }
}

/// A name to show in the switcher. An existing profile keeps the name the reader
/// gave it; a new one is named after its host.
fn profile_name(existing: &[AiProfile], id: &str, base_url: &str) -> String {
    match existing.iter().find(|profile| profile.id == id) {
        Some(profile) if !profile.name.trim().is_empty() => profile.name.clone(),
        _ => host_of(base_url),
    }
}

/// Where embeddings go, and what signs them.
///
/// One place resolves the fallback, so the two call sites (indexing a book and
/// searching it) cannot disagree about which endpoint a book was indexed
/// against — an index built on one endpoint and queried on another is a
/// dimension mismatch at best and nonsense at worst.
pub fn embedding_endpoint(config: &AiConfig) -> (&str, &str) {
    let base = if config.embedding_base_url.trim().is_empty() {
        config.base_url.as_str()
    } else {
        config.embedding_base_url.as_str()
    };
    let key = if config.embedding_api_key.trim().is_empty() {
        config.api_key.as_str()
    } else {
        config.embedding_api_key.as_str()
    };
    (base, key)
}

/// `true` once a model is named: the endpoint may still be wrong, which is what
/// the test call is for.
pub fn is_ready(config: &AiConfig) -> bool {
    !config.model.trim().is_empty() && !config.base_url.trim().is_empty()
}

/// `…/chat/completions`, without duplicating a slash.
pub(crate) fn completions_url(base_url: &str) -> String {
    format!("{base_url}/chat/completions")
}

/// The full system message: the built-in voice, then whatever the reader
/// appended. Empty halves add nothing rather than leaving a stray blank line.
pub fn system_message(config: &AiConfig) -> String {
    match (config.system_prompt.trim(), config.system_prompt_extra.trim()) {
        ("", "") => String::new(),
        ("", extra) => extra.to_string(),
        (main, "") => main.to_string(),
        (main, extra) => format!("{main}\n\n{extra}"),
    }
}

/// How many chapter titles travel with a request.
///
/// A novel split one paragraph per chapter can run to thousands, and a system
/// message that long costs more than the answer. A hundred and fifty covers
/// every ordinary book outright and still tells the model the shape of a long
/// one; past it, the omission line says how many were left and the number stays
/// usable with `read_chapter`.
const TOC_LIMIT: usize = 150;

/// The book in hand, for the assistant's system message.
///
/// The tools reach a chapter only by number and no tool lists them, so a
/// structural question — "梳理一下本书的脉络", which is half of what the mind map
/// is for — would otherwise be unanswerable: the model would have to guess
/// chapter numbers. The contents are a few hundred characters, do not change
/// during a turn, and are exactly what that question needs.
///
/// Takes titles rather than chapter rows so this stays a pure function; the
/// caller owns the library.
pub fn book_context(title: &str, titles: &[String]) -> String {
    if titles.is_empty() {
        return String::new();
    }
    let mut out = format!("读者正在读《{title}》，共 {} 章。\n\n目录：\n", titles.len());
    for (index, chapter) in titles.iter().take(TOC_LIMIT).enumerate() {
        out.push_str(&format!("{}. {chapter}\n", index + 1));
    }
    if titles.len() > TOC_LIMIT {
        out.push_str(&format!(
            "……（后 {} 章未列出，仍可按章节号读取）\n",
            titles.len() - TOC_LIMIT
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;

    struct Harness {
        dir: std::path::PathBuf,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
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
    fn an_unconfigured_library_gets_the_defaults() {
        let harness = Harness::new("ai-default");
        let config = config(&harness.library).expect("config");
        assert_eq!(config.base_url, "https://api.openai.com/v1");
        assert!(!config.system_prompt.is_empty());
        assert!(is_ready(&config));
        assert_eq!(config.temperature, 0.7);
        assert_eq!(config.max_tokens, 4096);
        assert_eq!(config.context_turns, 8);
        assert_eq!(config.rag_top_k, 6);
        assert!(config.show_token_usage);
        assert_eq!(config.quick_questions.len(), DEFAULT_QUICK_QUESTIONS.len());
    }

    #[test]
    fn a_config_saved_with_the_old_default_prompt_adopts_the_new_one() {
        let harness = Harness::new("ai-legacy-prompt");
        set_config(
            &harness.library,
            &AiConfig { system_prompt: LEGACY_DEFAULT_SYSTEM_PROMPT.into(), ..AiConfig::default() },
        )
        .expect("save");
        assert_eq!(config(&harness.library).expect("config").system_prompt, DEFAULT_SYSTEM_PROMPT);
    }

    #[test]
    fn a_customized_or_empty_prompt_is_left_alone() {
        let harness = Harness::new("ai-custom-prompt");
        set_config(
            &harness.library,
            &AiConfig { system_prompt: "我的提示词".into(), ..AiConfig::default() },
        )
        .expect("save custom");
        assert_eq!(config(&harness.library).expect("config").system_prompt, "我的提示词");

        set_config(
            &harness.library,
            &AiConfig { system_prompt: String::new(), ..AiConfig::default() },
        )
        .expect("save empty");
        assert_eq!(
            config(&harness.library).expect("config").system_prompt,
            "",
            "空提示词是「不加系统消息」的选择，不该被默认值顶掉"
        );
    }

    #[test]
    fn a_saved_config_round_trips_without_its_key_leaking_elsewhere() {
        let harness = Harness::new("ai-roundtrip");
        set_config(
            &harness.library,
            &AiConfig {
                base_url: "http://localhost:11434/v1/".into(),
                api_key: " sk-secret ".into(),
                model: " qwen2.5 ".into(),
                imported_models: Vec::new(),
                system_prompt: "简短回答".into(),
                embedding_model: "nomic-embed-text".into(),
                rerank_model: " bge-reranker-v2-m3 ".into(),
                deepl_key: " key:fx ".into(),
                ..AiConfig::default()
            },
        )
        .expect("save");

        let config = config(&harness.library).expect("config");
        assert_eq!(config.base_url, "http://localhost:11434/v1", "斜杠与空白要去掉");
        assert_eq!(config.api_key, "sk-secret");
        assert_eq!(config.model, "qwen2.5");
        assert_eq!(config.system_prompt, "简短回答");
        assert_eq!(config.rerank_model, "bge-reranker-v2-m3");

        // The round trip above cannot tell sealing from not sealing: a plaintext
        // row reads back just as well. This is the assertion that fails if
        // `set_config` ever stops routing through `secrets`, and it is the only
        // place the wiring is checked from the caller's side.
        let raw: String = harness
            .library
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT value FROM settings WHERE key = 'ai.config'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("raw row");
        assert!(!raw.contains("sk-secret"), "API Key 明文落盘了：{raw}");
        assert!(!raw.contains("key:fx"), "DeepL Key 明文落盘了：{raw}");
    }

    #[test]
    fn saving_again_overwrites_rather_than_conflicting() {
        let harness = Harness::new("ai-overwrite");
        set_config(&harness.library, &AiConfig::default()).expect("first");
        set_config(&harness.library, &AiConfig { model: "other".into(), ..AiConfig::default() })
            .expect("second");
        assert_eq!(config(&harness.library).expect("config").model, "other");
    }

    #[test]
    fn a_model_name_is_required() {
        let harness = Harness::new("ai-no-model");
        let result =
            set_config(&harness.library, &AiConfig { model: "   ".into(), ..AiConfig::default() });
        assert!(matches!(result, Err(AppError::InvalidArgument(_))), "{result:?}");
    }

    #[test]
    fn the_completions_path_is_joined_once() {
        assert_eq!(
            completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn out_of_range_numbers_are_clamped_not_rejected() {
        let harness = Harness::new("ai-clamp");
        let saved = set_config(
            &harness.library,
            &AiConfig {
                temperature: 9.0,
                max_tokens: 1,
                context_turns: 999,
                max_tool_rounds: 0,
                rag_top_k: 99,
                token_price: TokenPrice { input_cached: -1.0, input_miss: 2.0, output: 8.0 },
                ..AiConfig::default()
            },
        )
        .expect("save");

        assert_eq!(saved.temperature, 2.0);
        assert_eq!(saved.max_tokens, 64);
        assert_eq!(saved.context_turns, 40);
        assert_eq!(saved.max_tool_rounds, 1);
        assert_eq!(saved.rag_top_k, 20);
        assert_eq!(saved.token_price.input_cached, 0.0, "负价格要归零");
        assert_eq!(saved.token_price.output, 8.0);
    }

    #[test]
    fn quick_questions_are_trimmed_deduped_and_capped() {
        let harness = Harness::new("ai-questions");
        let mut questions = vec![" 甲 ".to_string(), "甲".to_string(), String::new()];
        questions.extend((0..20).map(|index| format!("问题 {index}")));

        let saved = set_config(
            &harness.library,
            &AiConfig { quick_questions: questions, ..AiConfig::default() },
        )
        .expect("save");

        assert_eq!(saved.quick_questions.first().map(String::as_str), Some("甲"));
        assert_eq!(saved.quick_questions.len(), 12, "上限 12 条");
        assert!(!saved.quick_questions.iter().any(|q| q.is_empty()));
    }

    #[test]
    fn the_first_save_seeds_a_profile_so_the_switcher_is_never_empty() {
        let harness = Harness::new("ai-seed-profile");
        let saved = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-chat".into(),
                api_key: "sk-a".into(),
                ..AiConfig::default()
            },
        )
        .expect("save");

        assert_eq!(saved.profiles.len(), 1);
        assert_eq!(saved.profiles[0].name, "api.deepseek.com");
        assert_eq!(saved.profiles[0].base_url, "https://api.deepseek.com/v1");
        assert_eq!(saved.active_profile_id, saved.profiles[0].id);
        assert_eq!(saved.profile_keys.get(&saved.active_profile_id), Some(&"sk-a".into()));
    }

    #[test]
    fn a_second_profile_keeps_the_first_ones_key() {
        let harness = Harness::new("ai-two-profiles");
        let first = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-chat".into(),
                api_key: "sk-deepseek".into(),
                ..AiConfig::default()
            },
        )
        .expect("first");

        // Switching means copying the snapshot back into the flat fields, which
        // is what the settings form does; the backend only has to remember both
        // keys under their own ids. An empty `active_profile_id` is "this is a
        // new endpoint", which is how a second entry gets created.
        let second = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.openai.com/v1".into(),
                model: "gpt-4o-mini".into(),
                api_key: "sk-openai".into(),
                profiles: first.profiles.clone(),
                profile_keys: first.profile_keys.clone(),
                ..AiConfig::default()
            },
        )
        .expect("second");

        assert_eq!(second.profiles.len(), 2);
        assert_eq!(second.profile_keys.get(&first.active_profile_id), Some(&"sk-deepseek".into()));
        assert_eq!(second.profile_keys.get(&second.active_profile_id), Some(&"sk-openai".into()));
    }

    #[test]
    fn a_renamed_profile_keeps_its_name_on_the_next_save() {
        let harness = Harness::new("ai-rename-profile");
        let first = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-chat".into(),
                ..AiConfig::default()
            },
        )
        .expect("first");

        let mut profiles = first.profiles.clone();
        profiles[0].name = "我的 DeepSeek".into();
        let renamed = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-reasoner".into(),
                profiles,
                active_profile_id: first.active_profile_id.clone(),
                ..AiConfig::default()
            },
        )
        .expect("rename");

        assert_eq!(renamed.profiles[0].name, "我的 DeepSeek");
        assert_eq!(renamed.profiles[0].model, "deepseek-reasoner", "方案跟着最新一次保存走");
    }

    #[test]
    fn clearing_a_key_clears_it_for_that_profile_too() {
        let harness = Harness::new("ai-clear-profile-key");
        let saved = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-chat".into(),
                api_key: "sk-a".into(),
                ..AiConfig::default()
            },
        )
        .expect("save");

        // What the form does when the reader empties the field.
        let cleared = set_config(
            &harness.library,
            &AiConfig {
                base_url: saved.base_url.clone(),
                model: saved.model.clone(),
                api_key: String::new(),
                profiles: saved.profiles.clone(),
                profile_keys: saved.profile_keys.clone(),
                active_profile_id: saved.active_profile_id.clone(),
                ..AiConfig::default()
            },
        )
        .expect("clear");

        assert!(
            !cleared.profile_keys.contains_key(&saved.active_profile_id),
            "清空的 Key 不能留在方案里，否则切走再切回来会复活"
        );
        assert_eq!(cleared.api_key, "");
    }

    #[test]
    fn embeddings_share_the_chat_endpoint_until_they_are_given_their_own() {
        let shared = AiConfig {
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: "sk-chat".into(),
            ..AiConfig::default()
        };
        assert_eq!(
            embedding_endpoint(&shared),
            ("https://api.deepseek.com/v1", "sk-chat"),
            "没设就是沿用"
        );

        // Chat on a hosted model, embeddings on a local runtime: no key, and a
        // different port. This is the case the field exists for.
        let split = AiConfig {
            embedding_base_url: "http://127.0.0.1:11434/v1".into(),
            embedding_api_key: String::new(),
            ..shared.clone()
        };
        assert_eq!(
            embedding_endpoint(&split),
            ("http://127.0.0.1:11434/v1", "sk-chat"),
            "只换地址时 Key 仍沿用对话的（本地服务会忽略它）"
        );

        let keyed = AiConfig { embedding_api_key: "emb-key".into(), ..split.clone() };
        assert_eq!(embedding_endpoint(&keyed).1, "emb-key");
    }

    #[test]
    fn the_embedding_endpoint_round_trips_and_its_key_is_sealed() {
        let harness = Harness::new("ai-embedding-endpoint");
        let saved = set_config(
            &harness.library,
            &AiConfig {
                base_url: "https://api.openai.com/v1".into(),
                api_key: "sk-chat".into(),
                model: "gpt-4o-mini".into(),
                embedding_base_url: " http://127.0.0.1:11434/v1/ ".into(),
                embedding_api_key: " sk-emb ".into(),
                ..AiConfig::default()
            },
        )
        .expect("save");

        assert_eq!(saved.embedding_base_url, "http://127.0.0.1:11434/v1", "斜杠与空白要去掉");
        assert_eq!(saved.embedding_api_key, "sk-emb");

        let raw: String = harness
            .library
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT value FROM settings WHERE key = 'ai.config'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("raw row");
        assert!(!raw.contains("sk-emb"), "向量 Key 明文落盘了：{raw}");
    }

    #[test]
    fn a_malformed_embedding_address_is_refused_but_an_empty_one_is_fine() {
        let harness = Harness::new("ai-embedding-url");
        let bad = set_config(
            &harness.library,
            &AiConfig { embedding_base_url: "not a url".into(), ..AiConfig::default() },
        );
        assert!(bad.is_err(), "给了地址就要是地址");

        // Empty is not a URL to validate, it is "use the chat endpoint".
        assert!(
            set_config(
                &harness.library,
                &AiConfig { embedding_base_url: "  ".into(), ..AiConfig::default() }
            )
            .is_ok()
        );
    }

    #[test]
    fn the_system_message_joins_both_halves_and_skips_empty_ones() {
        let base = AiConfig { system_prompt: "主".into(), ..AiConfig::default() };
        assert_eq!(system_message(&base), "主");

        let both = AiConfig { system_prompt_extra: "附".into(), ..base.clone() };
        assert_eq!(system_message(&both), "主\n\n附");

        let only_extra = AiConfig {
            system_prompt: "  ".into(),
            system_prompt_extra: "附".into(),
            ..base.clone()
        };
        assert_eq!(system_message(&only_extra), "附");

        let neither = AiConfig { system_prompt: String::new(), ..base };
        assert_eq!(system_message(&neither), "");
    }

    #[test]
    fn a_book_without_chapters_contributes_nothing() {
        assert_eq!(book_context("无名", &[]), "");
    }

    #[test]
    fn the_contents_are_numbered_and_say_how_many_were_left_out() {
        let titles: Vec<String> = (1..=200).map(|n| format!("第 {n} 节")).collect();
        let text = book_context("测试书", &titles);

        assert!(text.starts_with("读者正在读《测试书》，共 200 章。"), "{text}");
        assert!(text.contains("1. 第 1 节\n"), "{text}");
        assert!(text.contains("150. 第 150 节\n"), "{text}");
        assert!(!text.contains("151. "), "超出上限的章节不该被列出：{text}");
        assert!(text.contains("后 50 章未列出"), "{text}");
    }

    #[test]
    fn a_short_book_is_listed_whole() {
        let titles = vec!["开端".to_string(), "发展".to_string(), "结局".to_string()];
        let text = book_context("短篇", &titles);

        assert!(text.contains("3. 结局"), "{text}");
        assert!(!text.contains("未列出"), "没被截断就不该有省略说明：{text}");
    }

    #[test]
    fn a_host_names_a_profile_and_loopback_is_called_local() {
        assert_eq!(host_of("https://api.deepseek.com/v1"), "api.deepseek.com");
        assert_eq!(host_of("http://127.0.0.1:1234/v1"), "本地");
        assert_eq!(host_of("http://localhost:11434/v1/"), "本地");
        assert_eq!(
            host_of("https://generativelanguage.googleapis.com/v1beta/openai"),
            "generativelanguage.googleapis.com"
        );
    }
}
