//! Book metadata from the outside world.
//!
//! **Two catalogues, tried in order, because of a network fact rather than a
//! data one.** NeoDB is not reachable from mainland China without a proxy, and
//! a feature that only works with a proxy is a feature that does not work. So
//! Douban is asked first — it is reachable, it has better Chinese coverage than
//! anything else, and its rating is the one readers actually mean when they say
//! 「豆瓣评分」. NeoDB is still asked when Douban answers nothing: it covers
//! foreign books Douban does not, and it is the only source of an ISBN.
//!
//! Neither has a public API. Both are reached the way their own clients reach
//! them — Douban through the autocomplete endpoint its search box calls and the
//! JSON endpoint its mobile app calls, NeoDB through its documented
//! `/api/catalog/search`. That is a real risk, and the shape of the risk is
//! 「the provider changes and this breaks」: which is why every parser here is a
//! pure function over a captured response, and why a provider that fails says
//! so instead of pretending the book has no metadata.
//!
//! **No trait.** Two providers, and the thing that is shared is [`Candidate`]
//! plus a small function each. An async trait would have to be rewritten the
//! moment the two disagree about a field, which they already do: Douban has no
//! ISBN and no language, NeoDB has both and no blurb for most records.
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

/// Douban's autocomplete. It is what the site's own search box calls, it needs
/// no login, and it answers with subject ids — the only way in, because the
/// search *page* is JS-rendered and the search *API* answers `need_login`.
const DOUBAN_SUGGEST: &str = "https://book.douban.com/j/subject_suggest";

/// Douban's mobile JSON endpoint, by subject id.
///
/// It requires a `Referer` from a Douban page. Without one it answers HTTP 200
/// with `{"code": 1287, "msg": "invalid_request_1284"}` — a failure dressed as
/// success, which is why the response is checked for a `title` rather than for
/// a status code.
const DOUBAN_DETAIL: &str = "https://m.douban.com/rexxar/api/v2/book";

/// A browser UA. Douban rejects requests that announce themselves as a library,
/// and the honest UA this app sends to NeoDB gets a 403 here.
const DOUBAN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// One page of results, and only books. The API also serves movies, music and
/// games; `category=book` is what keeps a shelf of books from matching a film
/// with the same name.
const CATEGORY: &str = "book";

/// Which catalogue to ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// First, because it is the one that works without a proxy.
    Douban,
    /// The fallback: better foreign coverage, and the only source of an ISBN.
    Neodb,
}

impl Provider {
    /// The order is the design. Douban is reachable from where this app is used;
    /// NeoDB is not, so asking it first would make every lookup wait out a
    /// twelve-second timeout before the one that works even started.
    pub const CHAIN: [Provider; 2] = [Provider::Douban, Provider::Neodb];

    /// What goes into the database, and into `Candidate::source`.
    pub fn key(self) -> &'static str {
        match self {
            Provider::Douban => "douban",
            Provider::Neodb => "neodb",
        }
    }

    /// What the reader sees next to a rating. The name is not decoration: a
    /// bare number would be read as Douban's, and NeoDB's is a different number
    /// from a different set of people.
    pub fn label(self) -> &'static str {
        match self {
            Provider::Douban => "豆瓣",
            Provider::Neodb => "NeoDB",
        }
    }
}

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
    /// The catalogue's own community rating — **not Douban's**, and the UI says
    /// so every time it prints one.
    pub rating: Option<f64>,
    pub rating_count: Option<i32>,
    /// The Douban page this record was linked from, when it has one.
    pub douban_url: Option<String>,
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
    pub rating: Option<f64>,
    pub douban_url: Option<String>,
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
    /// The catalogue's rating, how many people gave it, and the Douban page.
    ///
    /// Carried beside the fills rather than as fills: they are not fields the
    /// reader edits, they are what the catalogue said at lookup time. `None`
    /// when the book already has them, so what the row shows is exactly what
    /// the apply will write.
    pub rating: Option<f64>,
    pub rating_count: Option<i32>,
    pub douban_url: Option<String>,
    /// Which catalogue that rating came from — `douban` or `neodb`. Stored with
    /// the number because they are different numbers from different people, and
    /// a label that has to be guessed later is a label that will be wrong.
    pub rating_source: Option<String>,
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
        rating: None,
        rating_count: None,
        douban_url: None,
        rating_source: None,
    }
}

/// Turns one book's best candidate into a proposal, or into a reason.
pub fn propose_for(target: &Target, best: Option<Candidate>) -> Proposal {
    let (fills, skipped, match_score, rating, rating_count, douban_url, rating_source) = match best
    {
        None => (Vec::new(), Some("没有找到相近的书".to_string()), 0.0, None, None, None, None),
        Some(candidate) if candidate.match_score < MIN_SCORE => (
            Vec::new(),
            Some(format!("匹配度只有 {:.0}%，不采用", candidate.match_score * 100.0)),
            candidate.match_score,
            None,
            None,
            None,
            None,
        ),
        Some(candidate) => {
            let fills = fills(&candidate, target);
            // Only what the book does not already have — the same rule as the
            // fills, so the row never promises a write the apply will skip.
            let rating = target.rating.is_none().then_some(candidate.rating).flatten();
            let rating_count = rating.and(candidate.rating_count);
            let douban_url = target.douban_url.is_none().then_some(candidate.douban_url).flatten();
            let nothing_to_do = fills.is_empty() && rating.is_none() && douban_url.is_none();
            let skipped = nothing_to_do.then(|| "可补的字段都已经有了".to_string());
            // The source only travels when the number does: a label with no
            // rating behind it would print next to an empty space.
            let rating_source = rating.and(Some(candidate.source));
            (fills, skipped, candidate.match_score, rating, rating_count, douban_url, rating_source)
        }
    };
    Proposal {
        book_id: target.id.clone(),
        book_title: target.title.clone(),
        fills,
        skipped,
        match_score,
        rating,
        rating_count,
        douban_url,
        rating_source,
    }
}

/// Asks one provider, best match first.
///
/// `depth` is how many hits to open into a full record. Douban needs it: its
/// autocomplete answers with an id and almost nothing else, so the fields the
/// sheet wants cost one more request per hit. NeoDB ignores it — one request
/// already returns everything.
pub async fn search(
    client: &Client,
    provider: Provider,
    lookup: &Lookup<'_>,
    depth: usize,
) -> AppResult<Vec<Candidate>> {
    if lookup.title.trim().is_empty() {
        return Err(AppError::InvalidArgument("这本书没有书名，查不了".into()));
    }
    match provider {
        Provider::Douban => search_douban(client, lookup, depth).await,
        Provider::Neodb => search_neodb(client, NEODB, lookup).await,
    }
}

/// What one batch learns about the network while it runs.
///
/// A provider that could not be reached for book three will not be reachable
/// for book four, and without this a batch of forty pays the twelve-second
/// timeout again for every book the first provider has nothing for. One batch,
/// one attempt per provider that fails: the reader gets an answer in seconds
/// instead of a dialog that appears to have hung.
#[derive(Default)]
pub struct Attempts {
    down: std::sync::Mutex<Vec<Provider>>,
}

impl Attempts {
    pub fn new() -> Self {
        Self::default()
    }

    fn is_down(&self, provider: Provider) -> bool {
        self.down.lock().is_ok_and(|down| down.contains(&provider))
    }

    /// A poisoned lock means another task panicked while holding it. Treating
    /// that as 「not down」 asks one more question; treating it as 「down」 would
    /// silently drop a provider for the rest of the batch.
    fn mark_down(&self, provider: Provider) {
        if let Ok(mut down) = self.down.lock()
            && !down.contains(&provider)
        {
            down.push(provider);
        }
    }
}

/// Asks each provider in turn, and returns the first one that has anything.
///
/// A chain rather than a merge. Two catalogues that disagree about a publisher
/// produce a third answer nobody chose, and the reader would have no way to see
/// which record they are looking at. First answer wins, and its name travels
/// with it — [`Candidate::source`] is what the rating label is built from.
///
/// **A provider that fails is not a book that does not exist.** When every
/// provider fails, the error carries each one's reason; when any provider
/// answered — even with nothing — the result is an honest empty list.
pub async fn find(
    client: &Client,
    lookup: &Lookup<'_>,
    depth: usize,
    attempts: &Attempts,
) -> AppResult<Vec<Candidate>> {
    let mut results = Vec::new();
    for provider in Provider::CHAIN {
        if attempts.is_down(provider) {
            results.push((provider, Err(AppError::Message("这次查询里连不上，已跳过".into()))));
            continue;
        }
        let outcome = search(client, provider, lookup, depth).await;
        if outcome.is_err() {
            attempts.mark_down(provider);
        }
        let answered = matches!(&outcome, Ok(found) if !found.is_empty());
        results.push((provider, outcome));
        // Stop at the first provider that has something. Asking the rest would
        // mean waiting out a timeout on the one that cannot be reached from
        // here, for an answer nobody is going to see.
        if answered {
            break;
        }
    }
    choose(results)
}

/// What the chain's per-provider results mean.
///
/// Pure, so the two rules that matter are testable without a socket: the first
/// non-empty answer wins, and 「a provider that failed」 is not 「the book does
/// not exist」 — it is only reported as an empty result when some provider
/// actually answered.
fn choose(results: Vec<(Provider, AppResult<Vec<Candidate>>)>) -> AppResult<Vec<Candidate>> {
    let mut notes = Vec::new();
    let mut answered = false;
    for (provider, outcome) in results {
        match outcome {
            Ok(found) if !found.is_empty() => return Ok(found),
            Ok(_) => {
                answered = true;
                notes.push(format!("{}：没有找到", provider.label()));
            }
            Err(err) => notes.push(format!("{}：{err}", provider.label())),
        }
    }
    if answered {
        return Ok(Vec::new());
    }
    Err(AppError::Message(notes.join("；")))
}

/// NeoDB in one request.
async fn search_neodb(
    client: &Client,
    base: &str,
    lookup: &Lookup<'_>,
) -> AppResult<Vec<Candidate>> {
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

/// Douban in two steps: ids, then the record behind the best ones.
///
/// The first step is the site's own autocomplete — no login, no key, and it is
/// the only door in: the search page is rendered by JavaScript and the search
/// API answers `need_login`. The second step is the JSON endpoint the mobile app
/// uses, one request per hit.
async fn search_douban(
    client: &Client,
    lookup: &Lookup<'_>,
    depth: usize,
) -> AppResult<Vec<Candidate>> {
    let url = douban_suggest_url(lookup)?;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(12))
        .header("User-Agent", DOUBAN_UA)
        .header("Referer", "https://book.douban.com/")
        .send()
        .await
        .map_err(|err| AppError::Message(format!("连不上豆瓣：{err}")))?;

    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "豆瓣返回了 {}，过一会儿再试",
            response.status().as_u16()
        )));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|err| AppError::Message(format!("豆瓣的回复看不懂：{err}")))?;

    let hits: Vec<Hit> = parse_suggest(&body, lookup).into_iter().take(depth.max(1)).collect();
    // Opened side by side rather than one after another: three records at about
    // a second each is three seconds of a dialog that looks stuck, and the cap
    // here is three. `join_all` keeps the order, so the ranking survives.
    let opened = futures_util::future::join_all(
        hits.iter().map(|hit| open_subject(client, &hit.id, lookup)),
    )
    .await;
    Ok(hits
        .into_iter()
        .zip(opened)
        // A hit whose record could not be opened is still worth showing: it has
        // the title, the author, the year and the page. Throwing the whole
        // lookup away because the second request timed out would lose that.
        .map(|(hit, rich)| match rich {
            Some(rich) => merge(&hit.candidate, rich),
            None => hit.candidate,
        })
        .collect())
}

/// One subject, in full. `None` on any failure — the caller already has
/// something to show.
async fn open_subject(client: &Client, id: &str, lookup: &Lookup<'_>) -> Option<Candidate> {
    let response = client
        .get(format!("{DOUBAN_DETAIL}/{id}"))
        .timeout(Duration::from_secs(12))
        .header("User-Agent", DOUBAN_UA)
        // Load-bearing: without it the endpoint answers 200 with a code-1287
        // body, which looks like success until you try to read a field.
        .header("Referer", "https://book.douban.com/")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    parse_detail(&body, lookup)
}

/// One autocomplete hit: the id, and what can be said without opening it.
struct Hit {
    id: String,
    candidate: Candidate,
}

/// Maps the autocomplete response onto hits, best match first.
///
/// Pure, like [`parse`], and for the same reason: this is the half that breaks
/// when the provider changes its mind.
fn parse_suggest(body: &Value, lookup: &Lookup<'_>) -> Vec<Hit> {
    let Some(items) = body.as_array() else {
        return Vec::new();
    };
    let mut hits: Vec<Hit> = items.iter().filter_map(|item| suggest_hit(item, lookup)).collect();
    hits.sort_by(|a, b| {
        b.candidate
            .match_score
            .partial_cmp(&a.candidate.match_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits
}

fn suggest_hit(item: &Value, lookup: &Lookup<'_>) -> Option<Hit> {
    // `type` is `b` for books. The same endpoint answers films and music, and a
    // film called 《活着》 is a different thing from the novel.
    if item.get("type").and_then(Value::as_str) != Some("b") {
        return None;
    }
    let id = item.get("id").and_then(Value::as_str)?.trim().to_string();
    // Digits only: this id is interpolated into a URL path, and a value from
    // somebody else's JSON has no business deciding where the request goes.
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let title = item.get("title").and_then(Value::as_str)?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let authors: Vec<String> = item
        .get("author_name")
        .and_then(Value::as_str)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .into_iter()
        .collect();
    let match_score = score(lookup, &title, &authors);
    Some(Hit {
        id: id.clone(),
        candidate: Candidate {
            source: Provider::Douban.key().to_string(),
            title,
            subtitle: None,
            authors,
            publisher: None,
            published_year: text(item, "year").as_deref().and_then(year_of),
            description: None,
            rating: None,
            rating_count: None,
            douban_url: Some(format!("https://book.douban.com/subject/{id}/")),
            language: None,
            // Douban's JSON endpoints do not carry an ISBN. The subject page
            // does, inside 120 KB of HTML — not worth a third request per book,
            // and not worth the most fragile parser in the file for one field
            // the reader can type.
            isbn: None,
            cover_url: text(item, "pic"),
            match_score,
        },
    })
}

/// Maps one subject onto a candidate. `None` when the body is not a record —
/// the endpoint reports its errors with HTTP 200, so a status check is not
/// enough.
fn parse_detail(body: &Value, lookup: &Lookup<'_>) -> Option<Candidate> {
    let title = body.get("title").and_then(Value::as_str)?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let authors = dedup(strings(body.get("author")));
    let match_score = score(lookup, &title, &authors);
    let rating = body.get("rating");
    Some(Candidate {
        source: Provider::Douban.key().to_string(),
        title,
        // `book_subtitle` is the string the app shows; `subtitle` is the same
        // thing as an array and is empty on older records.
        subtitle: text(body, "book_subtitle")
            .or_else(|| strings(body.get("subtitle")).into_iter().next()),
        authors,
        publisher: strings(body.get("press")).into_iter().next(),
        published_year: strings(body.get("pubdate")).first().and_then(|date| year_of(date)),
        description: text(body, "intro").map(cap),
        // Douban's own rating — the number readers mean by 「豆瓣评分」, which
        // is why the source is stored beside it.
        rating: rating.and_then(|value| value.get("value")).and_then(Value::as_f64),
        rating_count: rating
            .and_then(|value| value.get("count"))
            .and_then(Value::as_i64)
            .map(|count| count as i32),
        douban_url: douban_subject(body),
        // Neither is in this response. Left empty rather than guessed: 「zh」
        // would be right for most records and wrong for the foreign editions
        // that are also in the catalogue.
        language: None,
        isbn: None,
        cover_url: text(body, "cover_url").or_else(|| {
            body.get("pic")
                .and_then(|pic| pic.get("large"))
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        match_score,
    })
}

/// Keeps the opened record's fields, and falls back to the autocomplete hit for
/// anything it left empty.
fn merge(thin: &Candidate, rich: Candidate) -> Candidate {
    Candidate {
        source: rich.source,
        title: rich.title,
        subtitle: rich.subtitle.or_else(|| thin.subtitle.clone()),
        authors: if rich.authors.is_empty() { thin.authors.clone() } else { rich.authors },
        publisher: rich.publisher.or_else(|| thin.publisher.clone()),
        published_year: rich.published_year.or(thin.published_year),
        description: rich.description.or_else(|| thin.description.clone()),
        rating: rich.rating.or(thin.rating),
        rating_count: rich.rating_count.or(thin.rating_count),
        douban_url: rich.douban_url.or_else(|| thin.douban_url.clone()),
        language: rich.language.or_else(|| thin.language.clone()),
        isbn: rich.isbn.or_else(|| thin.isbn.clone()),
        cover_url: rich.cover_url.or_else(|| thin.cover_url.clone()),
        match_score: thin.match_score.max(rich.match_score),
    }
}

/// The first four digits of `2014-11`, as a year.
fn year_of(raw: &str) -> Option<i32> {
    let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
    (digits.len() == 4).then(|| digits.parse().ok()).flatten()
}

/// Douban repeats an author in more than one spelling — 《我们为什么会生病》
/// answers with `[美] 伦道夫·M·尼斯` and `伦道夫·尼斯` for the same person.
/// Exact duplicates are dropped and variants are kept: telling them apart would
/// take name-matching heuristics, and the author list is the one place the
/// reader sees every value before it is written.
fn dedup(names: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(names.len());
    for name in names {
        if !out.iter().any(|kept| kept == &name) {
            out.push(name);
        }
    }
    out
}

/// NeoDB's search URL. A function of its own so a test can read the query
/// string without a socket.
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

fn douban_suggest_url(lookup: &Lookup<'_>) -> AppResult<reqwest::Url> {
    let mut url = reqwest::Url::parse(DOUBAN_SUGGEST)
        .map_err(|err| AppError::Message(format!("书源地址不合法：{err}")))?;
    // The title alone, not title + author, for the same reason as NeoDB: the
    // catalogue spells authors differently (`[以色列] 尤瓦尔·赫拉利` against a
    // book whose file says `尤瓦尔·赫拉利`), and narrowing on that loses the
    // record. The author ranks the results instead.
    url.query_pairs_mut().append_pair("q", lookup.title.trim());
    Ok(url)
}

/// The subject page this record points at, when it points at one.
fn douban_subject(body: &Value) -> Option<String> {
    let url = text(body, "url")?;
    is_douban_subject(&url).then_some(url)
}

fn is_douban_subject(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|parsed| {
        parsed.scheme() == "https"
            && parsed.host_str() == Some("book.douban.com")
            && parsed.path().starts_with("/subject/")
    })
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
        source: Provider::Neodb.key().to_string(),
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
        rating: doc.get("rating").and_then(Value::as_f64),
        rating_count: doc.get("rating_count").and_then(Value::as_i64).map(|count| count as i32),
        douban_url: douban_link(doc),
        match_score,
    })
}

/// The Douban page this record was linked from.
///
/// NeoDB keeps a list of outside pages for each record; Douban is one of them
/// when the record was imported from there. Taken as-is rather than built from
/// an id, because the id this app would have to guess is the one thing that
/// makes the link wrong.
fn douban_link(doc: &Value) -> Option<String> {
    doc.get("external_resources")?
        .as_array()?
        .iter()
        .filter_map(|entry| entry.get("url").and_then(Value::as_str))
        // Parsed, not substring-matched: `https://evil.example/?x=book.douban.com/`
        // contains the string and would be handed to the operating system. The
        // host has to *be* Douban, and the scheme has to be https — the opener
        // capability is scoped to this host, so anything else would fail anyway,
        // silently.
        .find(|url| is_douban_subject(url))
        .map(str::to_string)
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
                    "cover_image_url": "https://neodb.social/m/book/2021/09/cover.jpg",
                    "rating": 9.2,
                    "rating_count": 995,
                    "external_resources": [
                        { "url": "https://www.goodreads.com/book/show/25233317" },
                        { "url": "https://book.douban.com/subject/25985021/" }
                    ]
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
            rating: None,
            douban_url: None,
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
            rating: None,
            rating_count: None,
            douban_url: None,
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

    /// The number is NeoDB's, not Douban's — 《活着》 is 9.2 with 995 people
    /// there and roughly 9.4 with hundreds of thousands on Douban. The link is
    /// the only honest way to show a Douban number, so it is carried too.
    #[test]
    fn a_candidate_carries_the_rating_and_the_douban_page() {
        let found = parse(&body(), &lookup("人类简史", &[]));
        let best = &found[0];
        assert_eq!(best.rating, Some(9.2));
        assert_eq!(best.rating_count, Some(995));
        assert_eq!(best.douban_url.as_deref(), Some("https://book.douban.com/subject/25985021/"));
        // Goodreads is in the same list and must not be mistaken for it.
        assert!(!best.douban_url.as_deref().unwrap_or_default().contains("goodreads"));
    }

    /// A URL that merely mentions Douban is not a Douban link. This string is
    /// handed to the operating system, and the capability scope only covers
    /// `book.douban.com` — so a lookalike would fail at the last moment, with
    /// nothing to show for it.
    #[test]
    fn a_lookalike_host_is_not_a_douban_link() {
        let body = json!({
            "data": [{
                "title": "书",
                "external_resources": [
                    { "url": "https://evil.example/?x=book.douban.com/subject/1/" },
                    { "url": "http://book.douban.com/subject/2/" },
                    { "url": "https://book.douban.com.evil.example/subject/3/" }
                ]
            }]
        });
        let found = parse(&body, &lookup("书", &[]));
        assert_eq!(found[0].douban_url, None, "{:?}", found[0].douban_url);
    }

    #[test]
    fn a_record_without_a_douban_page_says_nothing_rather_than_guessing() {
        let body = json!({ "data": [{ "title": "书" }] });
        let found = parse(&body, &lookup("书", &[]));
        assert_eq!(found[0].douban_url, None);
        assert_eq!(found[0].rating, None);
    }

    #[test]
    fn a_proposal_carries_the_rating_beside_its_fills() {
        let mut found = candidate(Some("中信出版社"), None, 0.95);
        found.rating = Some(9.2);
        found.rating_count = Some(995);
        found.douban_url = Some("https://book.douban.com/subject/1/".into());
        let proposal = propose_for(&target(None, None), Some(found));
        assert_eq!(proposal.rating, Some(9.2));
        assert_eq!(proposal.rating_count, Some(995));
        assert!(proposal.douban_url.is_some());
        assert!(!proposal.fills.is_empty(), "评分不影响字段补全");
    }

    /// A book that already has a rating keeps it: what the row shows must be
    /// exactly what the apply writes.
    #[test]
    fn a_book_that_already_has_a_rating_is_not_given_a_new_one() {
        let mut found = candidate(Some("中信出版社"), None, 0.95);
        found.rating = Some(9.2);
        found.douban_url = Some("https://book.douban.com/subject/1/".into());
        let mut book = target(None, None);
        book.rating = Some(8.0);
        let proposal = propose_for(&book, Some(found));
        assert_eq!(proposal.rating, None);
        assert_eq!(proposal.douban_url.as_deref(), Some("https://book.douban.com/subject/1/"));
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

    // ---- Douban -------------------------------------------------------
    //
    // Both fixtures below are real responses, trimmed to the fields this app
    // reads. 《活着》 is the autocomplete for a two-character title that returns
    // the novel twice — a 2012 printing and a 2017 one — which is exactly the
    // case the ranking and the id have to survive.

    fn douban_suggest_body() -> Value {
        json!([
            {
                "title": "活着",
                "url": "https://book.douban.com/subject/4913064/",
                "pic": "https://img9.doubanio.com/view/subject/s/public/s29869926.jpg",
                "author_name": "余华",
                "year": "2012",
                "type": "b",
                "id": "4913064"
            },
            {
                "title": "活着",
                "url": "https://book.douban.com/subject/27064488/",
                "pic": "https://img3.doubanio.com/view/subject/s/public/s29652928.jpg",
                "author_name": "余华",
                "year": "2017",
                "type": "b",
                "id": "27064488"
            }
        ])
    }

    fn douban_detail_body() -> Value {
        json!({
            "title": "我们为什么会生病",
            "book_subtitle": "",
            "subtitle": [],
            "author": ["[美] 伦道夫·M·尼斯", "[美] 乔治·C·威廉斯", "伦道夫·尼斯"],
            "press": ["湖南科学技术出版社"],
            "pubdate": ["2018-3"],
            "rating": { "count": 2344, "max": 10, "star_count": 4.0, "value": 8.4 },
            "intro": "有没有想过，人为什么会发烧、发炎？",
            "url": "https://book.douban.com/subject/30164677/",
            "cover_url": "https://img3.doubanio.com/view/subject/l/public/s29710377.jpg"
        })
    }

    #[test]
    fn a_suggest_hit_carries_the_id_the_year_and_the_page() {
        let authors = ["余华".to_string()];
        let hits = parse_suggest(&douban_suggest_body(), &lookup("活着", &authors));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "4913064");
        let first = &hits[0].candidate;
        assert_eq!(first.source, "douban");
        assert_eq!(first.title, "活着");
        assert_eq!(first.authors, ["余华"]);
        assert_eq!(first.published_year, Some(2012));
        assert_eq!(first.douban_url.as_deref(), Some("https://book.douban.com/subject/4913064/"));
        assert!(first.match_score > 0.9, "{first:?}");
    }

    /// The same endpoint answers films and music. 《活着》 is both a novel and a
    /// film, and a shelf of books must not be handed the film.
    #[test]
    fn a_film_with_the_same_title_is_not_a_book() {
        let body = json!([
            { "title": "活着", "type": "m", "id": "1292365", "author_name": "张艺谋" },
            { "title": "活着", "type": "b", "id": "4913064", "author_name": "余华" }
        ]);
        let hits = parse_suggest(&body, &lookup("活着", &[]));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "4913064");
    }

    /// The id is interpolated into a URL path. A value from somebody else's
    /// JSON does not get to decide where the next request goes.
    #[test]
    fn an_id_that_is_not_digits_is_refused() {
        let body = json!([
            { "title": "书", "type": "b", "id": "../../evil" },
            { "title": "书", "type": "b", "id": "12 34" },
            { "title": "书", "type": "b", "id": "" }
        ]);
        assert!(parse_suggest(&body, &lookup("书", &[])).is_empty());
    }

    #[test]
    fn the_opened_record_fills_what_the_sheet_asks_for() {
        let found = parse_detail(&douban_detail_body(), &lookup("我们为什么会生病", &[]))
            .expect("a record");
        assert_eq!(found.source, "douban");
        assert_eq!(found.publisher.as_deref(), Some("湖南科学技术出版社"));
        assert_eq!(found.published_year, Some(2018), "`2018-3` 取前四位");
        assert_eq!(found.rating, Some(8.4));
        assert_eq!(found.rating_count, Some(2344));
        assert_eq!(found.description.as_deref(), Some("有没有想过，人为什么会发烧、发炎？"));
        assert_eq!(found.douban_url.as_deref(), Some("https://book.douban.com/subject/30164677/"));
        // Douban repeats the same person twice; the array keeps both spellings
        // and drops nothing that is genuinely different.
        assert_eq!(found.authors.len(), 3, "{:?}", found.authors);
        // Neither of these is in the response, and guessing would be worse than
        // an empty field.
        assert_eq!(found.isbn, None);
        assert_eq!(found.language, None);
    }

    #[test]
    fn a_subtitle_comes_from_the_record() {
        let body = json!({
            "title": "人类简史",
            "book_subtitle": "从动物到上帝",
            "author": ["[以色列] 尤瓦尔·赫拉利"],
            "press": ["中信出版社"],
            "pubdate": ["2014-11"],
            "rating": { "count": 217634, "value": 9.1 }
        });
        let found = parse_detail(&body, &lookup("人类简史", &[])).expect("a record");
        assert_eq!(found.subtitle.as_deref(), Some("从动物到上帝"));
        assert_eq!(found.published_year, Some(2014));
        assert_eq!(found.rating, Some(9.1));
        assert_eq!(found.rating_count, Some(217634), "二十万人打的分，不是 995 人");
    }

    /// The endpoint reports its errors with HTTP 200 and a `code` field. A
    /// status check is not enough, and a candidate built from an error body
    /// would have an empty title and every field `None`.
    #[test]
    fn a_record_that_reports_an_error_is_not_a_candidate() {
        let body = json!({ "request": "GET /rexxar/v2/book/1", "msg": "invalid_request_1284", "code": 1287 });
        assert!(parse_detail(&body, &lookup("书", &[])).is_none());
    }

    #[test]
    fn a_lookalike_subject_url_is_dropped() {
        for url in [
            "https://evil.example/subject/1/",
            "http://book.douban.com/subject/1/",
            "https://book.douban.com.evil.example/subject/1/",
            "https://book.douban.com/collection/1/",
        ] {
            let body = json!({ "title": "书", "url": url });
            let found = parse_detail(&body, &lookup("书", &[])).expect("a record");
            assert_eq!(found.douban_url, None, "{url}");
        }
    }

    #[test]
    fn an_opened_record_that_lost_a_field_falls_back_to_the_hit() {
        let thin = parse_suggest(&douban_suggest_body(), &lookup("活着", &[])).remove(0).candidate;
        // A record with no authors: the autocomplete already knew them.
        let rich = parse_detail(
            &json!({ "title": "活着", "press": ["作家出版社"] }),
            &lookup("活着", &[]),
        )
        .expect("a record");
        let merged = merge(&thin, rich);
        assert_eq!(merged.authors, ["余华"]);
        assert_eq!(merged.publisher.as_deref(), Some("作家出版社"));
        assert_eq!(merged.published_year, Some(2012), "记录没给年份，用搜到的");
        assert_eq!(merged.cover_url, thin.cover_url);
    }

    #[test]
    fn a_year_is_the_first_four_digits_of_the_date() {
        assert_eq!(year_of("2014-11"), Some(2014));
        assert_eq!(year_of("2014"), Some(2014));
        assert_eq!(year_of("2014-1-1"), Some(2014));
        assert_eq!(year_of(""), None);
        assert_eq!(year_of("201"), None);
        assert_eq!(year_of("再版"), None);
    }

    /// The label is only correct if it travels with the number.
    #[test]
    fn a_douban_rating_carries_its_own_source() {
        let found = parse_detail(&douban_detail_body(), &lookup("我们为什么会生病", &[]))
            .expect("a record");
        let proposal = propose_for(&target(None, None), Some(found));
        assert_eq!(proposal.rating, Some(8.4));
        assert_eq!(proposal.rating_source.as_deref(), Some("douban"));
    }

    #[test]
    fn a_neodb_rating_says_neodb() {
        let mut found = candidate(None, None, 0.95);
        found.rating = Some(9.2);
        let proposal = propose_for(&target(None, None), Some(found));
        assert_eq!(proposal.rating_source.as_deref(), Some("neodb"));
    }

    #[test]
    fn a_book_that_keeps_its_rating_is_not_given_a_new_label() {
        let found = candidate(Some("重庆出版社"), None, 0.95);
        let mut book = target(None, None);
        book.rating = Some(8.0);
        let proposal = propose_for(&book, Some(found));
        assert_eq!(proposal.rating, None);
        assert_eq!(proposal.rating_source, None, "没有要写的评分，就没有来源");
    }

    // ---- 来源链 --------------------------------------------------------

    #[test]
    fn a_provider_that_failed_is_not_asked_again_in_the_same_batch() {
        let attempts = Attempts::new();
        assert!(!attempts.is_down(Provider::Neodb));
        attempts.mark_down(Provider::Neodb);
        assert!(attempts.is_down(Provider::Neodb));
        assert!(!attempts.is_down(Provider::Douban), "一个来源挂了不影响另一个");
    }

    #[test]
    fn the_chain_asks_douban_first() {
        // The order is the whole point: NeoDB is not reachable from mainland
        // China without a proxy, so asking it first costs a twelve-second
        // timeout before the provider that works even starts.
        assert_eq!(Provider::CHAIN[0], Provider::Douban);
        assert_eq!(Provider::CHAIN[1], Provider::Neodb);
    }

    #[test]
    fn the_chain_takes_the_first_answer() {
        let douban = parse_detail(&douban_detail_body(), &lookup("我们为什么会生病", &[]))
            .expect("a record");
        let results = vec![
            (Provider::Douban, Ok(vec![douban.clone()])),
            (Provider::Neodb, Ok(vec![candidate(None, None, 0.9)])),
        ];
        let chosen = choose(results).expect("an answer");
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].source, "douban");
    }

    #[test]
    fn the_chain_falls_through_when_the_first_has_nothing() {
        let results = vec![
            (Provider::Douban, Ok(Vec::new())),
            (Provider::Neodb, Ok(vec![candidate(None, None, 0.9)])),
        ];
        let chosen = choose(results).expect("an answer");
        assert_eq!(chosen[0].source, "neodb");
    }

    /// 「连不上」 and 「没有这本」 are different, and reporting the first as the
    /// second sends the reader looking for a better title when the network is
    /// the problem.
    #[test]
    fn two_failures_are_an_error_that_names_both() {
        let results = vec![
            (Provider::Douban, Err(AppError::Message("连不上豆瓣：超时".into()))),
            (Provider::Neodb, Err(AppError::Message("连不上 NeoDB：超时".into()))),
        ];
        let err = choose(results).expect_err("no provider answered");
        let text = err.to_string();
        assert!(text.contains("豆瓣"), "{text}");
        assert!(text.contains("NeoDB"), "{text}");
        assert!(text.contains("超时"), "{text}");
    }

    /// One provider answering 「没有找到」 makes the whole result an honest
    /// empty list, even when the other one is down: something was asked and
    /// something answered.
    #[test]
    fn one_answer_and_one_failure_is_an_empty_result_not_an_error() {
        let results = vec![
            (Provider::Douban, Ok(Vec::new())),
            (Provider::Neodb, Err(AppError::Message("连不上 NeoDB".into()))),
        ];
        let chosen = choose(results).expect("not an error");
        assert!(chosen.is_empty());
    }

    // ---- 联网（默认跳过） ------------------------------------------------
    //
    // ```text
    // cargo test --manifest-path src-tauri/Cargo.toml metadata -- --ignored --nocapture
    // ```

    /// Douban, live. This one runs from the mainland without a proxy, which is
    /// the entire reason the provider exists.
    #[test]
    #[ignore = "hits the network: book.douban.com"]
    fn the_live_douban_answers_the_shape_this_parser_expects() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let lookup = Lookup { title: "人类简史", authors: &authors };
        let client = Client::new();
        let found = tauri::async_runtime::block_on(search(&client, Provider::Douban, &lookup, 3))
            .expect("live search");
        println!("\n{} candidates", found.len());
        for candidate in &found {
            println!(
                "  {:.2}  {} · {:?} · {:?} · {:?}",
                candidate.match_score,
                candidate.title,
                candidate.authors,
                candidate.published_year,
                candidate.rating
            );
        }
        assert!(!found.is_empty(), "豆瓣不可能没有《人类简史》");
        assert_eq!(found[0].title, "人类简史");
        assert!(found[0].match_score > 0.5, "{:?}", found[0]);
        // The fields the sheet asks for, from a real record.
        assert!(found[0].publisher.is_some(), "{:?}", found[0]);
        assert!(found[0].rating.is_some(), "{:?}", found[0]);
        assert!(found[0].description.is_some(), "{:?}", found[0]);
    }

    /// The point of the whole chain: from a network where NeoDB cannot be
    /// reached — which is where this app is used — a lookup still answers.
    ///
    /// Run it somewhere the proxy is off. The fallback's outcome is printed
    /// rather than asserted, because it is a fact about the network this runs
    /// on, not about the code.
    #[test]
    #[ignore = "hits the network: book.douban.com"]
    fn the_chain_answers_when_the_proxy_is_off() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let lookup = Lookup { title: "人类简史", authors: &authors };
        let client = Client::new();
        let found = tauri::async_runtime::block_on(find(&client, &lookup, 1, &Attempts::new()))
            .expect("an answer without a proxy");
        println!("\n答案来自 {}：{}", found[0].source, found[0].title);
        assert!(!found.is_empty());
        assert_eq!(found[0].source, "douban");
        println!(
            "NeoDB 这条（有代理才通）：{:?}",
            tauri::async_runtime::block_on(search(&client, Provider::Neodb, &lookup, 1))
                .map(|found| found.len())
        );
    }

    #[test]
    #[ignore = "hits the network: neodb.social"]
    fn the_live_neodb_answers_the_shape_this_parser_expects() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let lookup = Lookup { title: "人类简史", authors: &authors };
        let client = Client::new();
        let found = tauri::async_runtime::block_on(search(&client, Provider::Neodb, &lookup, 1))
            .expect("live search");
        assert!(!found.is_empty(), "真实目录里不可能没有《人类简史》");
        assert!(found[0].title.contains("人类简史"), "{:?}", found[0]);
    }
}
