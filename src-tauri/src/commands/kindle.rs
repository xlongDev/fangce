//! `kindle.*` commands: push one EPUB to a Kindle library through Amazon's
//! official Send to Kindle email address.
//!
//! No scraper and no session cookie: Amazon still documents attaching a file
//! to the address in Personal Document Settings, so the whole feature is one
//! authenticated SMTP message with an `application/epub+zip` part. The reader
//! supplies their own relay and an app password; both are sealed by `secrets`.
//!
//! Only EPUB goes out. Amazon converts it on its side, and this command does
//! not pretend to do that conversion locally. What it does do is write the
//! shelf's metadata into the OPF before sending: the补全 the reader made in
//! 方册 would otherwise never reach Kindle, which reads the file, not our DB.

use std::time::Duration;

use lettre::message::{Attachment, Body, Message, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::book::shelf_cover;
use crate::document::epub::EpubMetaPatch;
use crate::document::{self, BookFormat};
use crate::error::{AppError, AppResult};
use crate::library::repository;
use crate::secrets;
use crate::state::AppState;

/// Conservative ceiling for an email attachment. Amazon's web uploader takes
/// 200 MB but the email path is much smaller (commonly quoted at 25–50 MB);
/// refusing early beats a bounce the reader cannot see from this app.
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
const CONFIG_KEY: &str = "send.kindle";

/// Where the file goes and which relay carries it.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindleConfig {
    /// SMTP relay, e.g. `smtp.qq.com`.
    #[serde(default)]
    pub smtp_host: String,
    /// 465 = implicit TLS, 587 = STARTTLS. No plaintext port.
    #[serde(default = "default_port")]
    pub smtp_port: u16,
    /// The approved sender on Amazon's Personal Document Settings list.
    #[serde(default)]
    pub username: String,
    /// App password, never the account's login password.
    #[serde(default)]
    pub password: String,
    /// The `@kindle.com` address from Personal Document Settings.
    #[serde(default)]
    pub kindle_email: String,
}

/// A fresh form starts on 465. Deriving `Default` would hand the UI a port of
/// `0` on the first run — the serde default is not the struct default.
impl Default for KindleConfig {
    fn default() -> Self {
        Self {
            smtp_host: String::new(),
            smtp_port: 465,
            username: String::new(),
            password: String::new(),
            kindle_email: String::new(),
        }
    }
}

fn default_port() -> u16 {
    465
}

/// Drop the space people put around an `@` when copying an address out of a
/// browser, without silently changing anything else in the field.
fn tidy(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Persisted config, or a blank form the settings page can fill in.
pub fn config(library: &crate::db::Library) -> AppResult<KindleConfig> {
    match secrets::read_json(library, CONFIG_KEY)? {
        Some(value) => serde_json::from_value(value)
            .map_err(|err| AppError::Message(format!("Kindle 配置已损坏，请重新填写：{err}"))),
        None => Ok(KindleConfig::default()),
    }
}

/// Validates, trims and stores the config. The password is sealed through the
/// same field list that blanks it out of backups.
pub fn set_config(library: &crate::db::Library, next: &KindleConfig) -> AppResult<KindleConfig> {
    let stored = KindleConfig {
        smtp_host: next.smtp_host.trim().to_string(),
        smtp_port: next.smtp_port,
        username: tidy(&next.username),
        password: next.password.clone(),
        kindle_email: tidy(&next.kindle_email).to_lowercase(),
    };
    validate(&stored)?;
    secrets::write_json(library, CONFIG_KEY, &serde_json::to_value(&stored)?)?;
    Ok(stored)
}

/// Everything that can be rejected before touching the network or the book.
fn validate(config: &KindleConfig) -> AppResult<()> {
    if config.smtp_host.is_empty() || config.username.is_empty() || config.password.is_empty() {
        return Err(AppError::InvalidArgument("请填写 SMTP 服务器、账号和授权码".into()));
    }
    if config.smtp_port != 465 && config.smtp_port != 587 {
        return Err(AppError::InvalidArgument("端口只支持 465（TLS）或 587（STARTTLS）".into()));
    }
    if !config.kindle_email.contains('@') {
        return Err(AppError::InvalidArgument("请填写 Kindle 个人文档邮箱地址".into()));
    }
    if config.kindle_email.ends_with("@kindle.cn") {
        return Err(AppError::InvalidArgument(
            "中国区个人文档服务已停止，请使用非中国区账户的 @kindle.com 地址".into(),
        ));
    }
    Ok(())
}

/// The Message on its own, so a test can inspect the MIME without a relay.
fn build_message(config: &KindleConfig, title: &str, epub: Vec<u8>) -> AppResult<Message> {
    let safe_title: String = title
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | '\n' | '\r') { '_' } else { c })
        .collect();
    let safe_title = if safe_title.is_empty() { "书" } else { &safe_title };
    let filename = format!("{safe_title}.epub");

    Message::builder()
        .from(
            config
                .username
                .parse()
                .map_err(|err| AppError::InvalidArgument(format!("发件邮箱格式不对：{err}")))?,
        )
        .to(config
            .kindle_email
            .parse()
            .map_err(|err| AppError::InvalidArgument(format!("Kindle 邮箱格式不对：{err}")))?)
        .subject(safe_title)
        .multipart(
            MultiPart::mixed().singlepart(SinglePart::plain("由方册发送".to_string())).singlepart(
                Attachment::new(filename)
                    .body(Body::new(epub), "application/epub+zip".parse().unwrap()),
            ),
        )
        .map_err(|err| AppError::Message(format!("邮件内容无法生成：{err}")))
}

/// Sends one already-built message through the configured relay.
async fn deliver(config: &KindleConfig, message: Message) -> AppResult<()> {
    let relay = if config.smtp_port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)
    }
    .map_err(|err| AppError::Message(format!("SMTP 服务器地址不可用：{err}")))?;

    relay
        .credentials(Credentials::new(config.username.clone(), config.password.clone()))
        .timeout(Some(Duration::from_secs(60)))
        .build()
        .send(message)
        .await
        .map_err(|err| AppError::Message(format!("发送失败，请检查授权码与信任邮箱设置：{err}")))?;
    Ok(())
}

/// `kindle.getConfig`
#[tauri::command]
#[specta::specta]
pub fn kindle_get_config(state: State<'_, AppState>) -> AppResult<KindleConfig> {
    config(&state.library)
}

/// `kindle.setConfig` — returns the stored, normalized form.
#[tauri::command]
#[specta::specta]
pub fn kindle_set_config(
    state: State<'_, AppState>,
    config: KindleConfig,
) -> AppResult<KindleConfig> {
    set_config(&state.library, &config)
}

/// `book.sendToKindle` — one book, one message. Desktop only: the browser has
/// no SMTP relay and no source path, so no local command is registered for it.
#[tauri::command]
#[specta::specta]
pub async fn book_send_to_kindle(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let library = state.library.clone();
    let config = config(&library)?;
    validate(&config)?;

    let (path, format) = library.with(|conn| repository::source(conn, &id))?;
    if format != BookFormat::Epub {
        return Err(AppError::UnsupportedFormat("发送到 Kindle 目前只支持 EPUB".into()));
    }
    let book = library
        .with(|conn| repository::get(conn, &id))?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;

    let file = std::path::Path::new(&path);
    let size = tokio::fs::metadata(file)
        .await
        .map_err(|err| AppError::missing_source(file, err.into()))?
        .len();
    if size == 0 || size > MAX_ATTACHMENT_BYTES {
        return Err(AppError::InvalidArgument(
            "EPUB 文件为空或超过 25 MB，请改用 Send to Kindle 网页上传".into(),
        ));
    }
    let bytes =
        tokio::fs::read(file).await.map_err(|err| AppError::missing_source(file, err.into()))?;
    let patch = EpubMetaPatch {
        title: Some(book.title.clone()),
        authors: book.authors.clone(),
        language: book.language.clone(),
        publisher: book.publisher.clone(),
        description: book.description.clone(),
        published_year: book.published_year,
        cover: shelf_cover(&library, &id)?,
    };
    let bytes = document::epub::write_metadata(&bytes, &patch)?;
    let message = build_message(&config, &book.title, bytes)?;
    deliver(&config, message).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> KindleConfig {
        KindleConfig {
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            username: "reader@example.com".into(),
            password: "app-password".into(),
            kindle_email: "reader@kindle.com".into(),
        }
    }

    #[test]
    fn a_fresh_form_uses_tls_and_ignores_spaces_pasted_around_an_address() {
        assert_eq!(KindleConfig::default().smtp_port, 465, "新表单不能显示端口 0");
        assert_eq!(tidy("duanxiaolong98_pw3 @kindle.com"), "duanxiaolong98_pw3@kindle.com");
    }

    #[test]
    fn rejects_china_address_and_plaintext_port() {
        let mut config = valid();
        config.kindle_email = "reader@kindle.cn".into();
        assert!(validate(&config).is_err(), "中国区地址必须挡在发送前");

        let mut config = valid();
        config.smtp_port = 25;
        assert!(validate(&config).is_err(), "明文端口不许用");

        assert!(validate(&valid()).is_ok());
    }

    #[test]
    fn message_carries_an_epub_attachment() {
        let message = build_message(&valid(), "Book/Name", b"epub-bytes".to_vec()).unwrap();
        let wire = String::from_utf8(message.formatted()).unwrap();
        assert!(wire.contains("application/epub+zip"), "附件 MIME 类型");
        assert!(wire.contains("Content-Disposition: attachment"), "是附件不是正文");
        assert!(wire.contains("Book_Name.epub"), "文件名里的路径分隔符要抹掉");
    }
}
