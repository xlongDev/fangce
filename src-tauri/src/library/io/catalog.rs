//! Shelf catalogue CSV: one row per book, readable without this app and
//! readable back again.
//!
//! Phase 5's 「导出书单」 answers a narrower question than 「备份」: a reader
//! who wants to see what is on the shelf — print it, diff it against a Calibre
//! library, hand it to a spreadsheet, keep it after uninstalling — needs the
//! *list*, not the bytes. A backup (see `backup`) already carries the whole
//! data directory, and copying book files or writing OPF sidecars here would
//! duplicate it while inventing a Calibre import protocol that does not exist:
//! Calibre has no standard "import this CSV of books", and its own book ids,
//! paths and `metadata.db` are private to it.
//!
//! A single book can be written as the same table with one row. [`import`]
//! reads that row back by `书籍ID` — the only identifier stable across an
//! export — and restores the fields the table actually carries. It never
//! writes a Calibre library, never touches `metadata.db`, and never reads a
//! book's source file. Books, covers and highlights are not in a CSV: the book
//! must still be on this shelf for a restore to have anything to write to.
//!
//! Only books on the shelf are listed. The bin is excluded on purpose: a
//! trashed book still has a row, but a list that says 「我有哪些书」 and
//! includes the ones thrown away is answering a different question. The bin
//! has its own screen.
//!
//! Reading `rating` is deliberately left out. 5.4d does not write it either:
//! Calibre's stars are the reader's own 0–10 mark, while this app's `rating`
//! is a catalogue's community score with a source and a count. A column called
//! 「评分」 with no source named would be a small, durable lie. The same goes
//! for `简介`, which the fourteen-column table has never had: restore carries
//! the current value through instead of inventing an empty one.

use std::collections::HashSet;
use std::path::Path;

use chrono::{Local, TimeZone};
use rusqlite::params;
use serde::Serialize;

use super::clippings::csv::csv_rows;
use crate::db::Library;
use crate::error::{AppError, AppResult};
use crate::library::export::{CSV_BOM, csv_field};
use crate::library::{has_extension, ops, repository, tags};
use repository::{BookMetadataPatch, BookQuery, BookSummary, LibrarySort};

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

/// One book as the same table with one row: the card's 「导出 CSV」 writes
/// exactly what the whole-shelf export would write for this book, so a reader
/// can move between the two without learning a second format.
pub fn export_book(library: &Library, id: &str, dest: &Path) -> AppResult<()> {
    if !has_extension(dest, &["csv"]) {
        return Err(AppError::InvalidArgument("书单请导出为 .csv".into()));
    }
    let book = library
        .with(|conn| repository::get(conn, id))?
        .ok_or_else(|| AppError::NotFound(id.to_string()))?;
    std::fs::write(dest, render(std::slice::from_ref(&book)))?;
    Ok(())
}

/// What one import call actually changed. Missing ids are reported rather
/// than failing the call: a CSV kept across a reinstall can name books that
/// are no longer on this shelf, and the rest are still worth restoring.
#[derive(specta::Type, Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImport {
    pub restored: usize,
    pub missing: Vec<String>,
}

/// Column positions found by name, so a hand-trimmed table still imports the
/// columns it kept. Only the two identity columns are required.
struct Columns {
    title: usize,
    authors: Option<usize>,
    subtitle: Option<usize>,
    isbn: Option<usize>,
    publisher: Option<usize>,
    published_year: Option<usize>,
    language: Option<usize>,
    tags: Option<usize>,
    progress: Option<usize>,
    favorite: Option<usize>,
    book_id: usize,
}

/// One CSV row after parsing and validation, before it meets the database.
struct CsvRow {
    id: String,
    title: String,
    authors: Vec<String>,
    subtitle: Option<String>,
    isbn: Option<String>,
    publisher: Option<String>,
    published_year: Option<i32>,
    language: Option<String>,
    tags: Vec<String>,
    progress: f64,
    favorite: bool,
}

/// Restores the books named by `书籍ID` in a catalogue CSV.
///
/// All rows land in one transaction and one operation-log call, so 「撤销」
/// puts a multi-book import back with one click. `格式` and the two date
/// columns are deliberately read past: the format belongs to the source file,
/// and the dates are history rather than something a snapshot should rewrite.
pub fn import(library: &Library, path: &Path) -> AppResult<CatalogImport> {
    if !has_extension(path, &["csv"]) {
        return Err(AppError::InvalidArgument("书单请导入为 .csv".into()));
    }
    let bytes = std::fs::read(path)?;
    let source =
        String::from_utf8(bytes).map_err(|_| AppError::Parse("CSV 必须是 UTF-8 文本".into()))?;
    let source = source.strip_prefix('\u{feff}').unwrap_or(&source);
    let mut csv = csv_rows(source).into_iter();
    let header = csv.next().ok_or_else(|| AppError::Parse("CSV 没有表头".into()))?;
    let column = |want: &str| header.iter().position(|field| field.trim() == want);
    let (Some(title), Some(book_id)) = (column("书名"), column("书籍ID")) else {
        return Err(AppError::Parse("CSV 缺少「书名」或「书籍ID」列".into()));
    };
    let columns = Columns {
        title,
        authors: column("作者"),
        subtitle: column("副标题"),
        isbn: column("ISBN"),
        publisher: column("出版社"),
        published_year: column("出版年"),
        language: column("语言"),
        tags: column("标签"),
        progress: column("阅读进度(%)"),
        favorite: column("收藏"),
        book_id,
    };

    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for (index, row) in csv.enumerate() {
        // Records, not lines: a quoted field can hold a line break. Counting
        // from the header still gives a number a reader can find in a sheet.
        let at = index + 2;
        let field = |at: Option<usize>| at.and_then(|at| row.get(at)).map_or("", String::as_str);
        let text = |at: Option<usize>| un_cell(field(at)).trim().to_string();
        let optional = |at: Option<usize>| nonempty(text(at));

        let id = text(Some(columns.book_id));
        if id.is_empty() {
            return Err(AppError::Parse(format!("第 {at} 条记录没有书籍ID")));
        }
        if !seen.insert(id.clone()) {
            return Err(AppError::Parse(format!("第 {at} 条记录的书籍ID 重复：{id}")));
        }
        let title = text(Some(columns.title));
        if title.is_empty() {
            return Err(AppError::Parse(format!("第 {at} 条记录没有书名")));
        }
        let year = match text(columns.published_year) {
            year if year.is_empty() => None,
            year => {
                let parsed: i32 = year
                    .parse()
                    .map_err(|_| AppError::Parse(format!("第 {at} 条记录的出版年不是数字")))?;
                if !(1..=9999).contains(&parsed) {
                    return Err(AppError::Parse(format!("第 {at} 条记录的出版年不在可识别范围内")));
                }
                Some(parsed)
            }
        };
        let progress = match text(columns.progress) {
            value if value.is_empty() => 0.0,
            value => {
                let percent: u32 = value
                    .parse()
                    .map_err(|_| AppError::Parse(format!("第 {at} 条记录的阅读进度不是百分比")))?;
                if percent > 100 {
                    return Err(AppError::Parse(format!("第 {at} 条记录的阅读进度超过 100%")));
                }
                f64::from(percent) / 100.0
            }
        };
        let favorite = match text(columns.favorite).as_str() {
            "是" => true,
            "否" | "" => false,
            _ => {
                return Err(AppError::Parse(format!(
                    "第 {at} 条记录的收藏既不是「是」也不是「否」"
                )));
            }
        };
        let names = |value: String| {
            value
                .split('、')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        };

        rows.push(CsvRow {
            id,
            title,
            authors: names(text(columns.authors)),
            subtitle: optional(columns.subtitle),
            isbn: optional(columns.isbn),
            publisher: optional(columns.publisher),
            published_year: year,
            language: optional(columns.language),
            tags: names(text(columns.tags)),
            progress,
            favorite,
        });
    }

    library.with_tx(|tx| {
        let mut befores = Vec::new();
        let mut missing = Vec::new();
        for row in rows {
            let Some(current) = repository::get(tx, &row.id)? else {
                missing.push(row.id);
                continue;
            };
            let cover_path = repository::cover_path(tx, &row.id)?
                .map(|path| path.to_string_lossy().into_owned());
            befores.push(ops::CatalogBefore {
                book_id: row.id.clone(),
                title: current.title.clone(),
                authors: current.authors.clone(),
                subtitle: current.subtitle.clone(),
                publisher: current.publisher.clone(),
                language: current.language.clone(),
                isbn: current.isbn.clone(),
                published_year: current.published_year,
                description: current.description.clone(),
                rating: current.rating,
                rating_count: current.rating_count,
                rating_source: current.rating_source.clone(),
                douban_url: current.douban_url.clone(),
                cover_path,
                tags: current.tags.clone(),
                progress: current.progress,
                favorite: current.favorite,
            });

            // Description and the catalogue's rating have no column in this
            // table. Carry them through rather than quietly clearing them.
            let patch = BookMetadataPatch {
                title: row.title,
                authors: row.authors,
                subtitle: row.subtitle,
                description: current.description.clone(),
                language: row.language,
                publisher: row.publisher,
                isbn: row.isbn,
                published_year: row.published_year,
                rating: current.rating,
                rating_count: current.rating_count,
                rating_source: current.rating_source.clone(),
                douban_url: current.douban_url.clone(),
            };
            repository::update_metadata(tx, &row.id, &patch)?;

            let add = row
                .tags
                .iter()
                .filter(|name| !current.tags.iter().any(|old| old.eq_ignore_ascii_case(name)))
                .cloned()
                .collect::<Vec<_>>();
            let remove = current
                .tags
                .iter()
                .filter(|old| !row.tags.iter().any(|name| name.eq_ignore_ascii_case(old)))
                .cloned()
                .collect::<Vec<_>>();
            tags::assign(tx, std::slice::from_ref(&row.id), &add, &remove)?;
            // Not `set_progress`: a restore must not pretend the reader just
            // opened the book and move `last_read_at` to now.
            tx.execute(
                "UPDATE books SET progress = ?1, favorite = ?2, updated_at = ?3 WHERE id = ?4",
                params![row.progress, row.favorite, crate::library::now_seconds(), row.id],
            )?;
        }

        let restored = befores.len();
        if restored > 0 {
            ops::record_catalog_restore(tx, &befores, &format!("从 CSV 恢复了 {restored} 本书"))?;
        }
        Ok(CatalogImport { restored, missing })
    })
}

/// The whole file. Pure, so the tests pin the columns without a database.
pub(super) fn render(books: &[BookSummary]) -> String {
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
/// change the passage on import. [`un_cell`] is the exact inverse, so this
/// table's own round trip keeps a title that looks like a formula.
const FORMULA_PREFIXES: [char; 6] = ['=', '+', '-', '@', '\t', '\r'];

fn cell(value: &str) -> String {
    let guarded = match value.chars().next() {
        Some(ch) if FORMULA_PREFIXES.contains(&ch) => format!("'{value}"),
        _ => value.to_string(),
    };
    csv_field(&guarded)
}

/// Removes only the apostrophe this writer added: a leading `'` followed by
/// something ordinary was there in the original and stays there.
fn un_cell(value: &str) -> &str {
    value
        .strip_prefix('\'')
        .filter(|rest| rest.chars().next().is_some_and(|ch| FORMULA_PREFIXES.contains(&ch)))
        .unwrap_or(value)
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
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

        /// A fully populated book: the export/import pair has to prove the
        /// columns it really writes, not just that a title came back.
        fn write(&self, id: &str, title: &str, author: &str, tag: &str, progress: f64) {
            let ids = vec![id.to_string()];
            let wanted_tags = vec![tag.to_string()];
            let patch = BookMetadataPatch {
                title: title.to_string(),
                subtitle: Some("副标题".into()),
                description: Some("简介".into()),
                language: Some("zh".into()),
                publisher: Some("出版社".into()),
                isbn: Some("9780000000001".into()),
                published_year: Some(2006),
                rating: Some(8.5),
                rating_count: Some(2),
                rating_source: Some("douban".into()),
                douban_url: Some("https://example.test/subject/1".into()),
                authors: vec![author.to_string()],
            };
            self.library
                .with_tx(|tx| {
                    repository::update_metadata(tx, id, &patch)?;
                    // Write the tag set, not just add to it: this fixture is
                    // reused to make a "before" state, and a stale tag left
                    // behind would make an undo assertion pass for the wrong
                    // reason.
                    let stale = repository::get(tx, id)?
                        .map(|book| {
                            book.tags
                                .iter()
                                .filter(|name| !wanted_tags.contains(*name))
                                .cloned()
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    tags::assign(tx, &ids, &wanted_tags, &stale)?;
                    tx.execute(
                        "UPDATE books SET progress = ?1, favorite = 1, last_read_at = 200 \
                         WHERE id = ?2",
                        params![progress, id],
                    )?;
                    Ok(())
                })
                .expect("write book");
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

    #[test]
    fn importing_one_row_restores_every_column_the_table_carries() {
        let shelf = Shelf::new("catalog-restore");
        shelf.add("b1", "旧书名");
        // A title that looks like a formula survives the writer's guard and
        // the reader's inverse: this is the whole point of `un_cell`.
        shelf.write("b1", "=1+1", "原作者", "原标签", 0.25);

        let csv = shelf.dir.join("one.csv");
        export_book(&shelf.library, "b1", &csv).expect("export one");

        shelf.write("b1", "被改坏的书名", "新作者", "新标签", 0.75);
        let result = import(&shelf.library, &csv).expect("import");
        assert_eq!(result.restored, 1);
        assert!(result.missing.is_empty());

        let book = shelf.library.with(|conn| repository::get(conn, "b1")).unwrap().unwrap();
        assert_eq!(book.title, "=1+1");
        assert_eq!(book.authors, vec!["原作者"]);
        assert_eq!(book.subtitle.as_deref(), Some("副标题"));
        assert_eq!(book.isbn.as_deref(), Some("9780000000001"));
        assert_eq!(book.publisher.as_deref(), Some("出版社"));
        assert_eq!(book.published_year, Some(2006));
        assert_eq!(book.language.as_deref(), Some("zh"));
        assert_eq!(book.tags, vec!["原标签"]);
        assert!((book.progress - 0.25).abs() < f64::EPSILON);
        assert!(book.favorite);
        // Carried, not cleared: neither field has a column in this table.
        assert_eq!(book.description.as_deref(), Some("简介"));
        assert_eq!(book.rating, Some(8.5));
        assert_eq!(book.last_read_at, Some(200));
    }

    #[test]
    fn one_import_is_one_undo_even_when_it_carries_marks_and_labels() {
        let shelf = Shelf::new("catalog-undo");
        shelf.add("b1", "原名");
        shelf.write("b1", "原名", "原作者", "原标签", 0.1);

        let csv = shelf.dir.join("one.csv");
        export_book(&shelf.library, "b1", &csv).expect("export one");
        shelf.write("b1", "新名", "新作者", "新标签", 0.9);
        import(&shelf.library, &csv).expect("import");

        let call_id: String = shelf
            .library
            .with(|conn| {
                conn.query_row(
                    "SELECT call_id FROM operations WHERE action = 'restore_catalog' LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("log");
        let undo = shelf
            .library
            .with_tx(|tx| ops::undo(tx, &call_id, &shelf.dir.join("covers")))
            .expect("undo");
        assert_eq!(undo, ops::Undo { undone: 1, skipped: 0 });

        let book = shelf.library.with(|conn| repository::get(conn, "b1")).unwrap().unwrap();
        assert_eq!(book.title, "新名");
        assert_eq!(book.authors, vec!["新作者"]);
        assert_eq!(book.tags, vec!["新标签"]);
        assert!((book.progress - 0.9).abs() < f64::EPSILON);
        // Absent CSV columns are carried, not treated as "no value" on undo.
        assert_eq!(book.description.as_deref(), Some("简介"));
        assert_eq!(book.rating, Some(8.5));
    }

    #[test]
    fn a_row_naming_a_missing_book_is_reported_instead_of_failing_the_file() {
        let shelf = Shelf::new("catalog-missing");
        shelf.add("b1", "在架的书");
        let csv = shelf.dir.join("missing.csv");
        let missing =
            ["不在架的书", "", "", "", "", "", "", "", "", "", "", "", "", "gone-id"].join(",");
        std::fs::write(&csv, format!("{HEADER}{missing}\n")).expect("write csv");

        let result = import(&shelf.library, &csv).expect("import");
        assert_eq!(result.restored, 0);
        assert_eq!(result.missing, vec!["gone-id"]);
    }

    #[test]
    fn a_duplicate_or_malformed_row_is_refused_before_any_book_is_written() {
        let shelf = Shelf::new("catalog-bad-row");
        shelf.add("b1", "甲");
        shelf.add("b2", "乙");
        let csv = shelf.dir.join("bad.csv");
        let first = ["甲", "", "", "", "", "", "", "", "", "", "", "", "", "b1"].join(",");
        let second = ["乙", "", "", "", "", "", "", "", "", "", "", "", "", "b1"].join(",");
        std::fs::write(&csv, format!("{HEADER}{first}\n{second}\n")).expect("write csv");
        assert!(matches!(import(&shelf.library, &csv), Err(AppError::Parse(_))));

        let bad = ["甲", "", "", "", "", "", "", "", "", "120", "", "", "", "b1"].join(",");
        std::fs::write(&csv, format!("{HEADER}{bad}\n")).expect("write csv");
        assert!(matches!(import(&shelf.library, &csv), Err(AppError::Parse(_))));

        let book = shelf.library.with(|conn| repository::get(conn, "b1")).unwrap().unwrap();
        assert_eq!(book.title, "甲", "解析失败不该留下半笔写入");
    }
}
