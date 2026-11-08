//! The AI reading guide: the sample of a book handed to the model, and the
//! cache the finished guide lives in.
//!
//! A guide is written from a sample, never from the whole book: the metadata,
//! the table of contents, and the opening of a handful of chapters spread
//! across the spine. That keeps the prompt bounded for a 400-chapter novel
//! while still showing the model how the book actually reads.
//!
//! The finished text is cached in `settings` under `guide:<book_id>`, so it
//! needs no table of its own. Opening the panel again replays the cache instead
//! of paying for a second generation; "regenerate" is the explicit opt-out.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{AppError, AppResult};

/// Chapters whose opening goes into the prompt.
const SAMPLED_CHAPTERS: usize = 5;
/// Characters taken from the opening of each sampled chapter.
const SAMPLE_CHARS: usize = 900;
/// Chapter titles listed before the list is cut short.
const TOC_LIMIT: usize = 60;

/// The instructions a guide is written under.
///
/// The four sections are fixed here rather than left to the model so the panel
/// renders the same shape every time. A model inventing its own headings drifts
/// between runs, and a reader comparing two books' guides notices.
pub const PROMPT: &str = "\
你在为一本书写导读，读者还没开始读。只依据下面给出的书名、目录和正文样本，\
样本没有提到的内容不要推测，拿不准就不写。用简体中文写，人名书名等专有名词保留原文。\
输出 Markdown，只输出下面四节，标题和顺序都不要改：

## 一句话概括
一句话说清这本书在讲什么。

## 这本书讲什么
3 到 5 条无序列表，每条一句话。

## 关键概念
3 到 6 条无序列表，每条写成「概念：一句话解释」。

## 怎么读
2 到 3 条建议：从哪读起、可以跳过什么、适合搭配什么读。

不要开场白、结语、致谢，不要表情符号，不要表格。";

/// Cache key for one book's guide.
pub fn cache_key(book_id: &str) -> String {
    format!("guide:{book_id}")
}

/// The stored guide for `book_id`, when one has been written already.
pub fn cached(conn: &Connection, book_id: &str) -> AppResult<Option<String>> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [cache_key(book_id)], |row| {
            row.get(0)
        })
        .optional()?;
    // A blank row is a failed write, not a guide: read it as a miss and let the
    // model answer again.
    Ok(stored.filter(|text| !text.trim().is_empty()))
}

/// Every book id whose guide is cached and non-blank, so a batch run can skip
/// them without one round trip per book.
pub fn cached_ids(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT substr(key, 7) FROM settings WHERE key LIKE 'guide:%' AND trim(value) <> ''",
    )?;
    let ids = stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

/// Replaces the stored guide for `book_id`.
pub fn store(conn: &Connection, book_id: &str, guide: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, \
                                         updated_at = excluded.updated_at",
        params![cache_key(book_id), guide, crate::library::now_seconds()],
    )?;
    Ok(())
}

/// The sample of the book a guide is written from.
///
/// Bounded by construction: the metadata, up to [`TOC_LIMIT`] chapter titles,
/// and [`SAMPLED_CHAPTERS`] chapter openings of [`SAMPLE_CHARS`] characters.
pub fn material(conn: &Connection, book_id: &str) -> AppResult<String> {
    let (title, subtitle, description, language, publisher) = metadata(conn, book_id)?;
    let authors = authors(conn, book_id)?;
    let chapters = chapter_titles(conn, book_id)?;

    let mut out = format!("书名：{title}\n");
    if let Some(text) = filled(subtitle) {
        out.push_str(&format!("副标题：{text}\n"));
    }
    if !authors.is_empty() {
        out.push_str(&format!("作者：{}\n", authors.join("、")));
    }
    if let Some(text) = filled(language) {
        out.push_str(&format!("语言：{text}\n"));
    }
    if let Some(text) = filled(publisher) {
        out.push_str(&format!("出版：{text}\n"));
    }
    if let Some(text) = filled(description) {
        out.push_str(&format!("简介：{text}\n"));
    }

    if chapters.is_empty() {
        // No extracted text (a comic archive, most often). The metadata is all
        // there is, and the sample ending here is what tells the model so.
        return Ok(out);
    }

    let total = chapters.len();
    out.push_str(&format!("\n共 {total} 章。\n\n目录：\n"));
    for (position, chapter) in chapters.iter().take(TOC_LIMIT).enumerate() {
        out.push_str(&format!("{}. {}\n", position + 1, chapter.title));
    }
    if total > TOC_LIMIT {
        out.push_str(&format!("……另有 {} 章\n", total - TOC_LIMIT));
    }

    out.push_str("\n正文样本：\n");
    for position in sample_positions(total) {
        let chapter = &chapters[position];
        let opening = chapter_opening(conn, book_id, chapter.idx)?;
        out.push_str(&format!("\n【第 {} 章 {}】\n{opening}\n", position + 1, chapter.title));
    }
    Ok(out)
}

/// Everything the `books` row carries into the prompt.
type Metadata = (String, Option<String>, Option<String>, Option<String>, Option<String>);

fn metadata(conn: &Connection, book_id: &str) -> AppResult<Metadata> {
    conn.query_row(
        "SELECT title, subtitle, description, language, publisher FROM books WHERE id = ?1",
        params![book_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(book_id.to_string()))
}

fn authors(conn: &Connection, book_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT a.name FROM authors a JOIN book_authors ba ON ba.author_id = a.id \
         WHERE ba.book_id = ?1 ORDER BY ba.position",
    )?;
    let names = stmt
        .query_map(params![book_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(names)
}

/// One row of the table of contents.
struct ChapterTitle {
    idx: i64,
    title: String,
}

fn chapter_titles(conn: &Connection, book_id: &str) -> AppResult<Vec<ChapterTitle>> {
    let mut stmt =
        conn.prepare("SELECT idx, title FROM chapters WHERE book_id = ?1 ORDER BY idx")?;
    let chapters = stmt
        .query_map(params![book_id], |row| {
            Ok(ChapterTitle {
                idx: row.get(0)?,
                title: row.get::<_, String>(1)?.trim().to_string(),
            })
        })?
        .collect::<rusqlite::Result<Vec<ChapterTitle>>>()?;
    Ok(chapters)
}

fn chapter_opening(conn: &Connection, book_id: &str, idx: i64) -> AppResult<String> {
    let text: String = conn.query_row(
        "SELECT substr(content, 1, ?3) FROM chapters WHERE book_id = ?1 AND idx = ?2",
        params![book_id, idx, SAMPLE_CHARS as i64],
        |row| row.get(0),
    )?;
    Ok(text.trim().to_string())
}

/// Positions in `chapters` to sample: the first, the last, and an even spread
/// between them, so a long book is represented end to end rather than by its
/// opening alone.
fn sample_positions(total: usize) -> Vec<usize> {
    if total <= SAMPLED_CHAPTERS {
        return (0..total).collect();
    }
    (0..SAMPLED_CHAPTERS).map(|slot| slot * (total - 1) / (SAMPLED_CHAPTERS - 1)).collect()
}

/// `Some` only for text that actually carries something, so the prompt never
/// grows a "副标题：" line with nothing after it.
fn filled(value: Option<String>) -> Option<String> {
    value.map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn seeded() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        migrations::migrate(&mut conn).expect("migrate");
        conn.execute(
            "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, file_size, \
             added_at, updated_at, description) \
             VALUES ('b', '活着', '活着', 'txt', 'h', 'p', 1, 1, 1, '  一个老人的一生  ')",
            [],
        )
        .expect("book");
        conn.execute("INSERT INTO authors (id, name, sort_name) VALUES ('a', '余华', '余华')", [])
            .expect("author");
        conn.execute(
            "INSERT INTO book_authors (book_id, author_id, position) VALUES ('b', 'a', 1)",
            [],
        )
        .expect("link");
        conn
    }

    fn add_chapter(conn: &Connection, idx: i64, title: &str, content: &str) {
        conn.execute(
            "INSERT INTO chapters (book_id, idx, title, content, chars) VALUES ('b', ?1, ?2, ?3, ?4)",
            params![idx, title, content, content.chars().count() as i64],
        )
        .expect("chapter");
    }

    #[test]
    fn the_sample_carries_the_metadata_and_the_spine() {
        let conn = seeded();
        for idx in 0..10 {
            add_chapter(&conn, idx, &format!("第 {} 章", idx + 1), "正文正文正文");
        }

        let material = material(&conn, "b").expect("material");
        assert!(material.starts_with("书名：活着\n"), "{material}");
        assert!(material.contains("作者：余华\n"), "{material}");
        assert!(material.contains("简介：一个老人的一生\n"), "简介要去掉首尾空白");
        assert!(material.contains("共 10 章。"), "{material}");
        assert!(material.contains("10. 第 10 章"), "目录要列到最后一章");
        assert_eq!(material.matches("【第 ").count(), SAMPLED_CHAPTERS, "{material}");
    }

    #[test]
    fn only_the_opening_of_each_sampled_chapter_is_sent() {
        let conn = seeded();
        let long = "x".repeat(SAMPLE_CHARS * 3);
        add_chapter(&conn, 0, "第一章", &long);

        let material = material(&conn, "b").expect("material");
        assert_eq!(material.matches('x').count(), SAMPLE_CHARS, "样本必须截断");
    }

    #[test]
    fn a_book_with_no_extracted_text_still_produces_metadata() {
        let conn = seeded();
        let material = material(&conn, "b").expect("material");
        assert!(material.contains("书名：活着"), "{material}");
        assert!(!material.contains("正文样本"), "没有章节就没有样本段：{material}");
        assert!(!material.contains("副标题"), "空字段不成行：{material}");
    }

    #[test]
    fn a_missing_book_is_not_found() {
        let conn = seeded();
        assert!(matches!(material(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn a_long_book_still_produces_a_bounded_prompt() {
        let conn = seeded();
        for idx in 0..400 {
            add_chapter(&conn, idx, &format!("第 {} 章", idx + 1), &"正".repeat(3_000));
        }

        let material = material(&conn, "b").expect("material");
        let chars = material.chars().count();
        // The sample is fixed at 60 titles plus 5 openings whatever the book
        // weighs; only the "……另有 N 章" line grows with the chapter count.
        assert!(chars < 8_000, "素材长度必须与书的长度基本无关：{chars}");
    }

    #[test]
    fn sample_positions_spread_from_first_to_last() {
        assert_eq!(sample_positions(0), Vec::<usize>::new());
        assert_eq!(sample_positions(1), vec![0]);
        assert_eq!(sample_positions(SAMPLED_CHAPTERS), (0..SAMPLED_CHAPTERS).collect::<Vec<_>>());

        let spread = sample_positions(400);
        assert_eq!(spread.len(), SAMPLED_CHAPTERS);
        assert_eq!(spread.first(), Some(&0));
        assert_eq!(spread.last(), Some(&399), "最后一章必须在样本里");
        assert!(spread.windows(2).all(|pair| pair[0] < pair[1]), "位置必须严格递增");
    }

    #[test]
    fn the_cache_round_trips_and_overwrites() {
        let conn = seeded();
        assert_eq!(cached(&conn, "b").expect("read"), None);

        store(&conn, "b", "第一版").expect("store");
        assert_eq!(cached(&conn, "b").expect("read").as_deref(), Some("第一版"));

        store(&conn, "b", "第二版").expect("overwrite");
        assert_eq!(cached(&conn, "b").expect("read").as_deref(), Some("第二版"));

        // A blank write reads as a miss, so a truncated answer is regenerated
        // instead of being served forever.
        store(&conn, "b", "   ").expect("blank");
        assert_eq!(cached(&conn, "b").expect("read"), None);
    }

    #[test]
    fn cached_ids_lists_only_filled_guides() {
        let conn = seeded();
        assert!(cached_ids(&conn).expect("read").is_empty());

        store(&conn, "b", "有货").expect("store");
        store(&conn, "other", "   ").expect("blank");
        assert_eq!(cached_ids(&conn).expect("read"), vec!["b".to_string()]);
    }

    #[test]
    fn the_cache_key_is_namespaced_per_book() {
        assert_eq!(cache_key("abc"), "guide:abc");
        let conn = seeded();
        store(&conn, "b", "g").expect("store");
        assert_eq!(cached(&conn, "other").expect("read"), None, "缓存不能串书");
    }
}
