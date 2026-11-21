//! Reading highlights back in — from Kindle, and from this app's own exports.
//!
//! Three shapes, told apart by [`detect`] from their content rather than their
//! name: Kindle's `My Clippings.txt`, and the Markdown and CSV files
//! [`crate::library::export`] writes. All three come out as the same
//! [`Clipping`]s and go through the same [`import`], so the report, the
//! de-duplication and the anchoring are one code path.
//!
//! What each source knows differs, and nothing is invented to paper over it. A
//! Kindle entry is a title, an author and a passage. An export adds the reader's
//! own note, the ink and the chapter the highlight sits in — which turns the
//! search from "every chapter" into "the one it names" — and the CSV adds the
//! paint style as well — the Markdown carries both in a comment on its link
//! line, so it stays readable as a page and still round-trips.
//!
//! An export also links back to the book it came from, and that link is the
//! strongest thing either source carries: it names the book by id, so a renamed
//! book still matches and a shelf holding the same title twice is not a coin
//! toss. `Catalog::lookup` — the title path, all a Kindle file can offer —
//! resolves a repeated title by taking the first, which is fine as a fallback
//! and not good enough when the file knows.
//!
//! The Kindle `My Clippings.txt` case, in detail: the file knows a highlight's
//! *text* and a `位置 #1234-1237` line number, and nothing else. The line number
//! counts positions inside the file Amazon shipped, which is not the file we
//! have: a re-imported AZW3, an EPUB from elsewhere, a re-flowed TXT all number
//! their positions differently. So the text is the only anchor that survives,
//! and that is what this module matches on — every clipping is located by
//! finding its text in the chapter bodies we already store for full-text search.
//!
//! Matching ignores whitespace and the invisible characters the two sides
//! disagree about (Kindle drops the line breaks an EPUB splits a paragraph at;
//! extracted book text keeps soft hyphens the clipping does not have).
//! Everything else has to be identical, which it is: both sides are the same
//! sentence.
//!
//! For EPUB/MOBI/AZW3 the located offsets are not enough on their own — those
//! books are painted by foliate, which anchors on a CFI. [`Annotation.cfi`]
//! stays `None` here and the reader resolves it the first time it loads the
//! section (see `FoliateBookView`); the offsets are what the annotation list
//! orders by until then.
//!
//! [`Annotation.cfi`]: crate::library::annotations::Annotation::cfi

//! The split is by which file to open. This one holds the model the three
//! shapes share and the one decision that has to be made before any of them
//! runs; `kindle`, `markdown` and `csv` each read one source; `anchor` finds the
//! book and the passage inside it; and `import` walks the path a preview walks
//! and writes nothing when it is one.

mod anchor;
pub(crate) mod csv;
mod import;
mod kindle;
mod markdown;

#[cfg(test)]
mod fixture;

pub use anchor::{chapter_haystacks, locate, signature};
pub use csv::parse_csv;
pub use import::{Outcome, import};
pub use kindle::parse;
pub use markdown::parse_markdown;

/// One highlight lifted out of a clippings file.
///
/// The first three fields are all a Kindle file carries. The rest are what this
/// app's own exports add on top — the reader's note, the ink, the shape, the
/// chapter the highlight sits in, and the book it came from — and they stay
/// `None` for a Kindle file rather than being invented.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Clipping {
    pub title: String,
    pub author: String,
    pub text: String,
    /// The book id this app's own export links back to, when the file carries
    /// the link.
    ///
    /// Worth more than the title, which is only what the shelf *called* the book
    /// when the file was written: a renamed book still matches, and a shelf
    /// holding the same title twice — two editions, a re-import — is no longer
    /// a coin toss. `Catalog::lookup` says as much from its own side: an
    /// identical title "wins even when the shelf holds the book twice", which is
    /// the best a Kindle file can do and a poor excuse for a file that knows.
    pub book_id: Option<String>,
    /// The reader's own note on this highlight. A Kindle clippings file keeps
    /// notes as separate entries with no text of their own, so this is only
    /// ever set by an export.
    pub note: Option<String>,
    /// Ink and paint style, same story.
    pub color: Option<String>,
    pub style: Option<String>,
    /// The chapter the file says the highlight is in.
    ///
    /// Worth more than it looks: it turns "search every chapter for this
    /// sentence" into "search the one chapter the reader marked it in", which
    /// is both cheaper and correct when the same sentence occurs twice in a
    /// book. A Kindle file does not say, so this is `None` there.
    pub chapter_idx: Option<usize>,
}

/// Everything a clippings file turned into.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub highlights: Vec<Clipping>,
    /// Notes and bookmarks share the file with highlights. They are counted so
    /// the report can say where the entries the reader expected went.
    pub notes: usize,
    pub bookmarks: usize,
}

/// Which of the three shapes a file is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Kindle's `My Clippings.txt`.
    Kindle,
    /// This app's own Markdown export.
    Markdown,
    /// This app's own CSV export.
    Csv,
}

/// The scheme and path every highlight in an export links back through.
const LINK_PREFIX: &str = "fangce://book/";

/// Whether `text` carries one of this app's export links.
pub(super) fn carries_link(text: &str) -> bool {
    text.contains(LINK_PREFIX)
}

/// The book id an export's link names, or `None` when the line carries no link.
///
/// The shape is `fangce://book/<book id>?annotation=<highlight id>`, which
/// `export::link` writes and `src/lib/deeplink.ts` parses from the other end.
/// The query is dropped here: this is asking which book, not which highlight.
///
/// Searched for rather than matched at the start: in the Markdown the link is
/// wrapped in `[在 方册 中打开](…)`, and a reader who pasted the file
/// through something that rewrote the wrapper should still be matched.
fn linked_book_id(text: &str) -> Option<String> {
    let at = text.find(LINK_PREFIX)?;
    let rest = &text[at + LINK_PREFIX.len()..];
    let id = rest.split(['?', ')', ']', ' ']).next().unwrap_or("").trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// Says what a file is from what is *in* it, never from its name.
///
/// The reader picks the file in a native panel and may well have renamed it, so
/// a wrong extension is not a reason to fail at. All three shapes announce
/// themselves in their first lines.
///
/// Order matters, and the header has to be looked at first: a CSV export carries
/// the same `fangce://` link on every row that a Markdown one does, so
/// asking "does this mention a link?" before "is this a table?" calls every CSV
/// a Markdown file. (Measured: it did.) The header row is unambiguous — a table
/// opens with column names, and neither of the other two shapes can.
pub fn detect(source: &str) -> Shape {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let first = source.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
    if header_of(first).is_some() {
        return Shape::Csv;
    }
    // An export with nothing in it carries no link, so the heading is then the
    // only thing left to go on. Kindle's first line is `Title (Author)` and
    // never starts with a hash.
    if carries_link(source) || first.starts_with('#') {
        return Shape::Markdown;
    }
    Shape::Kindle
}

/// The column names of an export's header row, or `None` when the line is not
/// one.
///
/// `原文` is what makes a table an export at all; a title or a chapter is what
/// makes a row findable. Columns are read *by name* rather than by position, so
/// a table that gains one is read for the rest instead of refused — which is
/// what lets the two sides move independently (`export::CSV_HEADER` is the
/// writer's half of the same agreement).
fn header_of(line: &str) -> Option<Vec<String>> {
    let fields = csv::csv_rows(line).into_iter().next()?;
    let named = |want: &str| fields.iter().any(|field| field.trim() == want);
    (named("原文") && (named("章节") || named("书名"))).then_some(fields)
}

#[cfg(test)]
mod tests {
    use super::fixture::{LINK, blocks, highlight};
    use super::{Shape, detect};

    // ---- this app's own exports, read back ----------------------------------

    #[test]
    fn a_file_is_told_apart_by_what_is_in_it() {
        let kindle = highlight("Piranesi (Susanna Clarke)", "The Beauty of the House.");
        assert_eq!(detect(&kindle), Shape::Kindle);

        let markdown = blocks(&["# 《Piranesi》标注与笔记", "> The Beauty of the House."]);
        assert_eq!(detect(&markdown), Shape::Markdown);

        // A cross-book export names no book in its title heading; the link on
        // the entries is what gives it away.
        let many =
            blocks(&["# 笔记导出", "2 本书 · 3 条标注", &format!("[在 方册 中打开]({LINK})")]);
        assert_eq!(detect(&many), Shape::Markdown);

        // An export with nothing in it has neither a link nor a 原文 column —
        // the heading is all that is left, which is why it is checked.
        let empty = blocks(&["# 《Piranesi》标注与笔记", "0 条标注"]);
        assert_eq!(detect(&empty), Shape::Markdown);

        let single = blocks(&[
            "章节,原文,笔记,颜色,样式,链接",
            &format!("1,\"你好\",\"\",\"\",\"\",\"{LINK}\""),
        ]);
        assert_eq!(detect(&single), Shape::Csv);

        let cross = blocks(&["书名,章节,原文,笔记,颜色,样式,链接", "Piranesi,1,你好,,,,"]);
        assert_eq!(detect(&cross), Shape::Csv);

        // A table that is not ours: no 原文 column, so it is not an export and
        // falls through to the Kindle parser, which will find nothing in it.
        assert_eq!(detect("name,size\na,1\n"), Shape::Kindle);
    }
}
