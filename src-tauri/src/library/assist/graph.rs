//! Book knowledge graph: LLM extraction over chapters, storage and lookup.
//!
//! Extraction reuses the streaming chat client — the answer is collected into
//! a string and parsed as JSON — instead of a second HTTP path for "structured
//! output". Storage is two plain tables and SQL joins, because a personal
//! library holds hundreds of nodes per book, not millions.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::AiConfig;
use crate::ai::chat::{self, ChatMessage, Role, StreamEvent};
use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Chapters shorter than this have nothing worth extracting; skipping them
/// saves an LLM call each.
const MIN_CHAPTER_CHARS: usize = 40;

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
pub async fn build(
    library: &Library,
    client: &reqwest::Client,
    config: &AiConfig,
    book_id: &str,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> AppResult<usize> {
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
    for (done, (idx, content)) in chapters.iter().enumerate() {
        if content.trim().chars().count() >= MIN_CHAPTER_CHARS {
            let extracted = extract_chapter(client, config, content).await?;
            merge(&mut entity_totals, &mut relation_totals, extracted, *idx);
        }
        on_progress(done + 1, total);
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
    tracing::info!(book_id, entities = entities.len(), relations = relations.len(), "图谱已重建");
    Ok(entities.len())
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
pub fn query(conn: &Connection, book_id: &str, entity: Option<&str>) -> AppResult<GraphView> {
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
                  ORDER BY chapter_idx LIMIT 100",
            )?;
            let mut rows = stmt.query(params![book_id, name])?;
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

        let all = harness.library.with(|conn| query(conn, "b", None)).expect("query all");
        assert_eq!(all.entities.len(), 2);
        assert_eq!(all.entities[0].name, "孙悟空", "按 mentions 排序");
        assert!(all.relations.is_empty());

        let around =
            harness.library.with(|conn| query(conn, "b", Some("花果山"))).expect("query one");
        assert_eq!(around.relations.len(), 1, "object 方向也命中");
        assert_eq!(around.relations[0].subject, "孙悟空");

        // Rebuild with less data and nothing from the old graph survives.
        replace(&harness.library, "b", &entities[..1], &[]).expect("replace again");
        assert_eq!(harness.library.with(|conn| counts(conn, "b")).expect("counts"), (1, 0));
    }
}
