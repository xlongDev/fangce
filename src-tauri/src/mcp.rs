//! A read-only-by-default MCP server over stdio.
//!
//! `fangce --mcp` turns this app into a tool provider for an outside agent
//! (Claude Code, Cursor, anything that speaks MCP). It is deliberately the
//! *same binary*: the library is one SQLite file plus a directory of books, and
//! a second program installed beside it would be a second thing to keep in
//! step with every schema change.
//!
//! Transport is MCP's stdio one — newline-delimited JSON-RPC 2.0 on stdin and
//! stdout. Not an HTTP port: this app currently listens on nothing, and stdio
//! means the only process that can reach the library is the one the reader (or
//! their agent) started. A port, a token and a firewall exception are three
//! things that can be got wrong; this has none of them.
//!
//! **Permission is per connection, not per app.** The grant is declared by
//! whoever launched the server (`FANGCE_MCP_PERMISSIONS`), so the reader can
//! give one agent read-only access and another the right to edit metadata
//! without a settings screen in between. Default is `read,search`: an agent
//! configured with nothing gets nothing that writes.
//!
//! Writes go through the same `library::*` functions the UI calls, and every
//! one of them leaves a row in the library's `operations` table — 「写操作有
//! 审计」 is not a later task, it is the price of having a write tool at all.
//! The log lives in the database rather than beside it so the person whose
//! library it is can read it (设置 › 操作记录).

use std::collections::BTreeSet;
use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::ops::{self, Source};
use crate::library::repository::{self, BookMetadataPatch, BookQuery};
use crate::library::{annotations, bookmarks, search, tags};

/// What this server claims to speak. A client that only knows an older
/// revision may still connect — the tool surface here is the boring part of
/// the protocol, and has not moved between revisions.
const PROTOCOL_VERSION: &str = "2025-06-18";

const SERVER_NAME: &str = "fangce";

/// Env var a client sets to widen the grant.
const PERMISSIONS_ENV: &str = "FANGCE_MCP_PERMISSIONS";

/// Default and ceiling for a tool's `limit` argument.
///
/// Not politeness: an agent that asks for "all the books" would get a shelf of
/// two thousand JSON objects pushed through a pipe and into its context window.
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;

/// The four things a tool can need.
///
/// Only the tiers that have a tool are named. `export` and `manage_library`
/// arrive with `export_notes` and `import_books` — a permission with nothing
/// behind it is a word that means nothing, and a grant list the reader cannot
/// check against behaviour is worse than no grant list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    /// Look at one book: metadata, highlights, bookmarks.
    Read,
    /// Ask questions across the library. Separate from `read` because a search
    /// is a scan of every book's text, and "let it read one book I named" is
    /// not the same consent as "let it grep my whole library".
    Search,
    /// Change metadata and labels.
    WriteMetadata,
    /// Move books to the bin.
    Delete,
}

impl Permission {
    fn key(self) -> &'static str {
        match self {
            Permission::Read => "read",
            Permission::Search => "search",
            Permission::WriteMetadata => "write_metadata",
            Permission::Delete => "delete",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "read" => Some(Permission::Read),
            "search" => Some(Permission::Search),
            "write_metadata" | "write" => Some(Permission::WriteMetadata),
            "delete" => Some(Permission::Delete),
            _ => None,
        }
    }

    fn all() -> [Permission; 4] {
        [Permission::Read, Permission::Search, Permission::WriteMetadata, Permission::Delete]
    }
}

/// What one connection is allowed to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grants {
    granted: BTreeSet<Permission>,
}

impl Grants {
    /// The default: everything that cannot change a byte.
    pub fn read_only() -> Self {
        Self { granted: [Permission::Read, Permission::Search].into_iter().collect() }
    }

    pub fn all() -> Self {
        Self { granted: Permission::all().into_iter().collect() }
    }

    /// Reads [`PERMISSIONS_ENV`], falling back to [`Grants::read_only`].
    ///
    /// An unknown name is logged and ignored rather than fatal: a typo that
    /// takes the whole server down looks like a crash, and a typo that silently
    /// grants nothing is the safe direction to fail in.
    pub fn from_env() -> Self {
        let Some(raw) = std::env::var(PERMISSIONS_ENV).ok().filter(|text| !text.trim().is_empty())
        else {
            return Self::read_only();
        };
        let mut granted = BTreeSet::new();
        for name in raw.split(',') {
            if name.trim().eq_ignore_ascii_case("all") {
                return Self::all();
            }
            match Permission::parse(name) {
                Some(permission) => {
                    granted.insert(permission);
                }
                None if name.trim().is_empty() => {}
                None => tracing::warn!(name = %name.trim(), "未知的权限名，已忽略"),
            }
        }
        Self { granted }
    }

    pub fn allows(&self, permission: Permission) -> bool {
        self.granted.contains(&permission)
    }

    /// Whether anything this connection may do writes.
    ///
    /// Asked once, when the connection is opened: a read-only grant gets a
    /// `query_only` connection, so a mistake in this layer cannot become a
    /// changed row. See [`crate::db::Library::open_existing`].
    pub fn may_write(&self) -> bool {
        self.granted
            .iter()
            .any(|permission| !matches!(permission, Permission::Read | Permission::Search))
    }

    fn names(&self) -> Vec<&'static str> {
        self.granted.iter().map(|permission| permission.key()).collect()
    }
}

/// One connection: the library it reads, the grant it holds, and where its
/// writes are recorded.
pub struct Server<'a> {
    library: &'a Library,
    grants: Grants,
}

impl<'a> Server<'a> {
    pub fn new(library: &'a Library, grants: Grants) -> Self {
        Self { library, grants }
    }

    /// Reads JSON-RPC messages from `input` until it closes, answering on
    /// `output`.
    ///
    /// One message per line, one response per line, flushed as it goes — an
    /// agent reads stdout as a stream, and a buffered reply looks like a hang.
    pub fn serve<R: BufRead, W: Write>(&self, input: R, output: W) -> AppResult<()> {
        let mut output = output;
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(message) => self.handle(&message),
                // A malformed line is the client's bug. MCP says answer with a
                // parse error and keep the session; dying here would make one
                // bad line look like a crashed server.
                Err(err) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("不是合法的 JSON：{err}") },
                })),
            };
            if let Some(response) = response {
                writeln!(output, "{response}")?;
                output.flush()?;
            }
        }
        Ok(())
    }

    /// One message in, at most one message out.
    ///
    /// `None` means "say nothing": notifications have no `id` and must never be
    /// answered, and answering one is a protocol violation some clients treat
    /// as a fatal desync.
    fn handle(&self, message: &Value) -> Option<Value> {
        let method = message.get("method")?.as_str()?;
        let id = message.get("id").cloned()?;
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        let response = match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                // Not part of the spec, but the one place a client can show the
                // reader what this connection may do.
                "instructions": format!("当前授予的权限：{}", self.grants.names().join(", ")),
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": self.catalogue() })),
            "tools/call" => self.call_tool(&params),
            other => Err((-32601, format!("这个服务不提供 {other}"))),
        };

        Some(match response {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        })
    }

    /// Runs one `tools/call`.
    ///
    /// Two kinds of failure, kept apart on purpose: an unknown tool is a
    /// protocol error (the client asked for something that does not exist),
    /// while a tool that ran and failed — or one this connection may not use —
    /// is a *result* with `isError`, so the model reads the reason and can act
    /// on it instead of the session ending.
    fn call_tool(&self, params: &Value) -> Result<Value, (i64, String)> {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Err((-32602, "tools/call 缺少 name".into()));
        };
        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

        let Some(tool) = catalogue().into_iter().find(|tool| tool.name == name) else {
            return Err((-32602, format!("没有名为 {name} 的工具")));
        };

        if !self.grants.allows(tool.permission) {
            // The suggestion has to *include* the missing one: echoing the
            // current grant back would be a config line that changes nothing.
            let mut suggested = self.grants.names();
            suggested.push(tool.permission.key());
            return Ok(error_result(&format!(
                "「{name}」需要 {} 权限，这个连接只被授予了 {}。要放开它，在客户端的 \
                 mcpServers 配置里加 \"env\": {{\"{PERMISSIONS_ENV}\": \"{}\"}}。",
                tool.permission.key(),
                self.grants.names().join(", "),
                suggested.join(","),
            )));
        }

        // Each write tool records itself, inside its own transaction where it
        // has one: a generic post-hoc line here could not say which book or
        // what changed, and it would land after the write had already
        // committed. See `ops::record`.
        let outcome = (tool.run)(&args, self.library);
        Ok(match outcome {
            Ok(payload) => json!({
                "content": [{ "type": "text", "text": text(&payload) }],
                "isError": false,
            }),
            Err(err) => error_result(&err.to_string()),
        })
    }

    /// The tools this connection may use, and only those.
    ///
    /// Filtered rather than advertised-then-refused: an agent that can see a
    /// `remove_books` it cannot call will keep trying to call it.
    fn catalogue(&self) -> Vec<Value> {
        catalogue()
            .into_iter()
            .filter(|tool| self.grants.allows(tool.permission))
            .map(|tool| (tool.schema)())
            .collect()
    }
}

fn error_result(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

/// Pretty-printed, because a model reads this: one book per line of diff noise
/// is worse than a little whitespace.
fn text(payload: &Value) -> String {
    serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string())
}

/// One tool: what it is called, what it needs, and what it does.
struct Tool {
    name: &'static str,
    permission: Permission,
    /// Built per call rather than stored: `json!` is not `const`, and a static
    /// `Value` would need a `OnceLock` for no gain at this size.
    schema: fn() -> Value,
    run: fn(&Value, &Library) -> AppResult<Value>,
}

/// The catalogue. `call_tool` looks a name up here, so this list and the
/// dispatch are the same list — there is no second place to add a tool and
/// forget its permission.
fn catalogue() -> Vec<Tool> {
    vec![
        Tool {
            name: "search_books",
            permission: Permission::Search,
            schema: || {
                json!({
                    "name": "search_books",
                    "description": "按书名或作者检索书库，返回书架上的书。回收站里的书不在其中。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "书名或作者名的一部分；留空则返回最近添加的书。"
                            },
                            "limit": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": MAX_LIMIT,
                                "default": DEFAULT_LIMIT
                            },
                            "offset": {
                                "type": "integer",
                                "minimum": 0,
                                "description": "跳过多少本，配合 limit 翻页；total 告诉你还有多少。"
                            }
                        }
                    }
                })
            },
            run: search_books,
        },
        Tool {
            name: "get_book",
            permission: Permission::Read,
            schema: || {
                json!({
                    "name": "get_book",
                    "description": "取一本书的元数据与阅读进度。id 来自 search_books。",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "id": { "type": "string" } },
                        "required": ["id"]
                    }
                })
            },
            run: get_book,
        },
        Tool {
            name: "search_book_content",
            permission: Permission::Search,
            schema: || {
                json!({
                    "name": "search_book_content",
                    "description": "在书的正文里检索，返回带章节号和字符偏移的原文片段——可以直接定位回阅读器。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string", "description": "要检索的词或短语。" },
                            "book_id": {
                                "type": "string",
                                "description": "只在这本书里找；留空则搜全库。"
                            },
                            "limit": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": MAX_LIMIT,
                                "default": DEFAULT_LIMIT
                            }
                        },
                        "required": ["query"]
                    }
                })
            },
            run: search_book_content,
        },
        Tool {
            name: "get_annotations",
            permission: Permission::Read,
            schema: || {
                json!({
                    "name": "get_annotations",
                    "description": "取一本书里读者划过的所有高亮和它们自己的批注。",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "book_id": { "type": "string" } },
                        "required": ["book_id"]
                    }
                })
            },
            run: get_annotations,
        },
        Tool {
            name: "get_bookmarks",
            permission: Permission::Read,
            schema: || {
                json!({
                    "name": "get_bookmarks",
                    "description": "取一本书里的书签。",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "book_id": { "type": "string" } },
                        "required": ["book_id"]
                    }
                })
            },
            run: get_bookmarks,
        },
        Tool {
            name: "update_metadata",
            permission: Permission::WriteMetadata,
            schema: || {
                json!({
                    "name": "update_metadata",
                    "description": "改一本书的元数据。只改你给的字段，其余保持原样；传空字符串表示清空该字段。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "title": { "type": "string" },
                            "subtitle": { "type": "string" },
                            "description": { "type": "string" },
                            "language": { "type": "string", "description": "BCP-47，如 zh、en。" },
                            "publisher": { "type": "string" },
                            "authors": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "整份作者表，按顺序覆盖。"
                            }
                        },
                        "required": ["id"]
                    }
                })
            },
            run: update_metadata,
        },
        Tool {
            name: "manage_tags",
            permission: Permission::WriteMetadata,
            schema: || {
                json!({
                    "name": "manage_tags",
                    "description": "给一本书加标签或去掉标签。两个列表都可以省略。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "add": { "type": "array", "items": { "type": "string" } },
                            "remove": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["id"]
                    }
                })
            },
            run: manage_tags,
        },
        Tool {
            name: "remove_books",
            permission: Permission::Delete,
            schema: || {
                json!({
                    "name": "remove_books",
                    "description": "把书移到回收站。不是彻底删除——书、笔记和阅读进度都还在，可以恢复。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "ids": {
                                "type": "array",
                                "items": { "type": "string" },
                                "minItems": 1
                            }
                        },
                        "required": ["ids"]
                    }
                })
            },
            run: remove_books,
        },
    ]
}

fn search_books(args: &Value, library: &Library) -> AppResult<Value> {
    let limit = limit_of(args);
    let offset =
        args.get("offset").and_then(Value::as_u64).map(|value| value as usize).unwrap_or(0);
    let query = BookQuery {
        search: args.get("query").and_then(Value::as_str).map(str::to_string),
        // Paged in SQL rather than fetched and sliced: on a real 985-book
        // library the whole shelf is ~1 MB of JSON, and an agent asking for
        // three titles was paying for all of it.
        limit: Some(limit),
        offset: Some(offset),
        ..BookQuery::default()
    };
    // One lock, two statements: the count and the page have to describe the
    // same set, and a write landing between them would make `total` a lie.
    let (books, total) = library.with(|conn| {
        let total = repository::count(conn, &query)?;
        let books = repository::list(conn, &query)?;
        Ok((books, total))
    })?;
    // Projected rather than serialised whole: `BookSummary` carries the
    // description and the last-position anchor, which are the two longest
    // fields and the two an agent asking "which book is this" never needs.
    let rows: Vec<Value> = books
        .into_iter()
        .map(|book| {
            json!({
                "id": book.id,
                "title": book.title,
                "authors": book.authors,
                "format": book.format,
                "progress": book.progress,
                "lastReadAt": book.last_read_at,
                "favorite": book.favorite,
                "tags": book.tags,
            })
        })
        .collect();
    Ok(json!({
        "total": total,
        "returned": rows.len(),
        "offset": offset,
        "books": rows,
    }))
}

fn get_book(args: &Value, library: &Library) -> AppResult<Value> {
    let id = required(args, "id")?;
    match library.with(|conn| repository::get(conn, id))? {
        Some(book) => Ok(json!(book)),
        None => Err(AppError::NotFound(format!("{id}（书库里没有这本书，或者它在回收站里）"))),
    }
}

fn search_book_content(args: &Value, library: &Library) -> AppResult<Value> {
    let needle = required(args, "query")?;
    let book_id = args.get("book_id").and_then(Value::as_str).filter(|id| !id.is_empty());
    let limit = limit_of(args);
    let hits = library.with(|conn| search::query(conn, needle, book_id, limit))?;
    Ok(json!({ "hits": hits }))
}

fn get_annotations(args: &Value, library: &Library) -> AppResult<Value> {
    let book_id = required(args, "book_id")?;
    let marks = library.with(|conn| annotations::list(conn, book_id))?;
    Ok(json!({ "book_id": book_id, "count": marks.len(), "annotations": marks }))
}

fn get_bookmarks(args: &Value, library: &Library) -> AppResult<Value> {
    let book_id = required(args, "book_id")?;
    let marks = library.with(|conn| bookmarks::list(conn, book_id))?;
    Ok(json!({ "book_id": book_id, "count": marks.len(), "bookmarks": marks }))
}

/// Read-modify-write, and it has to be said out loud.
///
/// `repository::update_metadata` takes the *whole* metadata record — that is
/// what the edit sheet hands it, because the sheet always shows every field. An
/// agent naming one field means "change this and leave the rest", so the
/// current row is read first and the given keys are laid over it. Skipping that
/// would turn `{"publisher": "重庆出版社"}` into a book with no title.
fn update_metadata(args: &Value, library: &Library) -> AppResult<Value> {
    let id = required(args, "id")?;
    let current = library
        .with(|conn| repository::get(conn, id))?
        .ok_or_else(|| AppError::NotFound(format!("{id}（书库里没有这本书，或者它在回收站里）")))?;

    // `Some("")` is meaningful here: it clears the field, which
    // `blank_to_none` inside the repository turns into "no value".
    let field = |key: &str, existing: Option<String>| {
        args.get(key).and_then(Value::as_str).map(str::to_string).or(existing)
    };
    let authors = args
        .get("authors")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or(current.authors);

    let patch = BookMetadataPatch {
        title: field("title", Some(current.title)).unwrap_or_default(),
        subtitle: field("subtitle", current.subtitle),
        description: field("description", current.description),
        language: field("language", current.language),
        publisher: field("publisher", current.publisher),
        // Not editable through this tool yet, but they have to survive the
        // round trip: `update_metadata` writes the whole record.
        isbn: current.isbn,
        published_year: current.published_year,
        rating: current.rating,
        rating_count: current.rating_count,
        rating_source: current.rating_source,
        douban_url: current.douban_url,
        authors,
    };
    library.with_tx(|tx| {
        repository::update_metadata(tx, id, &patch)?;
        ops::record(
            tx,
            Source::Mcp,
            "update_metadata",
            std::slice::from_ref(&id.to_string()),
            "改了书籍信息（MCP）",
        )
    })?;
    Ok(json!({ "updated": id, "title": patch.title }))
}

fn manage_tags(args: &Value, library: &Library) -> AppResult<Value> {
    let id = required(args, "id")?;
    let add = string_list(args, "add");
    let remove = string_list(args, "remove");
    if add.is_empty() && remove.is_empty() {
        return Err(AppError::InvalidArgument("add 和 remove 至少要有一个".into()));
    }
    let ids = [id.to_string()];
    let summary = match (add.is_empty(), remove.is_empty()) {
        (false, true) => format!("加标签（MCP）：{}", add.join("、")),
        (true, false) => format!("去标签（MCP）：{}", remove.join("、")),
        _ => "改了标签（MCP）".to_string(),
    };
    library.with_tx(|tx| {
        tags::assign(tx, &ids, &add, &remove)?;
        ops::record(tx, Source::Mcp, "manage_tags", &ids, &summary)
    })?;
    Ok(json!({ "updated": id, "added": add, "removed": remove }))
}

fn remove_books(args: &Value, library: &Library) -> AppResult<Value> {
    let ids = string_list(args, "ids");
    if ids.is_empty() {
        return Err(AppError::InvalidArgument("ids 不能为空".into()));
    }
    library.with(|conn| repository::ensure_existing(conn, &ids))?;
    library.with_tx(|tx| {
        for id in &ids {
            repository::trash(tx, id)?;
        }
        ops::record(tx, Source::Mcp, "trash", &ids, "移到回收站（MCP）")
    })?;
    Ok(json!({ "trashed": ids, "recoverable": true }))
}

/// A required string argument. The error is written for a model to read and
/// correct, not for a stack trace.
fn required<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::InvalidArgument(format!("缺少参数 {key}")))
}

fn string_list(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn limit_of(args: &Value) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|value| (value as usize).clamp(1, MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};

    use crate::document::BookFormat;
    use crate::library::repository::NewBook;

    /// A library with one book, one chapter, one highlight and one bookmark,
    /// opened the way the tool server opens one.
    ///
    /// The seeding uses `Library::open` because that is what the app does; the
    /// handle returned is `open_existing(.., true)`, because that is what a
    /// granted connection gets. Using `Library::open` for the handle is what
    /// let a `query_only` bug ship — every write tool failed in production and
    /// every test here passed.
    fn harness(tag: &str) -> (PathBuf, Library) {
        let dir = crate::document::fixture::temp_dir(tag);
        seed(&dir);
        let library = Library::open_existing(&dir, true).expect("tool handle");
        (dir, library)
    }

    fn seed(dir: &Path) {
        let app = Library::open(dir).expect("open library");
        app.with_tx(|tx| {
            repository::insert(
                tx,
                &NewBook {
                    id: "b1",
                    title: "三体",
                    subtitle: None,
                    description: None,
                    language: Some("zh"),
                    publisher: Some("重庆出版社"),
                    identifier: None,
                    format: BookFormat::Epub,
                    content_hash: "h1",
                    file_path: "/books/b1.epub",
                    file_size: 1024,
                    cover_path: None,
                    authors: &["刘慈欣".to_string()],
                },
            )?;
            Ok(())
        })
        .expect("insert book");
        app.with(|conn| {
            conn.execute(
                "INSERT INTO chapters (book_id, idx, title, content, chars) \
                 VALUES ('b1', 0, '第一章', '宇宙很大，生活更大。', 10)",
                [],
            )?;
            conn.execute(
                "INSERT INTO annotations (id, book_id, chapter_idx, start_char, end_char, \
                 text, created_at, updated_at) VALUES ('a1', 'b1', 0, 0, 2, '宇宙', 1, 1)",
                [],
            )?;
            conn.execute(
                "INSERT INTO bookmarks (id, book_id, chapter_idx, fraction, label, \
                 created_at, updated_at) VALUES ('m1', 'b1', 0, 0.5, '页签', 1, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed marks");
    }

    /// Feeds a script through `serve` and returns the parsed responses.
    fn run_with(grants: Grants, library: &Library, lines: &[&str]) -> Vec<Value> {
        let mut input = lines.join("\n");
        input.push('\n');
        let mut output = Vec::new();
        Server::new(library, grants).serve(input.as_bytes(), &mut output).expect("serve");
        String::from_utf8(output)
            .expect("utf-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("response is JSON"))
            .collect()
    }

    fn run_script(library: &Library, lines: &[&str]) -> Vec<Value> {
        run_with(Grants::all(), library, lines)
    }

    fn call(name: &str, arguments: Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        })
        .to_string()
    }

    /// The text of a tool result, which is where a tool's answer actually lives.
    fn text_of(response: &Value) -> &str {
        response["result"]["content"][0]["text"].as_str().expect("content[0].text")
    }

    #[test]
    fn initialize_announces_tools_and_a_protocol_version() {
        let (dir, library) = harness("mcp-init");
        let out = run_script(
            &library,
            &[r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(out[0]["result"]["capabilities"]["tools"].is_object());
        assert_eq!(out[0]["result"]["serverInfo"]["name"], SERVER_NAME);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Notifications have no `id` and must never be answered: a client that
    /// gets a reply to one treats the stream as desynchronised.
    #[test]
    fn a_notification_gets_no_reply_and_does_not_stop_the_loop() {
        let (dir, library) = harness("mcp-notify");
        let out = run_script(
            &library,
            &[
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
            ],
        );
        assert_eq!(out.len(), 1, "只有 ping 该被回答");
        assert_eq!(out[0]["id"], 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_full_grant_lists_every_tool() {
        let (dir, library) = harness("mcp-list");
        let out = run_script(&library, &[r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#]);
        let names: Vec<&str> = out[0]["result"]["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            [
                "search_books",
                "get_book",
                "search_book_content",
                "get_annotations",
                "get_bookmarks",
                "update_metadata",
                "manage_tags",
                "remove_books"
            ]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The default grant must not even *mention* the writes. An agent that can
    /// see a tool it cannot call keeps trying to call it.
    #[test]
    fn the_default_grant_lists_only_the_reads() {
        let (dir, library) = harness("mcp-list-readonly");
        let out = run_with(
            Grants::read_only(),
            &library,
            &[r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#],
        );
        let names: Vec<&str> = out[0]["result"]["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            ["search_books", "get_book", "search_book_content", "get_annotations", "get_bookmarks"]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A stale client that calls a hidden tool anyway gets a message it can act
    /// on: the missing permission, and the exact config to change.
    #[test]
    fn calling_an_ungranted_tool_says_which_permission_is_missing() {
        let (dir, library) = harness("mcp-forbidden");
        let out = run_with(
            Grants::read_only(),
            &library,
            &[&call("remove_books", json!({ "ids": ["b1"] }))],
        );
        assert_eq!(out[0]["result"]["isError"], true);
        let message = text_of(&out[0]);
        assert!(message.contains("delete"), "{message}");
        assert!(message.contains(PERMISSIONS_ENV), "{message}");
        // The suggested config has to actually grant it — a message that echoes
        // the current grant back is a message that changes nothing.
        assert!(message.contains("read,search,delete"), "{message}");
        // And nothing happened.
        assert!(library.with(|conn| repository::get(conn, "b1")).expect("get").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_books_finds_the_book_and_stays_off_the_bin() {
        let (dir, library) = harness("mcp-search");
        let out = run_script(&library, &[&call("search_books", json!({ "query": "三体" }))]);
        let payload: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        assert_eq!(payload["total"], 1);
        assert_eq!(payload["books"][0]["id"], "b1");
        assert_eq!(payload["books"][0]["authors"][0], "刘慈欣");

        // The bin is a different set of rows, and a tool that could see into it
        // would be answering "what is in my library" with books the reader
        // cannot open.
        library.with(|conn| repository::trash(conn, "b1")).expect("trash");
        let out = run_script(&library, &[&call("search_books", json!({ "query": "三体" }))]);
        let payload: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        assert_eq!(payload["total"], 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn content_search_returns_a_locatable_quote() {
        let (dir, library) = harness("mcp-content");
        let out = run_script(&library, &[&call("search_book_content", json!({ "query": "宇宙" }))]);
        let payload: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        let hit = &payload["hits"][0];
        // The hits are `SearchHit`, which the IPC layer already serialises
        // camelCase — the tool hands the model the same shape the reader gets,
        // so an id or an offset copied out of a tool result means the same
        // thing on both sides.
        assert_eq!(hit["bookId"], "b1");
        assert_eq!(hit["chapterIdx"], 0);
        assert_eq!(hit["chapterTitle"], "第一章");
        assert!(hit["snippet"].as_str().expect("snippet").contains("宇宙"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The page is the page; the total is the query. An agent that reads
    /// `returned == total` as "that is the whole library" must not be able to
    /// make that mistake here.
    #[test]
    fn search_books_pages_without_losing_the_total() {
        let (dir, library) = harness("mcp-page");
        let out = run_script(
            &library,
            &[&call("search_books", json!({ "query": "三体", "limit": 1, "offset": 0 }))],
        );
        let payload: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        assert_eq!(payload["returned"], 1);
        assert_eq!(payload["total"], 1);
        assert_eq!(payload["offset"], 0);

        // Past the end: an empty page, and a total that still says how many
        // there are — that is what makes "there is nothing on page 7" different
        // from "there is nothing at all".
        let out = run_script(
            &library,
            &[&call("search_books", json!({ "query": "三体", "offset": 40 }))],
        );
        let payload: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        assert_eq!(payload["returned"], 0);
        assert_eq!(payload["total"], 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn annotations_and_bookmarks_come_back_with_their_book() {
        let (dir, library) = harness("mcp-marks");
        let out = run_script(
            &library,
            &[
                &call("get_annotations", json!({ "book_id": "b1" })),
                &call("get_bookmarks", json!({ "book_id": "b1" })),
            ],
        );
        let marks: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        assert_eq!(marks["count"], 1);
        assert_eq!(marks["annotations"][0]["text"], "宇宙");

        let pins: Value = serde_json::from_str(text_of(&out[1])).expect("payload");
        assert_eq!(pins["count"], 1);
        assert_eq!(pins["bookmarks"][0]["label"], "页签");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The one write that could quietly destroy a book: naming a single field
    /// must leave every other field alone.
    #[test]
    fn update_metadata_changes_only_the_named_fields() {
        let (dir, library) = harness("mcp-update");
        let out = run_script(
            &library,
            &[&call("update_metadata", json!({ "id": "b1", "publisher": "新出版社" }))],
        );
        assert_eq!(out[0]["result"]["isError"], false, "{}", text_of(&out[0]));

        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.title, "三体", "只给了 publisher，书名不能被动");
        assert_eq!(book.authors, ["刘慈欣"], "作者也不能被动");
        assert_eq!(book.publisher.as_deref(), Some("新出版社"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn update_metadata_can_clear_a_field_with_an_empty_string() {
        let (dir, library) = harness("mcp-clear");
        run_script(&library, &[&call("update_metadata", json!({ "id": "b1", "publisher": "" }))]);
        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.publisher, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manage_tags_adds_and_removes() {
        let (dir, library) = harness("mcp-tags");
        run_script(
            &library,
            &[&call("manage_tags", json!({ "id": "b1", "add": ["科幻", "重读"] }))],
        );
        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.tags.len(), 2, "{:?}", book.tags);
        assert!(book.tags.contains(&"科幻".to_string()));
        assert!(book.tags.contains(&"重读".to_string()));

        run_script(&library, &[&call("manage_tags", json!({ "id": "b1", "remove": ["重读"] }))]);
        let book = library.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.tags, ["科幻"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Deleting through a tool is the reversible kind. An agent that says
    /// "remove this" must not be able to do what the reader's own bin cannot
    /// undo.
    #[test]
    fn remove_books_moves_to_the_bin_and_says_so() {
        let (dir, library) = harness("mcp-remove");
        let out = run_script(&library, &[&call("remove_books", json!({ "ids": ["b1"] }))]);
        let payload: Value = serde_json::from_str(text_of(&out[0])).expect("payload");
        assert_eq!(payload["recoverable"], true);

        assert!(library.with(|conn| repository::get(conn, "b1")).expect("get").is_none());
        // Still a row, still holding its highlights — the bin, not a delete.
        let rows: i64 = library
            .with(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))?))
            .expect("count");
        assert_eq!(rows, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Every write leaves a line in `operations`, and a read leaves none. The
    /// log is the database's, not a file beside it: it has to be readable from
    /// inside the app, which is where the person whose library it is will look.
    #[test]
    fn a_write_leaves_one_operation_row_and_a_read_leaves_none() {
        let (dir, library) = harness("mcp-audit");
        let script = [
            call("get_book", json!({ "id": "b1" })),
            call("update_metadata", json!({ "id": "b1", "publisher": "审计出版社" })),
        ]
        .join("\n")
            + "\n";
        let mut output = Vec::new();
        Server::new(&library, Grants::all()).serve(script.as_bytes(), &mut output).expect("serve");

        let rows = library.with(|conn| ops::list(conn, 10)).expect("operations");
        assert_eq!(rows.len(), 1, "读不该留痕：{rows:?}");
        assert_eq!(rows[0].action, "update_metadata");
        assert_eq!(rows[0].source, "mcp", "来源要说得出是哪个 Agent 改的");
        assert_eq!(rows[0].book_title.as_deref(), Some("三体"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A tool that ran and failed is a *result* the model can read and act on,
    /// not a dead session: the error text says which book and why.
    #[test]
    fn a_missing_book_is_an_error_result_and_the_session_survives() {
        let (dir, library) = harness("mcp-missing");
        let out = run_script(
            &library,
            &[
                &call("get_book", json!({ "id": "nope" })),
                r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#,
            ],
        );
        assert_eq!(out.len(), 2, "第二次请求必须还能被回答");
        assert_eq!(out[0]["result"]["isError"], true);
        assert!(text_of(&out[0]).contains("nope"));
        assert_eq!(out[1]["id"], 9);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_tool_is_a_protocol_error_not_a_result() {
        let (dir, library) = harness("mcp-unknown");
        let out = run_script(&library, &[&call("delete_everything", json!({}))]);
        assert_eq!(out[0]["error"]["code"], -32602);
        assert!(out[0]["result"].is_null());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// One malformed line must not take the session down with it — a client
    /// that writes half a message and retries would otherwise lose the server.
    #[test]
    fn a_broken_line_is_a_parse_error_and_the_loop_continues() {
        let (dir, library) = harness("mcp-parse");
        let out =
            run_script(&library, &["{not json", r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["error"]["code"], -32700);
        assert_eq!(out[1]["id"], 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_grant_holds_exactly_what_it_was_given() {
        let grants = Grants { granted: [Permission::Delete].into_iter().collect() };
        assert!(grants.allows(Permission::Delete));
        assert!(!grants.allows(Permission::Read), "给了 delete 不等于给了 read");
        assert_eq!(grants.names(), ["delete"]);
        assert_eq!(Permission::parse("write"), Some(Permission::WriteMetadata));
        assert_eq!(Permission::parse("nonsense"), None);
    }

    #[test]
    fn a_grant_knows_whether_it_needs_a_writable_handle() {
        assert!(!Grants::read_only().may_write());
        assert!(Grants::all().may_write());
        // `write` alone is enough: the handle is not about *how much* it can
        // write, only whether it may.
        let write_only = Grants { granted: [Permission::WriteMetadata].into_iter().collect() };
        assert!(write_only.may_write());
    }

    /// Defence in depth, and the bug that proved it was needed: the grant says
    /// this connection may write, the handle says it may not, and the handle
    /// wins. A mistake in the grant layer must not become a changed row.
    #[test]
    fn a_read_only_handle_refuses_a_write_the_grant_allowed() {
        let dir = crate::document::fixture::temp_dir("mcp-ro-handle");
        seed(&dir);
        let library = Library::open_existing(&dir, false).expect("read-only handle");

        let out = run_with(
            Grants::all(),
            &library,
            &[&call("update_metadata", json!({ "id": "b1", "publisher": "不该写进去" }))],
        );
        assert_eq!(out[0]["result"]["isError"], true, "{}", text_of(&out[0]));

        drop(library);
        let check = Library::open_existing(&dir, false).expect("reopen");
        let book = check.with(|conn| repository::get(conn, "b1")).expect("get").expect("b1");
        assert_eq!(book.publisher.as_deref(), Some("重庆出版社"), "库里一个字都没变");
        std::fs::remove_dir_all(&dir).ok();
    }
}
