//! Versioned schema applied through SQLite's `user_version` pragma.
//!
//! Each entry is applied at most once, inside a transaction together with the
//! version bump, so a crash half way through leaves the database at the previous
//! version instead of a half-created schema. Migrations are append-only: never
//! edit an entry that has shipped.

use rusqlite::Connection;

use crate::error::AppResult;

/// One irreversible schema step.
pub struct Migration {
    /// Monotonic, gap-free, starting at 1.
    pub version: u32,
    /// Short snake_case name, used in logs.
    pub name: &'static str,
    pub sql: &'static str,
}

/// All migrations in application order.
///
/// Book identity is `content_hash` (SHA-256 of the source bytes), which is the
/// dedupe key for imports. `sort_title` is precomputed on the Rust side so the
/// UI can sort without shipping a collation into SQLite.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init_library",
        sql: r#"
CREATE TABLE books (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  sort_title   TEXT NOT NULL,
  subtitle     TEXT,
  description  TEXT,
  language     TEXT,
  publisher    TEXT,
  identifier   TEXT,
  format       TEXT NOT NULL CHECK (format IN ('epub', 'txt', 'markdown')),
  content_hash TEXT NOT NULL UNIQUE,
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  cover_path   TEXT,
  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_read_at INTEGER,
  progress     REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  favorite     INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))
);

CREATE INDEX books_added_at ON books (added_at DESC);
CREATE INDEX books_last_read_at ON books (last_read_at DESC) WHERE last_read_at IS NOT NULL;
CREATE INDEX books_sort_title ON books (sort_title COLLATE NOCASE);
CREATE INDEX books_favorite ON books (added_at DESC) WHERE favorite = 1;

CREATE TABLE authors (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  UNIQUE (name)
);

CREATE INDEX authors_sort_name ON authors (sort_name COLLATE NOCASE);

CREATE TABLE book_authors (
  book_id   TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors (id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (book_id, author_id)
);

CREATE INDEX book_authors_author ON book_authors (author_id);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  UNIQUE (name)
);

CREATE TABLE book_tags (
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);

CREATE INDEX book_tags_tag ON book_tags (tag_id);
"#,
    },
    Migration {
        version: 2,
        name: "init_chapters",
        // The reader engine works on chapter granularity: the import pipeline
        // extracts plain-text chapters once and the reader loads one chapter at a
        // time, so no book-sized payload ever crosses the IPC boundary.
        // Paragraphs are single lines joined with `\n`; `chars` is the chapter's
        // character count, which lets the frontend map a global progress fraction
        // onto a chapter without loading any content.
        sql: r#"
CREATE TABLE chapters (
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  content TEXT NOT NULL,
  chars   INTEGER NOT NULL,
  PRIMARY KEY (book_id, idx)
);
"#,
    },
    Migration {
        version: 3,
        name: "init_annotations",
        // A highlight anchors to immutable chapter text by character range. The
        // offsets are UTF-16 code-unit counts computed and interpreted only by
        // the frontend; the backend stores them opaquely and keeps `text` as the
        // snippet shown in the list (and the future re-location key). Chapter
        // content never changes for a given book (re-import is a new hash), so
        // no re-location runs today.
        sql: r#"
CREATE TABLE annotations (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  start_char  INTEGER NOT NULL,
  end_char    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX annotations_book ON annotations (book_id, chapter_idx, start_char);
"#,
    },
    Migration {
        version: 4,
        name: "init_chapters_fts",
        // Full-text index over chapter bodies. The table is `content`-less in
        // the sense that it stores no text of its own: it is an external
        // content table reading `chapters.content` through the rowid, so a
        // book's text lives exactly once on disk. Triggers keep the index in
        // sync with the chapters table, including the cascade that removes
        // chapters when a book is deleted.
        //
        // `trigram` is deliberate: the default `unicode61` tokenizer treats a
        // run of Han characters as ONE token, so searching 世界 inside 你好世界
        // would never match. Trigram indexes every three-character window and
        // therefore does substring matching in Chinese as well as English.
        sql: r#"
CREATE VIRTUAL TABLE chapters_fts USING fts5(
  content,
  content = 'chapters',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER chapters_fts_ai AFTER INSERT ON chapters BEGIN
  INSERT INTO chapters_fts (rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER chapters_fts_ad AFTER DELETE ON chapters BEGIN
  INSERT INTO chapters_fts (chapters_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER chapters_fts_au AFTER UPDATE ON chapters BEGIN
  INSERT INTO chapters_fts (chapters_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO chapters_fts (rowid, content) VALUES (new.rowid, new.content);
END;
"#,
    },
    Migration {
        version: 5,
        name: "init_settings",
        // Only backend-owned settings live here. They are the ones the renderer
        // must never hold: an API key sitting in a webview's localStorage is
        // readable by anything that can read the profile directory, and the
        // backend needs the key anyway because it performs the HTTP call.
        // Appearance settings stay in the renderer, where they belong.
        sql: r#"
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"#,
    },
    Migration {
        version: 6,
        name: "init_chunks",
        // A chunk is a run of chapter text anchored exactly like an annotation:
        // character offsets into the chapter's joined text. The embedding is
        // stored normalized as little-endian f32 bytes, so retrieval is a plain
        // dot product. `model` and `dims` ride along because embeddings from a
        // different model live in a different space — comparing them is noise.
        // Volumes here are thousands, not millions, so retrieval is a brute
        // force scan in Rust; an ANN index is added when the numbers demand it.
        sql: r#"
CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  start_char  INTEGER NOT NULL,
  end_char    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   BLOB NOT NULL,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX chunks_book ON chunks (book_id);
CREATE INDEX chunks_model ON chunks (model, dims);
"#,
    },
    Migration {
        version: 7,
        name: "init_graph",
        // A knowledge graph extracted by the LLM, one book at a time. Entities
        // are keyed by (book, name) because the same character named slightly
        // differently is a different node the merge step cannot safely fold.
        // Relations store names directly instead of entity ids: a relation may
        // name something that never made it into the entity list, and a join
        // would silently drop it. Rebuilds replace the whole graph inside one
        // transaction, so a failed extraction never leaves half a graph.
        sql: r#"
CREATE TABLE entities (
  id      INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  mentions INTEGER NOT NULL,
  UNIQUE (book_id, name)
);

CREATE INDEX entities_book ON entities (book_id, mentions DESC);

CREATE TABLE entity_relations (
  id          INTEGER PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  object      TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL,
  UNIQUE (book_id, subject, relation, object)
);

CREATE INDEX entity_relations_book ON entity_relations (book_id);
CREATE INDEX entity_relations_subject ON entity_relations (book_id, subject);
CREATE INDEX entity_relations_object ON entity_relations (book_id, object);
"#,
    },
    Migration {
        version: 8,
        name: "init_sources",
        // Online book sources. The whole rule set lives in one JSON column on
        // purpose: a source is edited as a single document in the UI, and there
        // is no query that needs to reach into individual rules.
        sql: r#"
CREATE TABLE sources (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rules      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
"#,
    },
    Migration {
        version: 9,
        name: "init_bookmarks",
        // A bookmark pins a position (chapter + fraction inside it). `label`
        // is the snippet shown in the list; like annotation offsets, the
        // fraction is only meaningful for the exact content it was saved with,
        // and re-importing a book creates a new content hash anyway.
        sql: r#"
CREATE TABLE bookmarks (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  fraction    REAL NOT NULL CHECK (fraction >= 0 AND fraction <= 1),
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX bookmarks_book ON bookmarks (book_id, chapter_idx, fraction);
"#,
    },
    Migration {
        version: 10,
        name: "books_format_unconstrained",
        // The set of readable formats is data, not schema: `BookFormat` names
        // it in Rust and it grows without a schema change, so the CHECK on
        // `format` has to go. SQLite cannot alter a constraint in place, so the
        // table is rebuilt the documented way: create, copy, drop, rename.
        //
        // [`migrate`] runs with foreign key enforcement off: with it on,
        // `DROP TABLE books` fires an implicit DELETE that cascades into every
        // table referencing it, and the rebuild would empty the whole library.
        sql: r#"
CREATE TABLE books_new (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  sort_title   TEXT NOT NULL,
  subtitle     TEXT,
  description  TEXT,
  language     TEXT,
  publisher    TEXT,
  identifier   TEXT,
  format       TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  cover_path   TEXT,
  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_read_at INTEGER,
  progress     REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  favorite     INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1))
);

INSERT INTO books_new
  (id, title, sort_title, subtitle, description, language, publisher, identifier,
   format, content_hash, file_path, file_size, cover_path, added_at, updated_at,
   last_read_at, progress, favorite)
SELECT
  id, title, sort_title, subtitle, description, language, publisher, identifier,
  format, content_hash, file_path, file_size, cover_path, added_at, updated_at,
  last_read_at, progress, favorite
FROM books;

DROP TABLE books;
ALTER TABLE books_new RENAME TO books;

CREATE INDEX books_added_at ON books (added_at DESC);
CREATE INDEX books_last_read_at ON books (last_read_at DESC) WHERE last_read_at IS NOT NULL;
CREATE INDEX books_sort_title ON books (sort_title COLLATE NOCASE);
CREATE INDEX books_favorite ON books (added_at DESC) WHERE favorite = 1;
"#,
    },
    Migration {
        version: 11,
        name: "annotations_cfi_and_book_location",
        // Two anchors our (chapter, offset) model cannot express.
        //
        // `annotations.cfi` is an EPUB CFI for books rendered by foliate
        // (MOBI/AZW3). Their sections are the container's own, and they do not
        // line up with the chapter indices the importer extracts, so a Kindle
        // highlight can only be re-located inside the reading engine that owns
        // the document. `chapter_idx` still holds the foliate section index and
        // `start_char`/`end_char` the in-section offsets, which keeps list
        // ordering and the delete path working; only re-anchoring needs the CFI.
        //
        // `books.location` is the opaque last-position string of the same
        // engines (a CFI today). It replaces the reader's localStorage parking
        // spot so a reading position survives a cache clear and rides along
        // with the library row. Both columns are nullable: every other format
        // keeps using (chapter, fraction) and never sets either.
        sql: r#"
ALTER TABLE annotations ADD COLUMN cfi TEXT;
ALTER TABLE books ADD COLUMN location TEXT;
"#,
    },
    Migration {
        version: 12,
        name: "annotations_color_and_style",
        // Per-highlight ink. `color` is the frontend's own hex string (it also
        // feeds SVG overlays and CSS custom-highlight rules, so it stays
        // opaque here); `style` is one of "highlight" | "underline" |
        // "squiggly". Both nullable: legacy rows read as the original
        // translucent marker look, so nothing re-styles underneath the reader.
        sql: r#"
ALTER TABLE annotations ADD COLUMN color TEXT;
ALTER TABLE annotations ADD COLUMN style TEXT;
"#,
    },
    Migration {
        version: 13,
        name: "reading_sessions",
        // Reading time per book per local day, one row per (day, book). The
        // reader reports elapsed wall-clock seconds in batches; the row is
        // upserted, so a crash loses at most one batch and no history is
        // rewritten. `day` is a local `YYYY-MM-DD` string produced in Rust
        // rather than a timestamp: the heat map and the streak both count
        // calendar days, and only the machine knows its own timezone offset.
        // Rows go with their book: deleting one drops its history.
        sql: r#"
CREATE TABLE reading_sessions (
  day     TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  seconds INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX reading_sessions_day_book ON reading_sessions (day, book_id);
CREATE INDEX reading_sessions_day ON reading_sessions (day DESC);
"#,
    },
    Migration {
        version: 14,
        name: "annotations_note",
        // The reader's own words about a highlight. Nullable and `NULL` by
        // default: most highlights never get one. The setter folds blank input
        // to `NULL` rather than storing "", so "has a note" stays a single
        // `IS NOT NULL` test and clearing one is indistinguishable from never
        // having written it.
        sql: r#"
ALTER TABLE annotations ADD COLUMN note TEXT;
"#,
    },
    Migration {
        version: 15,
        name: "annotation_and_bookmark_sync",
        // What multi-device sync needs and nothing more: a write clock per row
        // and a record of deletions.
        //
        // `updated_at` is the last-writer-wins key. Existing rows are backfilled
        // from `created_at` rather than left at 0, so a first sync does not
        // present every old row as "brand new" and win an upload against a
        // remote copy that is actually newer.
        //
        // A tombstone is the only way a deletion can travel: once the row is
        // gone the remote side would otherwise keep re-uploading it. The id is
        // a UUID minted once on the creating device and carried to every other
        // device with the row, so it is already a stable cross-device key; a
        // tombstone therefore needs no book reference to be meaningful.
        sql: r#"
ALTER TABLE annotations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE annotations SET updated_at = created_at;

ALTER TABLE bookmarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE bookmarks SET updated_at = created_at;

CREATE TABLE annotation_tombstones (
  id         TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bookmark_tombstones (
  id         TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
"#,
    },
    Migration {
        version: 16,
        name: "books_chapters_pending",
        // "This book's chapter index is written, its text is not yet."
        //
        // Only fixed-layout PDFs are ever set: their index is one row per page,
        // exact and cheap, but the per-page *text* is a full decode of the
        // document — measured at 974 ms for a 756-page / 21 MB file, 98% of the
        // entire import. Nothing on the shelf needs that text (the reader
        // paints pages with pdf.js; search, TTS and the assistant read it), so
        // the text is filled in after the import has answered.
        //
        // The flag is what makes the deferral safe rather than merely fast: the
        // background pass clears it, and `chapters::ensure` re-runs the
        // extraction whenever it sees it still set — so a process killed
        // mid-backfill heals the next time the book is opened or searched,
        // instead of sitting there permanently unsearchable. Every other format
        // extracts at import and stays at 0.
        sql: r#"
ALTER TABLE books ADD COLUMN chapters_pending INTEGER NOT NULL DEFAULT 0;
"#,
    },
    Migration {
        version: 17,
        name: "reading_sessions_book",
        // The index the delete cascade was missing.
        //
        // Every other child table leads its index with `book_id`, so deleting a
        // book searches its children by key. `reading_sessions` did not: its
        // unique index leads with `day`, and its second index leads with `day`
        // too — so the cascade that removes a book's reading history scanned the
        // whole table once per deleted book. A batch of fifty books scanned it
        // fifty times, on a table that grows one row per (day, book) forever.
        //
        // Measured on the child statement the cascade runs
        // (`EXPLAIN QUERY PLAN DELETE FROM reading_sessions WHERE book_id = ?`):
        // SCAN without this index, SEARCH USING INDEX with it.
        sql: r#"
CREATE INDEX reading_sessions_book ON reading_sessions (book_id);
"#,
    },
    Migration {
        version: 18,
        name: "drop_chapters_fts",
        // The trigram index is gone: search scans `chapters` instead.
        //
        // Measured on a real 194-book shelf (83 M characters of Chinese, the
        // numbers are in `retrieval/search.rs` and ARCHITECTURE.md): the index
        // was 1.12 GB — 4.6× the text it indexed, 78% of the entire database —
        // and every import and every delete paid to maintain it. A 5.5 M-char
        // book cost 3.7 s to index and 3.3 s to un-index, against 93 ms and
        // 4 ms for the same rows without it. The `ad` trigger is what made
        // deletion slow: an FTS5 external-content delete has to re-tokenize the
        // whole chapter to find the postings it is removing.
        //
        // `trigram` was chosen for CJK substring matching (the default
        // `unicode61` treats a run of Han characters as one token, so 世界
        // never matched inside 你好世界), and it did that job — but a scan does
        // it in 150 ms across the whole library, which is a price worth paying
        // once per search rather than once per book.
        //
        // Dropping the table frees its pages to the freelist, not to the file:
        // `Library::open` compacts when it finds a freelist worth compacting.
        sql: r#"
DROP TRIGGER IF EXISTS chapters_fts_ai;
DROP TRIGGER IF EXISTS chapters_fts_ad;
DROP TRIGGER IF EXISTS chapters_fts_au;
DROP TABLE IF EXISTS chapters_fts;
"#,
    },
    Migration {
        version: 19,
        name: "init_ai_conversations",
        // The assistant's history, kept next to the chunks because both are
        // derived from the same book and both die with it.
        //
        // A conversation belongs to one book (`book_id` nullable: a question
        // asked with nothing open is still a conversation), and the cascade is
        // what stops a deleted book leaving orphaned transcripts behind. The
        // message row carries its own `reasoning`, `citations` and `usage` as
        // JSON rather than as columns: nothing queries into them, and a shape
        // that changes with the provider's wire format should not be a schema
        // migration.
        sql: r#"
CREATE TABLE ai_conversations (
  id         TEXT PRIMARY KEY,
  book_id    TEXT REFERENCES books (id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX ai_conversations_book ON ai_conversations (book_id, updated_at DESC);
CREATE INDEX ai_conversations_recent ON ai_conversations (updated_at DESC);

CREATE TABLE ai_messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  reasoning       TEXT,
  citations       TEXT,
  usage           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX ai_messages_conversation ON ai_messages (conversation_id, id);
"#,
    },
    Migration {
        version: 20,
        name: "ai_message_tools",
        // What the assistant looked up while answering: the searches it ran and
        // the maps and clouds it drew. A JSON column rather than a table
        // because a tool row is only ever read back with its message, whole.
        //
        // Without this the mind map and the word cloud would exist only until
        // the panel closed, which is the one thing a reader expects to keep.
        sql: r#"
ALTER TABLE ai_messages ADD COLUMN tools TEXT;
"#,
    },
    Migration {
        version: 21,
        name: "chapter_summaries",
        // One row per chapter, keyed the same way `chapters` is so a deleted
        // book takes its summaries with it.
        //
        // `chars` is the chapter's length at the moment it was summarised. A
        // chapter is re-extracted when a book is reopened after an import that
        // deferred it, and a summary of the old text would then describe
        // something that is no longer there — comparing lengths is the cheap
        // way to notice without hashing every chapter.
        sql: r#"
CREATE TABLE chapter_summaries (
  book_id    TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  chars      INTEGER NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, idx)
);
"#,
    },
    Migration {
        version: 22,
        name: "books_deleted_at",
        // Deleting a book used to be a `DELETE`: one misclick and the file, the
        // highlights, the notes and the reading position were gone together.
        // A timestamp instead of a row removal makes that reversible, and the
        // rows stay put so every foreign key below still points at something.
        //
        // `books_live` is the other half of the change, and it is not a
        // convenience: `FROM books` appears in thirteen modules (search, RAG,
        // sync, stats, chapter backfill), and a soft delete that only taught
        // `list()` about it would leave deleted books surfacing in every one of
        // them. Reads go through the view, writes go through the table, and a
        // read path that forgets is a failing test rather than a ghost book.
        //
        // `SELECT *` here is expanded once, at creation: a column added to
        // `books` later does not appear in the view. That is deliberate — the
        // view is a *read* surface, and widening it silently would be a
        // schema change nobody reviewed.
        sql: r#"
ALTER TABLE books ADD COLUMN deleted_at INTEGER;

CREATE INDEX books_deleted_at ON books (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE VIEW books_live AS SELECT * FROM books WHERE deleted_at IS NULL;
"#,
    },
];

/// Applies every pending migration and returns the resulting schema version.
///
/// Enforcement of foreign keys is off while migrations run. A table rebuild
/// (migration 10) drops the table it replaces, and with enforcement on SQLite
/// answers a `DROP TABLE` with an implicit `DELETE` that cascades into every
/// child table. The pragma is a no-op inside a transaction, so it is switched
/// here rather than in the migration's SQL.
pub fn migrate(conn: &mut Connection) -> AppResult<u32> {
    let current = schema_version(conn)?;
    let enforced = foreign_keys_enforced(conn)?;
    conn.pragma_update(None, "foreign_keys", "OFF")?;

    let result = apply_pending(conn, current);
    if enforced {
        conn.pragma_update(None, "foreign_keys", "ON")?;
    }
    result
}

fn apply_pending(conn: &mut Connection, current: u32) -> AppResult<u32> {
    for migration in MIGRATIONS {
        if migration.version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        // Setting `user_version` inside the transaction makes the schema change
        // and the version bump atomic.
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;
        tracing::info!(version = migration.version, name = migration.name, "迁移已应用");
    }

    schema_version(conn)
}

fn foreign_keys_enforced(conn: &Connection) -> AppResult<bool> {
    let value: i64 = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    Ok(value != 0)
}

/// Current `user_version`, i.e. the highest applied migration number.
pub fn schema_version(conn: &Connection) -> AppResult<u32> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database must open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        conn
    }

    #[test]
    fn migrations_are_contiguous_from_one() {
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            assert_eq!(migration.version as usize, index + 1, "版本号必须从 1 开始且连续");
        }
    }

    #[test]
    fn applying_twice_is_a_no_op() {
        let mut conn = fresh();
        assert_eq!(migrate(&mut conn).expect("first migrate"), MIGRATIONS.len() as u32);
        assert_eq!(migrate(&mut conn).expect("second migrate"), MIGRATIONS.len() as u32);
    }

    #[test]
    fn schema_creates_expected_tables() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("prepare");
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");

        for expected in ["books", "authors", "book_authors", "tags", "book_tags"] {
            assert!(tables.contains(&expected.to_string()), "缺少表 {expected}: {tables:?}");
        }
    }

    #[test]
    fn rebuilding_books_keeps_every_row_and_accepts_new_formats() {
        // Start from the schema as it was before the rebuild, with data in a
        // child table: the point of the test is that nothing is lost.
        let mut conn = fresh();
        for migration in &MIGRATIONS[..9] {
            conn.execute_batch(migration.sql).expect("apply v9 schema");
        }
        conn.pragma_update(None, "user_version", 9).expect("pin version");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn.execute("INSERT INTO authors (id, name, sort_name) VALUES ('a', 'A', 'a')", [])
            .expect("insert author");
        conn.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES ('b', 'a', 1)",
            [],
        )
        .expect("link");

        assert_eq!(migrate(&mut conn).expect("migrate"), MIGRATIONS.len() as u32);

        let title: String = conn
            .query_row("SELECT title FROM books WHERE id = 'b'", [], |row| row.get(0))
            .expect("书必须还在");
        assert_eq!(title, "T");
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_authors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(links, 1, "DROP TABLE 不得级联删掉子表行");

        // The constraint that blocked new formats is gone.
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('c', 'C', 'c', 'cbz', 'h2', 'p2', 1, 1, 1)",
            [],
        )
        .expect("新格式必须能入库");
    }

    #[test]
    fn deleting_a_book_cascades_to_its_authors() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn.execute("INSERT INTO authors (id, name, sort_name) VALUES ('a', 'A', 'a')", [])
            .expect("insert author");
        conn.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES ('b', 'a', 1)",
            [],
        )
        .expect("link");

        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete");

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM book_authors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(left, 0, "外键级联没有生效");
    }

    /// The v17 index, pinned two ways: the history really goes with the book,
    /// and the statement the cascade runs against the child table searches
    /// rather than scans. `EXPLAIN QUERY PLAN` on the parent `DELETE` does not
    /// show the cascade's own plan (verified), so the plan is read off the
    /// child-keyed delete the cascade performs.
    #[test]
    fn deleting_a_book_cascades_to_its_reading_history_by_index() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
            [],
        )
        .expect("insert book");
        conn.execute(
            "INSERT INTO reading_sessions (day, book_id, seconds) VALUES ('2026-10-22', 'b', 60)",
            [],
        )
        .expect("insert session");

        // EQP answers four columns — (id, parent, notused, detail) — and the
        // plan text is the last one.
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN DELETE FROM reading_sessions WHERE book_id = 'b'",
                [],
                |row| row.get(3),
            )
            .expect("plan");
        assert!(
            plan.contains("reading_sessions_book"),
            "级联删阅读历史必须走 book_id 索引，实际计划：{plan}"
        );

        conn.execute("DELETE FROM books WHERE id = 'b'", []).expect("delete");

        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM reading_sessions", [], |row| row.get(0))
            .expect("count");
        assert_eq!(left, 0, "阅读历史必须随书一起删除");
    }

    #[test]
    fn content_hash_is_unique() {
        let mut conn = fresh();
        migrate(&mut conn).expect("migrate");
        let insert = "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                      file_size, added_at, updated_at) \
                      VALUES (?1, 'T', 't', 'epub', 'same', 'p', 1, 1, 1)";
        conn.execute(insert, ("one",)).expect("first insert");
        assert!(conn.execute(insert, ("two",)).is_err(), "相同哈希必须被拒绝");
    }
}
