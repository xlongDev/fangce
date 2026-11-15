//! AI 笔记草稿：给「划了线但没写笔记」的标注补一句草稿。
//!
//! 模型只出**建议**。写库要读者在预览里逐条确认，应用走 `annotations::set_note`
//! + `ops::record_details` —— 与手写笔记同一条路径，这里没有第二套写入口。
//!
//! 三个边界是刻意的：
//!
//! - **只碰 `note` 为空的标注。** 读者自己写过的话一条都不覆盖；`apply` 在写之前
//!   会再查一次，防止预览打开的这几分钟里他自己补了笔记。
//! - **一轮最多 [`RUN_LIMIT`] 条、每批 [`BATCH`] 条。** 一批回答坏掉不带走整轮。
//! - **模型给的 id 必须在这批里。** 否则它是在给不存在的划线写笔记。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::ai::AiConfig;
use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};
use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::annotations::{self, Annotation};
use crate::library::ops;

/// 每批送进提示词的划线。
pub const BATCH: usize = 20;
/// 一轮最多处理的划线。
pub const RUN_LIMIT: usize = 60;
/// 单条划线进提示词的字数。
const QUOTE_CHARS: usize = 400;
/// 一条草稿最长字符数（超了截断，不是丢掉）。
const NOTE_CHARS: usize = 120;

pub const PROMPT: &str = "\
下面是一位读者在书里划下的句子，每条前面有一串 id 和划线原文。请为每条写一句简短的中文笔记草稿，\
帮他记下这句话值得回头看的地方：可以点出句子在说什么，或者一个值得再想的问题。\
只依据给出的原文，不推测书里没写的情节，不评价书的好坏，不替读者发表观点，\
不要用「这句话说明」之类的模板开头。每条不超过 60 个字。确实看不出可写的，跳过那条。

只输出一个 JSON 数组，不要代码块，不要解释，不要开场白；即使只有一条划线，也必须是数组。\
每一项形如 {\"id\":\"<把该条前面的 id 原样抄过来，不要写成序号>\",\"note\":\"<一句话草稿>\"}。";

/// 一条建议，带着划线原文是为了预览里不用再查一次库。
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNoteSuggestion {
    pub annotation_id: String,
    pub book_id: String,
    pub quote: String,
    pub note: String,
}

/// 读者确认之后要写进去的一行。
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNoteDraft {
    pub annotation_id: String,
    pub book_id: String,
    pub note: String,
}

/// The highlights among `ids` that carry no note yet.
///
/// A stale id is not an error: the reader may have deleted the highlight in
/// another window between selecting and pressing the button.
pub fn without_note(conn: &Connection, ids: &[String]) -> AppResult<Vec<Annotation>> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(row) = annotations::get(conn, id)?
            && row.note.is_none()
        {
            out.push(row);
        }
    }
    Ok(out)
}

fn quote_of(row: &Annotation) -> String {
    let text = row.text.trim();
    let mut short: String = text.chars().take(QUOTE_CHARS).collect();
    if text.chars().count() > QUOTE_CHARS {
        short.push('…');
    }
    short
}

pub fn prompt_for(rows: &[Annotation]) -> String {
    let mut out = String::from(PROMPT);
    out.push_str("\n\n--- 划线 ---\n");
    for (index, row) in rows.iter().enumerate() {
        out.push_str(&format!("\n{}. id={} 第{}章\n", index + 1, row.id, row.chapter_idx + 1));
        out.push_str(&format!("   原文：{}\n", quote_of(row)));
    }
    out
}

/// What one model answer is allowed to become: a trust boundary, not a
/// formality. A single highlight in particular makes models answer with a bare
/// object instead of the array we asked for, or write the row's ordinal ("1")
/// in place of its id. Both are still the same suggestion; a model naming a
/// highlight outside this batch is not.
pub fn parse(text: &str, rows: &[Annotation]) -> Vec<AiNoteSuggestion> {
    let raw = raw_drafts(text);
    let mut out: Vec<AiNoteSuggestion> = Vec::new();
    for item in &raw {
        let Some(row) = match_row(&item.id, rows) else { continue };
        if out.iter().any(|seen| seen.annotation_id == row.id) {
            continue;
        }
        let note = clean_note(&item.note);
        if note.is_empty() {
            continue;
        }
        out.push(AiNoteSuggestion {
            annotation_id: row.id.clone(),
            book_id: row.book_id.clone(),
            quote: quote_of(row),
            note,
        });
    }
    // With exactly one row there is nothing to disambiguate: an answer that
    // carries a usable sentence but lost the id is still that row's draft.
    // A prose answer without any JSON never reaches here, so this cannot turn
    // an apology or a preamble into a note.
    if out.is_empty()
        && rows.len() == 1
        && let Some(note) =
            raw.iter().map(|item| clean_note(&item.note)).find(|note| !note.is_empty())
    {
        let row = &rows[0];
        out.push(AiNoteSuggestion {
            annotation_id: row.id.clone(),
            book_id: row.book_id.clone(),
            quote: quote_of(row),
            note,
        });
    }
    out
}

/// An array (possibly inside `{"notes":[…]}` or a code fence) or a lone object
/// are the shapes models actually answer with. Everything outside the outermost
/// pair of brackets/braces — a fence, an apology, a trailing remark — is dropped.
fn raw_drafts(text: &str) -> Vec<RawDraft> {
    if let (Some(start), Some(end)) = (text.find('['), text.rfind(']'))
        && end > start
        && let Ok(list) = serde_json::from_str::<Vec<RawDraft>>(&text[start..=end])
    {
        return list;
    }
    let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    serde_json::from_str::<RawDraft>(&text[start..=end]).map(|one| vec![one]).unwrap_or_default()
}

fn match_row<'a>(id: &str, rows: &'a [Annotation]) -> Option<&'a Annotation> {
    if let Some(row) = rows.iter().find(|row| row.id == id) {
        return Some(row);
    }
    // 「编号」in the prompt reads as the row's ordinal to many models.
    let ordinal = id.trim().parse::<usize>().ok()?;
    rows.get(ordinal.checked_sub(1)?)
}

#[derive(Deserialize)]
struct RawDraft {
    #[serde(default)]
    id: String,
    #[serde(default, alias = "draft", alias = "content")]
    note: String,
}

fn clean_note(note: &str) -> String {
    let note = note.trim();
    if note.chars().count() > NOTE_CHARS {
        return note.chars().take(NOTE_CHARS).collect();
    }
    note.to_string()
}

/// One batch of highlights, one model call.
pub async fn suggest(
    client: &reqwest::Client,
    config: &AiConfig,
    rows: &[Annotation],
) -> AppResult<Vec<AiNoteSuggestion>> {
    let mut text = String::new();
    chat::stream_chat(
        client,
        config,
        vec![ChatMessage::new(Role::User, prompt_for(rows))],
        None,
        &mut |event| {
            if let StreamEvent::Delta(delta) = event {
                text.push_str(&delta);
            }
            true
        },
    )
    .await?;

    if text.trim().is_empty() {
        return Err(AppError::Message("模型没有返回笔记".into()));
    }
    if crate::library::summary::looks_like_refusal(&text) {
        return Err(AppError::Message(
            "模型回答的不是笔记，换一个更擅长照格式输出的模型再试".into(),
        ));
    }
    let found = parse(&text, rows);
    if found.is_empty() {
        return Err(AppError::Message("模型没有按划线的格式回答，换一个模型或再试一次".into()));
    }
    Ok(found)
}

/// Writes what the reader kept, and records the run.
///
/// One transaction: a half-applied batch that still logged success is the one
/// outcome that must not exist. The log line carries the annotation id, which
/// is what 撤销 needs — `before_fields` only knows about the books table.
pub fn apply(library: &Library, items: &[AiNoteDraft]) -> AppResult<usize> {
    let wanted: Vec<&AiNoteDraft> =
        items.iter().filter(|item| !item.note.trim().is_empty()).collect();
    if wanted.is_empty() {
        return Ok(0);
    }
    library.with_tx(|tx| {
        let mut kept: Vec<&AiNoteDraft> = Vec::new();
        for item in &wanted {
            // The reader may have written a note while the preview was open.
            match annotations::get(tx, &item.annotation_id)? {
                Some(row) if row.note.is_none() => {}
                _ => continue,
            }
            annotations::set_note(tx, &item.annotation_id, Some(&item.note))?;
            kept.push(*item);
        }
        let summary = format!("AI 建议的笔记：{} 条", kept.len());
        let rows: Vec<(String, serde_json::Value)> = kept
            .iter()
            .map(|item| (item.book_id.clone(), ops::added_note_detail(&item.annotation_id)))
            .collect();
        ops::record_details(tx, ops::Source::Ai, ops::ADDED_NOTES_ACTION, &summary, &rows)?;
        Ok(kept.len())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn seeded() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
             file_size, added_at, updated_at) VALUES ('b1', '三体', '三体', 'txt', 'h1', 'p1', 1, 1, 1)",
            [],
        )
        .expect("book");
        conn.execute(
            "INSERT INTO annotations (id, book_id, chapter_idx, start_char, end_char, text, created_at) \
             VALUES ('a1', 'b1', 0, 0, 6, '给岁月以文明', 1)",
            [],
        )
        .expect("a1");
        conn.execute(
            "INSERT INTO annotations (id, book_id, chapter_idx, start_char, end_char, text, created_at) \
             VALUES ('a2', 'b1', 1, 0, 6, '给文明以岁月', 2)",
            [],
        )
        .expect("a2");
        conn
    }

    fn row(conn: &Connection, id: &str) -> Annotation {
        annotations::get(conn, id).expect("get").expect("row")
    }

    #[test]
    fn a_fenced_array_with_chatter_around_it_still_parses() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let text = "好的：\n```json\n[{\"id\":\"a1\",\"note\":\"文明先于岁月\"}]\n```\n希望有用。";
        let found = parse(text, &rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].note, "文明先于岁月");
        assert_eq!(found[0].quote, "给岁月以文明");
    }

    #[test]
    fn an_id_outside_the_batch_is_dropped() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let text = "[{\"id\":\"gone\",\"note\":\"不存在\"},{\"id\":\"a1\",\"note\":\"真的\"}]";
        let found = parse(text, &rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].annotation_id, "a1");
    }

    #[test]
    fn a_blank_or_duplicate_note_is_dropped_and_a_long_one_is_capped() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let long = "啊".repeat(NOTE_CHARS + 20);
        let text =
            format!("[{{\"id\":\"a1\",\"note\":\"   \"}},{{\"id\":\"a1\",\"note\":\"{long}\"}}]");
        let found = parse(&text, &rows);
        assert_eq!(found.len(), 1, "空笔记先被丢掉，重复的那条也随之跳过");
        assert_eq!(found[0].note.chars().count(), NOTE_CHARS);
    }

    #[test]
    fn the_prompt_carries_the_id_and_the_quote() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let prompt = prompt_for(&rows);
        assert!(prompt.contains("id=a1"));
        assert!(prompt.contains("给岁月以文明"));
        assert!(prompt.contains("即使只有一条划线，也必须是数组"));
    }

    /** A single highlight is exactly when models answer with a bare object. */
    #[test]
    fn a_lone_object_is_still_one_suggestion() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let found = parse("{\"id\":\"a1\",\"note\":\"值得回头看\"}", &rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].note, "值得回头看");
    }

    #[test]
    fn an_ordinal_in_place_of_the_id_is_resolved() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1"), row(&conn, "a2")];
        let found = parse("[{\"id\":\"2\",\"note\":\"第二条\"}]", &rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].annotation_id, "a2");
    }

    #[test]
    fn a_wrapped_array_and_a_note_alias_are_accepted() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let found =
            parse("```json\n{\"notes\":[{\"id\":\"a1\",\"draft\":\"包了一层\"}]}\n```", &rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].note, "包了一层");
    }

    #[test]
    fn one_row_keeps_a_draft_whose_id_was_lost() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        let found = parse("[{\"id\":\"随便写的\",\"note\":\"只有这一条\"}]", &rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].annotation_id, "a1");
    }

    /** Being lenient about shape must not turn an apology into a note. */
    #[test]
    fn prose_without_json_is_still_nothing() {
        let conn = seeded();
        let rows = vec![row(&conn, "a1")];
        assert!(parse("好的，我帮你写一句笔记：这句话值得回头看。", &rows).is_empty());
    }

    #[test]
    fn only_highlights_without_a_note_are_offered() {
        let conn = seeded();
        annotations::set_note(&conn, "a2", Some("我自己的话")).expect("note");
        let ids = vec!["a1".to_string(), "a2".to_string(), "gone".to_string()];
        let found = without_note(&conn, &ids).expect("without_note");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "a1");
    }

    struct Store {
        dir: std::path::PathBuf,
        library: Library,
    }

    impl Store {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let library = Library::open(&dir).expect("open library");
            library
                .with(|conn| {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, \
                         file_path, file_size, added_at, updated_at) \
                         VALUES ('b1', '三体', '三体', 'txt', 'h1', 'p1', 1, 1, 1)",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO annotations (id, book_id, chapter_idx, start_char, \
                         end_char, text, created_at) VALUES ('a1', 'b1', 0, 0, 6, '给岁月以文明', 1)",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO annotations (id, book_id, chapter_idx, start_char, \
                         end_char, text, created_at) VALUES ('a2', 'b1', 1, 0, 6, '给文明以岁月', 2)",
                        [],
                    )?;
                    annotations::set_note(conn, "a2", Some("我自己的话"))?;
                    Ok(())
                })
                .expect("seed");
            Self { dir, library }
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn applying_writes_the_note_and_one_ai_log_line_that_undoes() {
        let store = Store::new("note-draft-apply");
        let written = apply(
            &store.library,
            &[AiNoteDraft {
                annotation_id: "a1".into(),
                book_id: "b1".into(),
                note: "值得回头想".into(),
            }],
        )
        .expect("apply");
        assert_eq!(written, 1);

        let note = store.library.with(|conn| annotations::get(conn, "a1")).expect("get");
        assert_eq!(note.expect("row").note.as_deref(), Some("值得回头想"));

        let rows = store.library.with(|conn| ops::list(conn, 10)).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "ai");
        assert_eq!(rows[0].action, ops::ADDED_NOTES_ACTION);
        assert!(rows[0].undoable, "带 annotationId 的行应该可以撤销");

        let call_id = rows[0].call_id.clone();
        store.library.with_tx(|tx| ops::undo(tx, &call_id, &store.dir)).expect("undo");
        let cleared = store.library.with(|conn| annotations::get(conn, "a1")).expect("get");
        assert_eq!(cleared.expect("row").note, None, "撤销把草稿清掉");
        let kept = store.library.with(|conn| annotations::get(conn, "a2")).expect("get");
        assert_eq!(kept.expect("row").note.as_deref(), Some("我自己的话"), "读者自己的话没动");
    }

    #[test]
    fn applying_never_overwrites_a_note_the_reader_wrote() {
        let store = Store::new("note-draft-no-overwrite");
        let written = apply(
            &store.library,
            &[AiNoteDraft {
                annotation_id: "a2".into(),
                book_id: "b1".into(),
                note: "模型的猜测".into(),
            }],
        )
        .expect("apply");
        assert_eq!(written, 0);
        let note = store.library.with(|conn| annotations::get(conn, "a2")).expect("get");
        assert_eq!(note.expect("row").note.as_deref(), Some("我自己的话"));
        assert!(store.library.with(|conn| ops::list(conn, 10)).expect("list").is_empty());
    }
}
