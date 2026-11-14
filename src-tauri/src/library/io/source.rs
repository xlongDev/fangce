//! Online book sources: JSON rule definitions that describe how to search a
//! website's API, read a book's detail, list chapters and fetch content.
//!
//! The rule language is a deliberately tiny JSONPath subset, `$.a.b[*].c`:
//! enough to express real sources, small enough to audit at a glance. Download
//! walks the chapter list, assembles one TXT with `第N章` markers and hands it
//! to the ordinary import pipeline, so dedupe, hashing and chapter splitting
//! are all reused rather than reimplemented.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::net::Hosts;

/// How one search call finds books.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchRules {
    /// Request path; `{{keyword}}` is replaced by the percent-encoded query.
    pub url: String,
    /// Rule locating the array of result items.
    pub list: String,
    pub title: String,
    pub author: String,
    pub intro: String,
    pub cover: String,
    /// Rule locating the book-detail URL (relative or absolute).
    pub book_url: String,
}

/// How one book-detail call reads the metadata.
#[derive(specta::Type, Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BookRules {
    pub title: String,
    pub author: String,
    pub intro: String,
    pub cover: String,
}

/// How one chapter-list call finds chapters.
#[derive(specta::Type, Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChapterRules {
    pub list: String,
    pub title: String,
    pub url: String,
}

/// How one content call yields body text: a string (split on newlines) or an
/// array of paragraph strings.
#[derive(specta::Type, Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContentRules {
    pub paragraphs: String,
}

/// What one source is allowed to reach beyond its own host.
///
/// A source is a plugin, in the only sense this app needs: a definition
/// somebody else wrote, running with the reader's network. The base host is
/// implicit; anything else has to be declared here.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Permissions {
    /// Extra hosts the rule data may name — a CDN, a second API host. Hosts
    /// only: no scheme, no path, no `*`.
    pub hosts: Vec<String>,
}

/// One complete source definition, stored as JSON in the `sources` table.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceDef {
    pub name: String,
    pub base_url: String,
    pub permissions: Permissions,
    pub search: SearchRules,
    pub book: BookRules,
    pub chapters: ChapterRules,
    pub content: ContentRules,
}

impl SourceDef {
    /// The hosts this definition may talk to, base host included.
    pub fn hosts(&self) -> AppResult<Hosts> {
        Hosts::new(&self.base_url, &self.permissions.hosts)
    }

    /// Fails fast on a definition that cannot possibly work, before any
    /// network round trip.
    pub fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::InvalidArgument("书源名称不能为空".into()));
        }
        // A source is a third-party definition the reader pasted; its base URL
        // is where every search term they type ends up. Same rule as the AI
        // endpoint, same code (`crate::net`) — the opener plugin's URL
        // allowlist does not reach a reqwest request made from here.
        self.hosts()?;
        for (label, rule) in [
            ("搜索地址", &self.search.url),
            ("搜索结果列表", &self.search.list),
            ("搜索书名", &self.search.title),
            ("详情链接", &self.search.book_url),
            ("章节列表", &self.chapters.list),
            ("章节标题", &self.chapters.title),
            ("章节链接", &self.chapters.url),
            ("正文", &self.content.paragraphs),
        ] {
            if rule.trim().is_empty() {
                return Err(AppError::InvalidArgument(format!("{label}规则不能为空")));
            }
        }
        Ok(())
    }
}

/// A book as a search result or detail response describes it.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBook {
    pub title: String,
    pub author: String,
    pub intro: String,
    pub cover: String,
    /// Book-detail URL, absolute or relative to the source's base URL.
    pub url: String,
}

/// One chapter of a book's table of contents.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
pub struct SourceChapter {
    pub title: String,
    /// Absolute URL; resolved when the list is fetched.
    pub url: String,
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Token {
    Field(String),
    Wildcard,
}

/// Parses `$.a.b[*].c`. The leading `$.` is conventional but optional, so a
/// pasted path without it still works.
fn parse_rule(rule: &str) -> AppResult<Vec<Token>> {
    let trimmed = rule.trim();
    let mut rest = trimmed.strip_prefix("$.").unwrap_or(trimmed);
    let mut tokens = Vec::new();
    while !rest.is_empty() {
        if let Some(remainder) = rest.strip_prefix("[*].") {
            tokens.push(Token::Wildcard);
            rest = remainder;
            continue;
        }
        if rest == "[*]" {
            tokens.push(Token::Wildcard);
            break;
        }
        let end = rest.find(['.', '[']).unwrap_or(rest.len());
        let field = &rest[..end];
        if field.is_empty() {
            return Err(AppError::InvalidArgument(format!("规则语法错误：{trimmed}")));
        }
        tokens.push(Token::Field(field.to_string()));
        rest = rest[end..].strip_prefix('.').unwrap_or(&rest[end..]);
    }
    if tokens.is_empty() {
        return Err(AppError::InvalidArgument(format!("规则不能为空：{trimmed}")));
    }
    Ok(tokens)
}

fn walk(tokens: &[Token], value: &Value, out: &mut Vec<Value>) {
    let Some((first, rest)) = tokens.split_first() else {
        out.push(value.clone());
        return;
    };
    match first {
        Token::Field(name) => {
            if let Some(next) = value.get(name) {
                walk(rest, next, out);
            }
        }
        Token::Wildcard => {
            if let Value::Array(items) = value {
                for item in items {
                    walk(rest, item, out);
                }
            }
        }
    }
}

/// Evaluates a rule against a JSON value; zero matches is an empty list, not
/// an error, so optional fields degrade to empty strings.
fn evaluate(rule: &str, value: &Value) -> AppResult<Vec<Value>> {
    let tokens = parse_rule(rule)?;
    let mut out = Vec::new();
    walk(&tokens, value, &mut out);
    Ok(out)
}

/// First match rendered as text; arrays join their string items with newlines
/// so a paragraph-list rule reads naturally in the content step.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            items.iter().filter_map(|item| item.as_str()).collect::<Vec<_>>().join("\n")
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn first_text(rule: &str, value: &Value) -> AppResult<String> {
    Ok(evaluate(rule, value)?.first().map(text_of).unwrap_or_default())
}

/// Optional field: a broken or absent rule yields an empty string instead of
/// failing the whole item.
fn optional_text(rule: &str, value: &Value) -> String {
    first_text(rule, value).unwrap_or_default()
}

/// Splits evaluated content text into clean paragraphs.
fn paragraphs_of(rule: &str, value: &Value) -> AppResult<Vec<String>> {
    let mut paragraphs = Vec::new();
    for matched in evaluate(rule, value)? {
        for line in text_of(&matched).lines() {
            let line = line.trim();
            if !line.is_empty() {
                paragraphs.push(line.to_string());
            }
        }
    }
    Ok(paragraphs)
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/// Percent-encodes everything outside the unreserved set; no extra dependency.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Joins the source's base URL with a rule-provided path; an absolute URL in
/// the data wins, which is how pagination and CDN hosts keep working.
fn full_url(base_url: &str, path: &str) -> String {
    let path = path.trim();
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn search_url(def: &SourceDef, keyword: &str) -> String {
    full_url(&def.base_url, &def.search.url.replace("{{keyword}}", &encode_component(keyword)))
}

// ---------------------------------------------------------------------------
// Fetches
// ---------------------------------------------------------------------------

async fn fetch_json(client: &reqwest::Client, hosts: &Hosts, url: &str) -> AppResult<Value> {
    let url = hosts.check(url)?;
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|err| AppError::Message(format!("请求失败：{err}")))?;
    response.json().await.map_err(|err| AppError::Message(format!("响应不是合法 JSON：{err}")))
}

/// `search` — keyword lookup against the source's search endpoint.
pub async fn search(
    client: &reqwest::Client,
    def: &SourceDef,
    hosts: &Hosts,
    keyword: &str,
) -> AppResult<Vec<SourceBook>> {
    let value = fetch_json(client, hosts, &search_url(def, keyword)).await?;
    let items = evaluate(&def.search.list, &value)?;
    let mut books = Vec::with_capacity(items.len());
    for item in &items {
        let title = first_text(&def.search.title, item)?;
        if title.trim().is_empty() {
            continue;
        }
        books.push(SourceBook {
            title,
            author: optional_text(&def.search.author, item),
            intro: optional_text(&def.search.intro, item),
            cover: optional_text(&def.search.cover, item),
            url: optional_text(&def.search.book_url, item),
        });
    }
    Ok(books)
}

/// `getBook` — book detail for a URL from the search results.
pub async fn book_detail(
    client: &reqwest::Client,
    def: &SourceDef,
    hosts: &Hosts,
    book_url: &str,
) -> AppResult<SourceBook> {
    let value = fetch_json(client, hosts, &full_url(&def.base_url, book_url)).await?;
    Ok(SourceBook {
        title: first_text(&def.book.title, &value)?,
        author: optional_text(&def.book.author, &value),
        intro: optional_text(&def.book.intro, &value),
        cover: optional_text(&def.book.cover, &value),
        url: book_url.to_string(),
    })
}

/// `getChapters` — the table of contents, URLs resolved to absolute.
pub async fn chapters(
    client: &reqwest::Client,
    def: &SourceDef,
    hosts: &Hosts,
    book_url: &str,
) -> AppResult<Vec<SourceChapter>> {
    let value = fetch_json(client, hosts, &full_url(&def.base_url, book_url)).await?;
    let items = evaluate(&def.chapters.list, &value)?;
    let mut list = Vec::with_capacity(items.len());
    for item in &items {
        let title = first_text(&def.chapters.title, item)?;
        let url = first_text(&def.chapters.url, item)?;
        if title.trim().is_empty() || url.trim().is_empty() {
            continue;
        }
        list.push(SourceChapter { title, url: full_url(&def.base_url, &url) });
    }
    Ok(list)
}

/// `getChapterContent` — the body text of one chapter as clean paragraphs.
pub async fn content(
    client: &reqwest::Client,
    def: &SourceDef,
    hosts: &Hosts,
    chapter_url: &str,
) -> AppResult<Vec<String>> {
    let value = fetch_json(client, hosts, chapter_url).await?;
    paragraphs_of(&def.content.paragraphs, &value)
}

/// Assembles the downloaded book as one TXT the importer will split by its
/// `第N章` marker. Titles that already carry a marker pass through untouched.
fn build_txt(title: &str, author: &str, chapters: &[(String, Vec<String>)]) -> String {
    let mut out = format!("{title}\n");
    if !author.trim().is_empty() {
        out.push_str(&format!("作者：{}\n", author.trim()));
    }
    for (index, (chapter_title, paragraphs)) in chapters.iter().enumerate() {
        let heading = if chapter_title.starts_with('第') {
            chapter_title.clone()
        } else {
            format!("第{}章 {}", index + 1, chapter_title)
        };
        out.push_str("\n\n");
        out.push_str(&heading);
        for paragraph in paragraphs {
            out.push_str("\n\n");
            out.push_str(paragraph);
        }
    }
    out
}

/// The download outcome: the shelf entry that was created (or was already
/// there, when the same bytes were downloaded before).
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub book_id: String,
    pub title: String,
    pub duplicate: bool,
}

/// `download` — walks the whole book, writes a staged TXT and runs the
/// ordinary import pipeline over it, then removes the staging copy. The
/// pipeline's dedupe and hash rules apply unchanged.
///
/// The callback is a generic `Send` bound rather than `dyn FnMut`: the future
/// must stay `Send` for Tauri, and the callback lives across awaits.
pub async fn download(
    library: &crate::db::Library,
    layout: &crate::db::Layout,
    client: &reqwest::Client,
    def: &SourceDef,
    hosts: &Hosts,
    book_url: &str,
    on_progress: &mut (impl FnMut(usize, usize, &str) + Send),
) -> AppResult<Downloaded> {
    let detail = book_detail(client, def, hosts, book_url).await?;
    let title = if detail.title.trim().is_empty() { "未命名".into() } else { detail.title };
    let list = chapters(client, def, hosts, book_url).await?;
    if list.is_empty() {
        return Err(AppError::Message("章节列表为空，检查章节列表规则".into()));
    }

    let mut collected: Vec<(String, Vec<String>)> = Vec::with_capacity(list.len());
    for (index, chapter) in list.iter().enumerate() {
        let paragraphs = match content(client, def, hosts, &chapter.url).await {
            Ok(paragraphs) if !paragraphs.is_empty() => paragraphs,
            Ok(_) => vec![format!("（本章内容为空：{}）", chapter.title)],
            Err(err) => {
                return Err(AppError::Message(format!("第 {} 章下载失败：{err}", index + 1)));
            }
        };
        on_progress(index + 1, list.len(), &chapter.title);
        collected.push((chapter.title.clone(), paragraphs));
    }

    let staged = layout.books_dir.join(format!("download-{}.txt", Uuid::new_v4()));
    std::fs::write(&staged, build_txt(&title, &detail.author, &collected))?;

    let outcome = crate::library::import::import_files(
        library,
        layout,
        std::slice::from_ref(&staged),
        None,
        &|_, _, _| {},
    );
    if let Err(err) = std::fs::remove_file(&staged) {
        tracing::warn!(path = %staged.display(), error = %err, "清理下载暂存文件失败");
    }

    match &outcome[0] {
        crate::library::import::ImportOutcome::Imported { id, .. } => {
            Ok(Downloaded { book_id: id.clone(), title, duplicate: false })
        }
        crate::library::import::ImportOutcome::Duplicate { id, .. } => {
            Ok(Downloaded { book_id: id.clone(), title, duplicate: true })
        }
        crate::library::import::ImportOutcome::Failed { message, .. } => {
            Err(AppError::Message(format!("下载内容入库失败：{message}")))
        }
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// One stored source, definition included so the editor can round-trip it.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEntry {
    pub id: String,
    pub name: String,
    pub def: SourceDef,
}

pub fn list(conn: &rusqlite::Connection) -> AppResult<Vec<SourceEntry>> {
    let mut stmt = conn.prepare("SELECT id, name, rules FROM sources ORDER BY created_at")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, name, rules) = row?;
        let def = serde_json::from_str(&rules)
            .map_err(|err| AppError::Message(format!("书源 {name} 的规则不是合法定义：{err}")))?;
        entries.push(SourceEntry { id, name, def });
    }
    Ok(entries)
}

pub fn load(library: &crate::db::Library, id: &str) -> AppResult<SourceDef> {
    library.with(|conn| {
        let rules: String = conn
            .query_row("SELECT rules FROM sources WHERE id = ?1", [id], |row| row.get(0))
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("书源 {id} 不存在"))
                }
                other => AppError::from(other),
            })?;
        serde_json::from_str(&rules)
            .map_err(|err| AppError::Message(format!("书源规则不是合法定义：{err}")))
    })
}

/// Inserts or replaces one source; a fresh id is minted when `id` is `None`.
pub fn save(library: &crate::db::Library, id: Option<&str>, def: &SourceDef) -> AppResult<String> {
    def.validate()?;
    let id = id.map(str::to_string).unwrap_or_else(|| Uuid::new_v4().to_string());
    let rules = serde_json::to_string(def)?;
    let name = def.name.trim().to_string();
    library.with_tx(|tx| {
        tx.execute(
            "INSERT INTO sources (id, name, rules, created_at) VALUES (?1, ?2, ?3, \
             strftime('%s','now')) ON CONFLICT (id) DO UPDATE SET name = excluded.name, rules = \
             excluded.rules",
            rusqlite::params![id, name, rules],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn delete(library: &crate::db::Library, id: &str) -> AppResult<()> {
    let changed = library.with(|conn| {
        conn.execute("DELETE FROM sources WHERE id = ?1", [id]).map_err(AppError::from)
    })?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("书源 {id} 不存在")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire keys are camelCase, like the rest of the IPC surface. The old
    /// hand-written TS assumed that while this struct silently did not, so the
    /// `baseUrl` / `bookUrl` rules were dropped on the floor.
    #[test]
    fn the_wire_shape_is_camel_case() {
        let def = serde_json::to_value(def()).expect("serialises");
        assert!(def.get("baseUrl").is_some(), "SourceDef must send baseUrl");
        assert!(def.get("base_url").is_none());
        assert!(def["search"].get("bookUrl").is_some(), "SearchRules must send bookUrl");
        assert!(def["search"].get("book_url").is_none());
    }
    use serde_json::json;

    fn def() -> SourceDef {
        SourceDef {
            name: "示例源".into(),
            base_url: "https://example.com/api".into(),
            permissions: Permissions::default(),
            search: SearchRules {
                url: "/search?kw={{keyword}}".into(),
                list: "$.data.list[*]".into(),
                title: "$.name".into(),
                author: "$.author".into(),
                intro: "$.intro".into(),
                cover: "$.cover".into(),
                book_url: "$.book_id".into(),
            },
            book: BookRules {
                title: "$.title".into(),
                author: "$.author".into(),
                intro: "$.intro".into(),
                cover: String::new(),
            },
            chapters: ChapterRules {
                list: "$.data.chapters[*]".into(),
                title: "$.name".into(),
                url: "$.url".into(),
            },
            content: ContentRules { paragraphs: "$.data.content".into() },
        }
    }

    #[test]
    fn rules_parse_and_evaluate() {
        let value = json!({ "data": { "list": [ { "name": "三体", "book_id": "b1" } ] } });
        let books = search_algorithm_harness(&value);
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title, "三体");
        assert_eq!(books[0].url, "b1");
        assert_eq!(books[0].author, "", "缺失的可选字段降级为空串");
    }

    fn search_algorithm_harness(value: &Value) -> Vec<SourceBook> {
        let items = evaluate(&def().search.list, value).expect("list");
        items
            .iter()
            .map(|item| SourceBook {
                title: first_text(&def().search.title, item).expect("title"),
                author: optional_text(&def().search.author, item),
                intro: String::new(),
                cover: String::new(),
                url: optional_text(&def().search.book_url, item),
            })
            .collect()
    }

    #[test]
    fn the_wildcard_flattens_arrays() {
        let value = json!({ "items": [ { "n": "甲" }, { "n": "乙" } ] });
        let found = evaluate("$.items[*].n", &value).expect("evaluate");
        assert_eq!(found, vec![json!("甲"), json!("乙")]);
    }

    #[test]
    fn a_rule_without_the_dollar_prefix_still_parses() {
        let value = json!({ "a": { "b": "c" } });
        let found = evaluate("a.b", &value).expect("evaluate");
        assert_eq!(found, vec![json!("c")]);
    }

    #[test]
    fn broken_rules_name_themselves() {
        assert!(parse_rule("$.a..b").is_err());
        assert!(parse_rule("$.").is_err());
        let err = parse_rule("$.a[*").expect_err("unclosed bracket");
        assert!(err.to_string().contains("$.a[*"), "{err}");
    }

    #[test]
    fn content_splits_into_clean_paragraphs() {
        let value = json!({ "data": { "content": "第一段\n\n  第二段  \n\n\n第三段" } });
        let paragraphs = paragraphs_of("$.data.content", &value).expect("paragraphs");
        assert_eq!(paragraphs, ["第一段", "第二段", "第三段"]);
    }

    #[test]
    fn content_accepts_an_array_of_paragraphs() {
        let value = json!({ "data": { "content": ["甲段", "乙段"] } });
        let paragraphs = paragraphs_of("$.data.content", &value).expect("paragraphs");
        assert_eq!(paragraphs, ["甲段", "乙段"]);
    }

    #[test]
    fn keywords_are_percent_encoded() {
        assert_eq!(encode_component("三体 a~b"), "%E4%B8%89%E4%BD%93%20a~b");
        assert_eq!(
            search_url(&def(), "三体"),
            "https://example.com/api/search?kw=%E4%B8%89%E4%BD%93"
        );
    }

    #[test]
    fn absolute_urls_win_over_the_base() {
        assert_eq!(
            full_url("https://example.com/api", "https://cdn.example.com/x.json"),
            "https://cdn.example.com/x.json"
        );
        assert_eq!(
            full_url("https://example.com/api/", "/book/1"),
            "https://example.com/api/book/1"
        );
    }

    #[test]
    fn txt_output_carries_chapter_markers() {
        let text = build_txt(
            "三体",
            "刘慈欣",
            &[
                ("疯狂年代".into(), vec!["第一段".into()]),
                ("寂静的春天".into(), vec!["第二段".into()]),
            ],
        );
        assert!(text.starts_with("三体\n作者：刘慈欣\n"));
        assert!(text.contains("第1章 疯狂年代"));
        assert!(text.contains("第2章 寂静的春天"));
        assert!(text.contains("\n\n第一段"));
    }

    #[test]
    fn txt_titles_that_already_carry_a_marker_pass_through() {
        let text = build_txt("书", "", &[("第一章 开始".into(), vec!["正文".into()])]);
        assert!(text.contains("\n\n第一章 开始"));
        assert!(!text.contains("第1章"));
    }

    #[test]
    fn definitions_must_be_complete() {
        assert!(def().validate().is_ok());
        let mut broken = def();
        broken.content.paragraphs = "  ".into();
        let err = broken.validate().expect_err("missing content rule");
        assert!(err.to_string().contains("正文"), "{err}");
    }

    /// Rows written before `permissions` existed have no such key; they must
    /// keep loading rather than turning every saved source into a broken one.
    #[test]
    fn an_old_definition_without_permissions_still_loads() {
        let json = json!({
            "name": "老书源",
            "baseUrl": "https://example.com/api",
            "search": { "url": "/s?kw={{keyword}}", "list": "$.l[*]", "title": "$.t", "bookUrl": "$.u" },
            "book": { "title": "$.t" },
            "chapters": { "list": "$.c[*]", "title": "$.t", "url": "$.u" },
            "content": { "paragraphs": "$.p" }
        });
        let def: SourceDef = serde_json::from_value(json).expect("旧行照常加载");
        assert!(def.permissions.hosts.is_empty());
        assert!(def.validate().is_ok());
    }

    /// A source is somebody else's definition running on the reader's
    /// network: the base host is the only one it gets for free.
    #[test]
    fn a_url_nobody_granted_is_refused() {
        let def = def();
        let hosts = def.hosts().expect("hosts");
        assert!(hosts.check(&full_url(&def.base_url, "/ch/1")).is_ok(), "base 主机始终允许");

        let err = hosts
            .check(&full_url(&def.base_url, "https://cdn.example.net/1"))
            .expect_err("未声明的主机");
        assert!(err.to_string().contains("cdn.example.net"), "{err}");

        let mut declared = def.clone();
        declared.permissions.hosts = vec!["cdn.example.net".into()];
        assert!(declared.hosts().expect("hosts").check("https://cdn.example.net/1").is_ok());
    }

    #[test]
    fn a_wildcard_permission_is_refused_at_save_time() {
        let mut loose = def();
        loose.permissions.hosts = vec!["*".into()];
        let err = loose.validate().expect_err("wildcard");
        assert!(err.to_string().contains("主机名不合法"), "{err}");
    }

    #[test]
    fn a_clear_text_base_url_is_refused_at_save_time() {
        // The rule the AI endpoint already follows: a source is pasted from
        // somewhere, and its base URL is where every search term the reader
        // types ends up. Rejecting it at `validate` means no round trip has
        // happened yet when the reader is told.
        for base in ["http://example.com/api", "http://192.168.1.10/api", "ftp://x"] {
            let mut unsafe_def = def();
            unsafe_def.base_url = base.into();
            let err = unsafe_def.validate().expect_err("clear-text base URL");
            assert!(err.to_string().contains("书源地址"), "{base}: {err}");
        }
        for base in ["https://example.com/api", "http://localhost:8080/api"] {
            let mut local = def();
            local.base_url = base.into();
            assert!(local.validate().is_ok(), "{base} should be allowed");
        }
    }

    #[test]
    fn sources_round_trip_through_the_table() {
        let harness = Harness::new("source-crud");

        let id = save(&harness.library, None, &def()).expect("save");
        let entries = harness.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].name, "示例源");
        assert_eq!(entries[0].def, def());

        let mut renamed = def();
        renamed.name = "改名".into();
        save(&harness.library, Some(&id), &renamed).expect("update");
        assert_eq!(harness.list().len(), 1, "同一 id 是更新不是新增");
        assert_eq!(load(&harness.library, &id).expect("load"), renamed);

        delete(&harness.library, &id).expect("delete");
        assert!(harness.list().is_empty());
        assert!(delete(&harness.library, &id).is_err(), "删除不存在的书源必须报错");
    }

    #[test]
    fn an_invalid_definition_is_rejected_before_touching_the_table() {
        let harness = Harness::new("source-invalid");
        let mut broken = def();
        broken.name = String::new();
        assert!(save(&harness.library, None, &broken).is_err());
        assert!(harness.list().is_empty());
    }

    struct Harness {
        dir: std::path::PathBuf,
        library: crate::db::Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let library = crate::db::Library::open(&dir).expect("open library");
            Self { dir, library }
        }

        fn list(&self) -> Vec<SourceEntry> {
            self.library.with(list).expect("list")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }
}
