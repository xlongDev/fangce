//! Text-to-image, for character portraits.
//!
//! Two backends, and the split is not cosmetic. A local Stable Diffusion was
//! trained on comma-separated tags and answers `{images: ["<base64>"]}`; an
//! OpenAI-compatible service wants a sentence and answers
//! `{data: [{b64_json}]}`. Feeding either one the other's prompt produces a
//! picture that ignores half the description, so [`Backend::prompt_style`]
//! decides what the chat model is asked to write.
//!
//! Only two backends on purpose. ColorTxt ships eight, and five of them exist
//! for field differences — `return_base64` here, `response_format` there, an
//! `aspect_ratio` derived from two numbers — each of which is a 400 waiting to
//! happen on a machine nobody can test. Two cover a local install and every
//! reseller that speaks the OpenAI shape.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use crate::ai::AiConfig;
use crate::error::{AppError, AppResult};

/// The most characters a generated prompt may carry. Past this a local SD model
/// starts dropping the tail, and a hosted one bills for text it ignores.
const MAX_PROMPT_CHARS: usize = 1200;

/// Which service draws the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Stable Diffusion WebUI, `POST /sdapi/v1/txt2img`.
    A1111,
    /// `POST /images/generations`, the shape OpenAI and most resellers speak.
    OpenAiCompat,
}

impl Backend {
    /// The stored name, or `None` when portraits are off.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "a1111" => Some(Self::A1111),
            "openai_compat" => Some(Self::OpenAiCompat),
            _ => None,
        }
    }

    /// Where this backend lives when the reader left the address empty.
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::A1111 => "http://127.0.0.1:7860",
            Self::OpenAiCompat => "https://api.openai.com/v1",
        }
    }

    /// How the prompt should read.
    pub fn prompt_style(self) -> PromptStyle {
        match self {
            Self::A1111 => PromptStyle::Tags,
            Self::OpenAiCompat => PromptStyle::Sentence,
        }
    }

    /// The stored name, for writing back.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::A1111 => "a1111",
            Self::OpenAiCompat => "openai_compat",
        }
    }
}

/// What kind of prompt the chat model should produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptStyle {
    /// Comma-separated phrases, in English — what an SD checkpoint expects.
    Tags,
    /// One English sentence — what a hosted image model expects.
    Sentence,
}

/// One picture to draw.
pub struct PortraitRequest<'a> {
    pub prompt: &'a str,
    /// Only A1111 uses this; hosted services ignore it.
    pub negative: &'a str,
    pub width: u32,
    pub height: u32,
}

/// Draws one picture and returns the decoded file bytes.
pub async fn draw(
    client: &reqwest::Client,
    config: &AiConfig,
    request: &PortraitRequest<'_>,
) -> AppResult<Vec<u8>> {
    let backend = Backend::parse(&config.image_backend)
        .ok_or_else(|| AppError::InvalidArgument("还没有选择文生图后端".into()))?;
    let base = base_url(config, backend);

    let encoded = match backend {
        Backend::A1111 => a1111(client, &base, request).await?,
        Backend::OpenAiCompat => openai_compat(client, &base, config, request).await?,
    };
    decode(&encoded)
}

/// The address to call, falling back to the backend's own default.
fn base_url(config: &AiConfig, backend: Backend) -> String {
    let raw = config.image_base_url.trim();
    if raw.is_empty() {
        backend.default_base_url().to_string()
    } else {
        raw.trim_end_matches('/').to_string()
    }
}

async fn a1111(
    client: &reqwest::Client,
    base: &str,
    request: &PortraitRequest<'_>,
) -> AppResult<String> {
    let body = json!({
        "prompt": request.prompt,
        "negative_prompt": request.negative,
        "width": request.width,
        "height": request.height,
        "steps": 28,
        "cfg_scale": 7,
        // One picture, and the answer comes back inline. Without this A1111
        // still returns `images`, so it is belt and braces rather than a
        // requirement.
        "batch_size": 1,
        "n_iter": 1,
    });

    let value = post_json(client, &format!("{base}/sdapi/v1/txt2img"), &body, None).await?;
    value
        .get("images")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::Message("A1111 没有返回图片，确认它已加载模型".into()))
}

async fn openai_compat(
    client: &reqwest::Client,
    base: &str,
    config: &AiConfig,
    request: &PortraitRequest<'_>,
) -> AppResult<String> {
    let mut body = json!({
        "model": config.image_model.trim(),
        "prompt": request.prompt,
        "size": format!("{}x{}", request.width, request.height),
        "n": 1,
    });
    // `dall-e-2` and `dall-e-3` require this; `gpt-image-*` rejects it with a
    // 400. Sending it to everything would break the newer models, and omitting
    // it breaks the older ones — so it follows the model name.
    if config.image_model.trim().starts_with("dall-e") {
        body["response_format"] = json!("b64_json");
    }

    let key = config.image_api_key.trim();
    let auth = (!key.is_empty()).then_some(key);
    let value = post_json(client, &format!("{base}/images/generations"), &body, auth).await?;
    value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|first| first.get("b64_json"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::Message("图像接口没有返回 b64_json；如果它只给 URL，这个后端还不支持".into())
        })
}

/// POSTs JSON and parses the reply, keeping the body when it is an error.
///
/// The body is the only useful thing a failing image service says — "model not
/// found", "invalid size", "quota" — and a bare status code throws it away.
async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    bearer: Option<&str>,
) -> AppResult<Value> {
    let mut request = client.post(url).json(body);
    if let Some(key) = bearer {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|err| AppError::Message(format!("连不上文生图服务：{err}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Message(format!("文生图返回 {status}：{}", excerpt(&text))));
    }
    serde_json::from_str(&text)
        .map_err(|err| AppError::Message(format!("文生图返回的不是 JSON：{err}")))
}

/// The first part of an error body, on one line.
fn excerpt(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = flat.chars().take(200).collect();
    if flat.chars().count() > 200 { format!("{short}…") } else { short }
}

/// Turns what a service handed back into file bytes.
///
/// Some proxies wrap the payload in a `data:` URL even though the documented
/// shape is bare base64, and a picture that fails to decode is worth a clear
/// error rather than a 0-byte PNG.
fn decode(encoded: &str) -> AppResult<Vec<u8>> {
    let payload = encoded.trim();
    let payload = payload.split_once("base64,").map_or(payload, |(_, rest)| rest);
    let bytes = STANDARD
        .decode(payload)
        .map_err(|err| AppError::Message(format!("图片数据解不开：{err}")))?;
    if bytes.is_empty() {
        return Err(AppError::Message("文生图返回了空图片".into()));
    }
    Ok(bytes)
}

/* ------------------------------------------------------------------ prompts */

/// Asks the chat model to turn a character into a prompt for the image backend.
///
/// The model is the right tool here: the reader typed a name and a few scraps
/// of description, and a picture needs a coherent paragraph. It is also the only
/// place the two prompt families can be produced without a second table of
/// per-vendor templates.
pub async fn write_prompt(
    client: &reqwest::Client,
    config: &AiConfig,
    style: PromptStyle,
    subject: &str,
) -> AppResult<String> {
    let instruction = match style {
        PromptStyle::Tags => {
            "把下面的角色资料写成 Stable Diffusion 提示词：英文短语，用逗号分隔，\
             只写外观与气质（年龄段、发型发色、五官、服饰、神态、光线、画风），\
             不要写名字、剧情、人物关系。最多 40 个短语。只输出提示词本身。"
        }
        PromptStyle::Sentence => {
            "把下面的角色资料写成一句英文画面描述，用于生成角色立绘：\
             只写外观与气质（年龄段、发型发色、五官、服饰、神态、光线、画风），\
             不要写名字、剧情、人物关系。只输出这一句，不要解释。"
        }
    };
    let prompt = format!("{instruction}\n\n角色资料：\n{subject}");

    let mut answer = String::new();
    crate::ai::chat::stream_chat(
        client,
        config,
        vec![crate::ai::chat::ChatMessage::new(crate::ai::chat::Role::User, prompt)],
        None,
        &mut |event| {
            if let crate::ai::chat::StreamEvent::Delta(text) = event {
                answer.push_str(&text);
            }
            true
        },
    )
    .await?;

    let trimmed = answer.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return Err(AppError::Message("模型没有写出画面描述".into()));
    }
    Ok(trimmed.chars().take(MAX_PROMPT_CHARS).collect())
}

/* -------------------------------------------------------------------- paths */

/// The portraits directory, inside the covers directory.
///
/// Covers already live in the data directory and are already excluded from
/// everything that walks it, so a second top-level directory would mean touching
/// the backup and sync paths for one folder of generated pictures.
pub fn portraits_dir(covers_dir: &Path) -> PathBuf {
    covers_dir.join("portraits")
}

/// Where one character's portrait lives.
pub fn portrait_path(covers_dir: &Path, book_id: &str, name: &str) -> PathBuf {
    portraits_dir(covers_dir).join(slug(book_id)).join(format!("{}.png", slug(name)))
}

/// A filesystem-safe name.
///
/// Keeps letters and digits — `is_alphanumeric` is true for CJK, so 林昭 survives
/// as itself — and replaces everything else with `_`. That is what makes `../`
/// impossible without a separate validation step, since `.` and `/` are both
/// replaced.
pub fn slug(name: &str) -> String {
    let mut out: String = name
        .trim()
        .chars()
        .take(40)
        .map(|ch| if ch.is_alphanumeric() { ch } else { '_' })
        .collect();
    if out.is_empty() {
        out.push_str("character");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn config(backend: &str) -> AiConfig {
        AiConfig {
            image_backend: backend.into(),
            image_model: "gpt-image-1".into(),
            ..AiConfig::default()
        }
    }

    /// A one-pixel PNG, so a decoded picture is a real picture.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    /// Serves one canned JSON reply and hands back what the client sent.
    ///
    /// The request shape is the whole risk here — a wrong field name is a 400 on
    /// a machine nobody can test against — so the mock records the body for the
    /// assertions below.
    fn serve_once(reply: String) -> (String, Arc<Mutex<String>>) {
        serve_with("200 OK", reply)
    }

    fn serve_with(status: &'static str, reply: String) -> (String, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = Arc::new(Mutex::new(String::new()));
        let captured = seen.clone();

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 8192];
                let read = stream.read(&mut buffer).unwrap_or(0);
                if let Ok(mut slot) = captured.lock() {
                    *slot = String::from_utf8_lossy(&buffer[..read]).to_string();
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        (format!("http://127.0.0.1:{port}"), seen)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().expect("client")
    }

    #[test]
    fn only_two_backends_are_recognised() {
        assert_eq!(Backend::parse("a1111"), Some(Backend::A1111));
        assert_eq!(Backend::parse(" openai_compat "), Some(Backend::OpenAiCompat));
        assert_eq!(Backend::parse(""), None);
        assert_eq!(Backend::parse("dashscope_wanx"), None, "没做的后端不能被当成做了");
    }

    #[test]
    fn an_empty_address_falls_back_to_the_backend_default() {
        let mut config = config("a1111");
        assert_eq!(base_url(&config, Backend::A1111), "http://127.0.0.1:7860");

        config.image_base_url = "https://img.example.com/v1/".into();
        assert_eq!(base_url(&config, Backend::A1111), "https://img.example.com/v1");
    }

    #[test]
    fn the_prompt_family_follows_the_backend() {
        assert_eq!(Backend::A1111.prompt_style(), PromptStyle::Tags);
        assert_eq!(Backend::OpenAiCompat.prompt_style(), PromptStyle::Sentence);
    }

    #[test]
    fn a_slug_keeps_chinese_and_cannot_climb_out_of_its_directory() {
        assert_eq!(slug("林昭"), "林昭");
        assert_eq!(slug("../../etc/passwd"), "______etc_passwd");
        assert_eq!(slug("A/B"), "A_B");
        assert_eq!(slug(""), "character");
        assert!(slug(&"很".repeat(200)).chars().count() <= 40);
    }

    #[test]
    fn a_portrait_path_stays_under_the_portraits_directory() {
        let path = portrait_path(Path::new("/data/covers"), "../../x", "../林昭");
        let text = path.to_string_lossy();
        assert!(text.starts_with("/data/covers/portraits/"), "{text}");
        assert!(text.ends_with("__林昭.png"), "{text}");
    }

    #[test]
    fn base64_and_data_urls_both_decode() {
        assert_eq!(
            decode(PNG).expect("裸 base64"),
            decode(&format!("data:image/png;base64,{PNG}")).expect("data URL")
        );
        assert!(decode("not base64 at all !!!").is_err());
        assert!(decode("").is_err());
    }

    #[test]
    fn a1111_gets_its_own_shape_and_answers_with_images() {
        let (base, seen) = serve_once(format!(r#"{{"images":["{PNG}"]}}"#));
        let mut config = config("a1111");
        config.image_base_url = base;

        let bytes = tauri::async_runtime::block_on(draw(
            &client(),
            &config,
            &PortraitRequest {
                prompt: "1girl, hanfu",
                negative: "lowres",
                width: 512,
                height: 768,
            },
        ))
        .expect("draw");

        assert!(!bytes.is_empty());
        let request = seen.lock().expect("lock").clone();
        assert!(request.starts_with("POST /sdapi/v1/txt2img "), "{request}");
        assert!(request.contains("\"prompt\":\"1girl, hanfu\""), "{request}");
        assert!(request.contains("\"negative_prompt\":\"lowres\""), "{request}");
        assert!(request.contains("\"width\":512"), "{request}");
    }

    #[test]
    fn openai_compat_omits_response_format_for_gpt_image_models() {
        // `gpt-image-*` answers 400 when `response_format` is present, and the
        // field is easy to leave in "for compatibility".
        let (base, seen) = serve_once(format!(r#"{{"data":[{{"b64_json":"{PNG}"}}]}}"#));
        let mut config = config("openai_compat");
        config.image_base_url = base;
        config.image_api_key = "sk-test".into();

        let bytes = tauri::async_runtime::block_on(draw(
            &client(),
            &config,
            &PortraitRequest { prompt: "a young scholar", negative: "", width: 1024, height: 1024 },
        ))
        .expect("draw");

        assert!(!bytes.is_empty());
        let request = seen.lock().expect("lock").clone();
        assert!(request.starts_with("POST /images/generations "), "{request}");
        assert!(request.contains("authorization: Bearer sk-test"), "{request}");
        assert!(!request.contains("response_format"), "gpt-image 不接受这个字段：{request}");
        assert!(request.contains("\"size\":\"1024x1024\""), "{request}");
    }

    #[test]
    fn dall_e_still_asks_for_base64() {
        let (base, seen) = serve_once(format!(r#"{{"data":[{{"b64_json":"{PNG}"}}]}}"#));
        let mut config = config("openai_compat");
        config.image_base_url = base;
        config.image_model = "dall-e-3".into();

        tauri::async_runtime::block_on(draw(
            &client(),
            &config,
            &PortraitRequest { prompt: "a scholar", negative: "", width: 1024, height: 1024 },
        ))
        .expect("draw");

        let request = seen.lock().expect("lock").clone();
        assert!(request.contains("\"response_format\":\"b64_json\""), "{request}");
    }

    #[test]
    fn an_error_body_reaches_the_reader() {
        // The status alone says nothing useful; the body names the model.
        let (base, _) = serve_with("404 Not Found", r#"{"error":"model not found"}"#.into());
        let mut config = config("openai_compat");
        config.image_base_url = base;

        let error = tauri::async_runtime::block_on(draw(
            &client(),
            &config,
            &PortraitRequest { prompt: "x", negative: "", width: 512, height: 512 },
        ))
        .expect_err("应当失败");

        let text = error.to_string();
        assert!(text.contains("404"), "{text}");
        assert!(text.contains("model not found"), "{error}");
    }
}
