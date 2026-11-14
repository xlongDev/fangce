//! Notes export: highlights and notes as a file the reader keeps after the app
//! is gone.
//!
//! Two shapes, picked by the destination extension. Markdown reads like a page
//! — the quoted passage, then the note under it, grouped by chapter. CSV is one
//! row per highlight, for a spreadsheet. Both are plain UTF-8 text: no archive,
//! no schema, nothing that needs this app to open again. A book pack (see
//! `pack`) is the other half of the story and answers a different question —
//! that one is for restoring the *reading state*, this one is for reading it.
//!
//! Either scope writes the same per-highlight blocks: `export` takes one book,
//! `export_selection` takes whatever set of highlights a screen is showing,
//! across as many books as they come from. Only the book-level framing differs
//! between the two, which is why the importer on the other side reads a header
//! rather than a fixed layout.
//!
//! Chapters are headings by *number*, never by title looked up in `chapters`:
//! foliate books number their annotations by section, and a title fetched by
//! that index would be off by exactly the offset those two lists differ by.
//! The number is also what the reader's own annotation list shows, so the file
//! and the app agree on where a highlight lives.
//!
//! Every highlight also carries a `fangce://` link back to itself. The
//! link names the book and the annotation and *nothing else* — no position, no
//! chapter, no offset. Positions are the one thing this app cannot state
//! portably: a foliate highlight is anchored by CFI, a paragraph one by
//! character offset, a PDF one by page, and the three do not convert into each
//! other. The row the id points at already knows which of the three it is, so
//! the link stays true across all of them, and a reader who opens it lands on
//! the passage in whichever renderer that book uses.

use std::path::Path;

use crate::db::Library;
use crate::error::{AppError, AppResult};

use crate::library::{annotations, has_extension, repository};

/// Extensions that select Markdown.
const MARKDOWN_EXTENSIONS: [&str; 2] = ["md", "markdown"];
/// Extension that selects CSV.
const CSV_EXT: &str = "csv";

/// The one word the caller passes to ask for Obsidian's dialect.
///
/// It is a word and not an enum because the browser side writes the same file
/// with the same word, and the two implementations are pinned to each other by
/// their tests (see `src/lib/local/notes.ts`). A third Markdown flavour is the
/// thing that would want a shared type; two dialects do not.
pub const OBSIDIAN: &str = "obsidian";

/// A byte-order mark, so Excel opens the file as UTF-8 instead of guessing the
/// system code page — the difference between 三体 and mojibake.
pub(crate) const CSV_BOM: &str = "\u{feff}";

/// The one column layout both CSV exporters write.
///
/// `书名` leads unconditionally, single book or many. It is what the importer
/// matches on, so a file without it is a file this module cannot read back.
/// `clippings::parse_csv` finds its columns by name, which is what lets the two
/// sides move together: adding a column here is invisible there until something
/// asks for it.
const CSV_HEADER: &str = "书名,章节,原文,笔记,颜色,样式,链接\n";

/// Scheme the app registers for deep links (see `deep_link`), so a highlight in
/// an exported file can be reopened in the app that wrote it.
pub const SCHEME: &str = "fangce";

/// One highlight as the export prints it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    /// The row's own id; what the link back into the app points at.
    id: String,
    chapter_idx: usize,
    text: String,
    note: Option<String>,
    color: Option<String>,
    style: Option<String>,
}

/// Everything both renderers read, gathered in one pass so a book is still
/// exported from a single consistent snapshot.
#[derive(Debug)]
struct Notes {
    id: String,
    title: String,
    authors: Vec<String>,
    /// 0..1, straight from the shelf.
    progress: f64,
    entries: Vec<Entry>,
}

/// The link a highlight carries back into the app.
///
/// Both ids are v4 UUIDs, so nothing needs escaping; the shape is pinned by
/// `src/lib/deeplink.ts`, which parses the other end of it.
fn link(book_id: &str, annotation_id: &str) -> String {
    format!("{SCHEME}://book/{book_id}?annotation={annotation_id}")
}

/// Which flavour of Markdown a file is written in.
///
/// Two, because there are two audiences: a renderer that displays what it is
/// given, and a vault that *indexes* it. Obsidian only ever reads `.md`, so its
/// dialect cannot be a different file — it is the same file with a YAML block
/// at the top, the book as a wikilink, and the quotes as callouts, so a query
/// over the vault can find a highlight and its metadata at all.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dialect {
    Plain,
    Obsidian,
}

impl Dialect {
    fn of(flavor: Option<&str>) -> Self {
        match flavor {
            Some(OBSIDIAN) => Self::Obsidian,
            _ => Self::Plain,
        }
    }

    fn quote(self, text: &str) -> String {
        match self {
            Self::Plain => quote(text),
            Self::Obsidian => format!("> [!quote]\n{}", quote(text)),
        }
    }
}

/// Writes one book's highlights and notes to `dest`.
///
/// The format follows the extension: `.md` (or `.markdown`) for prose, `.csv`
/// for a table. Anything else is refused rather than guessed at, because
/// writing the wrong shape into a file the reader chose is worse than saying no.
///
/// `flavor` names a Markdown variant without changing the extension — see
/// [`OBSIDIAN`]. It never turns a `.csv` into anything else: the extension is
/// what the reader chose, and a vault is not a spreadsheet.
pub fn export(
    library: &Library,
    book_id: &str,
    dest: &Path,
    flavor: Option<&str>,
) -> AppResult<()> {
    let notes = gather(library, book_id)?;
    let rendered = if has_extension(dest, &MARKDOWN_EXTENSIONS) {
        markdown_page(&notes, Dialect::of(flavor))
    } else if has_extension(dest, &[CSV_EXT]) {
        csv(&notes)
    } else {
        return Err(AppError::InvalidArgument("导出格式请用 .md 或 .csv".into()));
    };
    std::fs::write(dest, rendered)?;
    Ok(())
}

/// Obsidian's properties block.
///
/// This is the whole of that dialect's value: without it a vault holds the
/// highlights as prose, and no query can ask which book a note came from, who
/// wrote it, or how far in the reader was.
fn frontmatter(books: &[&Notes]) -> String {
    let mut fields = vec![match books {
        [only] => format!("title: {}", yaml(&format!("《{}》标注与笔记", only.title))),
        many => format!("title: {}", yaml(&format!("笔记导出（{} 本书）", many.len()))),
    }];
    // Author and progress belong to one book and mean nothing across several.
    if let [only] = books {
        if !only.authors.is_empty() {
            fields.push(format!(
                "authors: [{}]",
                only.authors.iter().map(|a| yaml(a)).collect::<Vec<_>>().join(", ")
            ));
        }
        fields.push(format!("progress: {:.2}", only.progress));
    }
    fields.push("tags:".to_string());
    fields.push("  - 方册".to_string());
    let mut out = String::from("---\n");
    for field in fields {
        out.push_str(&field);
        out.push('\n');
    }
    out.push_str("---");
    out
}

/// A YAML scalar, quoted — a title carrying a colon or a quote would otherwise
/// end the mapping somewhere it was not meant to.
fn yaml(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn gather(library: &Library, book_id: &str) -> AppResult<Notes> {
    let book = library
        .with(|conn| repository::get(conn, book_id))?
        .ok_or_else(|| AppError::NotFound(book_id.to_string()))?;
    let entries = library.with(|conn| {
        Ok(annotations::list(conn, book_id)?
            .into_iter()
            .map(|annotation| Entry {
                id: annotation.id,
                chapter_idx: annotation.chapter_idx,
                text: annotation.text,
                note: annotation.note,
                color: annotation.color,
                style: annotation.style,
            })
            .collect::<Vec<_>>())
    })?;

    Ok(Notes {
        id: book_id.to_string(),
        title: book.title,
        authors: book.authors,
        progress: book.progress,
        entries,
    })
}

/// Writes the highlights named by `ids` to `dest`, in the order `book_ids`
/// gives.
///
/// The notes page exports what it is *showing*, and that is a set of highlights
/// rather than a book: a search or the 有笔记 filter narrows the page, so a file
/// that quietly carried the rest would not be the file the reader asked for.
/// `book_ids` carries the page's own order — the shelf's — so the file groups
/// the way the screen does, and `ids` decides which rows survive.
///
/// Books are gathered whole and then filtered, rather than one highlight looked
/// up at a time, so the query count follows the books rather than the notes.
pub fn export_selection(
    library: &Library,
    book_ids: &[String],
    ids: &[String],
    dest: &Path,
    flavor: Option<&str>,
) -> AppResult<()> {
    if ids.is_empty() {
        return Err(AppError::InvalidArgument("没有可导出的标注".into()));
    }

    let mut books = Vec::new();
    for book_id in book_ids {
        let mut notes = gather(library, book_id)?;
        notes.entries.retain(|entry| ids.contains(&entry.id));
        if !notes.entries.is_empty() {
            books.push(notes);
        }
    }

    let rendered = if has_extension(dest, &MARKDOWN_EXTENSIONS) {
        markdown_many(&books, Dialect::of(flavor))
    } else if has_extension(dest, &[CSV_EXT]) {
        csv_many(&books)
    } else {
        return Err(AppError::InvalidArgument("导出格式请用 .md 或 .csv".into()));
    };
    std::fs::write(dest, rendered)?;
    Ok(())
}

/// The whole file as one page of Markdown.
fn markdown_page(notes: &Notes, dialect: Dialect) -> String {
    let title = match dialect {
        Dialect::Plain => format!("# 《{}》标注与笔记", notes.title),
        Dialect::Obsidian => format!("# [[{}]] 标注与笔记", notes.title),
    };
    // The properties block is a property of the file rather than one of its
    // blocks, so it rides on the first one instead of standing in the list
    // where it would be joined by a blank line like everything else.
    let title = match dialect {
        Dialect::Plain => title,
        Dialect::Obsidian => format!("{}\n\n{title}", frontmatter(&[notes])),
    };
    let mut blocks = vec![title, summary(notes)];
    markdown_body(notes, "##", dialect, &mut blocks);
    // Trailing newline: the file is meant to be opened by other tools, and a
    // text file that ends without one makes every one of them complain.
    format!("{}\n", blocks.join("\n\n"))
}

/// Several books as one page of Markdown, a section each.
///
/// The book heading and the chapter headings differ by a level here, where the
/// single-book file has only the chapters: two `##`s in a row would read as two
/// of the same thing, and one of them is a book.
fn markdown_many(books: &[Notes], dialect: Dialect) -> String {
    let mut blocks = vec!["# 笔记导出".to_string(), summary_many(books)];
    // One properties block for the file, at the top, naming what it holds. A
    // second one part-way down would be a YAML mapping in the middle of a
    // Markdown document, which is not a thing any reader of either one wants.
    if dialect == Dialect::Obsidian {
        let refs: Vec<&Notes> = books.iter().collect();
        blocks[0] = format!("{}\n\n{}", frontmatter(&refs), blocks[0]);
    }
    for notes in books {
        blocks.push(match dialect {
            Dialect::Plain => format!("## 《{}》", notes.title),
            Dialect::Obsidian => format!("## [[{}]]", notes.title),
        });
        if !notes.authors.is_empty() {
            blocks.push(notes.authors.join("、"));
        }
        markdown_body(notes, "###", dialect, &mut blocks);
    }
    format!("{}\n", blocks.join("\n\n"))
}

/// One book's highlights, chapter by chapter, appended to `blocks`.
///
/// A heading is emitted when the chapter actually changes: the list is already
/// in reading order, so a group never needs to be buffered.
fn markdown_body(notes: &Notes, heading: &str, dialect: Dialect, blocks: &mut Vec<String>) {
    if notes.entries.is_empty() {
        blocks.push("这本书还没有标注。".to_string());
    }

    let mut chapter: Option<usize> = None;
    for entry in &notes.entries {
        if chapter != Some(entry.chapter_idx) {
            chapter = Some(entry.chapter_idx);
            blocks.push(format!("{heading} 第 {} 章", entry.chapter_idx + 1));
        }
        blocks.push(dialect.quote(&entry.text));
        if let Some(note) = entry.note.as_deref() {
            blocks.push(note.to_string());
        }
        // The way back in. A link rather than a bare URL: note apps render the
        // one and leave the other as text that has to be copied out by hand.
        blocks.push(format!("[在 方册 中打开]({})", link(&notes.id, &entry.id)));
    }
}

/// The line under the title: who wrote it, how much there is, how far in.
fn summary(notes: &Notes) -> String {
    let noted = notes.entries.iter().filter(|entry| entry.note.is_some()).count();
    let mut parts = vec![format!("{} 条标注", notes.entries.len())];
    if noted > 0 {
        parts.push(format!("{noted} 条有笔记"));
    }
    if notes.progress > 0.0 {
        parts.push(format!("阅读进度 {}%", (notes.progress * 100.0).round() as i64));
    }

    let summary = parts.join(" · ");
    match notes.authors.is_empty() {
        true => summary,
        false => format!("{} · {summary}", notes.authors.join("、")),
    }
}

/// The line under the title of a cross-book export. Progress is per book and
/// has no meaning across several, so it is left to each section's own summary.
fn summary_many(books: &[Notes]) -> String {
    let highlights: usize = books.iter().map(|book| book.entries.len()).sum();
    let noted =
        books.iter().flat_map(|book| &book.entries).filter(|entry| entry.note.is_some()).count();

    let mut parts = vec![format!("{} 本书", books.len()), format!("{highlights} 条标注")];
    if noted > 0 {
        parts.push(format!("{noted} 条有笔记"));
    }
    parts.join(" · ")
}

/// One blockquote. Every line gets its own `>`, so a highlight spanning
/// paragraphs stays a single quote instead of making its second half a nested
/// one.
fn quote(text: &str) -> String {
    text.lines().map(|line| format!("> {line}")).collect::<Vec<_>>().join("\n")
}

/// The whole file as one CSV table.
fn csv(notes: &Notes) -> String {
    let mut out = String::from(CSV_BOM);
    out.push_str(CSV_HEADER);
    for entry in &notes.entries {
        out.push_str(&csv_row(notes, entry));
    }
    out
}

/// Several books as one CSV table.
///
/// One header, one shape: a single-book file leads with `书名` exactly as a
/// cross-book one does, even though the title repeats down every row.
///
/// The earlier shape omitted the column here and added it only when a second
/// book showed up, on the argument that a repeated title is noise. That was
/// wrong, and the round-trip test is what showed it: the importer matches a
/// clipping to a book by title, so a file that never names its book cannot be
/// read back at all — `matched: 0` on a file this module had just written.
/// Export and import are one contract, and a column the reader needs is not
/// noise.
fn csv_many(books: &[Notes]) -> String {
    let mut out = String::from(CSV_BOM);
    out.push_str(CSV_HEADER);
    for notes in books {
        for entry in &notes.entries {
            out.push_str(&csv_row(notes, entry));
        }
    }
    out
}

/// One CSV row: the book it came from, then the highlight.
fn csv_row(notes: &Notes, entry: &Entry) -> String {
    format!(
        "{},{},{},{},{},{},{}\n",
        csv_field(&notes.title),
        entry.chapter_idx + 1,
        csv_field(&entry.text),
        csv_field(entry.note.as_deref().unwrap_or("")),
        // Left empty rather than filled with the defaults the UI applies:
        // "never chosen" and "chose yellow" are different facts, and the
        // file should not invent one of them.
        csv_field(entry.color.as_deref().unwrap_or("")),
        csv_field(entry.style.as_deref().unwrap_or("")),
        // Raw rather than as a `[text](url)` pair: a spreadsheet column is
        // a value, and the URL is what the app answers to.
        csv_field(&link(&notes.id, &entry.id)),
    )
}

/// Quotes a field when it holds a delimiter, a quote or a line break — the
/// three things that would otherwise split one row into several.
///
/// `pub(crate)` because the shelf catalogue writes CSV too. It deliberately
/// does *not* guard against spreadsheet formula injection: this file's CSV is
/// read back by `clippings::parse_csv`, and prefixing a `'` to a highlight
/// that starts with `=` would change the passage on the round trip. The
/// catalogue has no reader on this side, so it adds the guard itself.
pub(crate) fn csv_field(value: &str) -> String {
    match value.contains([',', '"', '\n', '\r']) {
        true => format!("\"{}\"", value.replace('"', "\"\"")),
        false => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::fixture;
    use crate::library::clippings;
    use crate::library::import::ImportOutcome;
    use crate::library::repository::{BookQuery, BookSummary};
    use rusqlite::params;
    use std::path::PathBuf;

    struct Harness {
        dir: PathBuf,
        layout: Layout,
        library: Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            let layout = Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, layout, library }
        }

        fn import(&self, paths: &[PathBuf]) -> Vec<ImportOutcome> {
            crate::library::import::import_files(
                &self.library,
                &self.layout,
                paths,
                None,
                &|_, _, _| {},
            )
        }

        fn shelf(&self) -> Vec<BookSummary> {
            self.library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list")
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// The book on the shelf, with no highlights on it.
    fn seed_shelf(harness: &Harness) -> String {
        let epub = fixture::write_epub(
            &harness.dir,
            "source.epub",
            &fixture::full_opf("三体", "刘慈欣"),
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        harness.import(&[epub]);
        harness.shelf()[0].id.clone()
    }

    /// A book with two highlights in chapter 0 (one carrying a note) and one in
    /// chapter 2, in a deliberately shuffled amount of ink.
    fn seed_book(harness: &Harness) -> String {
        let id = seed_shelf(harness);
        harness
            .library
            .with(|conn| {
                repository::set_progress(conn, &id, 0.256, None)?;
                let first =
                    annotations::create(conn, &id, 0, 1, 3, "你好", None, Some("#ffd12e"), None)?;
                annotations::set_note(conn, &first.id, Some("第三章的伏笔"))?;
                annotations::create(conn, &id, 0, 5, 9, "再见", None, None, Some("squiggly"))?;
                annotations::create(conn, &id, 2, 1, 4, "最后一段", None, None, None)?;
                Ok(())
            })
            .expect("seed annotations");
        id
    }

    fn write(harness: &Harness, id: &str, name: &str) -> String {
        let dest = harness.dir.join(name);
        export(&harness.library, id, &dest, None).expect("export");
        std::fs::read_to_string(dest).expect("read back")
    }

    fn notes(entries: Vec<Entry>) -> Notes {
        Notes {
            id: BOOK.into(),
            title: "三体".into(),
            authors: vec!["刘慈欣".into()],
            progress: 0.5,
            entries,
        }
    }

    /// A short book id, so the expected file stays readable. The format itself
    /// is pinned by `the_link_format_is_the_one_the_frontend_parses`, and the
    /// ids a real book hands out are exercised end to end below.
    const BOOK: &str = "b1";

    fn entry(id: &str, chapter_idx: usize, text: &str, note: Option<&str>) -> Entry {
        Entry {
            id: id.into(),
            chapter_idx,
            text: text.into(),
            note: note.map(str::to_string),
            color: None,
            style: None,
        }
    }

    /// The annotation ids the app has for a book, in list order.
    fn annotation_ids(harness: &Harness, book_id: &str) -> Vec<String> {
        harness
            .library
            .with(|conn| annotations::list(conn, book_id))
            .expect("list annotations")
            .into_iter()
            .map(|annotation| annotation.id)
            .collect()
    }

    #[test]
    fn markdown_groups_by_chapter_and_puts_notes_under_their_quote() {
        let rendered = markdown_page(
            &notes(vec![
                entry("a1", 0, "你好", Some("第三章的伏笔")),
                entry("a2", 0, "再见", None),
                entry("a3", 2, "最后一段", Some("记一笔")),
            ]),
            Dialect::Plain,
        );

        assert_eq!(
            rendered,
            "# 《三体》标注与笔记\n\
             \n\
             刘慈欣 · 3 条标注 · 2 条有笔记 · 阅读进度 50%\n\
             \n\
             ## 第 1 章\n\
             \n\
             > 你好\n\
             \n\
             第三章的伏笔\n\
             \n\
             [在 方册 中打开](fangce://book/b1?annotation=a1)\n\
             \n\
             > 再见\n\
             \n\
             [在 方册 中打开](fangce://book/b1?annotation=a2)\n\
             \n\
             ## 第 3 章\n\
             \n\
             > 最后一段\n\
             \n\
             记一笔\n\
             \n\
             [在 方册 中打开](fangce://book/b1?annotation=a3)\n"
        );
    }

    #[test]
    fn the_link_format_is_the_one_the_frontend_parses() {
        // The other end of this contract is `parseDeepLink` in
        // `src/lib/deeplink.ts`; the two are pinned to the same string.
        assert_eq!(link("book-1", "note-1"), "fangce://book/book-1?annotation=note-1");
    }

    #[test]
    fn the_obsidian_dialect_carries_properties_a_query_can_read() {
        let rendered =
            markdown_page(&notes(vec![entry("a1", 0, "你好", Some("伏笔"))]), Dialect::Obsidian);

        // The properties block is the whole reason for the dialect: without it
        // a vault holds the highlights as prose and cannot answer a question
        // about them.
        assert!(rendered.starts_with("---\n"), "{rendered}");
        assert!(rendered.contains("title: \"《三体》标注与笔记\""), "{rendered}");
        assert!(rendered.contains("authors: [\"刘慈欣\"]"), "{rendered}");
        assert!(rendered.contains("progress: 0.50"), "{rendered}");
        assert!(rendered.contains("  - 方册"), "{rendered}");
        // And the parts a vault treats as links rather than text.
        assert!(rendered.contains("# [[三体]] 标注与笔记"), "{rendered}");
        assert!(rendered.contains("> [!quote]\n> 你好"), "{rendered}");
        // The way back into this app is the same one it always was.
        assert!(rendered.contains("[在 方册 中打开](fangce://book/b1?annotation=a1)"));
    }

    #[test]
    fn a_title_with_yaml_in_it_cannot_break_the_properties_block() {
        let mut awkward = notes(vec![entry("a1", 0, "你好", None)]);
        awkward.title = "三体：\"引用\"版".into();
        let rendered = markdown_page(&awkward, Dialect::Obsidian);
        let front = rendered.split("\n---").next().unwrap_or_default();
        assert!(front.contains("title: \"《三体：\\\"引用\\\"版》标注与笔记\""), "{front}");
        // Exactly the six lines the block should have. An unescaped quote
        // would have ended the scalar early and spilled the rest of the title
        // onto a line of its own, which YAML reads as garbage.
        assert_eq!(front.lines().count(), 6, "{front}");
    }

    #[test]
    fn markdown_keeps_a_multiline_quote_a_single_block() {
        let rendered =
            markdown_page(&notes(vec![entry("a1", 0, "第一行\n第二行", None)]), Dialect::Plain);
        assert!(rendered.contains("> 第一行\n> 第二行"), "{rendered}");
    }

    #[test]
    fn markdown_says_so_when_there_is_nothing_to_export() {
        let rendered = markdown_page(&notes(vec![]), Dialect::Plain);
        assert!(rendered.contains("这本书还没有标注。"), "{rendered}");
        assert!(rendered.contains("0 条标注"), "{rendered}");
    }

    #[test]
    fn a_book_without_an_author_keeps_the_summary_line_clean() {
        let mut notes = notes(vec![entry("a1", 0, "你好", None)]);
        notes.authors.clear();
        let rendered = markdown_page(&notes, Dialect::Plain);
        assert!(rendered.contains("\n1 条标注 · 阅读进度 50%\n"), "{rendered}");
    }

    #[test]
    fn csv_is_one_row_per_highlight_with_a_bom() {
        let rendered = csv(&notes(vec![entry("a1", 0, "你好", Some("伏笔"))]));
        assert_eq!(
            rendered,
            "\u{feff}书名,章节,原文,笔记,颜色,样式,链接\n\
             三体,1,你好,伏笔,,,fangce://book/b1?annotation=a1\n",
            "旧标注没写过颜色和样式，文件不该替它们编一个"
        );
    }

    #[test]
    fn a_csv_field_escapes_its_delimiters() {
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
        assert_eq!(csv_field("plain"), "plain");
    }

    #[test]
    fn exporting_a_real_book_writes_its_highlights_and_notes() {
        let harness = Harness::new("export-markdown");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);

        let rendered = write(&harness, &id, "notes.md");
        assert!(rendered.starts_with("# 《三体》标注与笔记\n"), "{rendered}");
        assert!(rendered.contains("刘慈欣 · 3 条标注 · 1 条有笔记 · 阅读进度 26%"), "{rendered}");
        assert!(rendered.contains("## 第 1 章"), "{rendered}");
        assert!(rendered.contains("## 第 3 章"), "{rendered}");
        assert!(rendered.contains("> 你好\n\n第三章的伏笔"), "{rendered}");
        // Real ids are v4 UUIDs, and every highlight gets its own link.
        assert_eq!(ids.len(), 3);
        for annotation_id in &ids {
            let back = format!("[在 方册 中打开](fangce://book/{id}?annotation={annotation_id})");
            assert!(rendered.contains(&back), "缺链接 {back}\n{rendered}");
        }
    }

    #[test]
    fn exporting_a_book_as_csv_writes_one_row_per_highlight() {
        let harness = Harness::new("export-csv");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);

        let rendered = write(&harness, &id, "notes.csv");
        let rows: Vec<&str> = rendered.lines().collect();
        assert_eq!(rows.len(), 4, "表头加三条标注：{rendered}");
        assert_eq!(rows[0], "\u{feff}书名,章节,原文,笔记,颜色,样式,链接");
        assert_eq!(rows[1], format!("三体,1,你好,第三章的伏笔,#ffd12e,,{}", link(&id, &ids[0])));
        assert_eq!(rows[2], format!("三体,1,再见,,,squiggly,{}", link(&id, &ids[1])));
        assert_eq!(rows[3], format!("三体,3,最后一段,,,,{}", link(&id, &ids[2])));
    }

    #[test]
    fn an_unknown_extension_is_refused_rather_than_guessed() {
        let harness = Harness::new("export-unknown-ext");
        let id = seed_book(&harness);
        let err = export(&harness.library, &id, &harness.dir.join("notes.pdf"), None);
        assert!(matches!(err, Err(AppError::InvalidArgument(_))), "不认识的扩展名要拒绝");
    }

    #[test]
    fn exporting_a_book_that_is_not_on_the_shelf_is_not_found() {
        let harness = Harness::new("export-missing-book");
        let err = export(&harness.library, "nope", &harness.dir.join("notes.md"), None);
        assert!(matches!(err, Err(AppError::NotFound(_))));
    }

    #[test]
    fn the_extension_match_is_case_insensitive() {
        let harness = Harness::new("export-case");
        let id = seed_book(&harness);
        let markdown = write(&harness, &id, "notes.MD");
        let csv = write(&harness, &id, "notes.CSV");
        assert!(markdown.starts_with("# 《三体》"), "{markdown}");
        assert!(csv.starts_with("\u{feff}书名"), "{csv}");
    }

    /// The same per-highlight blocks as the single-book file, under a book
    /// heading — the whole point of the cross-book shape is that a reader who
    /// knows one file knows the other.
    #[test]
    fn markdown_many_puts_each_book_under_its_own_heading() {
        let mut second = notes(vec![entry("b1", 1, "另一本的一句", Some("另一条的笔记"))]);
        second.id = "b2".into();
        second.title = "球状闪电".into();
        second.authors.clear();
        second.progress = 0.0;

        let rendered = markdown_many(
            &[notes(vec![entry("a1", 0, "你好", Some("伏笔"))]), second],
            Dialect::Plain,
        );

        assert_eq!(
            rendered,
            "# 笔记导出\n\
             \n\
             2 本书 · 2 条标注 · 2 条有笔记\n\
             \n\
             ## 《三体》\n\
             \n\
             刘慈欣\n\
             \n\
             ### 第 1 章\n\
             \n\
             > 你好\n\
             \n\
             伏笔\n\
             \n\
             [在 方册 中打开](fangce://book/b1?annotation=a1)\n\
             \n\
             ## 《球状闪电》\n\
             \n\
             ### 第 2 章\n\
             \n\
             > 另一本的一句\n\
             \n\
             另一条的笔记\n\
             \n\
             [在 方册 中打开](fangce://book/b2?annotation=b1)\n"
        );
    }

    /// A cross-book table needs the one thing a row cannot say for itself.
    #[test]
    fn csv_many_leads_every_row_with_the_book_it_came_from() {
        let mut second = notes(vec![entry("b1", 0, "另一本", None)]);
        second.id = "b2".into();
        second.title = "球状闪电".into();

        let rendered = csv_many(&[notes(vec![entry("a1", 0, "你好", Some("伏笔"))]), second]);
        assert_eq!(
            rendered,
            "\u{feff}书名,章节,原文,笔记,颜色,样式,链接\n\
             三体,1,你好,伏笔,,,fangce://book/b1?annotation=a1\n\
             球状闪电,1,另一本,,,,fangce://book/b2?annotation=b1\n"
        );
    }

    /// One shape for one book and for many, because the importer has to read
    /// both back and matches on the title. See `csv_many`.
    #[test]
    fn csv_names_its_book_even_when_there_is_only_one() {
        assert!(csv(&notes(vec![entry("a1", 0, "你好", None)])).starts_with("\u{feff}书名,"));
    }

    #[test]
    fn a_cross_book_export_takes_only_the_highlights_it_was_named() {
        let harness = Harness::new("export-selection");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);

        // The middle highlight only, as a search on this page would leave it.
        let dest = harness.dir.join("selection.md");
        export_selection(
            &harness.library,
            std::slice::from_ref(&id),
            &[ids[1].clone()],
            &dest,
            None,
        )
        .expect("export");
        let rendered = std::fs::read_to_string(&dest).expect("read back");

        assert!(rendered.contains("> 再见"), "{rendered}");
        assert!(!rendered.contains("> 你好"), "没选中的不该出现\n{rendered}");
        assert!(!rendered.contains("> 最后一段"), "没选中的不该出现\n{rendered}");
        assert!(rendered.contains(&link(&id, &ids[1])), "{rendered}");
        assert!(rendered.contains("1 本书 · 1 条标注"), "{rendered}");
    }

    #[test]
    fn a_cross_book_export_keeps_the_order_it_was_given() {
        let harness = Harness::new("export-selection-order");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);

        let dest = harness.dir.join("ordered.csv");
        export_selection(&harness.library, std::slice::from_ref(&id), &ids.clone(), &dest, None)
            .expect("export");
        let rendered = std::fs::read_to_string(&dest).expect("read back");
        let rows: Vec<&str> = rendered.lines().skip(1).collect();

        // Reading order, not the order the ids arrived in: the set is what the
        // page selected, and the file still reads like the book.
        assert!(rows[0].starts_with("三体,1,你好"), "{rendered}");
        assert!(rows[1].starts_with("三体,1,再见"), "{rendered}");
        assert!(rows[2].starts_with("三体,3,最后一段"), "{rendered}");

        // The reverse order of the same ids gives the same file.
        let mut reversed = ids.clone();
        reversed.reverse();
        let dest = harness.dir.join("reversed.csv");
        export_selection(&harness.library, std::slice::from_ref(&id), &reversed, &dest, None)
            .expect("export");
        assert_eq!(std::fs::read_to_string(&dest).expect("read back"), rendered);
    }

    #[test]
    fn an_empty_selection_is_refused_rather_than_writing_an_empty_file() {
        let harness = Harness::new("export-selection-empty");
        let id = seed_book(&harness);
        let dest = harness.dir.join("nothing.md");
        let err = export_selection(&harness.library, &[id], &[], &dest, None);
        assert!(matches!(err, Err(AppError::InvalidArgument(_))), "空选择要拒绝");
        assert!(!dest.exists(), "拒绝时不该留下一个空文件");
    }

    #[test]
    fn a_cross_book_export_refuses_an_unknown_extension_too() {
        let harness = Harness::new("export-selection-ext");
        let id = seed_book(&harness);
        let ids = annotation_ids(&harness, &id);
        let err =
            export_selection(&harness.library, &[id], &ids, &harness.dir.join("notes.rtf"), None);
        assert!(matches!(err, Err(AppError::InvalidArgument(_))));
    }

    /// A book on the shelf with the chapter bodies its highlights anchor into,
    /// and nothing marked in it.
    ///
    /// `seed_book` cannot serve here, and the reason is worth writing down: the
    /// EPUB fixture declares a spine item (`text/ch1.xhtml`) that `write_epub`
    /// never writes, so an imported fixture book has no chapter bodies at all.
    /// Nothing noticed until now because every other export test only reads the
    /// file back — and the round trip *imports* it, and an import anchors a
    /// highlight by finding its text in the chapter the file names.
    ///
    /// The offsets are the ones the text actually implies, so the comparison at
    /// the end is a real round trip rather than a comparison of two guesses:
    /// 你好 at 3..5 and 再见 at 9..11 in chapter 0, 最后一段 at 0..4 in chapter 2.
    fn seed_chapters(harness: &Harness) -> String {
        let id = seed_shelf(harness);
        harness
            .library
            .with(|conn| {
                for (idx, content) in
                    [(0i64, "前言。你好，世界。再见，世界。"), (2, "最后一段，就此结束。")]
                {
                    conn.execute(
                        "INSERT INTO chapters (book_id, idx, title, content, chars) \
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            id,
                            idx,
                            format!("第 {} 章", idx + 1),
                            content,
                            content.chars().count() as i64
                        ],
                    )?;
                }
                Ok(())
            })
            .expect("seed chapters");
        id
    }

    /// The same book with the three highlights the export writes.
    fn seed_round_trip(harness: &Harness) -> String {
        let id = seed_chapters(harness);
        harness
            .library
            .with(|conn| {
                let first =
                    annotations::create(conn, &id, 0, 3, 5, "你好", None, Some("#ffd12e"), None)?;
                annotations::set_note(conn, &first.id, Some("第三章的伏笔"))?;
                annotations::create(conn, &id, 0, 9, 11, "再见", None, None, Some("squiggly"))?;
                annotations::create(conn, &id, 2, 0, 4, "最后一段", None, None, None)?;
                Ok(())
            })
            .expect("seed annotations");
        id
    }

    /// A file this app writes, read back in.
    ///
    /// The test the two halves exist for, and neither module can make it alone:
    /// `export` only knows what it wrote and `clippings` only knows what it can
    /// read, so a change to either that the other does not follow shows up here
    /// and nowhere else. The spelled-out expectations in `clippings` pin the
    /// reader against the format as it is written today; this pins the two
    /// against each other.
    ///
    /// Both readings are checked, because they are two different things the
    /// reader does with the same file. Importing it back into the library it came
    /// from — restoring a backup over the top of itself — has to be a no-op
    /// rather than a second copy of every note. Importing it into a *fresh*
    /// library, which is the real point of the feature, has to bring everything
    /// back exactly: moving notes to another machine, or back after losing a
    /// disk. The fresh library holds the same chapter text, so the offsets have
    /// to come out identical.
    #[test]
    fn an_export_imports_back_into_a_fresh_library() {
        let source = Harness::new("export-round-trip-source");
        let id = seed_round_trip(&source);

        for name in ["notes.md", "notes.csv"] {
            let dest = source.dir.join(name);
            export(&source.library, &id, &dest, None).expect("export");
            let text = std::fs::read_to_string(&dest).expect("read back");
            let parsed = match clippings::detect(&text) {
                clippings::Shape::Markdown => clippings::parse_markdown(&text),
                clippings::Shape::Csv => clippings::parse_csv(&text),
                clippings::Shape::Kindle => panic!("{name} was not read as an export"),
            };

            // Over the top of itself: every row is already there.
            let again =
                source.library.with_tx(|tx| clippings::import(tx, &parsed, false)).expect("import");
            assert_eq!(again.imported, 0, "{name}: {again:?}");
            assert_eq!(again.duplicates, 3, "{name}: {again:?}");

            // Into an empty shelf holding the same book.
            let fresh = Harness::new(&format!("export-round-trip-{name}"));
            let fresh_id = seed_chapters(&fresh);
            let outcome =
                fresh.library.with_tx(|tx| clippings::import(tx, &parsed, false)).expect("import");

            assert_eq!(outcome.imported, 3, "{name}: {outcome:?}");
            assert_eq!(outcome.located, 3, "{name}: {outcome:?}");
            assert_eq!(outcome.unknown_titles, Vec::<String>::new(), "{name}");

            let back = fresh.library.with(|conn| annotations::list(conn, &fresh_id)).expect("list");
            let seen: Vec<(usize, usize, usize, &str, Option<&str>)> = back
                .iter()
                .map(|annotation| {
                    (
                        annotation.chapter_idx,
                        annotation.start_char,
                        annotation.end_char,
                        annotation.text.as_str(),
                        annotation.note.as_deref(),
                    )
                })
                .collect();

            // Chapter, offsets, passage and note, in reading order. The offsets
            // are the strongest of the four: they can only come back right if
            // the passage was located in the same chapter at the same place,
            // which is the whole job.
            assert_eq!(
                seen,
                vec![
                    (0, 3, 5, "你好", Some("第三章的伏笔")),
                    (0, 9, 11, "再见", None),
                    (2, 0, 4, "最后一段", None),
                ],
                "{name}"
            );

            // Ink is the one thing the two shapes disagree about: the CSV has a
            // column for it and the Markdown is written to be read as a page.
            let colours: Vec<Option<&str>> =
                back.iter().map(|annotation| annotation.color.as_deref()).collect();
            let styles: Vec<Option<&str>> =
                back.iter().map(|annotation| annotation.style.as_deref()).collect();
            match name {
                "notes.csv" => {
                    assert_eq!(colours, vec![Some("#ffd12e"), None, None], "{name}");
                    assert_eq!(styles, vec![None, Some("squiggly"), None], "{name}");
                }
                _ => {
                    assert_eq!(colours, vec![None, None, None], "{name}");
                    assert_eq!(styles, vec![None, None, None], "{name}");
                }
            }
        }
    }
}
