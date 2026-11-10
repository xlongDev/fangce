//! Full-text search over chapter bodies.
//!
//! A scan, not an index. `chapters.content` is read straight off the table and
//! matched with `LIKE '%needle%'`; SQLite streams it at roughly 650 MB/s, so a
//! library-wide query over 83 M characters of Chinese answers in ~150 ms.
//!
//! This replaced an FTS5 table with the `trigram` tokenizer (migration v4), and
//! the numbers are why. On the same 83 M-character library the index cost
//! 1.12 GB on disk — 4.6× the text it indexed, 78% of the whole database — and
//! every import and every delete paid for it: 3.7 s to index a 5.5 M-character
//! book, 3.3 s to tear its postings down again, against 93 ms and 4 ms for the
//! same rows without it. Import and delete happen on every book; a search is
//! asked once in a while. Trading 150 ms of scan for that is the whole point.
//!
//! A hit carries the character offset of the match inside the chapter so the
//! reader can scroll straight to the paragraph holding it.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::AppResult;
use crate::library::repository;

/// Characters wrapping the matched run inside [`SearchHit::snippet`].
///
/// Control characters rather than markup: the frontend splits on them, and no
/// extracted book text is expected to contain them.
pub const MARK_START: char = '\u{2}';
pub const MARK_END: char = '\u{3}';

/// Characters kept on each side of a match when building a snippet.
const WINDOW_CHARS: usize = 40;

/// One place where the needle occurs.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub book_id: String,
    pub book_title: String,
    pub chapter_idx: usize,
    pub chapter_title: String,
    /// Text around the match, with the match itself wrapped in `MARK_START`
    /// and `MARK_END`.
    pub snippet: String,
    /// Character offset of the match inside the chapter's joined text.
    pub offset: usize,
}

/// Chapters matching `needle`, spread across the books that contain it.
///
/// Passing `book_id` restricts the search to one book.
pub fn query(
    conn: &Connection,
    needle: &str,
    book_id: Option<&str>,
    limit: usize,
) -> AppResult<Vec<SearchHit>> {
    let needle = needle.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let needle_lower = needle.to_lowercase();
    let needle_chars = needle.chars().count();

    select(conn, needle, book_id, limit)?
        .into_iter()
        .map(|(book_id, book_title, chapter_idx)| {
            let (chapter_title, content) = body(conn, &book_id, chapter_idx)?;
            let offset = match_offset(&content, &needle_lower);
            Ok(SearchHit {
                book_id,
                book_title,
                chapter_idx: chapter_idx as usize,
                chapter_title,
                snippet: snippet(&content, offset, needle_chars),
                offset,
            })
        })
        .collect::<AppResult<Vec<_>>>()
}

/// Which chapters to show, and in what order.
///
/// The scan finds every matching chapter, but returning the first `limit` of
/// them in table order would hand the whole list to whichever book sorts first
/// by id — a library-wide search would look like a single-book search. So the
/// candidates are dealt out round-robin: every book's first hit, then every
/// book's second, until `limit` is reached. Grouped by book in the UI, that
/// reads as "one passage from each place this word appears".
///
/// The chapter body is deliberately *not* selected here: a common word matches
/// thousands of rows, and pulling their text out of SQLite only to throw all
/// but fifty away is most of the cost of the query.
fn select(
    conn: &Connection,
    needle: &str,
    book_id: Option<&str>,
    limit: usize,
) -> AppResult<Vec<(String, String, i64)>> {
    let pattern = repository::like_pattern(needle);
    let mut stmt = conn.prepare(
        "SELECT c.book_id, b.title, c.idx
           FROM chapters c
           JOIN books_live b ON b.id = c.book_id
          WHERE c.content LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR c.book_id = ?2)",
    )?;
    let mut rows = stmt.query(params![pattern, book_id])?;

    // Book id → its matching chapter indexes, in reading order; and the ids in
    // the order the scan met them, so the deal is deterministic.
    let mut order: Vec<String> = Vec::new();
    let mut titles: HashMap<String, String> = HashMap::new();
    let mut hits: HashMap<String, Vec<i64>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let idx: i64 = row.get(2)?;
        if !hits.contains_key(&id) {
            order.push(id.clone());
            titles.insert(id.clone(), title);
        }
        hits.entry(id).or_default().push(idx);
    }

    let mut picked: Vec<(String, String, i64)> = Vec::with_capacity(limit);
    let mut depth = 0;
    while picked.len() < limit {
        let mut dealt = false;
        for id in &order {
            let Some(chapters) = hits.get(id) else { continue };
            let Some(&idx) = chapters.get(depth) else { continue };
            picked.push((id.clone(), titles.get(id).cloned().unwrap_or_default(), idx));
            dealt = true;
            if picked.len() == limit {
                break;
            }
        }
        if !dealt {
            break;
        }
        depth += 1;
    }
    Ok(picked)
}

/// Title and body of one chapter. A chapter deleted between the scan and this
/// read answers with empty text rather than failing the whole query.
fn body(conn: &Connection, book_id: &str, idx: i64) -> AppResult<(String, String)> {
    let found = conn
        .query_row(
            "SELECT title, content FROM chapters WHERE book_id = ?1 AND idx = ?2",
            params![book_id, idx],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    Ok(found.unwrap_or_default())
}

/// Character offset of the first occurrence of `needle_lower` (already folded).
///
/// Counted on the lower-cased text because `LIKE` folds ASCII case, so the
/// offset has to land where the match was found, not where a case-sensitive
/// scan would put it.
fn match_offset(content: &str, needle_lower: &str) -> usize {
    let lower = content.to_lowercase();
    match lower.find(needle_lower) {
        Some(byte) => lower[..byte].chars().count(),
        None => 0,
    }
}

/// `WINDOW_CHARS` of context around `[offset, offset + needle_chars)`, with the
/// match itself marked.
fn snippet(content: &str, offset: usize, needle_chars: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    let end = (offset + needle_chars + WINDOW_CHARS).min(chars.len());
    let mut out = String::new();
    if offset > WINDOW_CHARS {
        out.push('…');
        out.extend(&chars[offset - WINDOW_CHARS..offset]);
    } else {
        out.extend(&chars[0..offset]);
    }
    out.push(MARK_START);
    out.extend(&chars[offset..(offset + needle_chars).min(chars.len())]);
    out.push(MARK_END);
    out.extend(&chars[(offset + needle_chars).min(chars.len())..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::document::RawChapter;
    use crate::library::chapters;

    fn seed() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn
    }

    fn add_book(conn: &mut Connection, id: &str, title: &str, chapters: &[&[&str]]) {
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at) VALUES (?1, ?2, 'x', 'txt', ?1, 'p', 1, 1, 1)",
            params![id, title],
        )
        .expect("insert book");
        let raw: Vec<RawChapter> = chapters
            .iter()
            .enumerate()
            .map(|(idx, paragraphs)| RawChapter {
                title: Some(crate::document::untitled_section(idx + 1)),
                paragraphs: paragraphs.iter().map(|p| p.to_string()).collect(),
            })
            .collect();
        let tx = conn.transaction().expect("tx");
        crate::library::chapters::insert(&tx, id, &raw).expect("insert chapters");
        tx.commit().expect("commit");
    }

    fn hits(conn: &Connection, needle: &str, book_id: Option<&str>) -> Vec<SearchHit> {
        query(conn, needle, book_id, 20).expect("query")
    }

    #[test]
    fn chinese_substrings_match_inside_a_run_of_text() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "三体", &[&["你好世界啊，这是很长的一段中文正文。"]]);

        let found = hits(&conn, "世界", None);
        assert_eq!(found.len(), 1, "中文子串必须命中");
        assert_eq!(found[0].chapter_idx, 0);
        assert_eq!(found[0].book_title, "三体");
    }

    #[test]
    fn english_matches_are_case_insensitive() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "Dune", &[&["The spice must flow, they said."]]);

        let found = hits(&conn, "SPICE", None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].offset, 4, "偏移要指向匹配开始的位置");
    }

    #[test]
    fn one_hit_is_returned_per_matching_chapter() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["重复出现的关键词"], &["无关内容"], &["另一个关键词"]]);

        assert_eq!(hits(&conn, "关键词", None).len(), 2);
    }

    #[test]
    fn a_book_id_scopes_the_search() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "第一本", &[&["共同的一句话"]]);
        add_book(&mut conn, "b2", "第二本", &[&["共同的一句话"]]);

        assert_eq!(hits(&conn, "共同", None).len(), 2);
        let scoped = hits(&conn, "共同", Some("b2"));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].book_id, "b2");
    }

    /// The reason the scan deals hits out per book instead of taking the first
    /// `limit` rows: one book with a hundred matches must not fill the list.
    #[test]
    fn hits_are_spread_across_books_rather_than_taken_in_table_order() {
        let mut conn = seed();
        let chapter: &[&str] = &["重复的段落"];
        let noisy: Vec<&[&str]> = vec![chapter; 30];
        add_book(&mut conn, "a-noisy", "话多的书", &noisy);
        add_book(&mut conn, "b-quiet", "话少的书", &[&["重复的段落"]]);

        let found = query(&conn, "重复", None, 4).expect("query");
        assert_eq!(found.len(), 4);
        assert_eq!(
            found.iter().filter(|hit| hit.book_id == "b-quiet").count(),
            1,
            "每个命中的书都该先拿到一条：{found:?}"
        );
        assert_eq!(found.iter().filter(|hit| hit.book_id == "a-noisy").count(), 3);
    }

    #[test]
    fn short_queries_match_too() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["爱情不是答案"]]);

        assert_eq!(hits(&conn, "爱情", None).len(), 1);
        assert_eq!(hits(&conn, "爱", None).len(), 1);
    }

    #[test]
    fn blank_queries_return_nothing() {
        let conn = seed();
        assert!(hits(&conn, "", None).is_empty());
        assert!(hits(&conn, "   ", None).is_empty());
    }

    #[test]
    fn query_operators_are_treated_as_literal_text() {
        let mut conn = seed();
        add_book(
            &mut conn,
            "b1",
            "书",
            &[&["plain text here"], &["star * not an operator"], &["quote a\"b inside"]],
        );

        // `%` and `_` are `LIKE` wildcards; they have to reach the scan as
        // ordinary characters, or a search for `100%` would match anything.
        let star = hits(&conn, "star *", None);
        assert_eq!(star.len(), 1, "整句按字面匹配，星号不是通配符");
        assert_eq!(star[0].chapter_idx, 1);

        let quote = hits(&conn, "a\"b", None);
        assert_eq!(quote.len(), 1);
        assert_eq!(quote[0].chapter_idx, 2);

        assert!(hits(&conn, "100%", None).is_empty(), "百分号不是通配符");
        assert!(hits(&conn, "st_r", None).is_empty(), "下划线不是通配符");
    }

    #[test]
    fn snippets_mark_the_match_and_keep_surrounding_context() {
        let mut conn = seed();
        let filler = "前".repeat(60);
        add_book(&mut conn, "b1", "书", &[&[&format!("{filler}命中{filler}")]]);

        let found = hits(&conn, "命中", None);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].snippet,
            format!("…{}\u{2}命中\u{3}{}…", "前".repeat(40), "前".repeat(40)),
            "片段要标记命中并截断上下文"
        );
        assert_eq!(found[0].offset, 60);
    }

    #[test]
    fn deleting_a_book_removes_it_from_the_results() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["会被删除的正文"]]);
        assert_eq!(hits(&conn, "删除", None).len(), 1);

        conn.execute("DELETE FROM books WHERE id = 'b1'", []).expect("delete");
        assert!(hits(&conn, "删除", None).is_empty(), "级联删除后不该再搜到");
    }

    #[test]
    fn chapters_inserted_later_are_found_too() {
        let mut conn = seed();
        add_book(&mut conn, "b1", "书", &[&["第一批正文"]]);
        // Mirrors the lazy back-fill a pre-Phase-3 book goes through.
        add_book(&mut conn, "b2", "另一本", &[&["第二批正文"]]);

        assert_eq!(hits(&conn, "第二批", None).len(), 1, "后插入的章节同样要搜得到");
        assert_eq!(chapters::count(&conn, "b2").expect("count"), 1);
    }
}
