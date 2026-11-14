//! Shelf catalogue export: one CSV row per book, readable without this app.
//!
//! Phase 5's 「导出」 answers a narrower question than 「备份」: a reader who
//! wants to see what is on the shelf — print it, diff it against a Calibre
//! library, hand it to a spreadsheet, keep it after uninstalling — needs the
//! *list*, not the bytes. A backup (see `backup`) already carries the whole
//! data directory, and copying book files or writing OPF sidecars here would
//! duplicate it while inventing a Calibre import protocol that does not exist:
//! Calibre has no standard "import this CSV of books", and its own book ids,
//! paths and `metadata.db` are private to it.
//!
//! So this is a one-way, plain-UTF-8 inventory. It never writes to a Calibre
//! library, never touches `metadata.db`, and never reads a book's source file.
//! The columns are the same metadata 5.4 copies *in* from Calibre, which makes
//! an import-then-export round trip something a reader can check by eye.
//!
//! Only books on the shelf are listed. The bin is excluded on purpose: a
//! trashed book still has a row, but a list that says 「我有哪些书」 and
//! includes the ones thrown away is answering a different question. The bin
//! has its own screen.
//!
//! Reading `rating` is deliberately left out. 5.4d does not write it either:
//! Calibre's stars are the reader's own 0–10 mark, while this app's `rating`
//! is a catalogue's community score with a source and a count. A column called
//! 「评分」 with no source named would be a small, durable lie.

use std::path::Path;

use chrono::{Local, TimeZone};

use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::export::{CSV_BOM, csv_field};
use crate::library::{has_extension, repository};
use repository::{BookQuery, BookSummary, LibrarySort};

/// One column layout, in the order the row builder fills it.
///
/// `书籍ID` is last because it is the least human of them: a script can point
/// back at a book with it, but a reader scanning the sheet should meet the
/// title first. `阅读进度(%)` names its unit rather than leaving a bare `0.26`
/// to be read as either a fraction or a percent.
const HEADER: &str = "书名,作者,副标题,ISBN,出版社,出版年,语言,标签,格式,阅读进度(%),收藏,添加日期,最近阅读,书籍ID\n";

/// Writes the shelf to `dest` and returns how many books it listed.
///
/// The extension is checked rather than guessed, for the same reason the notes
/// export checks it: the save panel promised a shape, and writing a CSV into a
/// file ending in `.xlsx` is worse than refusing. A BOM leads the file so Excel
/// reads the Chinese titles as UTF-8 instead of the machine's code page.
pub fn export(library: &Library, dest: &Path) -> AppResult<usize> {
    if !has_extension(dest, &["csv"]) {
        return Err(AppError::InvalidArgument("书单请导出为 .csv".into()));
    }

    // One query, and a stable order: a catalogue you diff against last month's
    // copy should not shuffle because a book was opened. Title order is also
    // the order a printed list wants. `BookQuery::default()` reads `books_live`,
    // so the bin never reaches the file.
    let books = library.with(|conn| {
        repository::list(conn, &BookQuery { sort: LibrarySort::TitleAsc, ..BookQuery::default() })
    })?;

    std::fs::write(dest, render(&books))?;
    Ok(books.len())
}

/// The whole file. Pure, so the tests pin the columns without a database.
fn render(books: &[BookSummary]) -> String {
    let mut out = String::from(CSV_BOM);
    out.push_str(HEADER);
    for book in books {
        out.push_str(&row(book));
    }
    out
}

fn row(book: &BookSummary) -> String {
    let fields = [
        cell(&book.title),
        cell(&book.authors.join("、")),
        cell(book.subtitle.as_deref().unwrap_or("")),
        cell(book.isbn.as_deref().unwrap_or("")),
        cell(book.publisher.as_deref().unwrap_or("")),
        book.published_year.map(|year| year.to_string()).unwrap_or_default(),
        cell(book.language.as_deref().unwrap_or("")),
        cell(&book.tags.join("、")),
        book.format.as_str().to_string(),
        (book.progress * 100.0).round().clamp(0.0, 100.0).to_string(),
        if book.favorite { "是" } else { "否" }.to_string(),
        date(book.added_at),
        book.last_read_at.map(date).unwrap_or_default(),
        cell(&book.id),
    ];
    format!("{}\n", fields.join(","))
}

/// CSV quoting plus a guard against spreadsheet formula injection.
///
/// A title beginning with `=`, `+`, `-` or `@` is a formula to Excel and
/// Sheets, not a title: someone else's book name becomes an expression the
/// reader's machine evaluates on open. Prefixing `'` keeps the cell text.
/// Leading tab/CR get the same treatment because a value that starts with
/// whitespace can be reinterpreted by a spreadsheet's CSV parser.
///
/// The guard lives here rather than in `export::csv_field` because the notes
/// CSV is read back by `clippings::parse_csv`: adding a character there would
/// change the passage on import. This file has no reader on this side.
fn cell(value: &str) -> String {
    let guarded = match value.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{value}"),
        _ => value.to_string(),
    };
    csv_field(&guarded)
}

/// A local calendar date, not Unix seconds: a column a person is meant to read
/// should not need a conversion to say when a book arrived. An out-of-range
/// timestamp becomes an empty cell rather than an invented date.
fn date(seconds: i64) -> String {
    Local
        .timestamp_opt(seconds, 0)
        .single()
        .map(|at| at.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Layout;
    use crate::document::{BookFormat, fixture};
    use std::path::PathBuf;

    fn book() -> BookSummary {
        BookSummary {
            id: "b1".into(),
            title: "三体".into(),
            subtitle: None,
            description: None,
            language: None,
            publisher: None,
            format: BookFormat::Epub,
            file_size: 1024,
            cover_url: None,
            added_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            last_read_at: None,
            progress: 0.0,
            location: None,
            favorite: false,
            isbn: None,
            published_year: None,
            rating: None,
            rating_count: None,
            rating_source: None,
            douban_url: None,
            authors: vec![],
            tags: vec![],
        }
    }

    fn lines(books: &[BookSummary]) -> Vec<String> {
        render(books).lines().map(str::to_string).collect()
    }

    #[test]
    fn the_header_leads_with_a_bom_and_names_every_column() {
        let rendered = render(&[]);
        assert!(rendered.starts_with("\u{feff}书名,作者,"), "{rendered}");
        assert_eq!(rendered.lines().count(), 1, "空书库也该有表头：{rendered}");
        assert_eq!(HEADER.matches(',').count() + 1, 14);
    }

    #[test]
    fn a_row_fills_the_columns_in_header_order() {
        let mut one = book();
        one.subtitle = Some("地球往事".into());
        one.isbn = Some("9787536692930".into());
        one.publisher = Some("重庆出版社".into());
        one.published_year = Some(2006);
        one.language = Some("zh".into());
        one.authors = vec!["刘慈欣".into(), "姚海军".into()];
        one.tags = vec!["科幻".into(), "中国文学".into()];
        one.progress = 0.256;
        one.favorite = true;
        one.last_read_at = Some(1_700_086_400);

        let row = lines(&[one]).remove(1);
        let parts: Vec<&str> = row.split(',').collect();
        assert_eq!(parts.len(), 14, "{row}");
        assert_eq!(parts[0], "三体");
        assert_eq!(parts[1], "刘慈欣、姚海军");
        assert_eq!(parts[2], "地球往事");
        assert_eq!(parts[3], "9787536692930");
        assert_eq!(parts[4], "重庆出版社");
        assert_eq!(parts[5], "2006");
        assert_eq!(parts[6], "zh");
        assert_eq!(parts[7], "科幻、中国文学");
        assert_eq!(parts[8], "epub");
        assert_eq!(parts[9], "26");
        assert_eq!(parts[10], "是");
        assert_eq!(parts[11].len(), 10, "本地日期 YYYY-MM-DD：{row}");
        assert_eq!(parts[12].len(), 10, "本地日期 YYYY-MM-DD：{row}");
        assert_eq!(parts[13], "b1");
    }

    #[test]
    fn missing_metadata_stays_empty_instead_of_inventing_a_value() {
        let row = lines(&[book()]).remove(1);
        let parts: Vec<&str> = row.split(',').collect();
        assert_eq!(parts.len(), 14);
        assert_eq!(&parts[..8], &["三体", "", "", "", "", "", "", ""]);
        assert_eq!(parts[8], "epub");
        assert_eq!(parts[9], "0");
        assert_eq!(parts[10], "否");
        assert_eq!(parts[11].len(), 10, "添加日期是本地 YYYY-MM-DD");
        assert_eq!(parts[12], "", "最近阅读为空");
        assert_eq!(parts[13], "b1");
    }

    #[test]
    fn delimiters_and_line_breaks_are_quoted() {
        let mut awkward = book();
        awkward.title = "三体, 全集".into();
        awkward.publisher = Some("重庆\"出版社\"".into());
        awkward.tags = vec!["科幻\n硬科幻".into()];
        // Not `lines()`: a quoted CSV field may itself hold a line break, and
        // splitting the file on `\n` would cut the very row under test.
        let rendered = render(&[awkward]);
        let row = rendered.split_once('\n').map(|(_, rest)| rest).unwrap_or_default();

        assert!(row.starts_with("\"三体, 全集\","), "{row}");
        assert!(row.contains("\"重庆\"\"出版社\"\"\""), "{row}");
        assert!(row.contains("\"科幻\n硬科幻\""), "{row}");
    }

    #[test]
    fn a_formula_like_title_is_written_as_text() {
        for title in ["=1+1", "+SUM(A1:A2)", "-2+3", "@SUM(1)", "\tcmd", "\rHYPERLINK"] {
            let mut dangerous = book();
            dangerous.title = title.into();
            let cell = cell(&dangerous.title);
            // `\t` / `\r` also make `csv_field` wrap the cell in quotes, so
            // the guard is "a `'` before the original value", not "first byte".
            assert!(cell.contains(&format!("'{title}")), "{title} 必须挡住：{cell}");
        }
        assert_eq!(cell("三体"), "三体", "普通书名不该被改写");
    }

    #[test]
    fn progress_is_clamped_to_the_range_the_header_promises() {
        let mut over = book();
        over.progress = 1.4;
        assert!(lines(&[over]).remove(1).contains(",100,"), "越界进度要落到 100%");
        let mut under = book();
        under.progress = -0.2;
        assert!(lines(&[under]).remove(1).contains(",0,"), "负进度要落到 0%");
    }

    /// A real library on disk, with one row the shelf query can read.
    struct Shelf {
        dir: PathBuf,
        library: Library,
    }

    impl Shelf {
        fn new(tag: &str) -> Self {
            let dir = fixture::temp_dir(tag);
            Layout::create(dir.clone()).expect("layout");
            let library = Library::open(&dir).expect("open library");
            Self { dir, library }
        }

        fn add(&self, id: &str, title: &str) {
            self.library
                .with(|conn| {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, \
                         file_path, file_size, added_at, updated_at) \
                         VALUES (?1, ?2, ?2, 'epub', ?3, ?4, 9, 1700000000, 1700000000)",
                        rusqlite::params![
                            id,
                            title,
                            format!("hash-{id}"),
                            self.dir.join(format!("{id}.epub")).to_string_lossy().into_owned()
                        ],
                    )
                    .map_err(Into::into)
                })
                .expect("insert book");
        }
    }

    impl Drop for Shelf {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn an_empty_shelf_writes_a_header_and_reports_zero() {
        let shelf = Shelf::new("catalog-empty");
        let dest = shelf.dir.join("books.csv");
        assert_eq!(export(&shelf.library, &dest).expect("export"), 0);
        assert_eq!(std::fs::read_to_string(&dest).expect("read back"), render(&[]));
    }

    #[test]
    fn a_real_book_becomes_one_row_and_the_count_matches() {
        let shelf = Shelf::new("catalog-one-book");
        shelf.add("b1", "活着");
        // A deleted book is still a row, but is not on the shelf.
        shelf.add("b2", "已删掉的书");
        shelf
            .library
            .with(|conn| {
                conn.execute("UPDATE books SET deleted_at = 1 WHERE id = 'b2'", [])
                    .map_err(Into::into)
            })
            .expect("trash b2");

        let dest = shelf.dir.join("books.csv");
        assert_eq!(export(&shelf.library, &dest).expect("export"), 1);
        let text = std::fs::read_to_string(&dest).expect("read back");
        assert!(text.contains("\n活着,"), "{text}");
        assert!(!text.contains("已删掉的书"), "回收站里的书不该进书单：{text}");
        assert_eq!(text.lines().count(), 2, "表头加一本书：{text}");
    }

    #[test]
    fn an_unknown_extension_is_refused_without_leaving_a_file() {
        let shelf = Shelf::new("catalog-extension");
        let dest = shelf.dir.join("books.xlsx");
        assert!(matches!(export(&shelf.library, &dest), Err(AppError::InvalidArgument(_))));
        assert!(!dest.exists());
    }
}
