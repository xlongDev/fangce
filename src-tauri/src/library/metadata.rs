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

/// The client every lookup uses.
///
/// The connect timeout is the load-bearing part: a host that is blocked does
/// not refuse the connection, it swallows it, so without this the whole
/// twelve-second budget goes on a TCP handshake. A 950-book run asks about
/// twenty-four batches, and one stall per batch is five minutes of nothing.
///
/// `Client::default()` on the (practically impossible) build failure: a lookup
/// without a connect timeout is worse than no lookup, but not worse than a
/// panic on the shelf.
pub fn client() -> Client {
    Client::builder().connect_timeout(Duration::from_secs(3)).build().unwrap_or_default()
}

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

    /// The inverse of [`Provider::key`], for the command that lets the reader
    /// pick a source by name.
    pub fn parse(key: &str) -> Option<Self> {
        match key.trim() {
            "douban" => Some(Provider::Douban),
            "neodb" => Some(Provider::Neodb),
            _ => None,
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
    /// Whether the book still has no ISBN — the one field that costs a second
    /// request, and the one worth it (Douban's JSON has none).
    pub want_isbn: bool,
    /// [`core_title`] of `title`, computed once.
    ///
    /// A library's titles carry things catalogues drop — 「索拉里斯星（修订版）」
    /// against a record called 「索拉里斯星」 — and both the query and the
    /// ranking have to look past them.
    core: String,
}

impl<'a> Lookup<'a> {
    pub fn new(title: &'a str, authors: &'a [String], want_isbn: bool) -> Self {
        Self { title, authors, want_isbn, core: core_title(title) }
    }
}

/// Brackets a Chinese title uses for an edition note, and their closers.
const BRACKETS: [(char, char); 5] =
    [('（', '）'), ('(', ')'), ('【', '】'), ('〔', '〕'), ('［', '］')];

/// Separators that end the part of a title a catalogue keeps.
const SEPARATORS: [&str; 8] = ["——", "—", "：", ":", "，", ",", "；", ";"];

/// The title with its edition note and subtitle taken off.
///
/// 「索拉里斯星（修订版）」 → 「索拉里斯星」, 「人类简史：从动物到上帝」 →
/// 「人类简史」. Used for the query *and* for scoring, because a candidate that
/// matches the core is the right book even when the shelf's title is longer.
fn core_title(title: &str) -> String {
    let mut text = title.trim().to_string();
    // Repeatedly, because 「书名（修订版）（全二册）」 is a shape that exists.
    while let Some(shorter) = strip_trailing_group(&text) {
        text = shorter;
    }
    for separator in SEPARATORS {
        if let Some(index) = text.find(separator) {
            let head = text[..index].trim();
            if head.chars().count() >= 2 {
                text = head.to_string();
                break;
            }
        }
    }
    text
}

fn strip_trailing_group(text: &str) -> Option<String> {
    let trimmed = text.trim_end();
    let last = trimmed.chars().last()?;
    let open = BRACKETS.iter().find(|(_, close)| *close == last)?.0;
    let cut = trimmed.rfind(open)?;
    let head = trimmed[..cut].trim();
    (!head.is_empty()).then(|| head.to_string())
}

/// 「沙丘2」 → 「沙丘」, 「三体Ⅱ」 → 「三体」. Left alone when nothing would be
/// left (「1984」 is a title, not a volume number).
fn strip_volume(text: &str) -> String {
    let trimmed = text.trim_end();
    let end = trimmed.trim_end_matches(|ch: char| {
        ch.is_ascii_digit() || ('Ⅰ'..='Ⅻ').contains(&ch) || ch.is_whitespace()
    });
    let end = end.trim_end_matches(['卷', '册', '部']);
    let head = end.trim();
    let shorter = head.chars().count() >= 2 && head.chars().count() < trimmed.chars().count();
    if shorter { head.to_string() } else { trimmed.to_string() }
}

/// How many queries one book may cost.
///
/// The first one answers for most books; the rest exist for the ones that do
/// not, and every extra attempt is another request to somebody else's server.
const MAX_QUERIES: usize = 4;

/// The queries to try, most specific first.
///
/// `subject_suggest` is an **autocomplete, not a search**: it matches from the
/// start of a title. 「索拉里斯星」 finds two records and 「索拉里斯星（修订版）」
/// finds none, which is what 「很多书查不到」 turned out to be. Every step below
/// removes something a catalogue does not have.
pub fn queries_for(title: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |query: String| {
        let query = query.trim().to_string();
        if query.chars().count() >= 2 && !out.contains(&query) {
            out.push(query);
        }
    };
    push(title.trim().to_string());
    let core = core_title(title);
    push(core.clone());
    let without_volume = strip_volume(&core);
    push(without_volume.clone());
    // A shorter prefix: the last resort, and it still beats 「没有找到」 when the
    // catalogue's title continues past the reader's.
    let head: String = without_volume.chars().take(6).collect();
    if head.chars().count() == 6 {
        push(head);
    }
    out.truncate(MAX_QUERIES);
    out
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
    /// Whether the shelf already has a picture for it. A cover is a file, not a
    /// column, and overwriting one the reader is used to seeing is not a
    /// "fill" — so this is the one field that is only ever written when absent.
    pub has_cover: bool,
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
    /// The catalogue's cover, when the book has none.
    ///
    /// Beside the fills rather than as one: a cover is a file to download, not
    /// a string to write, and `None` here means either the catalogue had no
    /// picture or the book already has one — both of which mean "nothing to do
    /// about the cover".
    pub cover_url: Option<String>,
    /// The fields this book already has, in the order the sheet shows them.
    ///
    /// Shown beside what the fill would add, because 「只补了两项」 reads as a
    /// catalogue with thin data unless the row also says the other four were
    /// already there. Same vocabulary as [`Fill::field`].
    pub existing: Vec<String>,
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
        cover_url: None,
        existing: Vec::new(),
    }
}

/// Turns one book's best candidate into a proposal, or into a reason.
pub fn propose_for(target: &Target, best: Option<Candidate>) -> Proposal {
    // What the book already has, in the sheet's order. Computed before the
    // match so an early return still reports it.
    let existing: Vec<String> = [
        ("subtitle", target.subtitle.is_some()),
        ("publisher", target.publisher.is_some()),
        ("language", target.language.is_some()),
        ("isbn", target.isbn.is_some()),
        ("publishedYear", target.published_year.is_some()),
        ("description", target.description.is_some()),
    ]
    .into_iter()
    .filter(|(_, has)| *has)
    .map(|(field, _)| field.to_string())
    .collect();

    let (fills, skipped, match_score, rating, rating_count, douban_url, rating_source, cover_url) =
        match best {
            None => (
                Vec::new(),
                Some("没有找到相近的书".to_string()),
                0.0,
                None,
                None,
                None,
                None,
                None,
            ),
            Some(candidate) if candidate.match_score < MIN_SCORE => (
                Vec::new(),
                Some(format!("匹配度只有 {:.0}%，不采用", candidate.match_score * 100.0)),
                candidate.match_score,
                None,
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
                let douban_url =
                    target.douban_url.is_none().then_some(candidate.douban_url).flatten();
                // A book that already has a picture keeps it: replacing one the
                // reader is used to seeing is not a fill.
                let cover_url = if target.has_cover { None } else { candidate.cover_url };
                let nothing_to_do = fills.is_empty()
                    && rating.is_none()
                    && douban_url.is_none()
                    && cover_url.is_none();
                let skipped = nothing_to_do.then(|| "可补的字段都已经有了".to_string());
                // The source only travels when the number does: a label with no
                // rating behind it would print next to an empty space.
                let rating_source = rating.and(Some(candidate.source));
                (
                    fills,
                    skipped,
                    candidate.match_score,
                    rating,
                    rating_count,
                    douban_url,
                    rating_source,
                    cover_url,
                )
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
        cover_url,
        existing,
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
        let settled = matches!(&outcome, Ok(found) if is_strong(found));
        results.push((provider, outcome));
        // Stop at the first provider with an answer worth using. Asking the rest
        // would mean waiting out a timeout on one that cannot be reached from
        // here — but a weak match is not worth stopping for: 「匹配度 45%」 from
        // one catalogue is a reason to ask the other, not an answer.
        if settled {
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
    let mut weak: Option<Vec<Candidate>> = None;
    for (provider, outcome) in results {
        match outcome {
            Ok(found) if is_strong(&found) => return Ok(found),
            Ok(found) if !found.is_empty() => {
                // Kept, not used: a weak match still beats 「两个来源都连不上」,
                // and the row will say 匹配度 only N% so nothing is hidden.
                notes.push(format!("{}：只有弱匹配", provider.label()));
                weak.get_or_insert(found);
            }
            Ok(_) => {
                answered = true;
                notes.push(format!("{}：没有找到", provider.label()));
            }
            Err(err) => notes.push(format!("{}：{err}", provider.label())),
        }
    }
    if let Some(found) = weak {
        return Ok(found);
    }
    if answered {
        return Ok(Vec::new());
    }
    Err(AppError::Message(notes.join("；")))
}

/// Whether a provider's answer is worth stopping the chain for.
fn is_strong(found: &[Candidate]) -> bool {
    found.first().is_some_and(|best| best.match_score >= MIN_SCORE)
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
/// API answers `need_login`. It is also a **prefix** matcher, so a title with an
/// edition note finds nothing; [`queries_for`] is what makes 「索拉里斯星（修订版）」
/// reach the record called 「索拉里斯星」.
async fn search_douban(
    client: &Client,
    lookup: &Lookup<'_>,
    depth: usize,
) -> AppResult<Vec<Candidate>> {
    let mut failure = None;
    for query in queries_for(lookup.title) {
        let body = match suggest(client, &query).await {
            Ok(body) => body,
            // A request that failed is not a query that found nothing: stop
            // rather than spend the remaining attempts on a network that is
            // down.
            Err(err) => {
                failure = Some(err);
                break;
            }
        };
        let hits = parse_suggest(&body, lookup);
        if !hits.is_empty() {
            return Ok(open_hits(client, hits, depth, lookup).await);
        }
    }
    match failure {
        Some(err) => Err(err),
        None => Ok(Vec::new()),
    }
}

/// One autocomplete request.
async fn suggest(client: &Client, query: &str) -> AppResult<Value> {
    let mut url = reqwest::Url::parse(DOUBAN_SUGGEST)
        .map_err(|err| AppError::Message(format!("书源地址不合法：{err}")))?;
    url.query_pairs_mut().append_pair("q", query);
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
    response.json().await.map_err(|err| AppError::Message(format!("豆瓣的回复看不懂：{err}")))
}

/// Opens the first `depth` hits into full records.
async fn open_hits(
    client: &Client,
    hits: Vec<Hit>,
    depth: usize,
    lookup: &Lookup<'_>,
) -> Vec<Candidate> {
    let hits: Vec<Hit> = hits.into_iter().take(depth.max(1)).collect();
    // Opened side by side rather than one after another: three records at about
    // a second each is three seconds of a dialog that looks stuck, and the cap
    // here is three. `join_all` keeps the order, so the ranking survives.
    let opened = futures_util::future::join_all(
        hits.iter().map(|hit| open_subject(client, &hit.id, lookup)),
    )
    .await;
    hits.into_iter()
        .zip(opened)
        // A hit whose record could not be opened is still worth showing: it has
        // the title, the author, the year and the page. Throwing the whole
        // lookup away because the second request timed out would lose that.
        .map(|(hit, rich)| match rich {
            Some(rich) => merge(&hit.candidate, rich),
            None => hit.candidate,
        })
        .collect()
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
    let mut candidate = parse_detail(&body, lookup)?;
    if lookup.want_isbn
        && candidate.isbn.is_none()
        && let Some(info_url) = text(&body, "info_url")
    {
        candidate.isbn = isbn_of(client, &info_url).await;
    }
    Some(candidate)
}

/// The ISBN, from the small page the mobile app shows for a book's details.
///
/// The JSON record has no ISBN at all, and the desktop subject page that does
/// is 118 KB of markup. This one is 3 KB and carries the same table —
/// `<td>ISBN</td><td>978…</td>` — which is the only reason the field can be
/// filled at all. `info_url` comes from the record, and is still checked to be
/// Douban before anything is sent to it.
async fn isbn_of(client: &Client, info_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(info_url).ok()?;
    if url.scheme() != "https" || !url.host_str()?.ends_with("douban.com") {
        return None;
    }
    let page = client
        .get(url)
        .timeout(Duration::from_secs(12))
        .header("User-Agent", DOUBAN_UA)
        .header("Referer", "https://book.douban.com/")
        .send()
        .await
        .ok()?;
    if !page.status().is_success() {
        return None;
    }
    isbn_from_page(&page.text().await.ok()?)
}

/// Pure: the table row, from the page's markup.
pub fn isbn_from_page(html: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = html[from..].find("ISBN") {
        let at = from + found + "ISBN".len();
        from = at;
        let rest = &html[at..];
        let Some(open) = rest.find("<td>") else {
            continue;
        };
        let after = &rest[open + "<td>".len()..];
        let Some(close) = after.find("</td>") else {
            continue;
        };
        let value = after[..close].trim();
        if is_isbn(value) {
            return Some(value.to_string());
        }
    }
    None
}

fn is_isbn(value: &str) -> bool {
    let count = value.chars().count();
    (count == 10 || count == 13)
        && value.chars().all(|ch| ch.is_ascii_digit() || ch == 'X')
        && value.chars().filter(char::is_ascii_digit).count() >= 9
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

/// The largest cover worth keeping. A shelf thumbnail at 1200 px is well under
/// this; anything larger is a page scan somebody mislabelled.
const MAX_COVER_BYTES: usize = 8 * 1024 * 1024;

/// Downloads a cover the catalogue pointed at.
///
/// The URL comes out of somebody else's JSON, so it is checked before a request
/// is sent: https, and a host that is one of the catalogues' own image servers.
/// Without that check this would be an HTTP client that fetches whatever a
/// response happened to contain — including the reader's own network.
pub async fn download_cover(client: &Client, url: &str) -> AppResult<Vec<u8>> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|err| AppError::Message(format!("封面地址不合法：{err}")))?;
    let host = parsed.host_str().unwrap_or_default();
    let allowed = parsed.scheme() == "https"
        && (host == "doubanio.com"
            || host.ends_with(".doubanio.com")
            || host == "neodb.social"
            || host.ends_with(".neodb.social"));
    if !allowed {
        return Err(AppError::InvalidArgument(format!("不是目录的图片地址：{host}")));
    }
    let response = client
        .get(parsed)
        .timeout(Duration::from_secs(20))
        .header("User-Agent", DOUBAN_UA)
        // Douban's image CDN answers 418 with no referer and 200 with one.
        .header("Referer", "https://book.douban.com/")
        .send()
        .await
        .map_err(|err| AppError::Message(format!("下载封面失败：{err}")))?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!("封面返回了 {}", response.status().as_u16())));
    }
    let bytes =
        response.bytes().await.map_err(|err| AppError::Message(format!("下载封面失败：{err}")))?;
    if bytes.len() > MAX_COVER_BYTES {
        return Err(AppError::Message("封面太大了，跳过".into()));
    }
    if image_extension(&bytes).is_none() {
        return Err(AppError::Message("拿到的不是图片，跳过".into()));
    }
    Ok(bytes.to_vec())
}

/// `jpg` or `png`, from the bytes rather than from the URL.
///
/// The extension matters: the shelf serves the file through the asset protocol,
/// which picks a content type from it. A JPEG stored as `.png` is the kind of
/// thing that works everywhere until it does not.
pub fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    None
}

/// The MIME a `data:` URL has to declare, derived from the bytes for the same
/// reason the extension is: Douban serves `.jpg` paths that are sometimes PNG,
/// and a data URL whose type disagrees with its payload renders as nothing.
pub fn preview_mime(bytes: &[u8]) -> Option<&'static str> {
    match image_extension(bytes) {
        Some("jpg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        _ => None,
    }
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
    // The better of the two: a record called 「索拉里斯星」 against a shelf title
    // of 「索拉里斯星（修订版）」 is the same book, and scoring only the full
    // title would rank it below a stranger that happens to share more characters.
    let title_score = similarity(lookup.title, title).max(similarity(&lookup.core, title));
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
        Lookup::new(title, authors, false)
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
            has_cover: false,
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

    /// 「已有 …」 — what the row is not going to touch.
    #[test]
    fn a_proposal_says_what_the_book_already_has() {
        let mut book = target(None, None);
        book.subtitle = Some("从动物到上帝".into());
        book.isbn = Some("9787508647357".into());
        let proposal = propose_for(&book, Some(candidate(Some("中信出版社"), None, 0.95)));
        assert_eq!(proposal.existing, ["subtitle", "isbn"], "按表单顺序，不是按有无");
        // And the fill is still only the empty ones.
        assert!(proposal.fills.iter().all(|fill| fill.field != "subtitle"));
    }

    /// A book with every field filled still gains a rating — so it is not
    /// 「没事可做」, and the row has to stay tickable.
    #[test]
    fn a_book_with_every_field_but_no_rating_still_has_something_to_write() {
        let mut book = target(Some("中信出版社"), Some("zh"));
        book.subtitle = Some("从动物到上帝".into());
        book.isbn = Some("9787508647357".into());
        book.published_year = Some(2014);
        book.description = Some("简介".into());
        let mut found = candidate(None, None, 0.95);
        found.rating = Some(9.1);
        let proposal = propose_for(&book, Some(found));
        assert!(proposal.fills.is_empty());
        assert_eq!(proposal.rating, Some(9.1));
        assert_eq!(proposal.skipped, None, "有评分可写，就不是「可补的字段都已经有了」");
        assert_eq!(proposal.existing.len(), 6);
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

    // ---- 书名归一化 ----------------------------------------------------

    /// The reason 「很多书查不到」 existed: the endpoint is an autocomplete, and
    /// an edition note at the end of the title makes it match nothing.
    #[test]
    fn an_edition_note_is_taken_off_before_asking() {
        let queries = queries_for("索拉里斯星（修订版）");
        assert_eq!(queries[0], "索拉里斯星（修订版）", "先原样问一次");
        assert_eq!(queries[1], "索拉里斯星", "再问一次去掉版次注的");
    }

    #[test]
    fn a_subtitle_is_taken_off_before_asking() {
        let queries = queries_for("人类简史：从动物到上帝");
        assert!(queries.contains(&"人类简史".to_string()), "{queries:?}");
    }

    #[test]
    fn a_volume_number_is_taken_off_before_asking() {
        let queries = queries_for("沙丘2");
        assert!(queries.contains(&"沙丘".to_string()), "{queries:?}");
        let roman = queries_for("三体Ⅱ");
        assert!(roman.contains(&"三体".to_string()), "{roman:?}");
    }

    /// 「1984」 is a title, not a volume number, and stripping it would leave
    /// nothing to search for.
    #[test]
    fn a_title_that_is_all_digits_is_left_alone() {
        assert_eq!(queries_for("1984"), ["1984"]);
    }

    #[test]
    fn both_shapes_at_once_are_handled() {
        let queries = queries_for("人类简史：从动物到上帝（修订版）");
        assert!(queries.contains(&"人类简史".to_string()), "{queries:?}");
    }

    #[test]
    fn a_title_is_never_asked_more_than_four_times() {
        let queries = queries_for("一个名字很长很长很长很长很长很长的书名：带副标题（修订版）");
        assert!(queries.len() <= MAX_QUERIES, "{queries:?}");
        assert_eq!(queries.len(), queries.iter().collect::<std::collections::HashSet<_>>().len());
    }

    /// A record called 「索拉里斯星」 against a shelf title of
    /// 「索拉里斯星（修订版）」 is the right book, and the ranking has to say so.
    #[test]
    fn a_record_matching_the_core_title_scores_as_a_match() {
        let authors: Vec<String> = Vec::new();
        let long = Lookup::new("索拉里斯星（修订版）", &authors, false);
        let short = Lookup::new("索拉里斯星", &authors, false);
        let with_note = score(&long, "索拉里斯星", &[]);
        assert!(with_note >= MIN_SCORE, "去掉版次注就该算匹配：{with_note}");
        assert_eq!(with_note, score(&short, "索拉里斯星", &[]));
    }

    // ---- ISBN ----------------------------------------------------------

    /// The table row from the page the mobile app shows — 3 KB, against the
    /// desktop page's 118 KB.
    #[test]
    fn the_isbn_comes_out_of_the_table_row() {
        let html = "<tr><td>出版社</td><td>湖南科学技术出版社</td></tr>\
                    <tr><td>ISBN</td><td>9787535795038</td></tr>";
        assert_eq!(isbn_from_page(html).as_deref(), Some("9787535795038"));
    }

    #[test]
    fn a_ten_digit_isbn_is_accepted() {
        let html = "<td>ISBN</td><td>753579503X</td>";
        assert_eq!(isbn_from_page(html).as_deref(), Some("753579503X"));
    }

    /// The word ISBN appears in a buy link too; the value there is not the
    /// table row, and a regex that took the first match would return rubbish.
    #[test]
    fn an_isbn_mention_without_a_value_is_skipped() {
        let html = "<a href=\"/isbn/\">ISBN</a><td>定价</td><td>49.00</td>";
        assert_eq!(isbn_from_page(html), None);
    }

    #[test]
    fn a_page_without_an_isbn_returns_nothing() {
        assert_eq!(isbn_from_page("<td>定价</td><td>49.00</td>"), None);
        assert_eq!(isbn_from_page(""), None);
    }

    // ---- 封面 ----------------------------------------------------------

    #[test]
    fn the_extension_comes_from_the_bytes() {
        assert_eq!(image_extension(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(image_extension(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]), Some("png"));
        assert_eq!(image_extension(b"<html>not an image</html>"), None);
        assert_eq!(image_extension(b""), None);
    }

    /// A data URL's declared type has to match its payload, and the payload is
    /// the only thing that knows. `image/jpeg` is not spelled `image/jpg` — the
    /// browser drops a data URL whose type it does not recognise, and the row
    /// would keep its placeholder with nothing in the console to say why.
    #[test]
    fn a_preview_declares_the_type_the_bytes_are() {
        assert_eq!(preview_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(
            preview_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            Some("image/png")
        );
        assert_eq!(preview_mime(b"<html>not an image</html>"), None);
    }

    /// The URL comes out of somebody else's JSON. Anything but a catalogue's
    /// own image host is refused before a request is sent — otherwise this app
    /// is an HTTP client for whatever a response happens to contain.
    #[test]
    fn a_cover_url_from_somewhere_else_is_refused() {
        let client = client();
        for url in [
            "https://evil.example/cover.jpg",
            "http://img3.doubanio.com/view/subject/l/public/s29710377.jpg",
            "https://doubanio.com.evil.example/cover.jpg",
            "file:///etc/passwd",
        ] {
            let outcome = tauri::async_runtime::block_on(download_cover(&client, url));
            assert!(outcome.is_err(), "{url}");
        }
    }

    fn target_with_cover(has_cover: bool) -> Target {
        let mut book = target(None, None);
        book.has_cover = has_cover;
        book
    }

    #[test]
    fn a_book_without_a_picture_is_offered_one() {
        let mut found = candidate(Some("译林出版社"), None, 0.95);
        found.cover_url = Some("https://img3.doubanio.com/x.jpg".into());
        let proposal = propose_for(&target_with_cover(false), Some(found));
        assert_eq!(proposal.cover_url.as_deref(), Some("https://img3.doubanio.com/x.jpg"));
    }

    /// Replacing a cover the reader is used to seeing is not a "fill".
    #[test]
    fn a_book_with_a_picture_keeps_it() {
        let mut found = candidate(Some("译林出版社"), None, 0.95);
        found.cover_url = Some("https://img3.doubanio.com/x.jpg".into());
        let proposal = propose_for(&target_with_cover(true), Some(found));
        assert_eq!(proposal.cover_url, None);
    }

    /// A cover on its own is something to write — the row has to stay tickable
    /// and the batch has to include it.
    #[test]
    fn a_cover_alone_counts_as_something_to_do() {
        let mut book = target(Some("译林出版社"), Some("zh"));
        book.subtitle = Some("副标题".into());
        book.isbn = Some("9787544782173".into());
        book.published_year = Some(2021);
        book.description = Some("简介".into());
        book.rating = Some(9.0);
        book.douban_url = Some("https://book.douban.com/subject/1/".into());
        let mut found = candidate(None, None, 0.95);
        found.cover_url = Some("https://img3.doubanio.com/x.jpg".into());
        let proposal = propose_for(&book, Some(found));
        assert!(proposal.fills.is_empty());
        assert!(proposal.cover_url.is_some());
        assert_eq!(proposal.skipped, None);
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

    /// A weak match is a reason to ask the other catalogue, not an answer.
    #[test]
    fn the_chain_keeps_asking_when_the_first_only_has_a_weak_match() {
        let mut weak = candidate(None, None, 0.3);
        weak.source = "douban".into();
        let results = vec![
            (Provider::Douban, Ok(vec![weak])),
            (Provider::Neodb, Ok(vec![candidate(None, None, 0.95)])),
        ];
        let chosen = choose(results).expect("an answer");
        assert_eq!(chosen[0].source, "neodb", "0.3 不该结束整条链");
    }

    /// …but when nobody has a strong one, the weak match is still better than
    /// 「两个来源都连不上」 — and the row will print its score.
    #[test]
    fn a_weak_match_is_still_returned_when_it_is_all_there_is() {
        let mut weak = candidate(None, None, 0.3);
        weak.source = "douban".into();
        let results = vec![
            (Provider::Douban, Ok(vec![weak])),
            (Provider::Neodb, Err(AppError::Message("连不上 NeoDB".into()))),
        ];
        let chosen = choose(results).expect("an answer");
        assert_eq!(chosen[0].match_score, 0.3);
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
    /// Douban's image CDN answers **418** without a `Referer` and 200 with one,
    /// so this is the test that proves the header is load-bearing rather than
    /// decorative.
    #[test]
    #[ignore = "hits the network: img3.doubanio.com"]
    fn the_live_cover_downloads() {
        let client = client();
        let bytes = tauri::async_runtime::block_on(download_cover(
            &client,
            "https://img3.doubanio.com/view/subject/l/public/s29710377.jpg",
        ))
        .expect("a cover");
        println!("\n{} bytes", bytes.len());
        assert_eq!(image_extension(&bytes), Some("jpg"));
        assert!(bytes.len() > 10_000, "{}", bytes.len());
    }

    #[test]
    #[ignore = "hits the network: book.douban.com"]
    fn the_live_douban_answers_the_shape_this_parser_expects() {
        let authors = ["[以色列] 尤瓦尔·赫拉利".to_string()];
        let lookup = Lookup::new("人类简史", &authors, false);
        let client = client();
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
        let lookup = Lookup::new("人类简史", &authors, false);
        let client = client();
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
        let lookup = Lookup::new("人类简史", &authors, false);
        let client = client();
        let found = tauri::async_runtime::block_on(search(&client, Provider::Neodb, &lookup, 1))
            .expect("live search");
        assert!(!found.is_empty(), "真实目录里不可能没有《人类简史》");
        assert!(found[0].title.contains("人类简史"), "{:?}", found[0]);
    }
}
