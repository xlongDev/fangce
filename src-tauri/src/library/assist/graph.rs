//! Book knowledge graph: LLM extraction over chapters, storage and lookup.
//!
//! Extraction reuses the streaming chat client — the answer is collected into
//! a string and parsed as JSON — instead of a second HTTP path for "structured
//! output". Storage is two plain tables and SQL joins, because a personal
//! library holds hundreds of nodes per book, not millions.

use std::collections::HashMap;

use futures_util::StreamExt as _;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::AiConfig;
use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};
use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Chapters shorter than this have nothing worth extracting; skipping them
/// saves an LLM call each.
const MIN_CHAPTER_CHARS: usize = 40;

/// How many chapters are extracted at once.
///
/// One call per chapter is the design — batching them into one prompt makes the
/// model blur two chapters together — but sequentially it is 76 calls in a row
/// for a normal book, which is minutes of a panel that looks stuck. Four at a
/// time is where the endpoint stops being the only thing happening, without
/// tripping the rate limits that the free endpoints enforce.
const CONCURRENCY: usize = 4;

/// A name longer than this is almost always the model pasting prose instead of
/// a name, so the merge step drops it.
const MAX_NAME_CHARS: usize = 30;

/// One extracted entity.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEntity {
    pub name: String,
    pub kind: String,
    pub mentions: usize,
}

/// One extracted relation, anchored to the chapter it first appeared in.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRelation {
    pub subject: String,
    pub relation: String,
    pub object: String,
    pub evidence: String,
    pub chapter_idx: usize,
}

/// What the frontend renders: all entities, or the neighborhood of one.
#[derive(specta::Type, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphView {
    /// All entities (top of the list by mentions) when `entity` is `None`.
    pub entities: Vec<GraphEntity>,
    /// Both directions of one entity's relations when `entity` is set.
    pub relations: Vec<GraphRelation>,
}

/// Raw extraction payload as the model returns it.
#[derive(Debug, Default, Deserialize)]
struct RawExtract {
    entities: Vec<RawEntity>,
    relations: Vec<RawRelation>,
}

#[derive(Debug, Deserialize)]
struct RawEntity {
    name: String,
    #[serde(default)]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct RawRelation {
    subject: String,
    relation: String,
    object: String,
    #[serde(default)]
    evidence: String,
}

/// Extraction instructions. The reply is demanded as bare JSON so the parser
/// never has to strip markdown fences — models that add them anyway are
/// handled by taking the first `{` to the last `}`.
fn build_prompt(content: &str) -> String {
    format!(
        "从下面的文本中抽取实体与关系。只输出一个 JSON 对象，格式：\n\
         {{\"entities\":[{{\"name\":\"名字\",\"kind\":\"人物|地点|组织|物品|概念\"}}],\
         \"relations\":[{{\"subject\":\"A\",\"relation\":\"关系短语\",\"object\":\"B\",\
         \"evidence\":\"原文依据\"}}]}}\n\
         只抽取文本明确出现的实体和关系，不要推断编造；关系短语不超过十个字。\n\n文本：\n{content}"
    )
}

/// Pulls the outermost JSON object out of a reply that may carry prose or
/// markdown fences around it.
fn parse_extract(text: &str) -> Option<RawExtract> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str(&text[start..=end]).ok()
}

/// Folds one chapter's extraction into the running totals. Mentions add up;
/// relations dedupe on (subject, relation, object) and keep the first
/// evidence, which is as good as any.
fn merge(
    entities: &mut HashMap<String, (String, usize)>,
    relations: &mut HashMap<(String, String, String), (String, usize)>,
    extracted: RawExtract,
    chapter_idx: usize,
) {
    for entity in extracted.entities {
        let name = entity.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            continue;
        }
        let kind = match entity.kind.trim() {
            "" => "其他",
            other => other,
        };
        let entry = entities.entry(name.to_string()).or_insert_with(|| (kind.to_string(), 0));
        entry.1 += 1;
    }
    for relation in extracted.relations {
        let key = (
            relation.subject.trim().to_string(),
            relation.relation.trim().to_string(),
            relation.object.trim().to_string(),
        );
        if key.0.is_empty() || key.1.is_empty() || key.2.is_empty() {
            continue;
        }
        if key.0.chars().count() > MAX_NAME_CHARS || key.2.chars().count() > MAX_NAME_CHARS {
            continue;
        }
        relations.entry(key).or_insert_with(|| (relation.evidence.trim().to_string(), chapter_idx));
    }
}

/// Asks the model to extract one chapter and parses the reply.
async fn extract_chapter(
    client: &reqwest::Client,
    config: &AiConfig,
    content: &str,
) -> AppResult<RawExtract> {
    let mut reply = String::new();
    chat::stream_chat(
        client,
        config,
        vec![ChatMessage::new(Role::User, build_prompt(content))],
        None,
        &mut |event| {
            if let StreamEvent::Delta(delta) = event {
                reply.push_str(&delta);
            }
            // Not interruptible: this is a one-shot extraction behind a
            // "generate the graph" button, and half a JSON document is useless.
            true
        },
    )
    .await?;
    parse_extract(&reply).ok_or_else(|| {
        AppError::Message("模型没有返回可解析的 JSON，换一个更擅长指令跟随的模型再试".into())
    })
}

/// Replaces the whole graph of one book inside a transaction.
fn replace(
    library: &Library,
    book_id: &str,
    entities: &[GraphEntity],
    relations: &[GraphRelation],
) -> AppResult<()> {
    library.with_tx(|tx| {
        tx.execute("DELETE FROM entities WHERE book_id = ?1", params![book_id])?;
        tx.execute("DELETE FROM entity_relations WHERE book_id = ?1", params![book_id])?;
        for entity in entities {
            tx.execute(
                "INSERT INTO entities (book_id, name, kind, mentions) VALUES (?1, ?2, ?3, ?4)",
                params![book_id, entity.name, entity.kind, entity.mentions as i64],
            )?;
        }
        for relation in relations {
            tx.execute(
                "INSERT INTO entity_relations (book_id, subject, relation, object, evidence, \
                 chapter_idx) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    book_id,
                    relation.subject,
                    relation.relation,
                    relation.object,
                    relation.evidence,
                    relation.chapter_idx as i64
                ],
            )?;
        }
        Ok(())
    })
}

/// Builds the graph for one book: extract chapter by chapter, fold, replace.
///
/// `on_progress` reports `(done, total)` chapter counts. A failed chapter
/// aborts the build and leaves the previous graph untouched — the replacement
/// runs only after every chapter succeeded.
/// What one build produced.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBuildReport {
    pub entities: usize,
    pub relations: usize,
    /// Chapters whose reply could not be parsed. Non-zero means the graph is
    /// thinner than the book for those chapters — worth saying out loud rather
    /// than shipping a quietly incomplete graph.
    pub skipped: usize,
    pub chapters: usize,
}

pub async fn build(
    library: &Library,
    client: &reqwest::Client,
    config: &AiConfig,
    book_id: &str,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> AppResult<GraphBuildReport> {
    if !crate::ai::is_ready(config) {
        return Err(AppError::InvalidArgument(
            "还没有配置 AI 模型，先到设置里填写接口地址与模型名称".into(),
        ));
    }
    // The graph extracts entities out of chapter *text*, so the deferred
    // extraction has to be paid here: on a freshly imported PDF the chapters
    // exist but are empty, and a graph over nothing is an empty graph.
    crate::library::chapters::ensure_text(library, book_id)?;

    let chapters: Vec<(usize, String)> = library.with(|conn| {
        let mut stmt =
            conn.prepare("SELECT idx, content FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
        let mut rows = stmt.query(params![book_id])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push((row.get::<_, i64>(0)? as usize, row.get::<_, String>(1)?));
        }
        Ok(out)
    })?;
    if chapters.is_empty() {
        return Err(AppError::InvalidArgument("这本书没有正文，无法抽取".into()));
    }

    let total = chapters.len();
    let mut entity_totals: HashMap<String, (String, usize)> = HashMap::new();
    let mut relation_totals: HashMap<(String, String, String), (String, usize)> = HashMap::new();

    // One bad reply used to abort the build, throwing away every chapter that
    // had already been extracted — which is why a 76-chapter book never got
    // past chapter 2. A chapter that fails is now counted and skipped, and the
    // report says how many.
    let mut stream = futures_util::stream::iter(chapters)
        .map(|(idx, content)| async move {
            if content.trim().chars().count() < MIN_CHAPTER_CHARS {
                return (idx, None);
            }
            (idx, Some(extract_chapter(client, config, &content).await))
        })
        .buffer_unordered(CONCURRENCY);

    let mut extracted = 0usize;
    let mut skipped = 0usize;
    let mut last_error: Option<AppError> = None;
    let mut done = 0usize;
    while let Some((idx, result)) = stream.next().await {
        match result {
            None => {}
            Some(Ok(raw)) => {
                merge(&mut entity_totals, &mut relation_totals, raw, idx);
                extracted += 1;
            }
            Some(Err(err)) => {
                skipped += 1;
                tracing::warn!(idx, error = %err, "这一章没抽出来，跳过");
                last_error = Some(err);
            }
        }
        done += 1;
        on_progress(done, total);
    }

    // Nothing at all came back: the endpoint is wrong, the key is wrong, or the
    // model cannot follow instructions. Writing an empty graph over a good one
    // would be the worst possible outcome, so this is an error.
    if extracted == 0 {
        return Err(last_error.unwrap_or_else(|| {
            AppError::Message("这本书没有可抽取的正文，检查章节是否已解析".into())
        }));
    }

    let mut entities: Vec<GraphEntity> = entity_totals
        .into_iter()
        .map(|(name, (kind, mentions))| GraphEntity { name, kind, mentions })
        .collect();
    entities.sort_by(|a, b| b.mentions.cmp(&a.mentions).then_with(|| a.name.cmp(&b.name)));
    let relations: Vec<GraphRelation> = relation_totals
        .into_iter()
        .map(|((subject, relation, object), (evidence, chapter_idx))| GraphRelation {
            subject,
            relation,
            object,
            evidence,
            chapter_idx,
        })
        .collect();

    replace(library, book_id, &entities, &relations)?;
    tracing::info!(
        book_id,
        entities = entities.len(),
        relations = relations.len(),
        skipped,
        "图谱已重建"
    );
    Ok(GraphBuildReport {
        entities: entities.len(),
        relations: relations.len(),
        skipped,
        chapters: total,
    })
}

/// Stored node and edge counts for one book.
pub fn counts(conn: &Connection, book_id: &str) -> AppResult<(usize, usize)> {
    let entities: i64 = conn.query_row(
        "SELECT COUNT(*) FROM entities WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;
    let relations: i64 = conn.query_row(
        "SELECT COUNT(*) FROM entity_relations WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;
    Ok((entities as usize, relations as usize))
}

/// The whole entity list, or the neighborhood of one entity.
/// One entity's own row, or `None` when the graph has never seen the name.
///
/// `query` returns either the whole list or one entity's relations; neither
/// carries a single entity's kind, and a card without one says nothing about
/// what it is.
pub fn entity(conn: &Connection, book_id: &str, name: &str) -> AppResult<Option<GraphEntity>> {
    let mut stmt =
        conn.prepare("SELECT name, kind, mentions FROM entities WHERE book_id = ?1 AND name = ?2")?;
    let mut rows = stmt.query(params![book_id, name])?;
    match rows.next()? {
        Some(row) => Ok(Some(GraphEntity {
            name: row.get(0)?,
            kind: row.get(1)?,
            mentions: row.get::<_, i64>(2)? as usize,
        })),
        None => Ok(None),
    }
}

/// The kind every character card carries. The extractor prompt above spells it
/// the same way, and the card wall filters on it, so the two must not drift.
pub const CHARACTER_KIND: &str = "人物";

/// The book's characters, most-mentioned first — the order the card wall shows.
pub fn characters(conn: &Connection, book_id: &str) -> AppResult<Vec<GraphEntity>> {
    let mut stmt = conn.prepare(
        "SELECT name, kind, mentions FROM entities
          WHERE book_id = ?1 AND kind = ?2
          ORDER BY mentions DESC, name",
    )?;
    let mut rows = stmt.query(params![book_id, CHARACTER_KIND])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(GraphEntity {
            name: row.get(0)?,
            kind: row.get(1)?,
            mentions: row.get::<_, i64>(2)? as usize,
        });
    }
    Ok(out)
}

/// Adds a character the extractor never found — the reader knows someone the
/// graph does not.
///
/// Idempotent: a name already in the graph is promoted to 人物 rather than
/// duplicated, because `entities` is unique on (book_id, name).
pub fn add_character(conn: &Connection, book_id: &str, name: &str) -> AppResult<GraphEntity> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidArgument("角色名不能为空".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::InvalidArgument(format!("名字太长了（上限 {MAX_NAME_CHARS} 字）")));
    }
    conn.execute(
        "INSERT INTO entities (book_id, name, kind, mentions) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT (book_id, name) DO UPDATE SET kind = ?3",
        params![book_id, name, CHARACTER_KIND],
    )?;
    entity(conn, book_id, name)?.ok_or_else(|| AppError::Message("刚写入的角色读不回来".into()))
}

/// Removes every character card of one book, returning the names that went.
///
/// The relations that named them go too: a relation whose subject is gone would
/// keep the name alive in the graph panel as a dangling edge.
pub fn clear_characters(conn: &Connection, book_id: &str) -> AppResult<Vec<String>> {
    let names: Vec<String> = characters(conn, book_id)?.into_iter().map(|e| e.name).collect();
    if names.is_empty() {
        return Ok(names);
    }
    let tx = conn.unchecked_transaction()?;
    for name in &names {
        tx.execute(
            "DELETE FROM entity_relations WHERE book_id = ?1 AND (subject = ?2 OR object = ?2)",
            params![book_id, name],
        )?;
    }
    tx.execute(
        "DELETE FROM entities WHERE book_id = ?1 AND kind = ?2",
        params![book_id, CHARACTER_KIND],
    )?;
    tx.commit()?;
    Ok(names)
}

/// The whole entity list, or the neighborhood of one entity.
///
/// `max_chapter` keeps a spoiler-safe panel inside the reader's position: a
/// relation carries the chapter it was first seen in, and its `evidence` is a
/// line of that chapter's text. Only relations are filtered. An entity is a
/// name and a mention count, which says nothing about what happens later, and
/// hiding the names would leave a graph panel that looks empty at chapter one.
pub fn query(
    conn: &Connection,
    book_id: &str,
    entity: Option<&str>,
    max_chapter: Option<usize>,
) -> AppResult<GraphView> {
    let mut view = GraphView::default();
    match entity {
        None => {
            let mut stmt = conn.prepare(
                "SELECT name, kind, mentions FROM entities WHERE book_id = ?1
                  ORDER BY mentions DESC, name LIMIT 200",
            )?;
            let mut rows = stmt.query(params![book_id])?;
            while let Some(row) = rows.next()? {
                view.entities.push(GraphEntity {
                    name: row.get(0)?,
                    kind: row.get(1)?,
                    mentions: row.get::<_, i64>(2)? as usize,
                });
            }
        }
        Some(name) => {
            let mut stmt = conn.prepare(
                "SELECT subject, relation, object, evidence, chapter_idx FROM entity_relations
                  WHERE book_id = ?1 AND (subject = ?2 OR object = ?2)
                    AND chapter_idx <= COALESCE(?3, chapter_idx)
                  ORDER BY chapter_idx LIMIT 100",
            )?;
            // NULL means "no limit": comparing a column with itself is always
            // true, so the reader who left 防剧透 off gets the whole graph
            // without a second prepared statement.
            let limit = max_chapter.map(|idx| idx as i64);
            let mut rows = stmt.query(params![book_id, name, limit])?;
            while let Some(row) = rows.next()? {
                view.relations.push(GraphRelation {
                    subject: row.get(0)?,
                    relation: row.get(1)?,
                    object: row.get(2)?,
                    evidence: row.get(3)?,
                    chapter_idx: row.get::<_, i64>(4)? as usize,
                });
            }
        }
    }
    Ok(view)
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
            library
                .with(|conn| {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, \
                         file_path, file_size, added_at, updated_at) \
                         VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
                        [],
                    )?;
                    Ok(())
                })
                .expect("insert book");
            Self { dir, library }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn extract(text: &str) -> RawExtract {
        parse_extract(text).expect("extraction must parse")
    }

    #[test]
    fn a_bare_json_reply_parses() {
        let reply = r#"{"entities":[{"name":"林黛玉","kind":"人物"}],"relations":[]}"#;
        let extracted = extract(reply);
        assert_eq!(extracted.entities.len(), 1);
        assert_eq!(extracted.entities[0].name, "林黛玉");
    }

    #[test]
    fn prose_and_fences_around_the_json_are_tolerated() {
        let reply = "好的，以下是抽取结果：\n```json\n{\"entities\":[{\"name\":\"贾宝玉\",\
                     \"kind\":\"人物\"}],\"relations\":[]}\n```\n希望有帮助。";
        assert_eq!(extract(reply).entities[0].name, "贾宝玉");
    }

    #[test]
    fn unknown_fields_are_ignored_and_missing_ones_default() {
        let reply = r#"{"entities":[{"name":"大观园","kind":"地点","note":"x"}],
            "relations":[{"subject":"a","relation":"在","object":"b"}]}"#;
        let extracted = extract(reply);
        assert_eq!(extracted.entities[0].kind, "地点");
        assert_eq!(extracted.relations[0].evidence, "");
    }

    #[test]
    fn a_reply_without_json_is_rejected() {
        assert!(parse_extract("我做不到。").is_none());
        assert!(parse_extract("{oops").is_none());
    }

    #[test]
    fn merge_accumulates_mentions_and_dedupes_relations() {
        let mut entities = HashMap::new();
        let mut relations = HashMap::new();

        merge(
            &mut entities,
            &mut relations,
            extract(
                r#"{"entities":[{"name":"林黛玉","kind":"人物"},{"name":"贾宝玉","kind":"人物"}],
                "relations":[{"subject":"林黛玉","relation":"爱","object":"贾宝玉","evidence":"_e1"}]}"#,
            ),
            0,
        );
        // Same relation named again in a later chapter: mentions add up, the
        // first evidence stays.
        merge(
            &mut entities,
            &mut relations,
            extract(
                r#"{"entities":[{"name":"林黛玉","kind":"人物"}],
                "relations":[{"subject":"林黛玉","relation":"爱","object":"贾宝玉","evidence":"_e2"}]}"#,
            ),
            3,
        );

        assert_eq!(entities["林黛玉"].1, 2, "mentions 累加");
        assert_eq!(entities["贾宝玉"].1, 1);
        let (evidence, chapter) =
            relations.get(&("林黛玉".into(), "爱".into(), "贾宝玉".into())).expect("relation kept");
        assert_eq!((evidence.as_str(), chapter), ("_e1", &0));
    }

    #[test]
    fn merge_drops_junk_entries() {
        let mut entities = HashMap::new();
        let mut relations = HashMap::new();
        let long_name = "长".repeat(MAX_NAME_CHARS + 1);
        merge(
            &mut entities,
            &mut relations,
            extract(&format!(
                r#"{{"entities":[{{"name":"","kind":"人物"}},{{"name":"{long_name}","kind":"人物"}}],
                    "relations":[{{"subject":"","relation":"在","object":"b"}},{{"subject":"a","relation":"","object":"b"}}]}}"#
            )),
            0,
        );
        assert!(entities.is_empty(), "空名与超长名都丢弃");
        assert!(relations.is_empty(), "缺字段的丢弃");
    }

    #[test]
    fn a_rebuilt_graph_replaces_and_queries_back() {
        let harness = Harness::new("graph-roundtrip");
        let entities = vec![
            GraphEntity { name: "孙悟空".into(), kind: "人物".into(), mentions: 3 },
            GraphEntity { name: "花果山".into(), kind: "地点".into(), mentions: 1 },
        ];
        let relations = vec![GraphRelation {
            subject: "孙悟空".into(),
            relation: "出身于".into(),
            object: "花果山".into(),
            evidence: "花果山福地".into(),
            chapter_idx: 1,
        }];
        replace(&harness.library, "b", &entities, &relations).expect("replace");
        assert_eq!(harness.library.with(|conn| counts(conn, "b")).expect("counts"), (2, 1));

        let all = harness.library.with(|conn| query(conn, "b", None, None)).expect("query all");
        assert_eq!(all.entities.len(), 2);
        assert_eq!(all.entities[0].name, "孙悟空", "按 mentions 排序");
        assert!(all.relations.is_empty());

        let around =
            harness.library.with(|conn| query(conn, "b", Some("花果山"), None)).expect("query one");
        assert_eq!(around.relations.len(), 1, "object 方向也命中");
        assert_eq!(around.relations[0].subject, "孙悟空");

        // Rebuild with less data and nothing from the old graph survives.
        replace(&harness.library, "b", &entities[..1], &[]).expect("replace again");
        assert_eq!(harness.library.with(|conn| counts(conn, "b")).expect("counts"), (1, 0));
    }

    #[test]
    fn a_spoiler_safe_query_keeps_names_but_drops_later_relations() {
        let harness = Harness::new("graph-spoiler");
        let entities = vec![
            GraphEntity { name: "孙悟空".into(), kind: "人物".into(), mentions: 3 },
            GraphEntity { name: "花果山".into(), kind: "地点".into(), mentions: 1 },
        ];
        let relations = vec![
            GraphRelation {
                subject: "孙悟空".into(),
                relation: "出身于".into(),
                object: "花果山".into(),
                evidence: "花果山福地".into(),
                chapter_idx: 1,
            },
            GraphRelation {
                subject: "孙悟空".into(),
                relation: "大闹".into(),
                object: "花果山".into(),
                evidence: "后文才发生的事".into(),
                chapter_idx: 40,
            },
        ];
        replace(&harness.library, "b", &entities, &relations).expect("replace");

        let safe =
            harness.library.with(|conn| query(conn, "b", Some("孙悟空"), Some(2))).expect("query");
        assert_eq!(safe.relations.len(), 1, "读到第 2 章时不该看到第 40 章的证据");
        assert_eq!(safe.relations[0].chapter_idx, 1);

        // Entities are deliberately not filtered: a name is not a plot point,
        // and hiding them would leave the panel empty at chapter one.
        let all = harness.library.with(|conn| query(conn, "b", None, Some(2))).expect("query all");
        assert_eq!(all.entities.len(), 2);

        // No limit is the old behaviour, unchanged.
        let whole =
            harness.library.with(|conn| query(conn, "b", Some("孙悟空"), None)).expect("query");
        assert_eq!(whole.relations.len(), 2);
    }

    #[test]
    fn a_manual_character_joins_the_wall_and_clearing_takes_its_edges() {
        let harness = Harness::new("graph-characters");
        let entities = vec![
            GraphEntity { name: "孙悟空".into(), kind: "人物".into(), mentions: 3 },
            GraphEntity { name: "花果山".into(), kind: "地点".into(), mentions: 1 },
        ];
        let relations = vec![GraphRelation {
            subject: "孙悟空".into(),
            relation: "出身于".into(),
            object: "花果山".into(),
            evidence: "花果山福地".into(),
            chapter_idx: 1,
        }];
        replace(&harness.library, "b", &entities, &relations).expect("replace");

        let wall = harness.library.with(|conn| characters(conn, "b")).expect("characters");
        assert_eq!(wall.len(), 1, "只有人物上墙：{wall:?}");
        assert_eq!(wall[0].name, "孙悟空");

        let added = harness.library.with(|conn| add_character(conn, "b", " 白骨精 ")).expect("add");
        assert_eq!(added.name, "白骨精", "名字去掉空白");
        assert_eq!(added.kind, CHARACTER_KIND);
        // The same name twice is one card, not two.
        harness.library.with(|conn| add_character(conn, "b", "白骨精")).expect("add twice");
        assert_eq!(harness.library.with(|conn| characters(conn, "b")).expect("wall").len(), 2);

        let removed = harness.library.with(|conn| clear_characters(conn, "b")).expect("clear");
        assert_eq!(removed.len(), 2);
        let (left, edges) = harness.library.with(|conn| counts(conn, "b")).expect("counts");
        assert_eq!((left, edges), (1, 0), "地点留着，人物的关系一并删掉");
    }
}
