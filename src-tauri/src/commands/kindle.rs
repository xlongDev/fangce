//! `kindle.*` commands: push EPUBs to a Kindle library through Amazon's
//! official Send to Kindle email address.
//!
//! No scraper and no session cookie: Amazon still documents attaching a file
//! to the address in Personal Document Settings, so the whole feature is one
//! authenticated SMTP message with `application/epub+zip` parts. The reader
//! supplies their own relay and an app password; both are sealed by `secrets`.
//!
//! Only EPUB goes out. Amazon converts it on its side, and this command does
//! not pretend to do that conversion locally. What it does do is write the
//! shelf's metadata into the OPF before sending: the补全 the reader made in
//! 方册 would otherwise never reach Kindle, which reads the file, not our DB.

use std::collections::HashSet;
use std::time::Duration;

use lettre::message::{Attachment, Body, Message, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::book::shelf_cover;
use crate::db::Library;
use crate::document::epub::EpubMetaPatch;
use crate::document::{self, BookFormat};
use crate::error::{AppError, AppResult};
use crate::library::repository;
use crate::secrets;
use crate::state::AppState;

/// Progress of one batch, counted in input ids (duplicates included) so the
/// bar can go from `0/N` to `N/N` without knowing how the mail was split.
pub const KINDLE_SEND_PROGRESS_EVENT: &str = "kindle://send-progress";
/// Amazon's email path accepts a 50 MB total per message. A single attachment
/// may use the whole message; larger books belong on the web uploader (200 MB).
/// Note: MIME base64 inflates the wire size ~33%, so a relay with a smaller
/// per-message cap will bounce a full-size attachment — that is the reader's
/// SMTP provider to pick, not a limit we can detect here.
const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 25;
const MAX_MESSAGE_BYTES: u64 = 50 * 1024 * 1024;
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

/// Why one row of a batch ended the way it did.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KindleOutcomeKind {
    /// Attached to a message the relay accepted.
    Sent,
    /// Rejected before any network call: format, size, missing file, config.
    Invalid,
    /// The message carrying this book failed; no retry was attempted.
    Failed,
    /// The same book id appeared earlier in this batch.
    Duplicate,
}

/// One row per input id, in input order. `message` is already display text —
/// the same string a single send would have put in its toast.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindleBatchOutcome {
    pub book_id: String,
    pub title: String,
    pub kind: KindleOutcomeKind,
    pub message: Option<String>,
    /// 1-based position of the accepted message, when `kind` is `sent`.
    pub message_index: Option<usize>,
}

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindleBatchSummary {
    /// Input count, duplicates included; also the progress denominator.
    pub total: usize,
    pub unique: usize,
    pub sent: usize,
    pub invalid: usize,
    pub failed: usize,
    pub duplicate: usize,
    /// Messages the relay accepted, not messages attempted.
    pub messages: usize,
    /// Batch-wide config failure, when no message could be built at all.
    pub config_error: Option<String>,
    pub outcomes: Vec<KindleBatchOutcome>,
}

#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindleSendProgress {
    pub done: usize,
    pub total: usize,
    pub messages: usize,
}

/// A validated book, in memory, with the OPF already patched.
#[derive(Debug, Clone)]
struct PendingAttachment {
    title: String,
    bytes: Vec<u8>,
    /// Which row of `outcomes` this book belongs to.
    outcome_index: usize,
}

/// Drop the space people put around an `@` when copying an address out of a
/// browser, without silently changing anything else in the field.
fn tidy(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Persisted config, or a blank form the settings page can fill in.
pub fn config(library: &Library) -> AppResult<KindleConfig> {
    match secrets::read_json(library, CONFIG_KEY)? {
        Some(value) => serde_json::from_value(value)
            .map_err(|err| AppError::Message(format!("Kindle 配置已损坏，请重新填写：{err}"))),
        None => Ok(KindleConfig::default()),
    }
}

/// Validates, trims and stores the config. The password is sealed through the
/// same field list that blanks it out of backups.
pub fn set_config(library: &Library, next: &KindleConfig) -> AppResult<KindleConfig> {
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

/// One filename-safe title, shared by the single and the batch message so a
/// book keeps the same attachment name whichever entry sent it.
fn safe_title(title: &str) -> String {
    let safe: String = title
        .trim()
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | '\n' | '\r') { '_' } else { c })
        .collect();
    if safe.is_empty() { "书".to_string() } else { safe }
}

fn check_size(size: u64) -> AppResult<()> {
    if size == 0 || size > MAX_ATTACHMENT_BYTES {
        return Err(AppError::InvalidArgument(
            "EPUB 文件为空或超过 50 MB，请改用 Send to Kindle 网页上传".into(),
        ));
    }
    Ok(())
}

fn epub_only(format: BookFormat) -> AppResult<()> {
    if format != BookFormat::Epub {
        return Err(AppError::UnsupportedFormat("发送到 Kindle 目前只支持 EPUB".into()));
    }
    Ok(())
}

/// The Message on its own, so a test can inspect the MIME without a relay.
fn build_message(config: &KindleConfig, title: &str, epub: Vec<u8>) -> AppResult<Message> {
    let safe_title = safe_title(title);
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

/// Same envelope, many attachments. Titles can collide across books, so only
/// the MIME filename is disambiguated — the outcome keeps the real title.
fn build_batch_message(config: &KindleConfig, pending: &[PendingAttachment]) -> AppResult<Message> {
    let subject = if pending.len() == 1 {
        safe_title(&pending[0].title)
    } else {
        format!("方册批量发送（{} 本）", pending.len())
    };
    let mut multipart = MultiPart::mixed().singlepart(SinglePart::plain("由方册发送".to_string()));
    let mut used = HashSet::new();
    for item in pending {
        let base = safe_title(&item.title);
        let mut filename = format!("{base}.epub");
        let mut ordinal = 2;
        while !used.insert(filename.clone()) {
            filename = format!("{base} ({ordinal}).epub");
            ordinal += 1;
        }
        multipart = multipart.singlepart(
            Attachment::new(filename)
                .body(Body::new(item.bytes.clone()), "application/epub+zip".parse().unwrap()),
        );
    }
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
        .subject(subject)
        .multipart(multipart)
        .map_err(|err| AppError::Message(format!("邮件内容无法生成：{err}")))
}

/// Sequential greedy packing. A single book has already passed `check_size`,
/// so a group can never be left empty waiting for a book that will not fit.
fn group_attachments(queue: Vec<PendingAttachment>) -> Vec<Vec<PendingAttachment>> {
    let mut groups = Vec::new();
    let mut group = Vec::new();
    let mut bytes = 0u64;
    for item in queue {
        let size = item.bytes.len() as u64;
        if !group.is_empty()
            && (group.len() == MAX_ATTACHMENTS_PER_MESSAGE || bytes + size > MAX_MESSAGE_BYTES)
        {
            groups.push(std::mem::take(&mut group));
            bytes = 0;
        }
        bytes += size;
        group.push(item);
    }
    if !group.is_empty() {
        groups.push(group);
    }
    groups
}

/// First positions win; later copies are reported rather than re-sent.
fn dedupe_ids(ids: &[String]) -> (Vec<usize>, Vec<usize>) {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    let mut duplicates = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        if seen.insert(id.as_str()) {
            unique.push(index);
        } else {
            duplicates.push(index);
        }
    }
    (unique, duplicates)
}

/// A relay failure belongs to the whole message: every book in that group is
/// marked, and books in other groups are left for their own turn.
fn mark_group(
    outcomes: &mut [KindleBatchOutcome],
    group: &[PendingAttachment],
    message_index: usize,
    result: &AppResult<()>,
) {
    for item in group {
        let outcome = &mut outcomes[item.outcome_index];
        match result {
            Ok(()) => {
                outcome.kind = KindleOutcomeKind::Sent;
                outcome.message = None;
                outcome.message_index = Some(message_index);
            }
            Err(err) => {
                outcome.kind = KindleOutcomeKind::Failed;
                outcome.message = Some(err.to_string());
                outcome.message_index = None;
            }
        }
    }
}

/// Reads, validates and patches one book. Every error here is an `Invalid`
/// row in a batch and the exact toast text in a single send.
async fn prepare_attachment(library: &Library, id: &str) -> AppResult<PendingAttachment> {
    let (path, format) = library.with(|conn| repository::source(conn, id))?;
    epub_only(format)?;
    let book = library
        .with(|conn| repository::get(conn, id))?
        .ok_or_else(|| AppError::NotFound(id.to_string()))?;

    let file = std::path::Path::new(&path);
    let size = tokio::fs::metadata(file)
        .await
        .map_err(|err| AppError::missing_source(file, err.into()))?
        .len();
    check_size(size)?;
    let bytes =
        tokio::fs::read(file).await.map_err(|err| AppError::missing_source(file, err.into()))?;
    let patch = EpubMetaPatch {
        title: Some(book.title.clone()),
        authors: book.authors.clone(),
        language: book.language.clone(),
        publisher: book.publisher.clone(),
        description: book.description.clone(),
        published_year: book.published_year,
        cover: shelf_cover(library, id)?,
    };
    Ok(PendingAttachment {
        title: book.title,
        bytes: document::epub::write_metadata(&bytes, &patch)?,
        outcome_index: 0,
    })
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

    let pending = prepare_attachment(&library, &id).await?;
    let message = build_message(&config, &pending.title, pending.bytes)?;
    deliver(&config, message).await
}

/// `book.sendToKindleBatch` — one submit, many books, several messages when
/// the attachment count or total size crosses a relay limit. Partial failures
/// are data in the summary, not an `Err` that would hide the successful rows.
#[tauri::command]
#[specta::specta]
pub async fn book_send_to_kindle_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<KindleBatchSummary> {
    let library = state.library.clone();
    let total = ids.len();
    let (unique_positions, duplicate_positions) = dedupe_ids(&ids);
    let titles = library.with(|conn| {
        ids.iter()
            .map(|id| {
                Ok(repository::get(conn, id)?.map(|book| book.title).unwrap_or_else(|| id.clone()))
            })
            .collect::<AppResult<Vec<_>>>()
    })?;
    let mut outcomes: Vec<KindleBatchOutcome> = ids
        .iter()
        .zip(titles)
        .map(|(id, title)| KindleBatchOutcome {
            book_id: id.clone(),
            title,
            kind: KindleOutcomeKind::Invalid,
            message: None,
            message_index: None,
        })
        .collect();
    let emit = |done: usize, messages: usize| {
        // A closed window simply stops listening; the returned summary is the
        // authoritative end state either way.
        let _ = app.emit(KINDLE_SEND_PROGRESS_EVENT, KindleSendProgress { done, total, messages });
    };
    let mut done = 0usize;
    emit(done, 0);

    for &position in &duplicate_positions {
        let outcome = &mut outcomes[position];
        outcome.kind = KindleOutcomeKind::Duplicate;
        outcome.message = Some("重复选择，已跳过".to_string());
        done += 1;
        emit(done, 0);
    }

    let config = match config(&library).and_then(|found| {
        validate(&found)?;
        Ok(found)
    }) {
        Ok(found) => found,
        Err(err) => {
            let reason = err.to_string();
            for &position in &unique_positions {
                let outcome = &mut outcomes[position];
                outcome.kind = KindleOutcomeKind::Invalid;
                outcome.message = Some(reason.clone());
                done += 1;
                emit(done, 0);
            }
            return Ok(KindleBatchSummary {
                total,
                unique: unique_positions.len(),
                sent: 0,
                invalid: unique_positions.len(),
                failed: 0,
                duplicate: duplicate_positions.len(),
                messages: 0,
                config_error: Some(reason),
                outcomes,
            });
        }
    };

    let mut queue = Vec::new();
    let mut invalid = 0usize;
    for &position in &unique_positions {
        match prepare_attachment(&library, &ids[position]).await {
            Ok(mut pending) => {
                pending.outcome_index = position;
                queue.push(pending);
            }
            Err(err) => {
                let reason = err.to_string();
                let outcome = &mut outcomes[position];
                outcome.kind = KindleOutcomeKind::Invalid;
                outcome.message = Some(reason);
                invalid += 1;
                done += 1;
                emit(done, 0);
            }
        }
    }

    let mut sent = 0usize;
    let mut failed = 0usize;
    let mut messages = 0usize;
    for (index, group) in group_attachments(queue).iter().enumerate() {
        let message_index = index + 1;
        let result = match build_batch_message(&config, group) {
            Ok(message) => deliver(&config, message).await,
            Err(err) => Err(err),
        };
        mark_group(&mut outcomes, group, message_index, &result);
        if result.is_ok() {
            sent += group.len();
            messages += 1;
        } else {
            failed += group.len();
        }
        done += group.len();
        emit(done, messages);
    }

    Ok(KindleBatchSummary {
        total,
        unique: unique_positions.len(),
        sent,
        invalid,
        failed,
        duplicate: duplicate_positions.len(),
        messages,
        config_error: None,
        outcomes,
    })
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

    fn pending(title: &str, size: usize) -> PendingAttachment {
        PendingAttachment { title: title.into(), bytes: vec![0; size], outcome_index: 0 }
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

    #[test]
    fn one_attachment_ceiling_is_shared_by_single_and_batch() {
        assert!(check_size(0).is_err(), "空文件不能发");
        assert!(check_size(MAX_ATTACHMENT_BYTES + 1).is_err(), "超过 50 MB 不能发");
        assert!(check_size(MAX_ATTACHMENT_BYTES).is_ok(), "恰好 50 MB 可以发");
        assert!(epub_only(BookFormat::Epub).is_ok());
        assert!(
            epub_only(BookFormat::Text)
                .unwrap_err()
                .to_string()
                .contains("发送到 Kindle 目前只支持 EPUB")
        );
    }

    #[test]
    fn dedupe_keeps_the_first_occurrence_and_counts_later_ones() {
        let ids = ["a".to_string(), "b".to_string(), "a".to_string()];
        let (unique, duplicates) = dedupe_ids(&ids);
        assert_eq!(unique, vec![0, 1]);
        assert_eq!(duplicates, vec![2]);
    }

    #[test]
    fn groups_respect_both_attachment_count_and_total_bytes() {
        let many = (0..26).map(|_| pending("book", 1)).collect();
        let groups = group_attachments(many);
        assert_eq!(groups.iter().map(Vec::len).collect::<Vec<_>>(), vec![25, 1]);

        let half = (MAX_MESSAGE_BYTES / 2) as usize; // 25 MB each
        let pair = (0..2).map(|_| pending("half", half)).collect();
        let groups = group_attachments(pair);
        assert_eq!(groups.len(), 1, "两份 25 MB 恰好 50 MB，可以同封");

        // A full-size attachment equals the whole message budget, so it takes
        // a message of its own instead of being left out or overfilling one.
        let full = (0..2).map(|_| pending("big", MAX_ATTACHMENT_BYTES as usize)).collect();
        let groups = group_attachments(full);
        assert_eq!(groups.iter().map(Vec::len).collect::<Vec<_>>(), vec![1, 1]);

        let over = (0..3).map(|_| pending("big", MAX_ATTACHMENT_BYTES as usize)).collect();
        let groups = group_attachments(over);
        assert_eq!(groups.iter().map(Vec::len).collect::<Vec<_>>(), vec![1, 1, 1]);
        for group in groups {
            let bytes: u64 = group.iter().map(|item| item.bytes.len() as u64).sum();
            assert!(group.len() <= MAX_ATTACHMENTS_PER_MESSAGE);
            assert!(bytes <= MAX_MESSAGE_BYTES);
        }
    }

    #[test]
    fn same_titled_books_get_distinct_attachment_names() {
        // ASCII title keeps the assertion on the filename itself instead of
        // lettre's RFC 2231 encoding of non-ASCII header parameters.
        let batch = vec![pending("Same Book", 4), pending("Same Book", 4)];
        let wire =
            String::from_utf8(build_batch_message(&valid(), &batch).unwrap().formatted()).unwrap();
        assert!(wire.contains("Same Book.epub"));
        assert!(wire.contains("Same Book (2).epub"), "同名附件不能互相覆盖");
        assert_eq!(wire.matches("Content-Disposition: attachment").count(), 2);
    }

    #[test]
    fn a_failed_message_marks_only_its_own_books() {
        let mut outcomes: Vec<KindleBatchOutcome> = (0..3)
            .map(|index| KindleBatchOutcome {
                book_id: format!("b{index}"),
                title: format!("b{index}"),
                kind: KindleOutcomeKind::Invalid,
                message: None,
                message_index: None,
            })
            .collect();
        let mut first = pending("a", 1);
        first.outcome_index = 0;
        let mut third = pending("c", 1);
        third.outcome_index = 2;
        let group = vec![first, third];

        mark_group(
            &mut outcomes,
            &group,
            1,
            &Err(AppError::Message("发送失败，请检查授权码与信任邮箱设置".into())),
        );
        assert_eq!(outcomes[0].kind, KindleOutcomeKind::Failed);
        assert_eq!(outcomes[1].kind, KindleOutcomeKind::Invalid, "别的组不能跟着失败");
        assert_eq!(outcomes[2].kind, KindleOutcomeKind::Failed);

        mark_group(&mut outcomes, &group, 2, &Ok(()));
        assert_eq!(outcomes[0].kind, KindleOutcomeKind::Sent);
        assert_eq!(outcomes[0].message_index, Some(2));
        assert!(outcomes[0].message.is_none());
    }
}
