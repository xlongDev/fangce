//! Book metadata from the outside world.
//!
//! **NeoDB**, not Open Library. Open Library was the first choice — no key, no
//! cost — and it was wrong for this app: its index is essentially English-only,
//! so 《人类简史》 and 《未来简史》 both come back with `numFound: 0`. A provider
//! that cannot see the books on the shelf is worse than none, because it answers
//! "not found" with a straight face.
//!
//! NeoDB is a federated catalogue with real Chinese coverage (it is what dalibre
//! uses, and the reason that matters is the data, not the precedent). It also
//! answers with **editions** rather than works, so `publisher` / `language` /
//! `pub_year` describe the book in hand instead of the union across every
//! printing of it — the trap that made the Open Library version distrust those
//! fields.
//!
//! **No trait yet.** There is one implementation, and the abstraction that
//! matters for the UI is the [`Candidate`] shape, not the call. When a second
//! provider arrives, the thing to share is [`Candidate`] and a small function
//! per provider — an async trait with one implementor would be ceremony that
//! has to be rewritten the moment the second one disagrees about something.
//!
//! Nothing here writes. A candidate is a suggestion; applying it is the reader's
//! click, and the write path is the one `book.update` already uses.

use std::time::Duration;

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Where the catalogue lives. A parameter on [`search`] rather than a constant
/// inside it, so a test can point at a mock without changing the call shape.
pub const NEODB: &str = "https://neodb.social";

/// One page of results, and only books. The API also serves movies, music and
/// games; `category=book` is what keeps a shelf of books from matching a film
/// with the same name.
const CATEGORY: &str = "book";

/// One book as a provider described it, already normalised into the fields this
/// app stores.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Which provider said so. The reader is entitled to know whose answer this
    /// is before it becomes their book's metadata.
    pub source: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published_year: Option<i32>,
    /// The catalogue's blurb, capped — see [`DESCRIPTION_LIMIT`].
    pub description: Option<String>,
    /// A BCP-47-ish tag (`zh`, `en`), taken as the catalogue spells it — NeoDB
    /// already speaks that language, unlike a MARC catalogue's `chi`/`eng`.
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub cover_url: Option<String>,
    /// How well this matches the book that was looked up, 0..1.
    ///
    /// A heuristic, and named for what it is: the UI says 匹配度 and never
    /// 「概率」, because a match is not a probability and a number with a percent
    /// sign invites a trust it has not earned.
    pub match_score: f64,
}

/// What a lookup is based on.
pub struct Lookup<'a> {
    pub title: &'a str,
    pub authors: &'a [String],
}

/// A book as the batch fill sees it: the fields it has, and the ones it does
/// not.
pub struct Target {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub published_year: Option<i32>,
    pub description: Option<String>,
}

/// One field the fill would write.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    /// `publisher` or `language` — the two fields a batch can write.
    pub field: String,
    pub from: Option<String>,
    pub to: String,
}

/// What one book would gain, or why it would gain nothing.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub book_id: String,
    pub book_title: String,
    pub fills: Vec<Fill>,
    /// Why there is nothing to write. Shown to the reader rather than
    /// swallowed: 「没找到」 and 「字段都已经有了」 are different answers, and a
    /// silent skip reads as a bug.
    pub skipped: Option<String>,
    pub match_score: f64,
}

/// Below this a candidate is not offered at all.
///
/// A wrong publisher is worse than a missing one: the reader cannot tell from
/// the shelf that it is wrong, and the whole point of a fill is that nobody
/// reads it. 0.6 is a title that mostly matches — the same book in another
/// language lands under 0.5, which is the case this line exists to exclude.
const MIN_SCORE: f64 = 0.6;

/// What this candidate would add to this book.
///
/// **Only empty fields.** A fill that overwrote something the reader typed
/// would be a bulk edit wearing a different hat, and the reader would have no
/// way to know which of thirty books it touched. Everything here is "this book
/// has nothing, the catalogue has something".
pub fn fills(candidate: &Candidate, target: &Target) -> Vec<Fill> {
    let mut fills: Vec<Fill> = [
        offer("subtitle", target.subtitle.is_none(), candidate.subtitle.as_ref()),
        offer("publisher", target.publisher.is_none(), candidate.publisher.as_ref()),
        offer("language", target.language.is_none(), candidate.language.as_ref()),
        offer("isbn", target.isbn.is_none(), candidate.isbn.as_ref()),
    ]
    .into_iter()
    .flatten()
    .collect();
    if target.published_year.is_none()
        && let Some(year) = candidate.published_year
    {
        fills.push(Fill { field: "publishedYear".into(), from: None, to: year.to_string() });
    }
    // Last: it is the long one, and the sheet shows it at the bottom.
    if let Some(fill) =
        offer("description", target.description.is_none(), candidate.description.as_ref())
    {
        fills.push(fill);
    }
    fills
}

/// One field the fill would write, or nothing when the book already has it.
fn offer(field: &str, empty: bool, value: Option<&String>) -> Option<Fill> {
    if !empty {
        return None;
    }
    Some(Fill { field: field.into(), from: None, to: value?.clone() })
}

/// A lookup that failed, as a proposal.
///
/// The distinction this exists for: 「没有找到」 and 「连不上目录」 are different
/// answers, and a batch that reported the second as the first sent the reader
/// looking for a better title when the network was the problem.
pub fn propose_failed(target: &Target, reason: &str) -> Proposal {
    Proposal {
        book_id: target.id.clone(),
        book_title: target.title.clone(),
        fills: Vec::new(),
        skipped: Some(format!("查询失败：{reason}")),
        match_score: 0.0,
    }
}

/// Turns one book's best candidate into a proposal, or into a reason.
pub fn propose_for(target: &Target, best: Option<Candidate>) -> Proposal {
    let (fills, skipped, match_score) = match best {
        None => (Vec::new(), Some("没有找到相近的书".to_string()), 0.0),
        Some(candidate) if candidate.match_score < MIN_SCORE => (
            Vec::new(),
            Some(format!("匹配度只有 {:.0}%，不采用", candidate.match_score * 100.0)),
            candidate.match_score,
        ),
        Some(candidate) => {
            let fills = fills(&candidate, target);
            let skipped = if fills.is_empty() {
                Some("可补的字段都已经有了".to_string())
            } else {
                None
            };
            (fills, skipped, candidate.match_score)
        }
    };
    Proposal {
        book_id: target.id.clone(),
        book_title: target.title.clone(),
        fills,
        skipped,
        match_score,
    }
}

/// Asks the provider for candidates and scores them against the book.
pub async fn search(client: &Client, base: &str, lookup: &Lookup<'_>) -> AppResult<Vec<Candidate>> {
    if lookup.title.trim().is_empty() {
        return Err(AppError::InvalidArgument("这本书没有书名，查不了".into()));
    }
    let url = build_url(base, lookup)?;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(12))
        // A UA is the honest thing to send, and community instances throttle
        // anonymous clients harder without one.
        .header("User-Agent", "fangce (https://github.com/xlongDev/fangce)")
        .send()
        .await
        .map_err(|err| AppError::Message(format!("连不上 NeoDB：{err}")))?;

    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "NeoDB 返回了 {}，过一会儿再试",
            response.status().as_u16()
        )));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("NeoDB 的回复看不懂：{err}")))?;
    Ok(parse(&body, lookup))
}

fn build_url(base: &str, lookup: &Lookup<'_>) -> AppResult<reqwest::Url> {
    let mut url =
        reqwest::Url::parse(&format!("{}/api/catalog/search", base.trim_end_matches('/')))
            .map_err(|err| AppError::Message(format!("书源地址不合法：{err}")))?;
    {
        let mut query = url.query_pairs_mut();
        // The title alone, not title + author: NeoDB's `query` is a text search,
        // and appending an author name narrows it past the record when the
        // catalogue spells the author differently (`[以色列] 尤瓦尔·赫拉利`
        // against a book whose EPUB says `尤瓦尔·赫拉利`). The author is used
        // to *rank* the results instead, which is a comparison this side
        // controls.
        query.append_pair("query", lookup.title.trim());
        query.append_pair("category", CATEGORY);
        query.append_pair("page", "1");
    }
    Ok(url)
}

/// Maps one response onto candidates, best match first.
///
/// Separate from [`search`] and pure: this is the half that breaks when the
/// provider changes its mind about a field name, and it is the half a test can
/// hold without a socket.
pub fn parse(body: &Value, lookup: &Lookup<'_>) -> Vec<Candidate> {
    let Some(docs) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut candidates: Vec<Candidate> =
        docs.iter().filter_map(|doc| candidate(doc, lookup)).collect();
    candidates.sort_by(|a, b| {
        b.match_score.partial_cmp(&a.match_score).unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates
}

fn candidate(doc: &Value, lookup: &Lookup<'_>) -> Option<Candidate> {
    let title = doc.get("title").and_then(Value::as_str)?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let authors = strings(doc.get("author"));
    let match_score = score(lookup, &title, &authors);
    // Each record is one edition, so the first entry of each array *is* this
    // book's value rather than one printing's share of a union.
    Some(Candidate {
        source: "neodb".to_string(),
        title,
        subtitle: text(doc, "subtitle"),
        authors,
        publisher: strings(doc.get("publisher")).into_iter().next(),
        published_year: doc.get("pub_year").and_then(Value::as_i64).map(|year| year as i32),
        language: strings(doc.get("language")).into_iter().next(),
        isbn: doc
            .get("isbn")
            .and_then(Value::as_str)
            .map(|isbn| isbn.trim().to_string())
            .filter(|isbn| !isbn.is_empty()),
        cover_url: doc
            .get("cover_image_url")
            .and_then(Value::as_str)
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty()),
        // `brief` is the back-cover copy; `description` is the same field on
        // most records and the fuller one on some. Either is better than an
        // empty 简介, which is what the reader reported.
        description: text(doc, "brief").or_else(|| text(doc, "description")).map(cap),
        match_score,
    })
}

/// A trimmed string field, or `None` when it is missing or blank.
fn text(doc: &Value, key: &str) -> Option<String> {
    doc.get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Catalogue blurbs run to thousands of characters — the one for 《人类简史》 is
/// a whole marketing page. The sheet's 简介 field is 4000 by its own limit, so
/// the fill stops there, at a line break when there is one near the end rather
/// than mid-sentence.
const DESCRIPTION_LIMIT: usize = 4000;

fn cap(description: String) -> String {
    if description.chars().count() <= DESCRIPTION_LIMIT {
        return description;
    }
    let cut: String = description.chars().take(DESCRIPTION_LIMIT).collect();
    let cut = match cut.rfind('\n') {
        Some(index) if index > DESCRIPTION_LIMIT / 2 => cut[..index].to_string(),
        _ => cut,
    };
    format!("{}…", cut.trim_end())
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                // Catalogue data carries invisible direction marks — the real
                // `publisher` for 三体 arrives as `\u{200e}Tor Books`, which
                // would be stored and then rendered as a mystery indent.
                .map(|text| text.trim().trim_matches(is_invisible).to_string())
                .filter(|text| !text.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn is_invisible(ch: char) -> bool {
    matches!(ch, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{feff}')
}

/// How close a candidate is to the book being looked up, 0..1.
///
/// Title carries most of it because a title is the one field a bad EPUB still
/// gets right, and an author list is where providers disagree most (a
/// translator, a `[日]` prefix, a different order). The numbers are a ranking,
/// not a measurement — nothing downstream should treat 0.8 as a probability.
fn score(lookup: &Lookup<'_>, title: &str, authors: &[String]) -> f64 {
    let title_score = similarity(lookup.title, title);
    if lookup.authors.is_empty() {
        return title_score;
    }
    let author_score = lookup
        .authors
        .iter()
        .map(|wanted| authors.iter().map(|found| similarity(wanted, found)).fold(0.0_f64, f64::max))
        .fold(0.0_f64, f64::max);
    0.7 * title_score + 0.3 * author_score
}

/// Character-trigram overlap, 0..1.
///
/// Trigrams rather than word tokens because half this library is Chinese and
/// has no spaces to split on. Identical strings short-circuit to 1 so an exact
/// match cannot lose to a longer title that happens to contain it.
fn similarity(a: &str, b: &str) -> f64 {
    let a = normalize(a);
    let b = normalize(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    if a.contains(&b) || b.contains(&a) {
        // Containment is strong evidence, but a one-character needle inside a
        // long title is not: weight it by how much of the longer one it is.
        let (short, long) = if a.len() <= b.len() { (&a, &b) } else { (&b, &a) };
        return 0.6 + 0.35 * (short.chars().count() as f64 / long.chars().count() as f64);
    }
    let left = trigrams(&a);
    let right = trigrams(&b);
    let shared = left.intersection(&right).count() as f64;
    let total = left.union(&right).count() as f64;
    if total == 0.0 { 0.0 } else { shared / total }
}

/// Lowercase, drop everything that is punctuation or whitespace, and collapse
/// the full-width brackets a Chinese title block tends to carry.
fn normalize(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_whitespace() && !is_noise(*ch))
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_noise(ch: char) -> bool {
    matches!(
        ch,
        '《' | '》'
            | '「'
            | '」'
            | '（'
            | '）'
            | '('
            | ')'
            | '['
            | ']'
            | '【'
            | '】'
            | '·'
            | '・'
            | '-'
            | '_'
            | '—'
            | ':'
            | '：'
            | ','
            | '，'
            | '.'
            | '。'
            | '!'
            | '！'
            | '?'
            | '？'
            | '"'
            | '\''
            | '“'
            | '”'
            | '‘'
            | '’'
            | '/'
            | '\\'
            | '|'
    )
}

fn trigrams(text: &str) -> std::collections::HashSet<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 3 {
        return [text.to_string()].into_iter().collect();
    }
    chars.windows(3).map(|window| window.iter().collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    fn lookup<'a>(title: &'a str, authors: &'a [String]) -> Lookup<'a> {
        Lookup { title, authors }
    }

    /// The shape NeoDB actually answers with, trimmed to the fields this app
    /// reads. Taken from a live response for 《人类简史》.
    fn body() -> Value {
        json!({
            "data": [
                {
                    "title": "人类简史",
                    "subtitle": "从动物到上帝",
                    "author": ["[以色列] 尤瓦尔·赫拉利"],
                    "translator": ["林俊宏"],
                    "publisher": ["中信出版社"],
                    "pub_year": 2014,
                    "language": ["zh"],
                    "isbn": "9787508647357",
                    "cover_image_url": "https://neodb.social/m/book/2021/09/cover.jpg"
                },
                {
                    "title": "Sapiens",
                    "author": ["Yuval Noah Harari"],
                    "publisher": ["Harper"],
                    "pub_year": 2011,
                    "language": ["en"]
                }
            ]
        })
    }

    #[test]
    fn a_doc_becomes_a_candidate_with_the_fields_this_app_stores() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let found = parse(&body(), &lookup("人类简史", &authors));
        let best = &found[0];
        assert_eq!(best.title, "人类简史");
        assert_eq!(best.authors, ["[以色列] 尤瓦尔·赫拉利"]);
        assert_eq!(best.publisher.as_deref(), Some("中信出版社"));
        assert_eq!(best.published_year, Some(2014));
        assert_eq!(best.language.as_deref(), Some("zh"), "NeoDB 给的就是 BCP-47，不用翻译");
        assert_eq!(best.isbn.as_deref(), Some("9787508647357"));
        assert_eq!(
            best.cover_url.as_deref(),
            Some("https://neodb.social/m/book/2021/09/cover.jpg")
        );
        assert_eq!(best.source, "neodb");
        assert!(best.match_score > found[1].match_score, "{found:?}");
    }

    /// The provider answers with **editions**, so the first entry of
    /// `publisher` / `language` is this book's own value, not one printing's
    /// share of a union. That is the whole reason NeoDB replaced Open Library.
    #[test]
    fn an_edition_lends_its_own_publisher_and_language() {
        let body = json!({
            "data": [{
                "title": "三体",
                "author": ["刘慈欣"],
                "publisher": ["重庆出版社", "另一家"],
                "language": ["zh"],
                "pub_year": 2008
            }]
        });
        let found = parse(&body, &lookup("三体", &[]));
        assert_eq!(found[0].publisher.as_deref(), Some("重庆出版社"));
        assert_eq!(found[0].language.as_deref(), Some("zh"));
    }

    /// A provider that stops sending a field must degrade, not panic.
    #[test]
    fn a_sparse_doc_still_yields_a_candidate() {
        let body = json!({ "data": [{ "title": "只有书名" }] });
        let found = parse(&body, &lookup("只有书名", &[]));
        assert_eq!(found.len(), 1);
        assert!(found[0].authors.is_empty());
        assert_eq!(found[0].publisher, None);
        assert_eq!(found[0].language, None);
        assert_eq!(found[0].isbn, None);
        assert_eq!(found[0].match_score, 1.0, "没有作者时只看书名");
    }

    #[test]
    fn a_response_without_data_is_an_empty_list_not_an_error() {
        assert!(parse(&json!({ "detail": "nope" }), &lookup("三体", &[])).is_empty());
        assert!(parse(&json!({ "data": [] }), &lookup("三体", &[])).is_empty());
    }

    #[test]
    fn a_doc_with_no_title_is_dropped() {
        let body = json!({ "data": [{ "author": ["某人"] }, { "title": "  " }] });
        assert!(parse(&body, &lookup("三体", &[])).is_empty());
    }

    #[test]
    fn an_invisible_direction_mark_is_trimmed_off() {
        let body = json!({ "data": [{ "title": "书", "publisher": ["\u{200e}Tor Books"] }] });
        let found = parse(&body, &lookup("书", &[]));
        assert_eq!(found[0].publisher.as_deref(), Some("Tor Books"));
    }

    #[test]
    fn the_url_asks_the_book_catalogue_for_the_title() {
        let url = build_url(NEODB, &lookup("三体 全集", &[])).expect("url");
        let text = url.to_string();
        assert!(text.starts_with("https://neodb.social/api/catalog/search?"), "{text}");
        assert!(text.contains("category=book"), "不筛类别会连电影一起返回：{text}");
        // Encoded, not interpolated: a title with a space or an ampersand must
        // not become two query parameters.
        assert!(text.contains("query=%E4%B8%89%E4%BD%93+%E5%85%A8%E9%9B%86"), "{text}");
    }

    #[test]
    fn an_exact_match_scores_higher_than_a_contained_one() {
        let exact = similarity("三体", "三体");
        let contained = similarity("三体", "三体（全集）");
        let different = similarity("三体", "Dune");
        assert_eq!(exact, 1.0);
        assert!(contained > 0.6 && contained < exact, "{contained}");
        assert!(different < contained, "{different}");
    }

    /// The number is a ranking, and this pins the one property the UI relies on:
    /// the book that matches by title and author ranks above the same book in
    /// another language.
    #[test]
    fn the_same_book_in_another_language_ranks_below_the_match() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let found = parse(&body(), &lookup("人类简史", &authors));
        assert_eq!(found.len(), 2);
        assert!(found[0].match_score > 0.9, "{found:?}");
        assert!(found[1].match_score < 0.5, "英文版只是同义，不该排上来：{found:?}");
    }

    fn target(publisher: Option<&str>, language: Option<&str>) -> Target {
        Target {
            id: "b1".into(),
            title: "三体".into(),
            subtitle: None,
            authors: vec!["刘慈欣".into()],
            publisher: publisher.map(str::to_string),
            language: language.map(str::to_string),
            isbn: None,
            published_year: None,
            description: None,
        }
    }

    fn candidate(publisher: Option<&str>, language: Option<&str>, score: f64) -> Candidate {
        Candidate {
            source: "neodb".into(),
            title: "三体".into(),
            subtitle: None,
            authors: vec!["刘慈欣".into()],
            publisher: publisher.map(str::to_string),
            // Left empty by default: most tests below are about one field, and
            // a year that is always present would make every fill list longer
            // than the thing under test.
            published_year: None,
            language: language.map(str::to_string),
            isbn: None,
            cover_url: None,
            description: None,
            match_score: score,
        }
    }

    /// The rule that makes a bulk fill safe: it cannot overwrite a value the
    /// reader already has.
    #[test]
    fn a_fill_only_touches_fields_the_book_does_not_have() {
        let found = candidate(Some("重庆出版社"), Some("zh"), 0.95);
        let fills = fills(&found, &target(Some("我自己填的"), None));
        assert_eq!(
            fills,
            [Fill { field: "language".into(), from: None, to: "zh".into() }],
            "出版社已经有了，不能覆盖"
        );
    }

    /// What the reader reported: the sheet came back with the publisher and
    /// the language and nothing else, because the fill only knew those two
    /// fields.
    #[test]
    fn a_fill_brings_the_subtitle_the_blurb_the_isbn_and_the_year() {
        let mut found = candidate(Some("中信出版社"), Some("zh"), 0.95);
        found.subtitle = Some("从动物到上帝".into());
        found.description = Some("十万年前，地球上至少有六种不同的人。".into());
        found.isbn = Some("9787508647357".into());
        found.published_year = Some(2014);
        let fills = fills(&found, &target(None, None));
        let fields: Vec<&str> = fills.iter().map(|fill| fill.field.as_str()).collect();
        assert_eq!(
            fields,
            ["subtitle", "publisher", "language", "isbn", "publishedYear", "description"],
            "顺序就是表单上从上到下的顺序"
        );
        assert!(fills.iter().any(|fill| fill.to == "2014"));
    }

    /// A catalogue blurb can be a whole marketing page; the sheet's 简介 is
    /// 4000 by its own limit.
    #[test]
    fn a_long_blurb_is_cut_at_a_line_break() {
        let line = "这是一段介绍文字，长度大约二十个字。";
        let body = (0..400).map(|_| line).collect::<Vec<_>>().join("\n");
        assert!(body.chars().count() > DESCRIPTION_LIMIT);
        let capped = cap(body);
        assert!(capped.chars().count() <= DESCRIPTION_LIMIT + 1, "{}", capped.chars().count());
        assert!(capped.ends_with('…'));
        assert!(capped.trim_end_matches('…').ends_with('。'), "在句号处断开，不是半个句子");
    }

    #[test]
    fn a_short_blurb_is_left_alone() {
        assert_eq!(cap("很短的一段话。".into()), "很短的一段话。");
    }

    #[test]
    fn a_book_that_already_has_everything_says_so() {
        let found = candidate(Some("重庆出版社"), Some("zh"), 0.95);
        let proposal = propose_for(&target(Some("重庆出版社"), Some("zh")), Some(found));
        assert!(proposal.fills.is_empty());
        assert_eq!(proposal.skipped.as_deref(), Some("可补的字段都已经有了"));
    }

    #[test]
    fn a_weak_match_is_refused_and_says_its_score() {
        let proposal = propose_for(&target(None, None), Some(candidate(Some("X"), None, 0.42)));
        assert!(proposal.fills.is_empty(), "0.42 的候选不能写进书里");
        assert!(proposal.skipped.as_deref().unwrap_or_default().contains("42%"));
    }

    #[test]
    fn no_candidate_at_all_is_a_different_answer_from_nothing_to_fill() {
        let proposal = propose_for(&target(None, None), None);
        assert_eq!(proposal.skipped.as_deref(), Some("没有找到相近的书"));
        assert_eq!(proposal.match_score, 0.0);
    }

    /// A provider that is down is not "this book has no metadata".
    #[test]
    fn a_failed_lookup_says_so_instead_of_pretending_nothing_was_found() {
        let proposal = propose_failed(&target(None, None), "连不上 NeoDB：超时");
        assert!(proposal.fills.is_empty());
        let reason = proposal.skipped.as_deref().unwrap_or_default();
        assert!(reason.contains("查询失败"), "{reason}");
        assert!(reason.contains("超时"), "{reason}");
    }

    /// The live catalogue, once, on purpose: the parser above is written
    /// against a payload read from a real response, but the response is not the
    /// only thing that can change. Ignored by default like the TTS tests.
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml metadata -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "hits the network: neodb.social"]
    fn the_live_catalogue_answers_the_shape_this_parser_expects() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let lookup = Lookup { title: "人类简史", authors: &authors };
        let client = Client::new();
        let found =
            tauri::async_runtime::block_on(search(&client, NEODB, &lookup)).expect("live search");
        println!("\n{} candidates", found.len());
        for candidate in found.iter().take(3) {
            println!(
                "  {:.2}  {} · {:?} · {:?}",
                candidate.match_score, candidate.title, candidate.authors, candidate.published_year
            );
        }
        assert!(!found.is_empty(), "真实目录里不可能没有《人类简史》");
        assert!(found[0].title.contains("人类简史"), "{:?}", found[0]);
        assert!(found[0].match_score > 0.5, "{:?}", found[0]);
    }
}
