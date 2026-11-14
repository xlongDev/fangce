//! AI 书库整理：给还没有标签的书建议标签。
//!
//! 模型只出**建议**。写库要读者在预览里逐条确认，应用走 `tags::assign` +
//! `ops::record` —— 与手写标签同一条路径，所以筛选、统计、操作记录都照常工作，
//! 这里没有第二套写入口。
//!
//! 三个边界是刻意的：
//!
//! - **只碰没有标签的书。** 读者手打的标签是他自己的判断；一个「整理」按钮
//!   不该在上面覆盖一层模型的猜测。
//! - **一轮最多 [`RUN_LIMIT`] 本、每批 [`BATCH`] 本。** 分批不是为了省钱，是为了
//!   一批回答坏掉时不带走整轮建议（见 `suggest`）。
//! - **模型给的 id 必须在这批书里。** 否则它是在给不存在的书打标签。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::ai::AiConfig;
use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};
use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::ops;
use crate::library::repository::{self, BookSummary};

/// 每批送进提示词的书。
pub const BATCH: usize = 20;
/// 一轮最多处理的书。
pub const RUN_LIMIT: usize = 60;
/// 简介进提示词的字数。
const INTRO_CHARS: usize = 200;
/// 一本书最多几个标签。
const TAGS_PER_BOOK: usize = 4;
/// 单个标签最长字符数。
const TAG_CHARS: usize = 12;
/// 词表进提示词的字符预算。
///
/// 按「能塞多少塞多少」而不是固定个数：40 个词是原来的上限，而那个上限正好
/// 是长尾的来源 —— 模型看不到库里已有「日本文学」，就会造一个「日本小说」。
/// 273 个词约 820 字、600 tokens，占一次 60 本调用（约 1.2 万）的 5%，买的是
/// 「同一件事只用一种写法」。真到词表撑爆预算那天，被截掉的是用得最少的那头。
const VOCABULARY_CHARS: usize = 1200;

pub const PROMPT: &str = "\
下面是一位读者书架上的书，每本给出编号、书名、作者和简介。请为每本书给出 2 到 4 个中文标签，\
帮他按题材整理书架。标签要短（不超过 6 个字）、具体（写「科幻小说」而不是「小说」）、\
同一类书尽量用同一个标签。只依据给出的书名和简介判断，简介没提到的不要猜；\
确实看不出题材的书，宁可少给，不要瞎凑。

只输出 JSON 数组，不要代码块，不要解释，不要开场白。每一项形如：\
{\"id\":\"<编号>\",\"tags\":[\"标签1\",\"标签2\"]}。";

/// 一本书的建议，带着书名是为了预览里不用再查一次库。
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub book_id: String,
    pub title: String,
    pub tags: Vec<String>,
}

/// 读者确认之后要写进去的一行。
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagAdd {
    pub book_id: String,
    pub tags: Vec<String>,
}

/// The books among `ids` that carry no label yet.
///
/// A tagged book is skipped rather than sent along: the model would be guessing
/// at a shelf the reader has already arranged.
pub fn untagged(conn: &Connection, ids: &[String]) -> AppResult<Vec<BookSummary>> {
    let mut books = Vec::new();
    for id in ids {
        // A stale id is not an error here — the reader may have deleted the book
        // from another window between selecting and pressing the button.
        if let Some(book) = repository::get(conn, id)?
            && book.tags.is_empty()
        {
            books.push(book);
        }
    }
    Ok(books)
}

/// The labels this library already uses, most-used first.
///
/// Without it the model invents a spelling every run, and a shelf ends up with
/// 科幻 / 科幻小说 / 科幻文学 side by side — which makes filtering by label
/// useless, and no amount of local cleanup afterwards fixes it cheaply. Forty
/// words cost about 160 tokens per call and buy a shared vocabulary.
pub fn vocabulary(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t JOIN book_tags b ON b.tag_id = t.id \
         GROUP BY t.id ORDER BY COUNT(*) DESC, t.name",
    )?;
    let all =
        stmt.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut kept = Vec::new();
    let mut chars = 0usize;
    for name in all {
        // +1 for the separator the prompt will add.
        let width = name.chars().count() + 1;
        if chars + width > VOCABULARY_CHARS && !kept.is_empty() {
            break;
        }
        chars += width;
        kept.push(name);
    }
    Ok(kept)
}

fn intro_of(book: &BookSummary) -> String {
    let text = book.description.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        return String::new();
    }
    let mut short: String = text.chars().take(INTRO_CHARS).collect();
    if text.chars().count() > INTRO_CHARS {
        short.push('…');
    }
    short
}

/// The list of books and the shape asked for, as one prompt.
pub fn prompt_for(books: &[BookSummary], vocabulary: &[String]) -> String {
    let mut out = String::from(PROMPT);
    if !vocabulary.is_empty() {
        // 「同一件事」而不是「意思相近」：逼模型在词表里找最近的词，会把
        // 伦理学并进哲学、把日本小说并进文学 —— 那是把读者分的类别抹平，
        // 比多一个词更糟。相近但不同，就该另立。
        out.push_str(
            "\n\n这个书架已经在用的标签。说的是同一件事就用这里的原词；\
             只是相近、不是同一件事的，照实另立新词 —— 不要为了对齐词表把两个\
             概念合成一个（「伦理学」不同于「哲学」，后者不该吃掉前者）：",
        );
        out.push_str(&vocabulary.join("、"));
    }
    out.push_str("\n\n--- 书单 ---\n");
    for (index, book) in books.iter().enumerate() {
        let author = book.authors.join("、");
        out.push_str(&format!("\n{}. id={} 《{}》", index + 1, book.id, book.title));
        if !author.trim().is_empty() {
            out.push_str(&format!(" 作者：{author}"));
        }
        out.push('\n');
        let intro = intro_of(book);
        if !intro.is_empty() {
            out.push_str(&format!("   简介：{intro}\n"));
        }
    }
    out
}

/// What one model answer is allowed to become.
///
/// A trust boundary, not a formality: the text is generated, so it can name a
/// book that is not in the batch, return 30 tags for one book, or wrap the JSON
/// in a code fence with an apology in front of it.
pub fn parse(text: &str, books: &[BookSummary]) -> Vec<Suggestion> {
    let Some(start) = text.find('[') else { return Vec::new() };
    let Some(end) = text.rfind(']') else { return Vec::new() };
    if end <= start {
        return Vec::new();
    }
    let Ok(raw) = serde_json::from_str::<Vec<RawSuggestion>>(&text[start..=end]) else {
        return Vec::new();
    };

    let mut out: Vec<Suggestion> = Vec::new();
    for item in raw {
        let Some(book) = books.iter().find(|book| book.id == item.id) else { continue };
        if out.iter().any(|seen| seen.book_id == book.id) {
            continue;
        }
        let tags = clean_tags(item.tags);
        if tags.is_empty() {
            continue;
        }
        out.push(Suggestion { book_id: book.id.clone(), title: book.title.clone(), tags });
    }
    out
}

#[derive(Deserialize)]
struct RawSuggestion {
    #[serde(default)]
    id: String,
    #[serde(default)]
    tags: Vec<String>,
}

/// Trimmed, deduplicated, short and few — in the order the model gave them.
fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim().trim_start_matches('#').trim().to_string();
        if tag.is_empty() || tag.chars().count() > TAG_CHARS {
            continue;
        }
        if !out.contains(&tag) {
            out.push(tag);
        }
        if out.len() == TAGS_PER_BOOK {
            break;
        }
    }
    out
}

/// One batch of books, one model call.
pub async fn suggest(
    client: &reqwest::Client,
    config: &AiConfig,
    books: &[BookSummary],
    vocabulary: &[String],
) -> AppResult<Vec<Suggestion>> {
    let mut text = String::new();
    chat::stream_chat(
        client,
        config,
        vec![ChatMessage::new(Role::User, prompt_for(books, vocabulary))],
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
        return Err(AppError::Message("模型没有返回标签".into()));
    }
    // A refusal parsed as "no suggestions" would read as 「这些书看不出来题材」,
    // which sends the reader looking at their books instead of their model.
    if crate::library::summary::looks_like_refusal(&text) {
        return Err(AppError::Message(
            "模型回答的不是标签，换一个更擅长照格式输出的模型再试".into(),
        ));
    }
    let found = parse(&text, books);
    if found.is_empty() {
        return Err(AppError::Message("模型没有按书单的格式回答，换一个模型或再试一次".into()));
    }
    Ok(found)
}

/// Writes the confirmed labels, and records the run.
///
/// One transaction: a half-applied batch that still logged success is the one
/// outcome that must not exist.
pub fn apply(library: &Library, items: &[TagAdd]) -> AppResult<usize> {
    let done: Vec<&TagAdd> = items.iter().filter(|item| !item.tags.is_empty()).collect();
    if done.is_empty() {
        return Ok(0);
    }
    let summary = format!("AI 建议的标签：{} 本", done.len());
    // The log line carries the names this call added, which is what 撤销 needs:
    // these rows are invisible to `before_fields`, so without a detail of their
    // own they would be a write with no way back.
    let rows: Vec<(String, serde_json::Value)> = done
        .iter()
        .map(|item| (item.book_id.clone(), ops::added_tags_detail(&item.tags)))
        .collect();
    library.with_tx(|tx| {
        for item in &done {
            crate::library::tags::assign(tx, std::slice::from_ref(&item.book_id), &item.tags, &[])?;
        }
        ops::record_details(tx, ops::Source::Ai, ops::ADDED_TAGS_ACTION, &summary, &rows)
    })?;
    Ok(done.len())
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
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at, description) \
             VALUES ('b1', '三体', '三体', 'txt', 'h1', 'p1', 1, 1, 1, '地球往事')",
            [],
        )
        .expect("book");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b2', '活着', '活着', 'txt', 'h2', 'p2', 1, 1, 1)",
            [],
        )
        .expect("book");
        conn
    }

    fn load(conn: &Connection, id: &str) -> BookSummary {
        repository::get(conn, id).expect("read").expect("book exists")
    }

    #[test]
    fn a_fenced_array_with_chatter_around_it_still_parses() {
        let conn = seeded();
        let books = vec![load(&conn, "b1")];
        let text = "好的，这是标签：\n```json\n[{\"id\":\"b1\",\"tags\":[\"科幻\",\"#中国文学\"]}]\n```\n希望有用。";
        let found = parse(text, &books);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].tags, ["科幻", "中国文学"], "井号要去掉");
        assert_eq!(found[0].title, "三体");
    }

    #[test]
    fn an_id_outside_the_batch_is_dropped() {
        let conn = seeded();
        let books = vec![load(&conn, "b1")];
        let found = parse(r#"[{"id":"zzz","tags":["科幻"]},{"id":"b1","tags":["科幻"]}]"#, &books);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].book_id, "b1");
    }

    #[test]
    fn tags_are_trimmed_capped_and_deduplicated() {
        let conn = seeded();
        let books = vec![load(&conn, "b1")];
        let text = r#"[{"id":"b1","tags":[" 科幻 ","科幻","科幻","硬科幻","文革","历史","一个特别特别长的标签不该进来",""]}]"#;
        let found = parse(text, &books);
        assert_eq!(
            found[0].tags,
            ["科幻", "硬科幻", "文革", "历史"],
            "去重、去掉过长与空项、最多四个"
        );
    }

    #[test]
    fn a_book_left_out_of_the_answer_is_left_alone() {
        let conn = seeded();
        let books = vec![load(&conn, "b1"), load(&conn, "b2")];
        let found = parse(r#"[{"id":"b1","tags":["科幻"]}]"#, &books);
        assert_eq!(found.len(), 1, "模型没提的书不出现在建议里");
    }

    #[test]
    fn garbage_is_an_empty_answer_not_a_panic() {
        let conn = seeded();
        let books = vec![load(&conn, "b1")];
        assert!(parse("我不方便给这些书打标签。", &books).is_empty());
        assert!(parse("[{\"id\":", &books).is_empty());
    }

    #[test]
    fn the_prompt_carries_the_id_and_a_short_intro() {
        let conn = seeded();
        let long = "字".repeat(INTRO_CHARS + 50);
        conn.execute("UPDATE books SET description = ?1 WHERE id = 'b1'", [long]).expect("update");
        let books = vec![load(&conn, "b1")];

        let prompt = prompt_for(&books, &[]);
        assert!(prompt.contains("id=b1 《三体》"), "{prompt}");
        assert!(prompt.contains('…'), "长简介要截断并留省略号");
        assert!(
            prompt.chars().count() < INTRO_CHARS + PROMPT.chars().count() + 200,
            "提示词不为一份简介膨胀"
        );
    }

    /// 真机探针：模型是不是真的按约定的形状回答。
    ///
    /// 三个环境变量，值都在 设置 › AI 里（Key 那一栏要自己贴一次）：
    ///
    /// ```text
    /// FANGCE_LIVE_AI_BASE=http://127.0.0.1:41980/v1 \
    /// FANGCE_LIVE_AI_MODEL='OC · GLM-5.3-Flash Free' \
    /// FANGCE_LIVE_AI_KEY='…' \
    ///   cargo test --lib the_live_model -- --ignored --nocapture
    /// ```
    ///
    /// **为什么不直接读 profile 里那一行**：`secrets::master_key()` 在
    /// `cfg(test)` 下返回一个固定 key（单元测试不能拥有系统钥匙串，否则 CI 会
    /// 卡在权限弹窗上）。也就是说测试进程**按设计**解不开真密文 —— 这条探针
    /// 因此只吃明文，跑完别留在 shell 历史里。
    #[ignore = "hits the live model: needs FANGCE_LIVE_AI_BASE / _MODEL / _KEY"]
    #[test]
    fn the_live_model_answers_in_the_documented_shape() {
        use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};

        let env = |name: &str| {
            std::env::var(name).unwrap_or_else(|_| panic!("先给 {name}：设置 › AI 里那三个值"))
        };
        let config = crate::ai::AiConfig {
            base_url: env("FANGCE_LIVE_AI_BASE"),
            model: env("FANGCE_LIVE_AI_MODEL"),
            api_key: env("FANGCE_LIVE_AI_KEY"),
            ..crate::ai::AiConfig::default()
        };

        // Three real books with real blurbs: the point of a live run is whether
        // the model can tell 科幻 from 当代文学, not whether it echoes a stub.
        let conn = seeded();
        conn.execute(
            "UPDATE books SET description = ?1 WHERE id = 'b1'",
            ["文化大革命如火如荼进行的同时，军方探寻外星文明的绝秘计划「红岸工程」取得了突破性进展。\
              但在按下发射键的那一刻，历经劫难的叶文洁没有意识到，她彻底改变了人类的命运。"],
        )
        .expect("update b1");
        conn.execute(
            "UPDATE books SET description = ?1 WHERE id = 'b2'",
            ["地主少爷福贵嗜赌成性，终于赌光了家业。一次次的苦难接踵而至，\
              他与命运之间的友情却越来越深厚。"],
        )
        .expect("update b2");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at, description) VALUES ('b3', '人类简史', '人类简史', 'epub', 'h3', \
             'p3', 1, 1, 1, '从认知革命、农业革命到科学革命，智人如何成为地球的主宰。')",
            [],
        )
        .expect("b3");
        let books = vec![load(&conn, "b1"), load(&conn, "b2"), load(&conn, "b3")];

        let client = crate::commands::ai::client().expect("http client");
        let mut text = String::new();
        tauri::async_runtime::block_on(chat::stream_chat(
            &client,
            &config,
            vec![ChatMessage::new(Role::User, prompt_for(&books, &[]))],
            None,
            &mut |event| {
                if let StreamEvent::Delta(delta) = event {
                    text.push_str(&delta);
                }
                true
            },
        ))
        .expect("live answer");

        println!("=== 模型原文 ===\n{text}\n=== 解析结果 ===");
        let found = parse(&text, &books);
        for item in &found {
            println!("{} → {}", item.title, item.tags.join("、"));
        }
        assert!(!found.is_empty(), "模型没有返回能解析的数组，提示词或模型有一个不对");
        assert!(found.len() <= books.len(), "不该出现书单以外的书");
        assert!(
            found.iter().all(|item| !item.tags.is_empty() && item.tags.len() <= TAGS_PER_BOOK),
            "每本 1–{TAGS_PER_BOOK} 个标签"
        );
    }

    /// A library on disk, for the one thing `apply` has to prove end to end:
    /// the write goes through `tags::assign` **and** the log accepts a row
    /// sourced `ai`. The first version of this shipped without this test, and
    /// the schema's CHECK rejected the log line on the reader's screen.
    #[test]
    fn applying_writes_the_labels_and_one_ai_log_line() {
        let store = Store::new("tagging-apply");
        store
            .library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                 file_size, added_at, updated_at) VALUES ('b1', '三体', '三体', 'txt', 'h1', 'p1', \
                 1, 1, 1)",
                    [],
                )
                .map_err(Into::into)
            })
            .expect("book");

        let written = apply(
            &store.library,
            &[TagAdd { book_id: "b1".into(), tags: vec!["科幻".into(), "中国文学".into()] }],
        )
        .expect("apply");
        assert_eq!(written, 1);

        let tags: Vec<String> = store
            .library
            .with(|conn| {
                conn.prepare(
                    "SELECT t.name FROM tags t JOIN book_tags b ON b.tag_id = t.id \
                     WHERE b.book_id = 'b1' ORDER BY t.name",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
            })
            .expect("tags");
        assert_eq!(tags, ["中国文学", "科幻"]);

        let (source, action): (String, String) = store
            .library
            .with(|conn| {
                conn.query_row(
                    "SELECT source, action FROM operations WHERE book_id = 'b1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("operation");
        assert_eq!(source, "ai", "来源必须是 ai，否则操作记录分不清是谁改的");
        assert_eq!(action, "ai_tags");
    }

    /// The words the shelf already uses go into the prompt, most-used first —
    /// otherwise every run invents a synonym and filtering by label dies.
    #[test]
    fn the_prompt_carries_the_librarys_own_words() {
        let conn = seeded();
        conn.execute("INSERT INTO tags (id, name) VALUES ('t1', '科幻')", []).expect("tag");
        conn.execute("INSERT INTO tags (id, name) VALUES ('t2', '文学')", []).expect("tag");
        conn.execute("INSERT INTO book_tags (book_id, tag_id) VALUES ('b1', 't1')", []).expect("a");
        conn.execute("INSERT INTO book_tags (book_id, tag_id) VALUES ('b2', 't2')", []).expect("b");

        let words = vocabulary(&conn).expect("vocabulary");
        assert_eq!(words, ["文学", "科幻"], "同票按名字排，别让顺序随机");

        let books = vec![load(&conn, "b2")];
        let prompt = prompt_for(&books, &words);
        assert!(prompt.contains("已经在用的标签"), "{prompt}");
        assert!(prompt.contains("文学、科幻"), "{prompt}");
        assert!(!prompt_for(&books, &[]).contains("已经在用的标签"), "空词表不该留一句空话");
    }

    /// 词表按预算截断，不是按个数：用得少的先被截掉，用得多的先进去。
    #[test]
    fn the_vocabulary_stops_at_its_budget() {
        let conn = seeded();
        for index in 0..300 {
            let id = format!("t{index}");
            let name = format!("词{index:03}");
            conn.execute("INSERT INTO tags (id, name) VALUES (?1, ?2)", [&id, &name]).expect("tag");
            conn.execute("INSERT INTO book_tags (book_id, tag_id) VALUES ('b1', ?1)", [&id])
                .expect("label");
        }
        let words = vocabulary(&conn).expect("vocabulary");
        assert!(words.len() < 300, "300 个词必须被截：{}", words.len());
        let joined: usize = words.iter().map(|word| word.chars().count() + 1).sum();
        assert!(joined <= VOCABULARY_CHARS + 5, "超预算：{joined} 字");
    }

    /// 撤销一次 AI 标签：只删它加的那些名字，读者原来打的标签不动。
    #[test]
    fn undoing_an_ai_tag_write_removes_only_what_it_added() {
        let store = Store::new("tagging-undo");
        store
            .library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                     file_size, added_at, updated_at) VALUES ('b1', '三体', '三体', 'txt', 'h1', \
                     'p1', 1, 1, 1)",
                    [],
                )
                .map_err(Into::into)
            })
            .expect("book");
        store
            .library
            .with_tx(|tx| crate::library::tags::assign(tx, &["b1".into()], &["文学".into()], &[]))
            .expect("读者自己打的");

        apply(
            &store.library,
            &[TagAdd { book_id: "b1".into(), tags: vec!["科幻".into(), "中国文学".into()] }],
        )
        .expect("apply");

        let listed = store.library.with(|conn| crate::library::ops::list(conn, 10)).expect("list");
        let line = listed.first().expect("a log row");
        assert!(line.undoable, "AI 标签必须能撤回");

        let call_id = line.call_id.clone();
        store
            .library
            .with_tx(|tx| crate::library::ops::undo(tx, &call_id, &store.dir.join("covers")))
            .expect("undo");

        let tags: Vec<String> = store
            .library
            .with(|conn| {
                conn.prepare(
                    "SELECT t.name FROM tags t JOIN book_tags b ON b.tag_id = t.id \
                     WHERE b.book_id = 'b1' ORDER BY t.name",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into)
            })
            .expect("tags");
        assert_eq!(tags, ["文学"], "只删这次加的，读者自己打的那一个必须还在");
    }

    #[test]
    fn an_empty_selection_writes_nothing_at_all() {
        let store = Store::new("tagging-apply-empty");
        let written = apply(&store.library, &[TagAdd { book_id: "ghost".into(), tags: vec![] }])
            .expect("apply");
        assert_eq!(written, 0);
        let lines: i64 = store
            .library
            .with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .expect("count");
        assert_eq!(lines, 0, "没有要写的标签就不该留一行空记录");
    }

    struct Store {
        dir: std::path::PathBuf,
        library: Library,
    }

    impl Store {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let library = Library::open(&dir).expect("open library");
            Self { dir, library }
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn only_untagged_books_are_offered() {
        let conn = seeded();
        conn.execute("INSERT INTO tags (id, name) VALUES ('t', '文学')", []).expect("tag");
        conn.execute("INSERT INTO book_tags (book_id, tag_id) VALUES ('b2', 't')", [])
            .expect("label");

        let ids = vec!["b1".to_string(), "b2".to_string(), "gone".to_string()];
        let found = untagged(&conn, &ids).expect("untagged");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "b1", "已打标签的书与不存在的 id 都不进模型");
    }
}
