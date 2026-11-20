//! Reader-defined metadata catalogues.
//!
//! A custom source is a small JSON document: a base host, a search URL with
//! `{{query}}`, and JSONPath rules mapping the response onto the same
//! [`Candidate`] shape the built-in catalogues return. The rules are the tiny
//! subset already used by book sources — reusing it means one rule language to
//! learn, and no second parser to maintain.
//!
//! Security is the same as for book sources: HTTPS, base host only, redirects
//! checked hop by hop, and the process-wide catalogue gate. A custom source
//! cannot name a host it does not own.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::library::io::source::{
    encode_component, evaluate, first_text, full_url, optional_text, text_of,
};
use crate::library::metadata::{
    Candidate, Lookup, MetadataProvider, gate, is_throttle, retry_after_of, score,
};
use crate::net::Hosts;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// One reader-defined catalogue, stored as JSON in `metadata_sources.rules`.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomSourceDef {
    /// What the reader sees next to a rating from this source.
    pub name: String,
    /// HTTPS base; its host is the only one this source may reach.
    pub base_url: String,
    /// Search path; `{{query}}` is replaced by the percent-encoded title.
    pub search_url: String,
    /// Rule locating the array of result items.
    pub list: String,
    pub title: String,
    /// Rule for one author or an array of authors; optional.
    pub authors: String,
    pub intro: String,
    pub publisher: String,
    pub published_year: String,
    pub language: String,
    pub isbn: String,
    pub rating: String,
    pub cover: String,
}

impl CustomSourceDef {
    pub fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::InvalidArgument("来源名称不能为空".into()));
        }
        // No extra hosts on purpose: a reader adding a source knows its host,
        // and a pasted definition must not turn into an open proxy.
        Hosts::new(&self.base_url, &[])?;
        for (label, rule) in
            [("搜索地址", &self.search_url), ("结果列表", &self.list), ("书名", &self.title)]
        {
            if rule.trim().is_empty() {
                return Err(AppError::InvalidArgument(format!("{label}规则不能为空")));
            }
        }
        Ok(())
    }
}

/// One stored custom source, definition included so the editor can round-trip.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSourceEntry {
    pub id: String,
    pub name: String,
    pub def: CustomSourceDef,
}

pub fn list(conn: &rusqlite::Connection) -> AppResult<Vec<CustomSourceEntry>> {
    let mut stmt =
        conn.prepare("SELECT id, name, rules FROM metadata_sources ORDER BY created_at")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, name, rules) = row?;
        let def = serde_json::from_str(&rules).map_err(|err| {
            AppError::Message(format!("元数据来源 {name} 的规则不是合法定义：{err}"))
        })?;
        entries.push(CustomSourceEntry { id, name, def });
    }
    Ok(entries)
}

pub fn load(library: &crate::db::Library, id: &str) -> AppResult<CustomSourceDef> {
    library.with(|conn| {
        let rules: String = conn
            .query_row("SELECT rules FROM metadata_sources WHERE id = ?1", [id], |row| row.get(0))
            .map_err(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("元数据来源 {id} 不存在"))
                }
                other => AppError::from(other),
            })?;
        serde_json::from_str(&rules)
            .map_err(|err| AppError::Message(format!("元数据来源规则不是合法定义：{err}")))
    })
}

/// Inserts or replaces one source; a fresh id is minted when `id` is `None`.
pub fn save(
    library: &crate::db::Library,
    id: Option<&str>,
    def: &CustomSourceDef,
) -> AppResult<String> {
    def.validate()?;
    let id = id.map(str::to_string).unwrap_or_else(|| Uuid::new_v4().to_string());
    let rules = serde_json::to_string(def)?;
    let name = def.name.trim().to_string();
    library.with_tx(|tx| {
        tx.execute(
            "INSERT INTO metadata_sources (id, name, rules, created_at) VALUES (?1, ?2, ?3, \
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
        conn.execute("DELETE FROM metadata_sources WHERE id = ?1", [id]).map_err(AppError::from)
    })?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("元数据来源 {id} 不存在")));
    }
    Ok(())
}

/// A reader-defined source as a provider. The key is the row id: two sources
/// may share a name, and the id is what `rating_source` stores so a rename
/// cannot change the meaning of a rating already on the shelf.
pub struct CustomProvider {
    pub id: String,
    pub def: CustomSourceDef,
}

impl CustomProvider {
    pub fn new(id: String, def: CustomSourceDef) -> Self {
        Self { id, def }
    }
}

impl MetadataProvider for CustomProvider {
    fn key(&self) -> &str {
        &self.id
    }

    fn label(&self) -> &str {
        &self.def.name
    }

    fn search<'a>(
        &'a self,
        client: &'a reqwest::Client,
        lookup: &'a Lookup<'_>,
        _depth: usize,
    ) -> Pin<Box<dyn Future<Output = AppResult<Vec<Candidate>>> + Send + 'a>> {
        Box::pin(async move { search(client, self, lookup).await })
    }
}

async fn search(
    client: &reqwest::Client,
    provider: &CustomProvider,
    lookup: &Lookup<'_>,
) -> AppResult<Vec<Candidate>> {
    let def = &provider.def;
    let hosts = Hosts::new(&def.base_url, &[])?;
    let path = def.search_url.replace("{{query}}", &encode_component(lookup.title));
    let url = hosts.check(&full_url(&def.base_url, &path))?;

    gate().wait(provider).await;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(12))
        .header("User-Agent", "fangce (https://github.com/xlongDev/fangce)")
        .send()
        .await
        .map_err(|err| AppError::Message(format!("连不上{}：{err}", provider.label())))?;
    let status = response.status();
    if !status.is_success() {
        let wait = retry_after_of(response.headers());
        gate().penalize(provider, wait);
        if is_throttle(status) {
            return Err(AppError::Throttled {
                provider: provider.label().to_string(),
                status: status.as_u16(),
                retry_after: wait,
            });
        }
        return Err(AppError::Message(format!(
            "{}返回了 {}，过一会儿再试",
            provider.label(),
            status.as_u16()
        )));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("{}的回复看不懂：{err}", provider.label())))?;

    let mut candidates = Vec::new();
    for item in evaluate(&def.list, &body)? {
        let title = first_text(&def.title, &item)?;
        if title.trim().is_empty() {
            continue;
        }
        let authors: Vec<String> = evaluate(&def.authors, &item)
            .unwrap_or_default()
            .iter()
            .map(text_of)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect();
        let year = parse_year(&optional_text(&def.published_year, &item));
        let rating = optional_text(&def.rating, &item).parse::<f64>().ok();
        // Score before the fields move into the candidate; authors matter as
        // much as the title for telling 三体 from another book with that name.
        let match_score = score(lookup, &title, &authors);
        candidates.push(Candidate {
            source: provider.id.clone(),
            title,
            subtitle: None,
            authors,
            publisher: non_empty(optional_text(&def.publisher, &item)),
            published_year: year,
            description: non_empty(optional_text(&def.intro, &item)),
            rating,
            rating_count: None,
            douban_url: None,
            language: non_empty(optional_text(&def.language, &item)),
            isbn: non_empty(optional_text(&def.isbn, &item)),
            cover_url: cover_of(optional_text(&def.cover, &item)),
            match_score,
        });
    }
    candidates.sort_by(|a, b| {
        b.match_score.partial_cmp(&a.match_score).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(candidates)
}

fn non_empty(text: String) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Cover downloads are host-locked to the two built-in catalogues' image
/// servers. A custom source's picture is dropped here rather than offered and
/// then refused at download time — a broken preview is worse than no preview.
fn cover_of(text: String) -> Option<String> {
    let url = non_empty(text)?;
    let host = reqwest::Url::parse(&url).ok()?.host_str()?.to_string();
    let allowed = host == "doubanio.com"
        || host.ends_with(".doubanio.com")
        || host == "neodb.social"
        || host.ends_with(".neodb.social");
    allowed.then_some(url)
}

fn parse_year(text: &str) -> Option<i32> {
    text.trim().chars().take(4).collect::<String>().parse().ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn def() -> CustomSourceDef {
        CustomSourceDef {
            name: "我的目录".into(),
            base_url: "https://books.example.com".into(),
            search_url: "/api/search?q={{query}}".into(),
            list: "$.data[*]".into(),
            title: "$.title".into(),
            authors: "$.author".into(),
            intro: "$.summary".into(),
            publisher: String::new(),
            published_year: "$.year".into(),
            language: String::new(),
            isbn: "$.isbn".into(),
            rating: "$.score".into(),
            cover: "$.image".into(),
        }
    }

    #[test]
    fn a_definition_must_name_a_host_and_the_required_rules() {
        let mut bad = def();
        bad.base_url = "http://books.example.com".into();
        assert!(bad.validate().is_err(), "明文地址不能保存");
        let mut bad = def();
        bad.list.clear();
        assert!(bad.validate().is_err());
        assert!(def().validate().is_ok());
    }

    #[test]
    fn a_definition_refuses_to_reach_another_host() {
        let mut bad = def();
        bad.base_url = "https://one.example.com".into();
        // Only the base host is allowed; a pasted definition cannot add one.
        let hosts = Hosts::new(&bad.base_url, &[]).unwrap();
        assert!(hosts.check("https://two.example.com/x").is_err());
    }

    #[test]
    fn the_rules_map_a_response_onto_a_candidate() {
        // The mapping half is pure; check it without a socket by reusing the
        // same helpers the provider uses.
        let d = def();
        let body = json!({"data": [{"title": "三体", "author": ["刘慈欣"], "year": 2006,
                                   "isbn": "9787536692930", "score": "9.1"}]});
        let items = evaluate(&d.list, &body).unwrap();
        let item = &items[0];
        assert_eq!(first_text(&d.title, item).unwrap(), "三体");
        assert_eq!(optional_text(&d.isbn, item), "9787536692930");
        assert_eq!(parse_year(&optional_text(&d.published_year, item)), Some(2006));
        assert_eq!(optional_text(&d.rating, item).parse::<f64>().ok(), Some(9.1));
    }

    #[test]
    fn sources_round_trip_through_the_table() {
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
            fn list(&self) -> Vec<CustomSourceEntry> {
                self.library.with(list).expect("list")
            }
        }
        impl Drop for Harness {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.dir).ok();
            }
        }

        let h = Harness::new("custom-metadata-source-crud");
        let id = save(&h.library, None, &def()).unwrap();
        let entries = h.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(load(&h.library, &id).unwrap(), def());

        let mut renamed = def();
        renamed.name = "改名".into();
        save(&h.library, Some(&id), &renamed).unwrap();
        assert_eq!(h.list().len(), 1, "同一 id 是更新不是新增");

        delete(&h.library, &id).unwrap();
        assert!(h.list().is_empty());
        assert!(delete(&h.library, &id).is_err(), "删除不存在的来源必须报错");
    }

    /// Verbatim body returned by Open Library's search API (no key needed):
    /// https://openlibrary.org/search.json?q=three+body+problem&fields=title,author_name,first_publish_year,cover_i&limit=2
    /// This machine has no egress, so serve the real response over loopback:
    /// production code still runs the whole HTTP round trip, host check, rule
    /// evaluation and ranking.
    #[test]
    fn a_real_open_library_response_drives_the_whole_chain() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        const BODY: &str = r#"{"numFound":462,"start":0,"numFoundExact":true,"num_found":462,"documentation_url":"https://openlibrary.org/dev/docs/api/search","q":"three body problem","offset":null,"docs":[{"author_name":["刘慈欣","Vincent Schmitt","Gwennaël Gaffric","Marc Simonetti"],"cover_i":9157544,"first_publish_year":2008,"title":"三体"},{"author_name":["刘慈欣"],"cover_i":7893958,"first_publish_year":2010,"title":"Death's End (The Three-Body Problem Series Book 3)"}]}"#;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept one request");
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request).expect("read request");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                BODY.len(),
                BODY
            );
            stream.write_all(response.as_bytes()).expect("write response");
        });

        // The rule language has no numeric index, so array-valued fields such
        // as isbn and publisher stay empty rather than becoming a joined blob.
        let def = CustomSourceDef {
            name: "Open Library".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            search_url: "/search.json?q={{query}}&limit=2".into(),
            list: "$.docs[*]".into(),
            title: "$.title".into(),
            authors: "$.author_name[*]".into(),
            published_year: "$.first_publish_year".into(),
            ..CustomSourceDef::default()
        };
        def.validate().expect("a valid definition");
        let provider = CustomProvider::new("openlibrary-live".into(), def);
        let authors = ["刘慈欣".to_string()];
        let lookup = Lookup::new("三体", &authors, false);
        let client = crate::library::metadata::client();
        let found = tauri::async_runtime::block_on(MetadataProvider::search(
            &provider, &client, &lookup, 0,
        ))
        .expect("a search");
        server.join().expect("server thread");

        assert_eq!(found.len(), 2, "{:?}", found);
        let first = &found[0];
        assert_eq!(first.source, "openlibrary-live");
        assert_eq!(first.title, "三体");
        assert!(first.authors.iter().any(|name| name.contains("刘慈欣")), "{:?}", first);
        assert_eq!(first.published_year, Some(2008), "{:?}", first);
        assert!(first.isbn.is_none(), "规则里没填 isbn，不能凭空长出值");
        assert!(first.rating.is_none() && first.publisher.is_none() && first.language.is_none());
        assert!(first.cover_url.is_none(), "封面白名单不收 Open Library 的图片服务器");
    }

    /// The same definition against the live API, for a machine with egress.
    #[test]
    #[ignore = "hits the network: openlibrary.org"]
    fn the_live_open_library_source_answers_with_real_candidates() {
        let def = CustomSourceDef {
            name: "Open Library".into(),
            base_url: "https://openlibrary.org".into(),
            search_url: "/search.json?q={{query}}&limit=5".into(),
            list: "$.docs[*]".into(),
            title: "$.title".into(),
            authors: "$.author_name[*]".into(),
            published_year: "$.first_publish_year".into(),
            ..CustomSourceDef::default()
        };
        def.validate().expect("a valid definition");
        let provider = CustomProvider::new("openlibrary-live".into(), def);
        let authors = ["刘慈欣".to_string()];
        let lookup = Lookup::new("three body problem", &authors, false);
        let client = crate::library::metadata::client();
        let found = tauri::async_runtime::block_on(MetadataProvider::search(
            &provider, &client, &lookup, 0,
        ))
        .expect("a live search");
        assert!(!found.is_empty());
        assert!(found.iter().any(|candidate| candidate.title.contains("三体")), "{:?}", found);
    }
}
