//! The tools the reading assistant may call.
//!
//! Four of them, and the split is by what the model cannot do for itself:
//! `search_book` and `read_chapter` are *retrieval* — the book is not in its
//! context, and only the library can look things up. `mindmap` and `wordcloud`
//! are *rendering* — the model can produce the content, but the reader wants it
//! drawn, and a chat message cannot draw.
//!
//! A tool failure is returned to the model, not raised: "没有配置向量模型" is
//! something the model can work around by answering from what it already has,
//! and aborting the turn would take that away from it.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::AiConfig;
use crate::ai::chat::{FunctionDef, ToolCall, ToolDef};
use crate::ai::wordcloud::{self, WordCount};
use crate::ai::{embeddings, rerank};
use crate::db::Library;
use crate::library::graph::{self as book_graph, GraphRelation};
use crate::library::rag::{self, RagHit};

/// With a reranker configured, first-stage recall is this many times wider than
/// the final cut before `/rerank` picks the best few.
const RECALL_MULTIPLIER: usize = 4;

/// How much of one chapter may travel to the model. A chapter past this is cut
/// and told so — silently truncating would let the model claim the ending does
/// not exist.
const MAX_CHAPTER_CHARS: usize = 30_000;

/// One tool call as the panel draws it.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallView {
    /// The function name, e.g. `search_book`.
    pub name: String,
    /// One line naming what was asked, e.g. `检索「主角是谁」`.
    pub label: String,
    /// What came back, in a handful of characters.
    pub detail: String,
    pub ok: bool,
    /// Passages this call retrieved, so the reader can jump to them. Empty for
    /// the tools that return no text.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub sources: Vec<RagHit>,
    /// Present when this call produced a mind map; Markdown for `markmap`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mindmap: Option<String>,
    /// Present when this call produced a word cloud.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wordcloud: Option<Vec<WordCount>>,
}

/// What a call produced: one view for the reader, one text for the model.
pub struct ToolOutcome {
    pub view: ToolCallView,
    /// What the model reads next. Never empty — an empty tool message is
    /// rejected by some providers.
    pub for_model: String,
}

/// Everything a tool may need. Borrowed for the duration of one turn.
pub struct ToolContext<'a> {
    pub library: &'a Library,
    pub client: &'a reqwest::Client,
    pub config: &'a AiConfig,
    /// The book being read, when there is one.
    pub book_id: Option<&'a str>,
    /// The reader's position, for a spoiler-safe search.
    pub max_chapter: Option<usize>,
}

/// The schemas sent with every agent request.
///
/// Descriptions are written for the model, not for the reader: they say when to
/// call the tool and what comes back, because a tool nobody calls is dead weight
/// on every request.
pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            kind: "function",
            function: FunctionDef {
                name: "search_book",
                description: "在书中做语义检索，返回若干相关片段（带章节号）。问「谁在第几章出场」「某个情节在哪里」这类需要跨章定位的问题时先调它。",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "检索语句。用读者原话里的关键词，不要改写成问句。"
                        }
                    },
                    "required": ["query"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: FunctionDef {
                name: "read_chapter",
                description: "读取指定章节的完整正文。问「这一章讲了什么」或需要连续上下文时用它；章节号从 1 开始，与检索结果里的一致。",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "chapter": { "type": "integer", "description": "章节号，从 1 开始。" }
                    },
                    "required": ["chapter"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: FunctionDef {
                name: "character",
                description: "查书里某个角色或实体的档案：它是什么、和谁有什么关系、各出现在哪一章。这本书抽过知识图谱时，问「某某是谁」「A 和 B 什么关系」先用它——比检索原文更准，也省一次向量检索。",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "实体名，用书里的写法，不要改写。" }
                    },
                    "required": ["name"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: FunctionDef {
                name: "mindmap",
                description: "生成一张思维导图并展示给读者。用于「梳理人物关系」「概括本书结构」这类需要层级结构的回答。生成后不要再用文字重复一遍导图内容。",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "导图标题。" },
                        "markdown": {
                            "type": "string",
                            "description": "Markdown 层级：一级用 `# 标题`，往下用 `##` / `###`，最细用 `- 要点`。禁止使用 Mermaid 语法。"
                        }
                    },
                    "required": ["title", "markdown"]
                }),
            },
        },
        ToolDef {
            kind: "function",
            function: FunctionDef {
                name: "wordcloud",
                description: "统计高频词并生成词云图展示给读者。用于「这本书都在讲什么词」「本章高频词」这类问题。不依赖向量索引。",
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["chapter", "book"],
                            "description": "统计范围：本章还是全书。"
                        },
                        "chapter": {
                            "type": "integer",
                            "description": "scope 为 chapter 时的章节号，从 1 开始。"
                        },
                        "max_words": {
                            "type": "integer",
                            "description": "最多展示多少个词，10 到 200。"
                        }
                    },
                    "required": ["scope"]
                }),
            },
        },
    ]
}

/// Runs one call. Never returns `Err`: a failure is a message for the model.
pub async fn run(ctx: &ToolContext<'_>, call: &ToolCall) -> ToolOutcome {
    let arguments: Value = match serde_json::from_str(&call.arguments) {
        Ok(value) => value,
        Err(err) => {
            return failed(call, format!("参数不是合法 JSON：{err}"));
        }
    };

    let result = match call.name.as_str() {
        "search_book" => search_book(ctx, &arguments).await,
        "read_chapter" => read_chapter(ctx, &arguments),
        "character" => lookup_character(ctx, &arguments),
        "mindmap" => mindmap(&arguments),
        "wordcloud" => make_wordcloud(ctx, &arguments),
        other => Err(format!("没有叫 {other} 的工具")),
    };

    match result {
        Ok(outcome) => outcome,
        Err(message) => failed(call, message),
    }
}

/// A failed call: the reader sees that it failed, the model sees why.
fn failed(call: &ToolCall, message: String) -> ToolOutcome {
    ToolOutcome {
        view: ToolCallView {
            name: call.name.clone(),
            label: format!("{} 失败", label_of(&call.name)),
            detail: message.clone(),
            ok: false,
            sources: Vec::new(),
            mindmap: None,
            wordcloud: None,
        },
        for_model: format!("工具调用失败：{message}"),
    }
}

fn label_of(name: &str) -> &'static str {
    match name {
        "search_book" => "检索",
        "read_chapter" => "读取章节",
        "character" => "查角色",
        "mindmap" => "生成思维导图",
        "wordcloud" => "统计词频",
        _ => "工具",
    }
}

/// Makes sure a book's chapter bodies are extracted, so a tool can read them.
fn ensure_book_text(ctx: &ToolContext<'_>, book_id: &str) -> Result<(), String> {
    crate::library::chapters::ensure_text(ctx.library, book_id)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/* --------------------------------------------------------------- the graph */

/// The most relations a card hands the model.
///
/// A character who appears in every chapter has hundreds; what the model needs
/// is the shape of them, and the rest is context spent on repetition.
const MAX_CARD_RELATIONS: usize = 40;

/// One entity's card, read from the knowledge graph rather than from the text.
///
/// The graph already exists for the panel; using it here is what makes 「林昭是
/// 谁」 cheap and grounded instead of a fresh search over the whole book. When
/// the book has no graph the tool says so and names the fallback, because a
/// model that is merely told "failed" will retry the same call.
fn lookup_character(ctx: &ToolContext<'_>, arguments: &Value) -> Result<ToolOutcome, String> {
    let name = arguments
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "缺少 name".to_string())?;
    let book_id = ctx
        .book_id
        .ok_or_else(|| "当前没有打开的书，查不了角色；可以请读者先打开一本".to_string())?;

    let (entities, _) = ctx
        .library
        .with(|conn| book_graph::counts(conn, book_id))
        .map_err(|err| err.to_string())?;
    if entities == 0 {
        return Err(
            "这本书还没有抽取知识图谱；改用 search_book 检索原文，或用 read_chapter 读章节".into(),
        );
    }

    let found = ctx
        .library
        .with(|conn| {
            let entity = book_graph::entity(conn, book_id, name)?;
            let relations = book_graph::query(conn, book_id, Some(name))?.relations;
            Ok((entity, relations))
        })
        .map_err(|err| err.to_string())?;

    let (entity, relations) = found;
    let Some(entity) = entity else {
        return Err(format!("知识图谱里没有「{name}」；可以改用 search_book 检索原文"));
    };

    Ok(ToolOutcome {
        view: ToolCallView {
            name: "character".into(),
            label: format!("角色「{name}」"),
            detail: format!("{} 条关系", relations.len()),
            ok: true,
            sources: Vec::new(),
            mindmap: None,
            wordcloud: None,
        },
        for_model: card_text(&entity.name, &entity.kind, entity.mentions, &relations),
    })
}

/// The card as the model reads it. Split out because it is the whole of what
/// this tool says, and the only part worth asserting on.
fn card_text(name: &str, kind: &str, mentions: usize, relations: &[GraphRelation]) -> String {
    let mut out = format!("「{name}」（{kind}，全书提及 {mentions} 次）\n");
    if relations.is_empty() {
        out.push_str("\n图谱里没有与它相关的关系。\n");
        return out;
    }

    out.push_str("\n关系：\n");
    for relation in relations.iter().take(MAX_CARD_RELATIONS) {
        out.push_str(&format!(
            "- {} {} {}（第 {} 章）",
            relation.subject,
            relation.relation,
            relation.object,
            relation.chapter_idx + 1
        ));
        if !relation.evidence.is_empty() {
            out.push_str(&format!("：{}", relation.evidence));
        }
        out.push('\n');
    }
    if relations.len() > MAX_CARD_RELATIONS {
        out.push_str(&format!("（还有 {} 条关系未列出）\n", relations.len() - MAX_CARD_RELATIONS));
    }
    out
}

/* ------------------------------------------------------------- retrieval */

async fn search_book(ctx: &ToolContext<'_>, arguments: &Value) -> Result<ToolOutcome, String> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "缺少 query".to_string())?;

    let model = ctx.config.embedding_model.trim();
    if model.is_empty() {
        return Err("还没有配置向量模型，无法检索；可以直接依据已有上下文回答".into());
    }

    let query_text = query.to_string();
    let (base_url, api_key) = crate::ai::embedding_endpoint(ctx.config);
    let mut vector =
        embeddings::embed(ctx.client, base_url, api_key, model, std::slice::from_ref(&query_text))
            .await
            .map_err(|err| err.to_string())?
            .pop()
            .ok_or_else(|| "embedding 响应为空".to_string())?;
    embeddings::normalize(&mut vector).ok_or_else(|| "模型返回了零向量".to_string())?;

    let top_k = ctx.config.rag_top_k.max(1);
    let rerank_model = ctx.config.rerank_model.trim();
    let candidate_k = if rerank_model.is_empty() { top_k } else { top_k * RECALL_MULTIPLIER };
    let mut hits: Vec<RagHit> = ctx
        .library
        .with(|conn| rag::search(conn, model, &vector, ctx.book_id, ctx.max_chapter, candidate_k))
        .map_err(|err| err.to_string())?;

    if hits.is_empty() {
        return Ok(ToolOutcome {
            view: ToolCallView {
                name: "search_book".into(),
                label: format!("检索「{query}」"),
                detail: if ctx.max_chapter.is_some() {
                    "这一段之前没有可检索的内容".into()
                } else {
                    "没有可检索的索引".into()
                },
                ok: true,
                sources: Vec::new(),
                mindmap: None,
                wordcloud: None,
            },
            for_model: if ctx.max_chapter.is_some() {
                "这一段之前还没有索引内容，不要据此推断后文。".to_string()
            } else {
                "这本书还没有建立检索索引，请直接依据已有上下文回答，并说明无法检索。".to_string()
            },
        });
    }

    if !rerank_model.is_empty() {
        let documents: Vec<String> = hits.iter().map(|hit| hit.text.clone()).collect();
        let order = rerank::rerank(
            ctx.client,
            &ctx.config.base_url,
            &ctx.config.api_key,
            rerank_model,
            query,
            &documents,
            top_k,
        )
        .await
        .map_err(|err| err.to_string())?;
        if !order.is_empty() {
            hits = order.into_iter().filter_map(|index| hits.get(index).cloned()).collect();
        }
    }

    let mut context = String::new();
    for (index, hit) in hits.iter().enumerate() {
        context.push_str(&format!(
            "[{}] 《{}》第 {} 章\n{}\n\n",
            index + 1,
            hit.book_title,
            hit.chapter_idx + 1,
            hit.text
        ));
    }

    Ok(ToolOutcome {
        view: ToolCallView {
            name: "search_book".into(),
            label: format!("检索「{query}」"),
            detail: format!("{} 段", hits.len()),
            ok: true,
            sources: hits.clone(),
            mindmap: None,
            wordcloud: None,
        },
        for_model: format!(
            "以下是《{}》里与「{query}」最相关的 {} 段，按相关度排序。引用时说明章节号。\n\n{context}",
            hits.first().map(|hit| hit.book_title.as_str()).unwrap_or("这本书"),
            hits.len()
        ),
    })
}

fn read_chapter(ctx: &ToolContext<'_>, arguments: &Value) -> Result<ToolOutcome, String> {
    let book_id = ctx.book_id.ok_or_else(|| "没有打开的书".to_string())?;
    let chapter = arguments
        .get("chapter")
        .and_then(Value::as_i64)
        .ok_or_else(|| "缺少 chapter".to_string())?;
    if chapter < 1 {
        return Err("章节号从 1 开始".into());
    }
    let idx = (chapter - 1) as usize;

    // Chapter bodies are lazily extracted for older imports; reading one is the
    // same debt the reader pays when it opens the book. Called outside `with`:
    // it opens its own connection, and holding the mutex twice would deadlock.
    ensure_book_text(ctx, book_id)?;

    let found: Option<(String, String)> = ctx
        .library
        .with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT title, content FROM chapters WHERE book_id = ?1 AND idx = ?2",
                    rusqlite::params![book_id, idx as i64],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok())
        })
        .map_err(|err| err.to_string())?;

    let Some((title, content)) = found else {
        return Err(format!("没有第 {chapter} 章"));
    };
    if content.trim().is_empty() {
        return Err(format!("第 {chapter} 章还没有抽取到正文"));
    }

    let total = content.chars().count();
    let body: String = if total > MAX_CHAPTER_CHARS {
        content.chars().take(MAX_CHAPTER_CHARS).collect()
    } else {
        content.clone()
    };
    let truncated = total > MAX_CHAPTER_CHARS;

    Ok(ToolOutcome {
        view: ToolCallView {
            name: "read_chapter".into(),
            label: format!("读取第 {chapter} 章"),
            detail: if truncated {
                format!("{title}（前 {MAX_CHAPTER_CHARS} 字）")
            } else {
                format!("{title}（{total} 字）")
            },
            ok: true,
            sources: Vec::new(),
            mindmap: None,
            wordcloud: None,
        },
        for_model: format!(
            "第 {chapter} 章「{title}」的正文：\n\n{body}{}",
            if truncated {
                format!(
                    "\n\n（这一章共 {total} 字，上面只是前 {MAX_CHAPTER_CHARS} 字，后面的内容你还没有看到。）"
                )
            } else {
                String::new()
            }
        ),
    })
}

/* ------------------------------------------------------------- rendering */

fn mindmap(arguments: &Value) -> Result<ToolOutcome, String> {
    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("思维导图");
    let markdown = arguments
        .get("markdown")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少 markdown".to_string())?;

    // Models wrap structured output in a fence about half the time, and a fence
    // renders as a code block rather than as a map.
    let body = strip_fence(markdown);
    if !body.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with('#') || trimmed.starts_with("- ")
    }) {
        return Err("markdown 里没有任何标题或要点".into());
    }

    let nodes = body.lines().filter(|line| !line.trim().is_empty()).count();
    Ok(ToolOutcome {
        view: ToolCallView {
            name: "mindmap".into(),
            label: format!("思维导图「{title}」"),
            detail: format!("{nodes} 个节点"),
            ok: true,
            sources: Vec::new(),
            mindmap: Some(body),
            wordcloud: None,
        },
        for_model: format!(
            "已生成思维导图「{title}」并展示给读者（{nodes} 个节点）。不要再用文字重复导图内容；可以补一句结论。"
        ),
    })
}

fn make_wordcloud(ctx: &ToolContext<'_>, arguments: &Value) -> Result<ToolOutcome, String> {
    let book_id = ctx.book_id.ok_or_else(|| "没有打开的书".to_string())?;
    let scope = arguments.get("scope").and_then(Value::as_str).unwrap_or("chapter");
    let limit = arguments
        .get("max_words")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(10, 200) as usize)
        .unwrap_or(80);

    let texts: Vec<String> = if scope == "book" {
        ensure_book_text(ctx, book_id)?;
        ctx.library
            .with(|conn| {
                let mut stmt =
                    conn.prepare("SELECT content FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
                let mut rows = stmt.query(rusqlite::params![book_id])?;
                let mut out = Vec::new();
                let mut budget = wordcloud::MAX_CHARS;
                while let Some(row) = rows.next()? {
                    if budget == 0 {
                        break;
                    }
                    let content: String = row.get(0)?;
                    budget = budget.saturating_sub(content.chars().count());
                    out.push(content);
                }
                Ok(out)
            })
            .map_err(|err| err.to_string())?
    } else {
        let chapter = arguments
            .get("chapter")
            .and_then(Value::as_i64)
            .or_else(|| ctx.max_chapter.map(|idx| idx as i64 + 1))
            .ok_or_else(|| "缺少 chapter".to_string())?;
        if chapter < 1 {
            return Err("章节号从 1 开始".into());
        }
        ensure_book_text(ctx, book_id)?;
        let content: Option<String> = ctx
            .library
            .with(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT content FROM chapters WHERE book_id = ?1 AND idx = ?2",
                        rusqlite::params![book_id, chapter - 1],
                        |row| row.get(0),
                    )
                    .ok())
            })
            .map_err(|err| err.to_string())?;
        vec![content.ok_or_else(|| format!("没有第 {chapter} 章"))?]
    };

    let words = wordcloud::top_words(texts.iter().map(String::as_str), limit);
    if words.is_empty() {
        return Err("这段正文里没有统计出可用的词".into());
    }

    let listed: Vec<String> =
        words.iter().take(20).map(|entry| format!("{}（{}）", entry.word, entry.count)).collect();
    Ok(ToolOutcome {
        view: ToolCallView {
            name: "wordcloud".into(),
            label: format!("词云（{}）", if scope == "book" { "全书" } else { "本章" }),
            detail: format!("{} 个词", words.len()),
            ok: true,
            sources: Vec::new(),
            mindmap: None,
            wordcloud: Some(words.clone()),
        },
        for_model: format!(
            "已生成词云并展示给读者，共 {} 个词。高频词依次是：{}。可以据此说一两句主题判断，不要逐个复述。",
            words.len(),
            listed.join("、")
        ),
    })
}

/// Drops a leading/trailing code fence, if the model wrapped its Markdown in one.
fn strip_fence(markdown: &str) -> String {
    let trimmed = markdown.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let without_open = trimmed.split_once('\n').map(|(_, rest)| rest).unwrap_or(trimmed);
    without_open.rsplit_once("```").map(|(body, _)| body).unwrap_or(without_open).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_described_and_has_required_arguments() {
        let defs = definitions();
        // Named rather than counted: a new tool is a decision about what the
        // model may do, and it should be made here as well as in `definitions`.
        assert_eq!(
            defs.iter().map(|def| def.function.name).collect::<Vec<_>>(),
            ["search_book", "read_chapter", "character", "mindmap", "wordcloud"],
        );
        for def in &defs {
            assert!(!def.function.description.is_empty(), "{}", def.function.name);
            assert_eq!(def.kind, "function");
            assert_eq!(def.function.parameters["type"], json!("object"));
            assert!(
                def.function.parameters["required"].as_array().is_some_and(|list| !list.is_empty()),
                "{} 没有声明必填参数",
                def.function.name
            );
        }
    }

    #[test]
    fn a_fenced_mind_map_is_unwrapped() {
        let fenced = "```markdown\n# 甲\n## 乙\n- 丙\n```";
        assert_eq!(strip_fence(fenced), "# 甲\n## 乙\n- 丙");
        assert_eq!(strip_fence("# 甲\n- 乙"), "# 甲\n- 乙");
    }

    #[test]
    fn a_mind_map_with_no_structure_is_refused() {
        let error = mindmap(&json!({ "title": "空", "markdown": "什么都没有" }));
        assert!(error.is_err());
    }

    #[test]
    fn a_mind_map_counts_its_nodes_and_reports_success() {
        let outcome = mindmap(&json!({
            "title": "人物",
            "markdown": "# 主角\n## 林昭\n- 冷静\n- 寡言\n"
        }))
        .expect("mindmap");
        assert_eq!(outcome.view.name, "mindmap");
        assert_eq!(outcome.view.detail, "4 个节点");
        assert!(outcome.view.ok);
        assert!(outcome.view.mindmap.is_some());
        assert!(outcome.for_model.contains("不要再用文字重复"));
    }

    #[test]
    fn a_failed_call_tells_the_model_why_and_marks_itself_bad() {
        let outcome = failed(
            &ToolCall { id: "1".into(), name: "search_book".into(), arguments: "{}".into() },
            "没有配置向量模型".into(),
        );
        assert!(!outcome.view.ok);
        assert_eq!(outcome.view.label, "检索 失败");
        assert_eq!(outcome.view.detail, "没有配置向量模型");
        assert!(outcome.for_model.starts_with("工具调用失败"));
    }

    #[test]
    fn every_tool_has_a_label_of_its_own() {
        for name in ["search_book", "read_chapter", "character", "mindmap", "wordcloud"] {
            assert_ne!(label_of(name), "工具", "{name} 缺一个标签");
        }
        assert_eq!(label_of("nope"), "工具");
    }

    #[test]
    fn a_card_says_what_the_entity_is_and_where_it_was_seen() {
        let relations = vec![
            GraphRelation {
                subject: "林昭".into(),
                relation: "拜师".into(),
                object: "玄清道人".into(),
                evidence: "他在山门前跪了三日".into(),
                chapter_idx: 2,
            },
            GraphRelation {
                subject: "苏晚".into(),
                relation: "认得".into(),
                object: "林昭".into(),
                evidence: String::new(),
                chapter_idx: 7,
            },
        ];
        let text = card_text("林昭", "人物", 42, &relations);

        assert!(text.starts_with("「林昭」（人物，全书提及 42 次）"), "{text}");
        // Both directions of the relation reach the card, with the chapter a
        // reader would be sent to.
        assert!(text.contains("- 林昭 拜师 玄清道人（第 3 章）：他在山门前跪了三日"), "{text}");
        assert!(text.contains("- 苏晚 认得 林昭（第 8 章）\n"), "{text}");
    }

    #[test]
    fn a_card_without_relations_says_so_rather_than_looking_empty() {
        let text = card_text("断剑", "物品", 1, &[]);
        assert!(text.contains("没有与它相关的关系"), "{text}");
        assert!(!text.contains("关系："), "{text}");
    }

    #[test]
    fn a_card_cuts_the_archive_and_says_how_much_it_cut() {
        let relations: Vec<GraphRelation> = (0..MAX_CARD_RELATIONS + 5)
            .map(|index| GraphRelation {
                subject: "林昭".into(),
                relation: format!("关系{index}"),
                object: "某人".into(),
                evidence: String::new(),
                chapter_idx: index,
            })
            .collect();
        let text = card_text("林昭", "人物", 200, &relations);

        assert!(text.contains(&format!("关系{}", MAX_CARD_RELATIONS - 1)), "{text}");
        assert!(
            !text.contains(&format!("关系{MAX_CARD_RELATIONS}（")),
            "超出上限的不该出现：{text}"
        );
        assert!(text.contains("还有 5 条关系未列出"), "{text}");
    }
}
