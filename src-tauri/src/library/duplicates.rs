//! A read-only answer to 「书架上是不是有同一本书的两个文件」.
//!
//! Two imports of the same novel — one EPUB, one AZW3 — are different rows,
//! different files and different cover tiles. Import-time dedupe cannot see them: it compares the bytes of a file
//! being added against files already on disk, not the identity of the books.
//!
//! **This report never merges or deletes anything.** Deciding which copy to
//! keep is the reader's: a "duplicate" may be a different translation, a
//! different volume, or an annotated copy. The two reasons are printed on every
//! group so the strength of the evidence is visible.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;

#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateBook {
    pub id: String,
    pub title: String,
    pub isbn: Option<String>,
    pub format: String,
    pub file_size: i64,
    pub added_at: i64,
}

#[derive(specta::Type, Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// 「同一 ISBN」 or 「书名相同」 — how strong the match is.
    pub reason: String,
    /// Oldest first: that is the copy the reader is most likely to keep.
    pub books: Vec<DuplicateBook>,
}

/// Every group with two or more books, biggest pile first.
pub fn find(conn: &Connection) -> AppResult<Vec<DuplicateGroup>> {
    let mut stmt =
        conn.prepare("SELECT id, title, isbn, format, file_size, added_at FROM books_live")?;
    let rows = stmt.query_map([], |row| {
        Ok(DuplicateBook {
            id: row.get(0)?,
            title: row.get(1)?,
            isbn: row.get(2)?,
            format: row.get(3)?,
            file_size: row.get(4)?,
            added_at: row.get(5)?,
        })
    })?;
    Ok(group(rows.collect::<rusqlite::Result<Vec<_>>>()?))
}

fn group(books: Vec<DuplicateBook>) -> Vec<DuplicateGroup> {
    // ISBN first. An exact identifier beats a title, and a book claimed here
    // must not show up a second time in the looser title pass.
    let mut by_isbn: HashMap<String, Vec<DuplicateBook>> = HashMap::new();
    let mut claimed: HashSet<String> = HashSet::new();
    for book in &books {
        if let Some(key) = normalized_isbn(book.isbn.as_deref()) {
            by_isbn.entry(key).or_default().push(book.clone());
            claimed.insert(book.id.clone());
        }
    }
    let mut groups: Vec<DuplicateGroup> = by_isbn
        .into_values()
        .filter(|items| items.len() > 1)
        .map(|items| DuplicateGroup { reason: "同一 ISBN".into(), books: items })
        .collect();

    let mut by_title: HashMap<String, Vec<DuplicateBook>> = HashMap::new();
    for book in &books {
        if claimed.contains(&book.id) {
            continue;
        }
        let key = normalized_title(&book.title);
        // A one-character "title" is a placeholder, not evidence. Grouping on
        // it would put half a shelf of untitled imports in one pile.
        if key.chars().count() < 2 {
            continue;
        }
        by_title.entry(key).or_default().push(book.clone());
    }
    groups.extend(
        by_title
            .into_values()
            .filter(|items| items.len() > 1)
            .map(|items| DuplicateGroup { reason: "书名完全一致".into(), books: items }),
    );

    for group in &mut groups {
        group.books.sort_by_key(|book| book.added_at);
    }
    groups.sort_by(|left, right| {
        right
            .books
            .len()
            .cmp(&left.books.len())
            .then_with(|| left.books[0].title.cmp(&right.books[0].title))
    });
    groups
}

/// ISBN-10 or ISBN-13, without hyphens or spaces, upper-cased. Anything
/// shorter is a partial identifier someone typed by hand, not a key to group
/// on — it would merge unrelated books that happen to share a prefix.
fn normalized_isbn(raw: Option<&str>) -> Option<String> {
    let cleaned: String =
        raw?.chars().filter(char::is_ascii_alphanumeric).flat_map(char::to_uppercase).collect();
    (cleaned.len() == 10 || cleaned.len() == 13).then_some(cleaned)
}

/// The whole title, with only punctuation, spacing and case removed.
///
/// 🔴 **No subtitle is cut off.** The first version split at `: · - (` and
/// friends, and a real 1537-book shelf showed what that means in Chinese:
/// `·` separates a person's given name (彼得·林奇 / 彼得·德汉克) or a series
/// volume (大唐狄公案·第一辑), `-` separates a subtitle (玩转ChatGPT-秒变AI…),
/// and `（）` carries an issue or volume number (单读（11-15） / （01-10）).
/// Cutting there left two-character prefixes like 「彼得」 and 「大卫」, and
/// merged books that have nothing to do with each other. That is a false
/// positive, which is worse than a miss: it sends the reader looking for a
/// problem that is not there.
///
/// Two files of one book almost always carry the same title, so exact equality
/// after normalisation finds them. A copy whose cataloguer added a subtitle is
/// missed — an honest, visible limit, and the reader can still see it on the
/// shelf.
fn normalized_title(raw: &str) -> String {
    raw.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(id: &str, title: &str, isbn: Option<&str>, added: i64) -> DuplicateBook {
        DuplicateBook {
            id: id.into(),
            title: title.into(),
            isbn: isbn.map(str::to_string),
            format: "epub".into(),
            file_size: 1024,
            added_at: added,
        }
    }

    #[test]
    fn an_isbn_pairs_two_files_whatever_the_format() {
        let groups = group(vec![
            book("a", "三体", Some("978-7-5366-9293-0"), 2),
            book("b", "三体全集", Some("9787536692930"), 1),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].reason, "同一 ISBN");
        assert_eq!(groups[0].books.len(), 2);
        // Oldest first: the copy most likely worth keeping leads the pile.
        assert_eq!(groups[0].books[0].id, "b");
    }

    #[test]
    fn two_files_with_the_same_title_are_still_found() {
        let groups = group(vec![
            book("a", "宝贵的人生建议", None, 2),
            book("b", "宝贵的人生建议", None, 1),
            book("c", "东方的智慧", None, 3),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].reason, "书名完全一致");
        assert_eq!(groups[0].books.len(), 2);
    }

    /// The shelf that made the old rule untenable. Every pair here was reported
    /// as one book by a rule that cut the title at punctuation.
    #[test]
    fn real_shelf_titles_are_not_merged_by_a_shared_prefix() {
        let pairs = [
            ("彼得·林奇的成功投资", "彼得·德汉克：经典作品合集"),
            ("阿瑟·克拉克科幻短篇全集", "阿瑟·米勒戏剧经典（套装5册）"),
            ("大卫·贝尔", "大卫·科波菲尔：全2册"),
            ("玩转ChatGPT-秒变AI提问和追问高手", "玩转ChatGPT-秒变AI写作高手"),
            ("万万没想到：用理工科思维理解世界", "万万没想到：《西游记》可以这样读"),
            ("单读（11-15）", "单读（01-10）"),
            ("安娜·卡列尼娜（于大卫译）", "安娜·卡列尼娜回忆录（文学纪念碑）"),
            ("人类的终极问题", "人类的终极问题：未来篇"),
            ("神曲（全三册）", "神曲：插图珍藏本"),
        ];
        for (left, right) in pairs {
            let groups = group(vec![book("a", left, None, 1), book("b", right, None, 2)]);
            assert!(groups.is_empty(), "「{left}」和「{right}」不是同一本");
        }
    }

    /// A book already identified by ISBN must not be listed twice.
    #[test]
    fn an_isbn_match_is_not_repeated_as_a_title_match() {
        let groups = group(vec![
            book("a", "三体", Some("9787536692930"), 2),
            book("b", "三体：地球往事", Some("9787536692930"), 1),
            book("c", "三体", None, 3),
        ]);
        assert_eq!(groups.len(), 1, "只有一组，没有第二份「书名完全一致」");
        assert_eq!(groups[0].reason, "同一 ISBN");
        assert_eq!(groups[0].books.len(), 2);
    }

    #[test]
    fn different_books_and_short_titles_are_not_grouped() {
        let groups = group(vec![
            book("a", "三体", None, 1),
            book("b", "三体Ⅱ·黑暗森林", None, 2),
            book("c", "A", None, 3),
            book("d", "A", None, 4),
        ]);
        assert!(groups.is_empty(), "一卷/二卷不是重复，单字标题也不是证据");
    }

    #[test]
    fn a_partial_isbn_is_not_a_key() {
        let groups =
            group(vec![book("a", "甲", Some("9787"), 1), book("b", "乙", Some("9787"), 2)]);
        assert!(groups.is_empty());
    }

    #[test]
    fn the_biggest_pile_comes_first() {
        let groups = group(vec![
            book("a", "甲乙", None, 1),
            book("b", "甲乙", None, 2),
            book("c", "丙丁", None, 3),
            book("d", "丙丁", None, 4),
            book("e", "丙丁", None, 5),
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].books.len(), 3);
        assert_eq!(groups[0].books[0].id, "c");
    }
}
