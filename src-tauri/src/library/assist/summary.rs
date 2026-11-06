//! One paragraph per chapter, written once and kept.
//!
//! The problem is the one a long book creates: a reader who puts a 76-chapter
//! novel down for three days comes back to chapter 40 with no memory of who
//! anyone is, and the only way back is re-reading. A summary per chapter turns
//! that into one question — 前面讲了什么 — answered from cached text.
//!
//! Two decisions shape everything here:
//!
//! - A summary is written from **its own chapter only**. A model that has seen
//!   the ending writes "他这时还不知道…", which is the one thing a reader
//!   standing in the middle must not be told.
//! - It is written **once**. Every chapter is a model call, so a chapter that
//!   already has a summary is never sent again — the panel would otherwise cost
//!   a book's worth of tokens every time it is opened.

use futures_util::StreamExt as _;
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::ai::AiConfig;
use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};
use crate::db::Library;
use crate::error::{AppError, AppResult};

/// What a chapter summary is asked to be.
///
/// Two to four sentences, and the second half of the instruction is the part
/// that matters: models default to "本章讲述了……" and a page of those is
/// indistinguishable from the table of contents.
pub const PROMPT: &str = "\
你在为一位读者写某一章的摘要。他正读到这一章，后面的内容他还没看过。\
只依据下面给出的正文，不推测、不补充、不剧透后文。用简体中文，人名地名保留原文。\
写 2 到 4 句，说清：这一章发生了什么、谁做了什么、局面有什么变化。\
如果这段正文只是版权页、目录、献词或封面，用一句话说明它是什么，不要拒绝，不要要求提供更多内容。\
不要复述原句，不要评论好坏，不要用「本章讲述了」这类开头，不要分点。只输出摘要正文。";

/// What a recap is asked to be.
pub const RECAP_PROMPT: &str = "\
下面是一位读者已经读过的各章摘要。把它们串成一段前情提要，帮他想起自己读到了哪里。\
只依据摘要，不推测后文。用简体中文，200 到 400 字，按时间顺序写，突出人物关系和当前处境。\
不要逐章罗列，不要写「第一章……第二章……」，不要用列表，不要开场白。";

/// How much of a chapter goes into the prompt.
///
/// A normal chapter is 3–10k characters and travels whole. A file imported
/// without chapter detection is one 300k-character "chapter", and sending that
/// would cost more than the summary is worth — see [`excerpt`] for what happens
/// above this.
const EXCERPT_CHARS: usize = 18_000;

/// How many chapters are summarised at once.
///
/// Same reasoning as the graph build: one call per chapter is the design, but
/// sequentially it is minutes of a panel that looks stuck. Four is where the
/// endpoint stops being the only thing happening.
const CONCURRENCY: usize = 4;

/// The least real text a chapter can have and still be worth summarising.
///
/// Front matter is why this exists. A cover page extracts as `￼cover.jpeg`
/// — eleven characters — a title page as the title and the authors, a
/// copyright page as a hundred characters of boilerplate. A model handed one of
/// those answers, correctly, that there is nothing to summarise; that answer is
/// not a summary, and storing it puts a paragraph of the model complaining to
/// itself in the middle of a reader's chapter list.
///
/// Measured against a real book: cover 11, second cover 18, title page 38,
/// copyright 102, dedication 199, first real prose 1391. The floor sits between
/// the boilerplate and the prose.
const MIN_TEXT_CHARS: usize = 120;

/// Words a refusal uses and prose does not.
///
/// Narrow on purpose, and grown from what models actually said rather than
/// imagined: these are the four answers one book produced, reduced to the
/// phrases they share. `无法` alone cannot be on the list — a novel is full of
/// 他无法回头 — so only wording that addresses the person who wrote the prompt
/// is here: the model talking about the errand rather than the chapter.
const REFUSAL_MARKERS: [&str; 7] =
    ["粘贴", "无法完成摘要", "请提供", "你提供的", "没有可供阅读", "没有章节内容", "给出的正文"];

/// The most text a recap is built from.
///
/// 400 chapters of summaries is more than any model needs to answer "where am
/// I"; past this the chapters are sampled evenly, which keeps the beginning,
/// the middle and the position the reader is actually at.
const RECAP_CHARS: usize = 14_000;

/// One row of the panel.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummary {
    pub idx: usize,
    pub title: String,
    /// Empty when this chapter has no usable summary yet.
    pub summary: String,
    /// When it was written; 0 for a chapter that has none.
    pub created_at: i64,
    /// Characters in the chapter, image markers and all.
    ///
    /// The panel needs it to say *why* a row is empty. 「这一章只有 10 字」 is an
    /// answer the reader can check; 「封面、版权页或目录」 was a guess, and a
    /// dedication page (71 characters, very much not a cover) proved it wrong.
    pub chars: usize,
}

/// What one build produced.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryBuildReport {
    pub written: usize,
    /// Chapters the model could not summarise. Non-zero means the panel is
    /// thinner than the book, which is worth saying out loud.
    pub skipped: usize,
    pub total: usize,
}

/// Every chapter up to `upto`, with its summary when one exists.
///
/// `upto` is the reader's position and is inclusive: the chapter they are in
/// has been read. A chapter whose length no longer matches its summary reads as
/// unsummarised rather than as a summary of text that is gone.
pub fn list(conn: &Connection, book_id: &str, upto: usize) -> AppResult<Vec<ChapterSummary>> {
    let mut stmt = conn.prepare(
        "SELECT c.idx, c.title, \
                CASE WHEN s.chars = c.chars THEN s.summary END, \
                CASE WHEN s.chars = c.chars THEN s.created_at ELSE 0 END, \
                c.chars \
           FROM chapters c \
           LEFT JOIN chapter_summaries s ON s.book_id = c.book_id AND s.idx = c.idx \
          WHERE c.book_id = ?1 AND c.idx <= ?2 \
          ORDER BY c.idx",
    )?;
    let rows = stmt
        .query_map(params![book_id, upto as i64], |row| {
            Ok(ChapterSummary {
                idx: row.get::<_, i64>(0)? as usize,
                title: row.get::<_, String>(1)?,
                summary: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                created_at: row.get(3)?,
                chars: row.get::<_, i64>(4)? as usize,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(rows.len());
    for mut entry in rows {
        // A stored refusal is hidden, not shown: the reader asked what happened
        // in a chapter, not what the model thought of the prompt. Clearing the
        // timestamp too puts the row back to 「还没有摘要」, which is the truth —
        // the build will pick it up again.
        if looks_like_refusal(&entry.summary) {
            entry.summary.clear();
            entry.created_at = 0;
        }
        out.push(entry);
    }
    Ok(out)
}

/// Records that a chapter has no prose to summarise.
///
/// An empty summary with a matching `chars` is the record: the row exists, so
/// the build stops offering to fill it, and `createdAt > 0` with no text is what
/// the panel reads as 「这一章没有正文」. Without it, every cover page would keep
/// the button saying 补齐 N 章 forever.
pub fn mark_textless(conn: &Connection, book_id: &str, idx: usize, chars: usize) -> AppResult<()> {
    store(conn, book_id, idx, "", chars, "")
}

/// Replaces one chapter's summary.
pub fn store(
    conn: &Connection,
    book_id: &str,
    idx: usize,
    summary: &str,
    chars: usize,
    model: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO chapter_summaries (book_id, idx, summary, chars, model, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT (book_id, idx) DO UPDATE SET summary = excluded.summary, \
                                                  chars = excluded.chars, \
                                                  model = excluded.model, \
                                                  created_at = excluded.created_at",
        params![book_id, idx as i64, summary, chars as i64, model, crate::library::now_seconds()],
    )?;
    Ok(())
}

/// What a build would do to the chapters up to `upto`.
///
/// Split in two because they are different states for the reader: a chapter
/// waiting for a summary is one the build will fill, while a cover page will
/// never have one. Telling them apart is what lets the button reach 已补齐
/// instead of offering to fill a page that is a picture.
pub struct Plan {
    /// `(idx, text, chars)` — chapters to summarise.
    pub jobs: Vec<(usize, String, usize)>,
    /// `(idx, chars)` — chapters with nothing to summarise.
    pub textless: Vec<(usize, usize)>,
}

/// Works out which chapters still need a summary.
pub fn plan(conn: &Connection, book_id: &str, upto: usize) -> AppResult<Plan> {
    let mut stmt = conn.prepare(
        "SELECT c.idx, c.content, s.summary \
           FROM chapters c \
           LEFT JOIN chapter_summaries s \
             ON s.book_id = c.book_id AND s.idx = c.idx AND s.chars = c.chars \
          WHERE c.book_id = ?1 AND c.idx <= ?2 AND trim(c.content) <> '' \
          ORDER BY c.idx",
    )?;
    let rows = stmt.query_map(params![book_id, upto as i64], |row| {
        Ok((
            row.get::<_, i64>(0)? as usize,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;

    let mut out = Plan { jobs: Vec::new(), textless: Vec::new() };
    for row in rows {
        let (idx, content, existing) = row?;
        // A refusal is not a summary: it is the model telling the prompt that
        // there was nothing to work with. Treating it as done would leave the
        // panel looking finished while saying nothing — and putting it back in
        // the queue is also how a book summarised before this check repairs
        // itself on the next build.
        // Any row with a matching length means this chapter has been dealt
        // with: either summarised, or recorded as having nothing to summarise
        // (an empty summary with a timestamp). The one exception is a stored
        // refusal, which is not a summary at all.
        let done = existing.is_some_and(|text| !looks_like_refusal(&text));
        if done {
            continue;
        }
        let chars = content.chars().count();
        if summarisable(&content) {
            out.jobs.push((idx, content, chars));
        } else {
            out.textless.push((idx, chars));
        }
    }
    Ok(out)
}

/// How many characters of actual text a chapter has.
///
/// The extractor marks an embedded image with U+FFFC followed by its path, and
/// front matter is mostly those: a cover page is eleven characters, all of them
/// the marker and a filename. HTML tags and whitespace go for the same reason —
/// neither is something a summary can be written from.
fn text_weight(text: &str) -> usize {
    let mut weight = 0;
    let mut in_tag = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            // U+FFFC is an object replacement character: the image itself.
            '\u{FFFC}' => {
                while chars.peek().is_some_and(|next| !next.is_whitespace()) {
                    chars.next();
                }
            }
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if in_tag => {}
            _ if ch.is_alphanumeric() => weight += 1,
            _ => {}
        }
    }
    weight
}

/// Whether a chapter has enough prose to be worth a model call.
pub fn summarisable(text: &str) -> bool {
    text_weight(text) >= MIN_TEXT_CHARS
}

/// Whether an answer is the model talking about the errand instead of the book.
pub fn looks_like_refusal(text: &str) -> bool {
    REFUSAL_MARKERS.iter().any(|marker| text.contains(marker))
}

/// The text handed to the model for one chapter.
///
/// Whole for a normal chapter. Above [`EXCERPT_CHARS`] the opening and the
/// ending are kept and the middle is dropped, with a line saying so: a chapter
/// opens by setting something up and ends by landing it, while the middle is
/// where a 300k-character "chapter" repeats itself. Sending the opening alone —
/// what a plain truncation does — produces a summary of a chapter that stopped
/// halfway, and the model has no way to know it did.
pub fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    let total = trimmed.chars().count();
    if total <= EXCERPT_CHARS {
        return trimmed.to_string();
    }
    let head_chars = EXCERPT_CHARS * 3 / 5;
    let tail_chars = EXCERPT_CHARS - head_chars;
    let head: String = trimmed.chars().take(head_chars).collect();
    let tail: String = trimmed.chars().skip(total - tail_chars).collect();
    format!("{head}\n\n（……中间省略 {} 字……）\n\n{tail}", total - head_chars - tail_chars)
}

/// Writes a summary for every chapter up to `upto` that does not have one.
pub async fn build(
    library: &Library,
    client: &reqwest::Client,
    config: &AiConfig,
    book_id: &str,
    upto: usize,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> AppResult<SummaryBuildReport> {
    if !crate::ai::is_ready(config) {
        return Err(AppError::InvalidArgument(
            "还没有配置 AI 模型，先到设置里填写接口地址与模型名称".into(),
        ));
    }
    // Chapter bodies are extracted lazily; a summary of a chapter that has not
    // been parsed yet would be a summary of nothing.
    crate::library::chapters::ensure_text(library, book_id)?;

    let work = library.with(|conn| plan(conn, book_id, upto))?;

    // Chapters that are a cover page or a copyright notice are recorded as such
    // once, so the button can reach 已补齐 and the panel can say why the row is
    // empty. Marking them is cheap and idempotent; leaving them out of `jobs`
    // alone would keep them looking like work that never gets done.
    if !work.textless.is_empty() {
        library.with(|conn| {
            for (idx, chars) in &work.textless {
                mark_textless(conn, book_id, *idx, *chars)?;
            }
            Ok(())
        })?;
    }

    let jobs = work.jobs;
    let total = jobs.len();
    if total == 0 {
        return Ok(SummaryBuildReport { written: 0, skipped: 0, total: 0 });
    }

    let mut stream = futures_util::stream::iter(jobs)
        .map(|(idx, content, chars)| async move {
            (idx, chars, summarise(client, config, &content).await)
        })
        .buffer_unordered(CONCURRENCY);

    let mut written = 0usize;
    let mut skipped = 0usize;
    let mut last_error: Option<AppError> = None;
    let mut done = 0usize;
    while let Some((idx, chars, result)) = stream.next().await {
        match result {
            Ok(summary) => {
                // One bad row must not throw away the chapters already written,
                // which is exactly what a `?` here would do.
                if let Err(err) =
                    library.with(|conn| store(conn, book_id, idx, &summary, chars, &config.model))
                {
                    skipped += 1;
                    tracing::warn!(idx, error = %err, "这一章的摘要没写进库");
                    last_error = Some(err);
                } else {
                    written += 1;
                }
            }
            Err(err) => {
                skipped += 1;
                tracing::warn!(idx, error = %err, "这一章的摘要没写出来，跳过");
                last_error = Some(err);
            }
        }
        done += 1;
        on_progress(done, total);
    }

    // Nothing came back at all: the endpoint is wrong, the key is wrong, or the
    // model refuses. Reporting "0 written" as success would leave the panel
    // looking empty with no explanation.
    if written == 0 {
        return Err(last_error.unwrap_or_else(|| AppError::Message("没有可摘要的章节".into())));
    }
    tracing::info!(book_id, written, skipped, total, "章节摘要已补齐");
    Ok(SummaryBuildReport { written, skipped, total })
}

/// One chapter, summarised.
async fn summarise(
    client: &reqwest::Client,
    config: &AiConfig,
    content: &str,
) -> AppResult<String> {
    let body = format!("{}\n\n正文：\n{}", PROMPT, excerpt(content));
    let mut text = String::new();
    chat::stream_chat(
        client,
        config,
        vec![ChatMessage::new(Role::User, body)],
        None,
        &mut |event| {
            if let StreamEvent::Delta(delta) = event {
                text.push_str(&delta);
            }
            true
        },
    )
    .await?;

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Message("模型没有返回摘要".into()));
    }
    // An answer that talks about the errand is not a summary, and storing it
    // would put a paragraph of the model complaining into the reader's chapter
    // list — which is exactly what this check exists to prevent.
    if looks_like_refusal(&trimmed) {
        return Err(AppError::Message(
            "模型返回的是对任务的回应，不是摘要；换一个更擅长按指令写作的模型可以补上".into(),
        ));
    }
    Ok(trimmed)
}

/// The cached summaries up to `upto`, as the material for a recap.
///
/// Sampled rather than truncated when it is long: a recap built from the first
/// 14k characters of a 400-chapter book describes the opening and nothing else,
/// which is precisely not where the reader is.
pub fn recap_material(conn: &Connection, book_id: &str, upto: usize) -> AppResult<String> {
    let rows: Vec<(usize, String, String)> = conn
        .prepare(
            "SELECT c.idx, c.title, s.summary \
               FROM chapters c \
               JOIN chapter_summaries s ON s.book_id = c.book_id AND s.idx = c.idx \
              WHERE c.book_id = ?1 AND c.idx <= ?2 AND s.chars = c.chars AND s.summary <> '' \
              ORDER BY c.idx",
        )?
        .query_map(params![book_id, upto as i64], |row| {
            Ok((row.get::<_, i64>(0)? as usize, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // A recap is only as good as what it is built from. A stored refusal would
    // have the model summarising the model.
    let rows: Vec<(usize, String, String)> =
        rows.into_iter().filter(|(_, _, summary)| !looks_like_refusal(summary)).collect();

    if rows.is_empty() {
        return Err(AppError::InvalidArgument("前面几章还没有摘要，先补齐再生成提要".into()));
    }

    let picked = pick_evenly(&rows, RECAP_CHARS);
    let picked_len = picked.len();
    let mut out = String::new();
    for (idx, title, summary) in picked {
        out.push_str(&format!("第 {} 章 {title}：{summary}\n", idx + 1));
    }
    if picked_len < rows.len() {
        out.push_str(&format!(
            "（共 {} 章有摘要，上面是按比例抽取的 {picked_len} 章。）\n",
            rows.len()
        ));
    }
    Ok(out)
}

/// An even spread of rows that fits in `budget` characters.
///
/// Keeps the first and the last, so the recap covers from where the book began
/// to where the reader stands.
fn pick_evenly(rows: &[(usize, String, String)], budget: usize) -> Vec<&(usize, String, String)> {
    let cost = |row: &(usize, String, String)| row.1.chars().count() + row.2.chars().count() + 8;
    let total: usize = rows.iter().map(cost).sum();
    if total <= budget {
        return rows.iter().collect();
    }

    // How many fit, then an even spread of that many.
    let average = (total / rows.len()).max(1);
    let want = (budget / average).clamp(2, rows.len());
    if want >= rows.len() {
        return rows.iter().collect();
    }
    (0..want)
        .map(|slot| slot * (rows.len() - 1) / (want - 1))
        .map(|position| &rows[position])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::test_support::{Harness, answer, direct_client, mock_chat};
    use crate::db::migrations;

    fn seeded() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'txt', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("book");
        conn
    }

    /// Enough prose to clear `MIN_TEXT_CHARS`, so a fixture is a chapter a
    /// summary would actually be written for.
    fn prose() -> String {
        "林昭走进大殿，看见玄清道人正坐在蒲团上，殿外的雨还没有停。".repeat(12)
    }

    fn add_chapter(conn: &Connection, idx: i64, title: &str, content: &str) -> usize {
        conn.execute(
            "INSERT INTO chapters (book_id, idx, title, content, chars) VALUES ('b', ?1, ?2, ?3, ?4)",
            params![idx, title, content, content.chars().count() as i64],
        )
        .expect("chapter");
        content.chars().count()
    }

    #[test]
    fn a_summary_round_trips() {
        let conn = seeded();
        let chars = add_chapter(&conn, 0, "第一章", "林昭走进大殿。");

        store(&conn, "b", 0, "林昭进了大殿。", chars, "m").expect("store");
        let list = list(&conn, "b", 0).expect("list");

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].idx, 0);
        assert_eq!(list[0].title, "第一章");
        assert_eq!(list[0].summary, "林昭进了大殿。");
        assert!(list[0].created_at > 0);
    }

    #[test]
    fn writing_again_replaces_rather_than_duplicates() {
        let conn = seeded();
        let chars = add_chapter(&conn, 0, "第一章", "林昭走进大殿。");

        store(&conn, "b", 0, "旧", chars, "m").expect("first");
        store(&conn, "b", 0, "新", chars, "m").expect("second");

        let list = list(&conn, "b", 0).expect("list");
        assert_eq!(list.len(), 1, "同一章只能有一行");
        assert_eq!(list[0].summary, "新");
    }

    #[test]
    fn a_chapter_whose_length_changed_reads_as_unsummarised() {
        // Re-extracting a chapter replaces its text. The old summary describes
        // something that is no longer there, and serving it is worse than
        // showing nothing.
        let conn = seeded();
        let chars = add_chapter(&conn, 0, "第一章", &prose());
        store(&conn, "b", 0, "摘要", chars, "m").expect("store");

        conn.execute("UPDATE chapters SET chars = 99 WHERE idx = 0", []).expect("update");
        let list = list(&conn, "b", 0).expect("list");
        assert_eq!(list[0].summary, "", "长度变了就当没写过");

        let work = plan(&conn, "b", 0).expect("plan");
        assert_eq!(work.jobs.len(), 1, "并且要重新排队");
    }

    #[test]
    fn the_list_stops_at_the_reader_position() {
        let conn = seeded();
        for idx in 0..5 {
            add_chapter(&conn, idx, &format!("第 {} 章", idx + 1), "正文正文");
        }

        let list = list(&conn, "b", 2).expect("list");
        assert_eq!(list.iter().map(|row| row.idx).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn an_empty_chapter_is_never_queued() {
        // A model asked about an empty string invents something.
        let conn = seeded();
        add_chapter(&conn, 0, "第一章", &"正".repeat(200));
        add_chapter(&conn, 1, "第二章", "   ");

        let work = plan(&conn, "b", 1).expect("plan");
        assert_eq!(work.jobs.len(), 1, "空白章节不该进队列：{:?}", work.jobs);
    }

    #[test]
    fn front_matter_is_not_queued_and_is_recorded_instead() {
        // The exact shapes a real EPUB produces: a cover is an image marker and
        // a filename, a title page is the title and the authors, a copyright
        // page is a hundred characters of boilerplate.
        let conn = seeded();
        add_chapter(&conn, 0, "第 1 章", "\u{FFFC}cover.jpeg");
        add_chapter(&conn, 1, "第 2 章", "\u{FFFC}images/00052.jpeg");
        add_chapter(&conn, 2, "第 3 章", "人生设计课：如何设计充实且快乐的人生\n（美）比尔·博内特");
        add_chapter(&conn, 3, "再版序言", &"我们在写这本书的时候有一个简单的心愿。".repeat(30));

        let work = plan(&conn, "b", 3).expect("plan");
        assert_eq!(work.jobs.len(), 1, "只有真正的正文该进队列：{:?}", work.jobs);
        assert_eq!(work.textless.iter().map(|(idx, _)| *idx).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn a_stored_refusal_is_hidden_and_requeued() {
        // What a book summarised before the input guard looks like: four rows
        // of the model explaining that there was nothing to summarise. Hiding
        // them and putting them back in the queue is how such a book repairs
        // itself on the next build.
        let conn = seeded();
        let prose = "林昭走进大殿，看见玄清道人正坐在蒲团上。".repeat(20);
        let chars = add_chapter(&conn, 0, "第一章", &prose);
        store(
            &conn,
            "b",
            0,
            "抱歉，这条消息里的「正文」只有一处图片占位符（cover.jpeg），并没有可供阅读的章节文字。",
            chars,
            "m",
        )
        .expect("store");

        let list = list(&conn, "b", 0).expect("list");
        assert_eq!(list[0].summary, "", "读者不该看见模型的推辞");
        assert_eq!(list[0].created_at, 0, "也不该显示成已生成");

        let work = plan(&conn, "b", 0).expect("plan");
        assert_eq!(work.jobs.len(), 1, "推辞要重新排队");
    }

    #[test]
    fn a_textless_marker_is_neither_requeued_nor_read_as_a_summary() {
        let conn = seeded();
        let chars = add_chapter(&conn, 0, "第 1 章", "\u{FFFC}cover.jpeg");
        mark_textless(&conn, "b", 0, chars).expect("mark");

        let work = plan(&conn, "b", 0).expect("plan");
        assert!(work.jobs.is_empty(), "标记过的章不该再排队：{:?}", work.jobs);
        assert!(work.textless.is_empty(), "也不该重复标记");

        // The panel tells the two empty states apart by the timestamp.
        let list = list(&conn, "b", 0).expect("list");
        assert_eq!(list[0].summary, "");
        assert!(list[0].created_at > 0, "有行=没有正文；没有行=还没生成");
        // And it says how short the chapter is, which is the difference between
        // "this is a cover" and "something went wrong".
        assert_eq!(list[0].chars, "\u{FFFC}cover.jpeg".chars().count());
    }

    #[test]
    fn a_cover_page_is_not_prose() {
        // The exact strings a real EPUB extracts, measured from the library:
        // eleven and eighteen characters, both of them an image marker.
        assert!(!summarisable("\u{FFFC}cover.jpeg"));
        assert!(!summarisable("\u{FFFC}images/00052.jpeg"));
        assert!(!summarisable("人生设计课：如何设计充实且快乐的人生\n（美）比尔·博内特"));
        // A hundred characters of copyright boilerplate: long, and still not a
        // chapter.
        assert!(!summarisable(
            "版权信息 书名：人生设计课 作者：（美）比尔·博内特;（美）戴夫·伊万斯 译者：周芳芳 出版社：中信出版社 出版时间：2018 年 ISBN：9787508687356"
        ));
    }

    #[test]
    fn real_prose_clears_the_floor() {
        assert!(summarisable(&"林昭走进大殿，看见玄清道人正坐在蒲团上。".repeat(10)));
        assert!(summarisable(&"word ".repeat(50)));
    }

    #[test]
    fn an_image_marker_does_not_count_as_text() {
        // The marker is one character, but the filename behind it is not: a
        // chapter of twenty images would otherwise read as prose.
        let gallery =
            "\u{FFFC}images/00001.jpeg \u{FFFC}images/00002.jpeg \u{FFFC}images/00003.jpeg";
        assert_eq!(text_weight(gallery), 0, "{gallery}");
    }

    #[test]
    fn a_refusal_is_recognised_by_the_words_it_addresses_the_prompt_with() {
        // The four answers a real book produced, verbatim.
        for answer in [
            "抱歉，这条消息里的「正文」只有一处图片占位符（cover.jpeg），并没有可供阅读的章节文字，因此我无法依据正文写出摘要。请把该章的文本内容粘贴过来（或提供可读取的文本），我再按你的要求写 2 到 4 句摘要。",
            "无法完成摘要：你提供的「正文」只有一个图片引用 images/00052.jpeg，没有可用于阅读的文本内容。",
            "你只给了书名和作者，没有这一章的正文，因此无法按摘要要求写出只依据正文、不推测的摘要。请粘贴出该章正文。",
            "给出的正文只有版权信息（书名《人生设计课：如何设计充实且快乐的人生》、作者、译者、出版社、出版时间、ISBN），没有章节内容，无法在不推测、不补充的前提下概括这一章发生了什么。",
        ] {
            assert!(looks_like_refusal(answer), "没认出来：{answer}");
        }
    }

    #[test]
    fn a_summary_that_happens_to_say_cannot_is_not_a_refusal() {
        // The reason `无法` alone is not a marker: a novel is full of it.
        for summary in [
            "林昭无法回头，只能继续往殿里走。",
            "他无法完成师父交代的事，独自在山门前站了一夜。",
            "苏晚把信烧了，没有提供任何解释。",
        ] {
            assert!(!looks_like_refusal(summary), "误判：{summary}");
        }
    }

    #[test]
    fn a_short_chapter_travels_whole() {
        assert_eq!(excerpt("  林昭走进大殿。 "), "林昭走进大殿。");
    }

    #[test]
    fn a_long_chapter_keeps_its_opening_and_its_ending() {
        let text: String = (0..EXCERPT_CHARS * 2).map(|_| '正').collect();
        let cut = excerpt(&text);

        assert!(cut.chars().count() < text.chars().count(), "必须压缩");
        assert!(cut.contains("中间省略"), "必须说明省略了多少：{cut}");
        // Head and tail, not a truncation: the ending is where a chapter lands
        // its beat, and a summary that never sees it describes a chapter that
        // stopped halfway.
        assert!(cut.starts_with('正'), "开头要保留");
        assert!(cut.ends_with('正'), "结尾要保留");
    }

    #[test]
    fn only_chapters_without_a_summary_are_sent_to_the_model() {
        // Every chapter is a model call. A panel opened twice must cost what it
        // cost the first time, or the feature is a tax on rereading.
        let harness = Harness::new("summary-build");
        harness.add_chapter(0, "第一章", &prose());
        harness.add_chapter(1, "第二章", &prose());
        let chars = prose().chars().count();
        harness.library.with(|conn| store(conn, "b", 0, "已有的摘要", chars, "m")).expect("seed");

        let mock = mock_chat(vec![answer("新的摘要")]);
        let config = AiConfig { base_url: mock.base_url.clone(), ..AiConfig::default() };
        let client = direct_client();
        let report = tauri::async_runtime::block_on(build(
            &harness.library,
            &client,
            &config,
            "b",
            1,
            &|_, _| {},
        ))
        .expect("build");

        assert_eq!(report.total, 1, "已有摘要的章不该重发：{report:?}");
        assert_eq!(report.written, 1);
        assert_eq!(mock.count(), 1);

        let list = harness.library.with(|conn| list(conn, "b", 1)).expect("list");
        assert_eq!(list[0].summary, "已有的摘要", "旧摘要不该被覆盖");
        assert_eq!(list[1].summary, "新的摘要");
    }

    #[test]
    fn a_model_that_says_nothing_is_an_error_not_an_empty_panel() {
        // Reporting "0 written" as success would leave the panel looking empty
        // with no explanation of why.
        let harness = Harness::new("summary-empty");
        harness.add_chapter(0, "第一章", &prose());

        let mock = mock_chat(vec![answer("")]);
        let config = AiConfig { base_url: mock.base_url.clone(), ..AiConfig::default() };
        let client = direct_client();
        let error = tauri::async_runtime::block_on(build(
            &harness.library,
            &client,
            &config,
            "b",
            0,
            &|_, _| {},
        ))
        .expect_err("应当失败");

        assert!(error.to_string().contains("没有返回摘要"), "{error}");
    }

    #[test]
    fn a_recap_needs_summaries_to_build_from() {
        let conn = seeded();
        add_chapter(&conn, 0, "第一章", "正文");

        let error = recap_material(&conn, "b", 0).expect_err("应当失败");
        assert!(error.to_string().contains("先补齐"), "{error}");
    }

    #[test]
    fn a_recap_is_ordered_and_stops_at_the_reader_position() {
        let conn = seeded();
        for idx in 0..4 {
            add_chapter(&conn, idx, &format!("第 {} 章", idx + 1), "正文");
            store(&conn, "b", idx as usize, &format!("摘要{idx}"), 2, "m").expect("store");
        }

        let material = recap_material(&conn, "b", 1).expect("material");
        assert!(material.contains("第 1 章 第 1 章：摘要0"), "{material}");
        assert!(material.contains("第 2 章 第 2 章：摘要1"), "{material}");
        assert!(!material.contains("摘要2"), "读者还没读到的章不能进提要：{material}");
    }

    #[test]
    fn a_long_recap_is_sampled_from_end_to_end() {
        let rows: Vec<(usize, String, String)> =
            (0..200).map(|idx| (idx, format!("标题{idx}"), "摘".repeat(300))).collect();

        let picked = pick_evenly(&rows, RECAP_CHARS);
        assert!(picked.len() < rows.len(), "必须抽样");
        assert_eq!(picked.first().map(|row| row.0), Some(0), "开头必须在");
        assert_eq!(picked.last().map(|row| row.0), Some(199), "读者所在的位置必须在");

        let chars: usize =
            picked.iter().map(|row| row.1.chars().count() + row.2.chars().count()).sum();
        assert!(chars < RECAP_CHARS + 600, "抽样后仍超预算：{chars}");
    }

    #[test]
    fn a_short_recap_keeps_every_chapter() {
        let rows: Vec<(usize, String, String)> =
            (0..5).map(|idx| (idx, format!("标题{idx}"), "摘要".into())).collect();
        assert_eq!(pick_evenly(&rows, RECAP_CHARS).len(), 5);
    }
}
