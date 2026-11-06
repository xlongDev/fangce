//! Retrieval over embedded chapter chunks.
//!
//! The design leans on two facts. Chapter text is immutable per book (a
//! re-import is a new hash), so a chunk anchored by character offsets never
//! goes stale — same reasoning as annotations. And a personal library holds
//! thousands of chunks, not millions, so retrieval is a brute-force scan over
//! normalized vectors in Rust; an ANN index is added when the numbers demand
//! it, not before.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::ai::AiConfig;
use crate::ai::embeddings;
use crate::db::Library;
use crate::error::{AppError, AppResult};

/// Target chunk size in characters. Paragraphs are never split, so a chunk is
/// at most one long paragraph over the target — embedding models tolerate that
/// far better than they tolerate mid-sentence cuts.
const TARGET_CHARS: usize = 600;

/// One retrieved chunk, handed to the frontend and to the prompt builder.
#[derive(specta::Type, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHit {
    pub book_id: String,
    pub book_title: String,
    pub chapter_idx: usize,
    /// Offset into the chapter's joined text — the same space the reader
    /// already navigates by.
    pub start_char: usize,
    pub score: f32,
    pub text: String,
}

/// Character ranges of one chapter's chunks, in the chapter's joined text.
///
/// Paragraph boundaries are hard edges: a chunk never contains the `'\n'`
/// separator, so a hit's range maps cleanly onto what the reader renders.
pub fn chunk_offsets(content: &str, target: usize) -> Vec<(usize, usize)> {
    let mut chunks = Vec::new();
    let mut chunk_start: Option<usize> = None;
    let mut chunk_end = 0_usize;
    let mut offset = 0_usize;

    for paragraph in content.split('\n') {
        let p_start = offset;
        let p_end = p_start + paragraph.chars().count();
        offset = p_end + 1; // step over the '\n' separator
        if paragraph.is_empty() {
            continue;
        }
        match chunk_start {
            Some(start) if p_end - start > target => {
                chunks.push((start, chunk_end));
                chunk_start = Some(p_start);
                chunk_end = p_end;
            }
            Some(_) => chunk_end = p_end,
            None => {
                chunk_start = Some(p_start);
                chunk_end = p_end;
            }
        }
    }
    if let Some(start) = chunk_start {
        chunks.push((start, chunk_end));
    }
    chunks
}

/// One chapter's stored body with its chunk boundaries.
struct ChapterText {
    idx: usize,
    content: String,
    offsets: Vec<(usize, usize)>,
}

/// Reads a chapter's chunk offsets straight from the stored joined content.
fn chapter_chunks(conn: &Connection, book_id: &str) -> AppResult<Vec<ChapterText>> {
    let mut stmt =
        conn.prepare("SELECT idx, content FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let mut rows = stmt.query(params![book_id])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let idx: i64 = row.get(0)?;
        let content: String = row.get(1)?;
        let offsets = chunk_offsets(&content, TARGET_CHARS);
        out.push(ChapterText { idx: idx as usize, content, offsets });
    }
    Ok(out)
}

/// Rebuilds the embedding index for one book: chunk, embed in batches, replace.
///
/// `on_progress` reports `(done, total)` chunk counts between batches. Old
/// chunks are deleted inside the same transaction as the new inserts, so a
/// failed run leaves the previous index intact.
pub async fn reindex(
    library: &Library,
    client: &reqwest::Client,
    config: &AiConfig,
    book_id: &str,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> AppResult<usize> {
    let model = config.embedding_model.trim();
    if model.is_empty() {
        return Err(AppError::InvalidArgument("先到设置里填写向量模型，才能建立检索索引".into()));
    }
    // Chapters are lazily built for pre-Phase-3 books; indexing goes through
    // the same path so every book is indexable, whatever its age. Embedding
    // *text*, so this pays the deferred extraction too — an index built from
    // empty chapters would be a valid, searchable, useless index.
    crate::library::chapters::ensure_text(library, book_id)?;

    let planned: Vec<(usize, String, usize, usize)> = library.with(|conn| {
        let mut out = Vec::new();
        for chapter in chapter_chunks(conn, book_id)? {
            let chars = chapter.content.chars().collect::<Vec<_>>();
            for (start, end) in chapter.offsets {
                let text: String = chars[start..end].iter().collect();
                out.push((chapter.idx, text, start, end));
            }
        }
        Ok(out)
    })?;
    let total = planned.len();
    if total == 0 {
        return Ok(0);
    }

    let mut vectors = Vec::with_capacity(total);
    // Resolved once: every batch must go to the endpoint this book is being
    // indexed against, and the search side resolves the same way.
    let (base_url, api_key) = crate::ai::embedding_endpoint(config);
    for (done, batch) in planned.chunks(embeddings::BATCH).enumerate() {
        let texts: Vec<String> = batch.iter().map(|(_, text, _, _)| text.clone()).collect();
        let mut embedded = embeddings::embed(client, base_url, api_key, model, &texts).await?;
        for vector in &mut embedded {
            embeddings::normalize(vector)
                .ok_or_else(|| AppError::Message("模型返回了零向量，无法用于检索".into()))?;
        }
        vectors.extend(embedded);
        on_progress((done + 1) * embeddings::BATCH.min(total), total);
    }

    let dims = vectors.first().map_or(0, Vec::len);
    let now = now_seconds();
    library.with_tx(|tx| {
        tx.execute("DELETE FROM chunks WHERE book_id = ?1", params![book_id])?;
        for ((chapter_idx, text, start, end), vector) in planned.iter().zip(&vectors) {
            tx.execute(
                "INSERT INTO chunks (book_id, chapter_idx, start_char, end_char, text, embedding, \
                 model, dims, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    book_id,
                    *chapter_idx as i64,
                    *start as i64,
                    *end as i64,
                    text,
                    embeddings::to_bytes(vector),
                    model,
                    dims as i64,
                    now
                ],
            )?;
        }
        Ok(())
    })?;
    tracing::info!(book_id, chunks = total, dims, "书索引完成");
    Ok(total)
}

/// Brute-force top-k over normalized vectors. Scope is one book when
/// `book_id` is set, the whole library otherwise.
///
/// `max_chapter` keeps the scan to chapters at or before a position — the
/// reader's own, for a spoiler-safe question. It is inclusive because the
/// reader is usually *in* that chapter and asking about it.
pub fn search(
    conn: &Connection,
    model: &str,
    query: &[f32],
    book_id: Option<&str>,
    max_chapter: Option<usize>,
    k: usize,
) -> AppResult<Vec<RagHit>> {
    let dims = query.len() as i64;
    let mut stmt = conn.prepare(
        "SELECT c.book_id, b.title, c.chapter_idx, c.start_char, c.text, c.embedding
           FROM chunks c JOIN books b ON b.id = c.book_id
          WHERE c.model = ?1 AND c.dims = ?2
            AND (?3 IS NULL OR c.book_id = ?3)
            AND (?4 IS NULL OR c.chapter_idx <= ?4)",
    )?;
    let max_chapter = max_chapter.map(|idx| idx as i64);
    let mut rows = stmt.query(params![model, dims, book_id, max_chapter])?;
    let mut scored: Vec<(f32, RagHit)> = Vec::new();
    while let Some(row) = rows.next()? {
        let Some(vector) = embeddings::from_bytes(&row.get::<_, Vec<u8>>(5)?) else {
            continue; // a foreign blob never matches the dims filter anyway
        };
        let score = embeddings::dot(query, &vector);
        scored.push((
            score,
            RagHit {
                book_id: row.get(0)?,
                book_title: row.get(1)?,
                chapter_idx: row.get::<_, i64>(2)? as usize,
                start_char: row.get::<_, i64>(3)? as usize,
                text: row.get(4)?,
                score,
            },
        ));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored.into_iter().take(k).map(|(_, hit)| hit).collect())
}

/// Books whose stored chunks were built with a different model than `model`.
///
/// Retrieval filters on `model` and `dims`, so those chunks are invisible: the
/// book looks indexed in the panel and answers nothing. That silence is the
/// whole reason this count exists — without it, switching the embedding model
/// is a change that quietly breaks every book at once.
pub fn stale_books(conn: &Connection, model: &str) -> AppResult<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT book_id) FROM chunks WHERE model <> ?1",
        params![model],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

/// Whether this book's own index predates the configured model.
pub fn book_is_stale(conn: &Connection, book_id: &str, model: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE book_id = ?1 AND model <> ?2",
        params![book_id, model],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Ids of the books that carry an index, oldest work first is not a thing here:
/// the caller walks them in whatever order this returns.
pub fn indexed_books(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT book_id FROM chunks ORDER BY book_id")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(row.get(0)?);
    }
    Ok(out)
}

/// Drops the whole library's index, returning how many chunks went.
pub fn clear_library(conn: &Connection) -> AppResult<usize> {
    let removed = conn.execute("DELETE FROM chunks", [])?;
    Ok(removed)
}

/// Drops every chunk of one book, returning how many rows went.
///
/// The index is derived data — chapters are the source of truth — so this costs
/// one rebuild and nothing else. That is why the assistant's menu offers it as
/// a maintenance action instead of a confirmation dialog.
pub fn clear(conn: &Connection, book_id: &str) -> AppResult<usize> {
    let removed = conn.execute("DELETE FROM chunks WHERE book_id = ?1", params![book_id])?;
    Ok(removed)
}

/// Chunk counts for the status query: this book, and the whole library.
pub fn counts(conn: &Connection, book_id: &str) -> AppResult<(usize, usize)> {
    let one: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?;
    let all: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    Ok((one as usize, all as usize))
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Layout, Library};
    use crate::document::fixture;

    /// A library with two books and a handful of chunks, so the counting
    /// queries run against real rows rather than a mocked connection.
    fn seeded(tag: &str, rows: &[(&str, &str)]) -> (std::path::PathBuf, Library) {
        let dir = fixture::temp_dir(tag);
        let layout = Layout::create(dir.clone()).expect("layout");
        let library = Library::open(&layout.data_dir).expect("open");
        library
            .with(|conn| {
                for id in ["b1", "b2"] {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, \
                         file_path, file_size, added_at, updated_at) \
                         VALUES (?1, 'T', 't', 'epub', ?1, 'p', 1, 1, 1)",
                        params![id],
                    )?;
                }
                for (book, model) in rows {
                    conn.execute(
                        "INSERT INTO chunks (book_id, chapter_idx, start_char, end_char, text, \
                         embedding, model, dims, updated_at) \
                         VALUES (?1, 0, 0, 1, 'x', x'00', ?2, 1, 1)",
                        params![book, model],
                    )?;
                }
                Ok(())
            })
            .expect("seed");
        (dir, library)
    }

    #[test]
    fn staleness_is_per_model_and_per_book() {
        let (_dir, library) = seeded("rag-stale", &[("b1", "old"), ("b1", "old"), ("b2", "new")]);

        // b1's two chunks are the old model; b2's one is the current one.
        assert_eq!(library.with(|c| stale_books(c, "new")).unwrap(), 1);
        assert!(library.with(|c| book_is_stale(c, "b1", "new")).unwrap());
        assert!(!library.with(|c| book_is_stale(c, "b2", "new")).unwrap());

        // Every indexed book is listed once, whatever its chunk count.
        let books = library.with(indexed_books).unwrap();
        assert_eq!(books, vec!["b1".to_string(), "b2".to_string()]);

        // And the library-wide clear takes all of them.
        assert_eq!(library.with(clear_library).unwrap(), 3);
        assert_eq!(library.with(|c| counts(c, "b1")).unwrap(), (0, 0));
        assert!(library.with(indexed_books).unwrap().is_empty());
    }

    #[test]
    fn chunks_respect_paragraph_boundaries() {
        // "aa bb cc dd" joined with \n; target 3 → each paragraph is its own
        // chunk because adding another would overshoot.
        let offsets = chunk_offsets("aa\nbb\ncc\ndd", 3);
        assert_eq!(offsets, [(0, 2), (3, 5), (6, 8), (9, 11)]);
    }

    #[test]
    fn small_paragraphs_share_a_chunk() {
        let offsets = chunk_offsets("a\nb\nc", 10);
        assert_eq!(offsets, [(0, 5)]);
    }

    #[test]
    fn a_long_paragraph_is_never_split() {
        let long = "x".repeat(50);
        let content = format!("short\n{long}");
        let offsets = chunk_offsets(&content, 10);
        assert_eq!(offsets.len(), 2);
        // The over-target paragraph still lands whole.
        assert_eq!(offsets[1], (6, 56));
    }

    #[test]
    fn offsets_slice_back_to_the_original_text() {
        let content = "第一段\n第二段\n第三段";
        for (start, end) in chunk_offsets(content, 4) {
            let text: String = content.chars().skip(start).take(end - start).collect();
            assert!(!text.contains('\n'), "组块不跨段落: {text:?}");
            assert!(text.starts_with('第'));
        }
    }
}
