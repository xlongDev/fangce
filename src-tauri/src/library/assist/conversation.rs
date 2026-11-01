//! The assistant's conversation history.
//!
//! One conversation belongs to one book, and its messages are stored whole —
//! `reasoning`, `citations` and `usage` ride along as JSON rather than as
//! columns, because nothing queries into them and their shape follows the
//! provider's wire format, not ours.
//!
//! Persistence is driven from the renderer, not from `ai_chat`: the panel knows
//! when an answer is finished, and a stream that failed half way through should
//! leave no half message behind. `ai_chat` stays a pure function of its inputs.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::ai::tools::ToolCallView;
use crate::ai::usage::TokenUsage;
use crate::error::{AppError, AppResult};
use crate::library::rag::RagHit;

/// One row of the conversation switcher.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    /// `None` for a question asked with nothing open.
    pub book_id: Option<String>,
    /// The book's title, for a list that spans books. `None` when `book_id` is.
    pub book_title: Option<String>,
    pub title: String,
    pub message_count: usize,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One stored turn.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: i64,
    /// `"user"` or `"assistant"` — the CHECK constraint holds the same two.
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub citations: Vec<RagHit>,
    pub usage: Option<TokenUsage>,
    /// What the assistant looked up or drew while answering.
    pub tools: Vec<ToolCallView>,
    pub created_at: i64,
}

/// A conversation and everything in it.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub summary: ConversationSummary,
    pub messages: Vec<StoredMessage>,
}

/// How long an auto-generated title may be, in characters. Long enough to
/// recognise the question, short enough for one line in a narrow drawer.
const TITLE_CHARS: usize = 30;

/// The switcher's list, newest first. A book's conversations when `book_id` is
/// given, every conversation otherwise.
pub fn list(conn: &Connection, book_id: Option<&str>) -> AppResult<Vec<ConversationSummary>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.book_id, b.title, c.title, c.created_at, c.updated_at, \
                (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) \
           FROM ai_conversations c LEFT JOIN books b ON b.id = c.book_id \
          WHERE (?1 IS NULL OR c.book_id = ?1) \
          ORDER BY c.updated_at DESC \
          LIMIT 100",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(summary_from_row(row)?);
    }
    Ok(out)
}

/// One conversation with its messages, oldest first.
pub fn get(conn: &Connection, id: &str) -> AppResult<Conversation> {
    let summary = conn
        .query_row(
            "SELECT c.id, c.book_id, b.title, c.title, c.created_at, c.updated_at, \
                    (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) \
               FROM ai_conversations c LEFT JOIN books b ON b.id = c.book_id \
              WHERE c.id = ?1",
            params![id],
            summary_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::InvalidArgument("这个对话已经不在了".into()))?;

    let mut stmt = conn.prepare(
        "SELECT id, role, content, reasoning, citations, usage, created_at, tools \
           FROM ai_messages WHERE conversation_id = ?1 ORDER BY id",
    )?;
    let mut rows = stmt.query(params![id])?;
    let mut messages = Vec::new();
    while let Some(row) = rows.next()? {
        messages.push(StoredMessage {
            id: row.get(0)?,
            role: row.get(1)?,
            content: row.get(2)?,
            reasoning: row.get(3)?,
            // A row written by a newer build may hold JSON this one cannot read;
            // dropping the citations is better than refusing to show the answer.
            citations: row
                .get::<_, Option<String>>(4)?
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or_default(),
            usage: row
                .get::<_, Option<String>>(5)?
                .and_then(|json| serde_json::from_str(&json).ok()),
            created_at: row.get(6)?,
            tools: row
                .get::<_, Option<String>>(7)?
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or_default(),
        });
    }
    Ok(Conversation { summary, messages })
}

/// Starts an empty conversation. The title is filled in by the first question
/// (see [`append`]), so the caller does not have to invent one.
pub fn create(conn: &Connection, book_id: Option<&str>) -> AppResult<ConversationSummary> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::library::now_seconds();
    conn.execute(
        "INSERT INTO ai_conversations (id, book_id, title, created_at, updated_at) \
         VALUES (?1, ?2, '', ?3, ?3)",
        params![id, book_id, now],
    )?;
    get(conn, &id).map(|conversation| conversation.summary)
}

/// Renames a conversation. An empty title is refused: the switcher would then
/// show a blank row with no way to tell it from its neighbour.
pub fn rename(conn: &Connection, id: &str, title: &str) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("标题不能为空".into()));
    }
    let changed = conn.execute(
        "UPDATE ai_conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, crate::library::now_seconds()],
    )?;
    if changed == 0 {
        return Err(AppError::InvalidArgument("这个对话已经不在了".into()));
    }
    Ok(())
}

/// Deletes a conversation; its messages go with it through the cascade.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM ai_conversations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Appends one turn and bumps the conversation's clock.
///
/// The first question becomes the title, so a new conversation names itself
/// after what it was actually about.
#[allow(clippy::too_many_arguments)]
pub fn append(
    conn: &Connection,
    id: &str,
    role: &str,
    content: &str,
    reasoning: Option<&str>,
    citations: &[RagHit],
    usage: Option<TokenUsage>,
    tools: &[ToolCallView],
) -> AppResult<StoredMessage> {
    if role != "user" && role != "assistant" {
        return Err(AppError::InvalidArgument(format!("未知的对话角色: {role}")));
    }
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::InvalidArgument("消息内容不能为空".into()));
    }

    let now = crate::library::now_seconds();
    let citations_json =
        if citations.is_empty() { None } else { Some(serde_json::to_string(citations)?) };
    let usage_json = usage.map(|counts| serde_json::to_string(&counts)).transpose()?;
    let tools_json = if tools.is_empty() { None } else { Some(serde_json::to_string(tools)?) };

    conn.execute(
        "INSERT INTO ai_messages \
           (conversation_id, role, content, reasoning, citations, usage, created_at, tools) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, role, content, reasoning, citations_json, usage_json, now, tools_json],
    )?;
    let message_id = conn.last_insert_rowid();

    // Title from the first question only: a later one is a follow-up, and a
    // title that keeps changing is a title nobody can navigate by.
    if role == "user" {
        let named: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ai_messages WHERE conversation_id = ?1 AND role = 'user'",
            params![id],
            |row| row.get(0),
        )?;
        if named == 1 {
            conn.execute(
                "UPDATE ai_conversations SET title = ?2 WHERE id = ?1 AND title = ''",
                params![id, title_from(content)],
            )?;
        }
    }
    conn.execute("UPDATE ai_conversations SET updated_at = ?2 WHERE id = ?1", params![id, now])?;

    Ok(StoredMessage {
        id: message_id,
        role: role.to_string(),
        content: content.to_string(),
        reasoning: reasoning.map(str::to_string),
        citations: citations.to_vec(),
        usage,
        tools: tools.to_vec(),
        created_at: now,
    })
}

/// First line of a question, whitespace collapsed, capped at [`TITLE_CHARS`].
fn title_from(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= TITLE_CHARS {
        return flat;
    }
    let mut title: String = flat.chars().take(TITLE_CHARS).collect();
    title.push('…');
    title
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSummary> {
    Ok(ConversationSummary {
        id: row.get(0)?,
        book_id: row.get(1)?,
        book_title: row.get(2)?,
        title: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        message_count: row.get::<_, i64>(6)? as usize,
    })
}

/// One conversation as Markdown, for the reader who wants to keep it.
///
/// The reasoning, when there is any, goes in a `<details>` block: it is worth
/// keeping and not worth re-reading, which is exactly what that element means.
/// Token counts are left out — they are a property of the request, not of the
/// answer, and they date quickly.
pub fn to_markdown(conversation: &Conversation) -> String {
    let mut out = String::new();
    let title = if conversation.summary.title.is_empty() {
        "AI 对话"
    } else {
        conversation.summary.title.as_str()
    };
    out.push_str(&format!("# {title}\n\n"));
    if let Some(book) = &conversation.summary.book_title {
        out.push_str(&format!("《{book}》\n\n"));
    }

    for message in &conversation.messages {
        let heading = if message.role == "user" { "问" } else { "答" };
        out.push_str(&format!("## {heading}\n\n{}\n\n", message.content));
        if let Some(reasoning) = message.reasoning.as_deref().map(str::trim)
            && !reasoning.is_empty()
        {
            out.push_str(&format!(
                "<details>\n<summary>思考过程</summary>\n\n{reasoning}\n\n</details>\n\n"
            ));
        }
        for (index, hit) in message.citations.iter().enumerate() {
            out.push_str(&format!(
                "> [{}] 《{}》第 {} 章\n",
                index + 1,
                hit.book_title,
                hit.chapter_idx + 1
            ));
        }
        if !message.citations.is_empty() {
            out.push('\n');
        }
    }
    out.trim_end().to_string() + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;

    struct Harness {
        dir: std::path::PathBuf,
        library: crate::db::Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = crate::db::Library::open(&layout.data_dir).expect("open");
            Self { dir, library }
        }

        fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> T {
            self.library.with(f).expect("db")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// A book row, so `book_id` passes the foreign key.
    fn seed_book(harness: &Harness) -> String {
        let id = "book-1".to_string();
        harness
            .library
            .with(|conn| {
                Ok(conn.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                     file_size, added_at, updated_at) \
                     VALUES (?1, '书', '书', 'txt', 'hash-1', '/tmp/x.txt', 1, 1, 1)",
                    params![id],
                )?)
            })
            .expect("seed book");
        id
    }

    #[test]
    fn a_new_conversation_is_unnamed_until_it_is_asked_something() {
        let harness = Harness::new("conv-unnamed");
        let book = seed_book(&harness);
        let created = harness.with(|conn| create(conn, Some(&book)));
        assert_eq!(created.title, "");
        assert_eq!(created.message_count, 0);
        assert_eq!(created.book_id.as_deref(), Some(book.as_str()));
        assert_eq!(created.book_title.as_deref(), Some("书"));
    }

    #[test]
    fn the_first_question_names_the_conversation_and_later_ones_do_not() {
        let harness = Harness::new("conv-title");
        let book = seed_book(&harness);
        let created = harness.with(|conn| create(conn, Some(&book)));

        harness.with(|conn| {
            append(conn, &created.id, "user", "这一章讲了什么", None, &[], None, &[])?;
            append(conn, &created.id, "assistant", "讲了……", None, &[], None, &[])?;
            append(conn, &created.id, "user", "再展开一点", None, &[], None, &[])?;
            Ok(())
        });

        let conversation = harness.with(|conn| get(conn, &created.id));
        assert_eq!(conversation.summary.title, "这一章讲了什么");
        assert_eq!(conversation.messages.len(), 3);
        assert_eq!(conversation.summary.message_count, 3);
    }

    #[test]
    fn a_long_question_is_cut_to_one_line() {
        assert_eq!(title_from("短问题"), "短问题");
        let long = "问".repeat(50);
        let title = title_from(&long);
        assert_eq!(title.chars().count(), TITLE_CHARS + 1, "截断后带省略号");
        assert!(title.ends_with('…'));
        assert_eq!(title_from("多行\n问题"), "多行 问题");
    }

    #[test]
    fn citations_and_usage_survive_a_round_trip() {
        let harness = Harness::new("conv-payload");
        let book = seed_book(&harness);
        let created = harness.with(|conn| create(conn, Some(&book)));
        let hit = RagHit {
            book_id: book.clone(),
            book_title: "书".into(),
            chapter_idx: 3,
            start_char: 10,
            score: 0.87,
            text: "片段".into(),
        };
        let usage = TokenUsage { input: 120, cached: 64, output: 30 };

        harness.with(|conn| {
            append(
                conn,
                &created.id,
                "assistant",
                "答案",
                Some("想过"),
                std::slice::from_ref(&hit),
                Some(usage),
                &[],
            )?;
            Ok(())
        });

        let conversation = harness.with(|conn| get(conn, &created.id));
        let message = &conversation.messages[0];
        assert_eq!(message.reasoning.as_deref(), Some("想过"));
        assert_eq!(message.citations, vec![hit]);
        assert_eq!(message.usage, Some(usage));
    }

    #[test]
    fn the_tools_a_message_used_come_back_with_it() {
        let harness = Harness::new("conv-tools");
        let created = harness.with(|conn| create(conn, None));
        let view = ToolCallView {
            name: "mindmap".into(),
            label: "思维导图「人物」".into(),
            detail: "4 个节点".into(),
            ok: true,
            sources: Vec::new(),
            mindmap: Some("# 主角\n- 林昭".into()),
            wordcloud: None,
        };

        harness.with(|conn| {
            append(
                conn,
                &created.id,
                "assistant",
                "见图",
                None,
                &[],
                None,
                std::slice::from_ref(&view),
            )?;
            Ok(())
        });

        let stored = harness.with(|conn| get(conn, &created.id));
        assert_eq!(stored.messages[0].tools, vec![view], "导图不能只在面板打开时存在");
    }

    #[test]
    fn a_blank_message_is_refused() {
        let harness = Harness::new("conv-blank");
        let created = harness.with(|conn| create(conn, None));
        let result = harness
            .library
            .with(|conn| append(conn, &created.id, "user", "   ", None, &[], None, &[]));
        assert!(result.is_err());
    }

    #[test]
    fn an_unknown_role_is_refused_at_the_boundary() {
        let harness = Harness::new("conv-role");
        let created = harness.with(|conn| create(conn, None));
        let result = harness
            .library
            .with(|conn| append(conn, &created.id, "system", "x", None, &[], None, &[]));
        assert!(result.is_err());
    }

    #[test]
    fn the_list_is_scoped_to_one_book_and_newest_first() {
        let harness = Harness::new("conv-list");
        let book = seed_book(&harness);
        let other = harness.with(|conn| {
            Ok(conn.execute(
                "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                 file_size, added_at, updated_at) \
                 VALUES ('book-2', '另一本', '另一本', 'txt', 'hash-2', '/tmp/y.txt', 1, 1, 1)",
                [],
            )?)
        });
        assert_eq!(other, 1);

        let first = harness.with(|conn| create(conn, Some(&book)));
        let second = harness.with(|conn| create(conn, Some(&book)));
        harness.with(|conn| create(conn, Some("book-2")));

        // `updated_at` has one-second resolution, so make the order explicit.
        harness
            .library
            .with(|conn| {
                conn.execute(
                    "UPDATE ai_conversations SET updated_at = 2 WHERE id = ?1",
                    params![first.id],
                )?;
                conn.execute(
                    "UPDATE ai_conversations SET updated_at = 1 WHERE id = ?1",
                    params![second.id],
                )?;
                Ok(())
            })
            .expect("pin timestamps");

        let listed = harness.with(|conn| list(conn, Some(&book)));
        assert_eq!(listed.len(), 2, "另一本的对话不该出现");
        assert_eq!(listed[0].id, first.id, "最近的排前面");

        assert_eq!(harness.with(|conn| list(conn, None)).len(), 3);
    }

    #[test]
    fn deleting_a_conversation_takes_its_messages_with_it() {
        let harness = Harness::new("conv-delete");
        let created = harness.with(|conn| create(conn, None));
        harness.with(|conn| append(conn, &created.id, "user", "问题", None, &[], None, &[]));

        harness.with(|conn| delete(conn, &created.id));
        let orphans: i64 = harness
            .library
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM ai_messages WHERE conversation_id = ?1",
                    params![created.id],
                    |row| row.get(0),
                )?)
            })
            .expect("count orphans");
        assert_eq!(orphans, 0);
        assert!(harness.library.with(|conn| get(conn, &created.id)).is_err());
    }

    #[test]
    fn deleting_a_book_takes_its_conversations_with_it() {
        let harness = Harness::new("conv-cascade");
        let book = seed_book(&harness);
        let created = harness.with(|conn| create(conn, Some(&book)));
        harness.with(|conn| append(conn, &created.id, "user", "问题", None, &[], None, &[]));

        harness
            .library
            .with(|conn| Ok(conn.execute("DELETE FROM books WHERE id = ?1", params![book])?))
            .expect("delete book");

        assert!(harness.with(|conn| list(conn, None)).is_empty(), "书没了，对话也该没了");
    }

    #[test]
    fn renaming_refuses_a_blank_title() {
        let harness = Harness::new("conv-rename");
        let created = harness.with(|conn| create(conn, None));
        assert!(harness.library.with(|conn| rename(conn, &created.id, "   ")).is_err());

        harness.with(|conn| rename(conn, &created.id, " 新名字 "));
        assert_eq!(harness.with(|conn| get(conn, &created.id)).summary.title, "新名字");
    }

    #[test]
    fn the_markdown_export_reads_as_a_transcript() {
        let harness = Harness::new("conv-markdown");
        let book = seed_book(&harness);
        let created = harness.with(|conn| create(conn, Some(&book)));
        let hit = RagHit {
            book_id: book.clone(),
            book_title: "书".into(),
            chapter_idx: 1,
            start_char: 0,
            score: 0.5,
            text: "片段".into(),
        };

        harness.with(|conn| {
            append(conn, &created.id, "user", "主角是谁", None, &[], None, &[])?;
            append(conn, &created.id, "assistant", "是甲", Some("先找线索"), &[hit], None, &[])?;
            Ok(())
        });

        let markdown = to_markdown(&harness.with(|conn| get(conn, &created.id)));
        assert!(markdown.starts_with("# 主角是谁"), "{markdown}");
        assert!(markdown.contains("《书》"));
        assert!(markdown.contains("## 问\n\n主角是谁"));
        assert!(markdown.contains("## 答\n\n是甲"));
        assert!(markdown.contains("<summary>思考过程</summary>"));
        assert!(markdown.contains("> [1] 《书》第 2 章"));
        assert!(markdown.ends_with('\n'));
    }

    #[test]
    fn an_untitled_conversation_still_gets_a_heading() {
        let harness = Harness::new("conv-markdown-empty");
        let created = harness.with(|conn| create(conn, None));
        let markdown = to_markdown(&harness.with(|conn| get(conn, &created.id)));
        assert!(markdown.starts_with("# AI 对话"), "{markdown}");
    }
}
