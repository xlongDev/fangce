//! Reads this app's own CSV export back into highlights.

use super::{Clipping, Parsed, linked_book_id};

/// Straight from the header: every column is found by name. That is not
/// decoration — it is why adding a column to the writer cannot break this
/// reader, and why a hand-trimmed table that dropped one still reads for the
/// rest.
pub fn parse_csv(source: &str) -> Parsed {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut rows = csv_rows(source).into_iter();
    let Some(header) = rows.next() else {
        return Parsed::default();
    };
    let column = |want: &str| header.iter().position(|field| field.trim() == want);
    let Some(text_at) = column("原文") else {
        return Parsed::default();
    };
    let (title_at, chapter_at) = (column("书名"), column("章节"));
    let (note_at, color_at, style_at) = (column("笔记"), column("颜色"), column("样式"));
    let link_at = column("链接");

    let mut parsed = Parsed::default();
    for row in rows {
        let field = |at: Option<usize>| at.and_then(|at| row.get(at)).map_or("", String::as_str);
        // Kept verbatim, not collapsed the way a Kindle highlight is: this text
        // came out of our own `annotations` table, so its line breaks are the
        // reader's own and re-writing them as spaces would edit the passage.
        let text = field(Some(text_at)).trim().to_string();
        if text.is_empty() {
            continue;
        }
        parsed.highlights.push(Clipping {
            title: field(title_at).trim().to_string(),
            author: String::new(),
            // The link is what makes an old single-book export importable: it
            // was written before `书名` led every table, so the id it carries is
            // the only thing in the file that names the book.
            book_id: linked_book_id(field(link_at)),
            text,
            note: non_empty(field(note_at)),
            // Empty means "never chose", which is not the same fact as yellow —
            // `export::csv_row` leaves the column blank for the same reason.
            color: non_empty(field(color_at)),
            style: non_empty(field(style_at)),
            // Written one-based, like the Markdown heading and like the notes
            // page; annotations count from zero.
            chapter_idx: field(chapter_at)
                .trim()
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1)),
        });
    }
    parsed
}

/// A CSV field as an optional value: an empty column is an absent fact.
fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Splits a whole CSV source into rows of fields.
///
/// RFC 4180 as the writer on the other side produces it: a `"` quotes a field
/// that may then hold the delimiter, a line break, or a doubled `""` for one
/// literal quote. Written out rather than pulled in — it is forty lines with two
/// callers — one in `detect`, one here — and the alternative is a
/// dependency for one import path. Three callers now (this reader, the
/// clippings detector and the shelf catalogue's restore) share the same
/// quoting rules, which is the reason it lives here rather than in either.
///
/// This has to be exact rather than lenient. `export::csv_field` quotes a
/// passage exactly when it holds one of those three characters, and a reader
/// that split on commas anyway would silently turn one highlight into two
/// fragments of itself.
pub(crate) fn csv_rows(source: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    // A `"` only opens a quoted field at the start of one; inside a bare field
    // it is a literal quote (what a spreadsheet writes when it is not quoting).
    let mut at_start = true;
    let mut chars = source.chars().peekable();

    while let Some(ch) = chars.next() {
        if quoted {
            match ch {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        quoted = false;
                    }
                }
                _ => field.push(ch),
            }
            continue;
        }
        match ch {
            '"' if at_start => {
                quoted = true;
                at_start = false;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                at_start = true;
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                at_start = true;
            }
            // A stray CR is dropped rather than kept: the field already ends at
            // the LF that follows it.
            '\r' => {}
            _ => {
                field.push(ch);
                at_start = false;
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_reads_both_header_shapes_by_column_name() {
        let single = "章节,原文,笔记,颜色,样式,链接\n1,你好,第三章的伏笔,#ffd12e,,\n";
        let parsed = parse_csv(single);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "你好");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("第三章的伏笔"));
        assert_eq!(parsed.highlights[0].color.as_deref(), Some("#ffd12e"));
        assert_eq!(parsed.highlights[0].style, None);
        assert_eq!(parsed.highlights[0].chapter_idx, Some(0));
        // No 书名 column: the file names its book in its heading, so the row
        // has nothing to say and the parser must not invent one.
        assert_eq!(parsed.highlights[0].title, "");

        let cross = "书名,章节,原文,笔记,颜色,样式,链接\n三体,3,最后一段,,,,\n";
        let parsed = parse_csv(cross);
        assert_eq!(parsed.highlights[0].title, "三体");
        assert_eq!(parsed.highlights[0].chapter_idx, Some(2));
    }

    #[test]
    fn csv_takes_the_columns_it_knows_and_ignores_the_rest() {
        // A column added by a later version is read past, not refused — which
        // is what lets the two export shapes share one reader.
        let source = "书名,章节,原文,笔记,颜色,样式,链接,备注\n三体,1,你好,,#ffd12e,,,\n";
        let parsed = parse_csv(source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "你好");
        assert_eq!(parsed.highlights[0].title, "三体");
    }

    #[test]
    fn csv_survives_a_passage_holding_a_comma_a_quote_and_a_line_break() {
        // The writer quotes exactly these three, so the reader has to unquote
        // exactly these three: a comma split naively would turn one highlight
        // into two fragments of itself.
        let source = "书名,章节,原文,笔记,颜色,样式,链接\n\
                      三体,1,\"你好,世界\",\"他说\"\"不\"\"\",,,\n\
                      三体,1,\"First line.\nSecond line.\",,,,\n";
        let parsed = parse_csv(source);

        assert_eq!(parsed.highlights.len(), 2);
        assert_eq!(parsed.highlights[0].text, "你好,世界");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("他说\"不\""));
        assert_eq!(parsed.highlights[1].text, "First line.\nSecond line.");
    }

    #[test]
    fn a_row_with_no_passage_is_dropped() {
        let source = "章节,原文,笔记,颜色,样式,链接\n1,,只有笔记没有原文,,,\n1,有原文,,,,\n";
        let parsed = parse_csv(source);
        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "有原文");
    }

    /// The link is the exact half of what an export knows, and both shapes
    /// carry it — the Markdown half of the pair is covered in `markdown`.
    #[test]
    fn a_link_names_the_book_it_came_from() {
        let csv = parse_csv(
            "书名,章节,原文,笔记,颜色,样式,链接\n\
             三体,1,你好,,,,fangce://book/b1?annotation=a1\n",
        );
        assert_eq!(csv.highlights[0].book_id.as_deref(), Some("b1"));
    }
}
