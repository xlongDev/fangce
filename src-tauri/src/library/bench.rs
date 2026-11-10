//! Repeatable release benchmarks, kept behind `#[ignore]` so they never run in
//! the ordinary gate:
//!
//! ```text
//! cargo test --release --manifest-path src-tauri/Cargo.toml bench -- --ignored --nocapture
//! ```
//!
//! Numbers land in README. The workload mirrors the reference book used since
//! Phase 5: 600 chapters / ~828k Chinese characters, i.e. a long web novel.

#![cfg(test)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::chapters;
use super::import;
use super::rag;
use super::search;
use crate::db::{Layout, Library};
use crate::document::fixture::temp_dir;

const CHAPTERS: usize = 600;
const PARAS_PER_CHAPTER: usize = 28;

/// Builds the reference TXT: `第N章` markers drive the chapter splitter.
fn write_reference_txt(dir: &std::path::Path) -> PathBuf {
    let mut text = String::with_capacity(900_000);
    for chapter in 1..=CHAPTERS {
        text.push_str(&format!("第{chapter}章 风起第{chapter}回\n"));
        for para in 0..PARAS_PER_CHAPTER {
            text.push_str(&format!(
                "段落{para}：山雨欲来，江湖夜雨十年灯，桃李春风一杯酒。\
                 少年握紧手中剑，望向远方沉沉的暮色，胸中块垒化作一声长啸。\n"
            ));
        }
    }
    let path = dir.join("bench-book.txt");
    std::fs::write(&path, text).expect("write bench txt");
    path
}

struct Bench {
    dir: PathBuf,
}

impl Bench {
    fn new(tag: &str) -> Self {
        let dir = temp_dir(tag);
        Self { dir }
    }
}

impl Drop for Bench {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

fn ms(elapsed: Duration) -> f64 {
    elapsed.as_secs_f64() * 1000.0
}

#[test]
#[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
fn large_book_pipeline_bench() -> Result<(), Box<dyn std::error::Error>> {
    let bench = Bench::new("bench-pipeline");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");

    let source = write_reference_txt(&bench.dir);
    let bytes = std::fs::metadata(&source).expect("stat").len();
    println!("\nreference book: {CHAPTERS} chapters, {bytes} bytes");

    let started = Instant::now();
    let outcomes =
        import::import_files(&library, &layout, std::slice::from_ref(&source), None, &|_, _, _| {});
    let import_ms = ms(started.elapsed());
    let book_id = match &outcomes[0] {
        import::ImportOutcome::Imported { id, .. } => id.clone(),
        other => panic!("期望导入成功，实际 {other:?}"),
    };

    // The chapters are in the table by now; measure a warm query and a
    // cold-ish one (different needle) over the whole library. This is the
    // scan `search::query` runs, so the number is what a keystroke costs.
    let warmed = (0..20)
        .map(|i| {
            let started = Instant::now();
            let hits = library
                .with(|conn| {
                    search::query(conn, if i % 2 == 0 { "江湖夜雨" } else { "十年灯" }, None, 50)
                })
                .expect("search");
            assert!(!hits.is_empty());
            ms(started.elapsed())
        })
        .sum::<f64>()
        / 20.0;

    // Chapter list is what the reader TOC loads on every book open.
    let toc_ms = {
        let started = Instant::now();
        let meta = chapters::ensure(&library, &book_id).expect("chapters");
        assert_eq!(meta.len(), CHAPTERS);
        ms(started.elapsed())
    };

    println!("import (split + FTS index): {import_ms:.1} ms");
    println!("search query avg (20 runs): {warmed:.2} ms");
    println!("toc chapter list:           {toc_ms:.1} ms");
    Ok(())
}

/// 400 pages is enough for the per-page decode to dominate; the ratio, not the
/// absolute number, is the thing this pins.
const PDF_PAGES: usize = 400;

/// The reference PDF. Latin text on purpose: the fixture's font has no
/// ToUnicode map, so a CJK literal would come back as noise and make the
/// "text is non-empty" assertion meaningless.
fn write_reference_pdf(dir: &std::path::Path) -> PathBuf {
    let pages: Vec<String> = (1..=PDF_PAGES)
        .map(|page| {
            format!("Page {page}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.")
        })
        .collect();
    let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
    crate::document::fixture::write_pdf(dir, "bench-book.pdf", &refs, Some("Bench PDF"))
}

/// What deferring a PDF's text extraction actually buys.
///
/// The two numbers are the point: `import` is what the shelf waits for, and it
/// is the page index only. `backfill` is the per-page decode, and it happens
/// after the import has already answered.
///
/// ⚠️ The ratio here understates the real one badly, and the fixture is why:
/// it is hand-built with one font and no ToUnicode map, so the decode is nearly
/// free. On a real 756-page / 21 MB file the split was 974 ms of 2.1 s — 98% of
/// the import. Read this bench for the shape, not the magnitude.
#[test]
#[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
fn pdf_import_bench() -> Result<(), Box<dyn std::error::Error>> {
    let bench = Bench::new("bench-pdf");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");

    let source = write_reference_pdf(&bench.dir);
    println!("\nreference pdf: {PDF_PAGES} pages");

    let started = Instant::now();
    let outcomes =
        import::import_files(&library, &layout, std::slice::from_ref(&source), None, &|_, _, _| {});
    let import_ms = ms(started.elapsed());
    let book_id = match &outcomes[0] {
        import::ImportOutcome::Imported { id, .. } => id.clone(),
        other => panic!("期望导入成功，实际 {other:?}"),
    };

    // The import owes the text, and says so; this is the assertion that would
    // fail if the deferral silently turned into a loss.
    let index = library.with(|conn| chapters::list(conn, &book_id))?;
    assert_eq!(index.len(), PDF_PAGES, "导入必须落好页索引");
    assert!(index.iter().all(|chapter| chapter.chars == 0), "导入不得抽正文");

    // What the reader pays on a first open: the TOC of a book whose text is
    // still owed. It has to be the index read and nothing more — routing the
    // backfill through here once put a whole decode in front of "正在打开…".
    let started = Instant::now();
    let meta = chapters::ensure(&library, &book_id).expect("chapters");
    let toc_ms = ms(started.elapsed());
    assert_eq!(meta.len(), PDF_PAGES);
    assert!(meta.iter().all(|chapter| chapter.chars == 0), "读目录不许顺手补正文");

    let started = Instant::now();
    chapters::backfill(&library, &book_id).expect("backfill");
    let backfill_ms = ms(started.elapsed());

    let meta = chapters::ensure(&library, &book_id).expect("chapters");
    assert_eq!(meta.len(), PDF_PAGES);
    assert!(meta.iter().all(|chapter| chapter.chars > 0), "正文必须补齐");

    println!("import (page index only):  {import_ms:.1} ms");
    println!("toc (first open, owes text): {toc_ms:.1} ms");
    println!("backfill (text, deferred): {backfill_ms:.1} ms");
    Ok(())
}

/// Vector width of the shipped embedding models (`text-embedding-3-small`).
const DIMS: usize = 768;

/// Chunks in this bench. The reference book above is ~3 400; 50 000 is roughly
/// 50 long books, which is the point: the brute-force scan is linear in this
/// number, and the design is only right while linear is fast enough.
const RAG_CHUNKS: usize = 50_000;

/// A Top-6 semantic query over the whole library, and the threshold above which
/// the brute-force scan stops being the right answer.
///
/// `rag::search` is O(N × DIMS) with a BLOB deserialised per chunk, and the
/// architecture deliberately says that stays until a number proves otherwise.
/// This bench *is* that number: it prints the median and the P95, so the day the
/// P95 crosses [`RAG_ANN_P95_MS`] the decision is made by a measurement instead
/// of by an intuition. Until then, this is the evidence for leaving it alone.
#[test]
#[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
fn rag_search_bench() -> Result<(), Box<dyn std::error::Error>> {
    /// The line above which a full scan stops being imperceptible. Sized to the
    /// interaction it sits behind: a reader waiting for six passages while
    /// typing a question.
    const RAG_ANN_P95_MS: f64 = 100.0;

    let bench = Bench::new("bench-rag");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");
    let book_id = "bench-book";
    library
        .with(|conn| {
            Ok(conn.execute(
                "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                 file_size, added_at, updated_at) \
                 VALUES (?1, '基准书', 'bench', 'txt', ?1, 'p', 1, 1, 1)",
                [book_id],
            )?)
        })
        .expect("insert book");

    // Vectors, not text: the scan's cost is the deserialise plus the dot, and a
    // fixture that skipped embedding rows would measure SQLite's row iteration
    // instead. A deterministic pseudo-random fill is enough — this is a timing
    // bench, not a relevance one.
    library.with_tx(|tx| {
        let mut stmt = tx.prepare(
            "INSERT INTO chunks (book_id, chapter_idx, start_char, end_char, text, embedding, \
             model, dims, updated_at) VALUES (?1, ?2, 0, 10, 'x', ?3, 'bench', ?4, 1)",
        )?;
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        for i in 0..RAG_CHUNKS {
            let mut vector: Vec<f32> = (0..DIMS)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    ((seed >> 33) as f32 / u32::MAX as f32) * 2.0 - 1.0
                })
                .collect();
            crate::ai::embeddings::normalize(&mut vector).expect("normalize");
            stmt.execute(rusqlite::params![
                book_id,
                (i % 600) as i64,
                crate::ai::embeddings::to_bytes(&vector),
                DIMS as i64
            ])?;
        }
        Ok(())
    })?;

    let mut query: Vec<f32> = (0..DIMS).map(|i| if i % 7 == 0 { 0.5 } else { -0.25 }).collect();
    crate::ai::embeddings::normalize(&mut query).expect("normalize");

    // 20 runs: the median is the number, the P95 is the guard, and both come
    // from the same runs rather than from one lucky call.
    let mut samples: Vec<f64> = (0..20)
        .map(|_| {
            let started = Instant::now();
            let hits = library
                .with(|conn| rag::search(conn, "bench", &query, None, None, 6))
                .expect("rag search");
            assert_eq!(hits.len(), 6);
            ms(started.elapsed())
        })
        .collect();
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = samples[samples.len() / 2];
    let p95 = samples[samples.len() * 95 / 100];

    println!("\nrag: {RAG_CHUNKS} chunks × {DIMS} dims");
    println!("top-6 scan median (20 runs): {median:.2} ms");
    println!("top-6 scan P95:              {p95:.2} ms");
    if p95 > RAG_ANN_P95_MS {
        println!("↑ P95 越过 {RAG_ANN_P95_MS} ms：暴力扫描不再是对的形状，该量一次 ANN 了");
    } else {
        println!("(P95 仍在 {RAG_ANN_P95_MS} ms 以下，暴力扫描是对的形状 —— 别动它)");
    }
    Ok(())
}

/// Import and delete, on real books instead of fixtures.
///
/// The fixtures above are a few KB; the shelf this app actually holds is books
/// of a megabyte and more, and the difference is not proportional — it is the
/// whole point. Set the paths and run it:
///
/// ```text
/// FANGCE_BENCH_BOOKS="/path/a.epub:/path/b.epub" \
///   cargo test --release --manifest-path src-tauri/Cargo.toml bench -- --ignored --nocapture real_book
/// ```
///
/// Skips (rather than fails) without the variable: the repository has no real
/// book in it, and a bench that needs one should say so instead of pretending.
#[test]
#[ignore = "benchmark: 需要 FANGCE_BENCH_BOOKS 指向真实书"]
fn real_books_import_and_delete_bench() -> Result<(), Box<dyn std::error::Error>> {
    let Ok(list) = std::env::var("FANGCE_BENCH_BOOKS") else {
        println!("\n跳过：未设置 FANGCE_BENCH_BOOKS（冒号分隔的真实书路径）");
        return Ok(());
    };
    let sources: Vec<PathBuf> =
        list.split(':').filter(|path| !path.is_empty()).map(PathBuf::from).collect();
    if sources.is_empty() {
        println!("\n跳过：FANGCE_BENCH_BOOKS 是空的");
        return Ok(());
    }

    let bench = Bench::new("bench-real");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");

    println!("\nreal books: {}", sources.len());
    let started = Instant::now();
    let outcomes = import::import_files(&library, &layout, &sources, None, &|_, _, _| {});
    let import_ms = ms(started.elapsed());
    let mut chars = 0_usize;
    for outcome in &outcomes {
        match outcome {
            import::ImportOutcome::Imported { id, .. } => {
                chars += library
                    .with(|conn| chapters::list(conn, id))
                    .expect("chapters")
                    .iter()
                    .map(|chapter| chapter.chars)
                    .sum::<usize>();
            }
            other => panic!("期望导入成功，实际 {other:?}"),
        }
    }

    let ids: Vec<String> = library
        .with(|conn| crate::library::repository::list(conn, &Default::default()))
        .expect("list")
        .into_iter()
        .map(|book| book.id)
        .collect();
    let started = Instant::now();
    crate::library::delete_books(&library, &ids, &mut |_, _, _| {}).expect("delete");
    let delete_ms = ms(started.elapsed());

    let db_bytes = std::fs::metadata(layout.data_dir.join(crate::db::DB_FILE)).expect("stat").len();
    println!("import total: {import_ms:.0} ms  ({:.0} ms/book)", import_ms / sources.len() as f64);
    println!("  chapter text: {chars} chars ({:.2} M)", chars as f64 / 1e6);
    println!("delete total: {delete_ms:.0} ms");
    println!("database: {:.0} MB", db_bytes as f64 / 1e6);
    Ok(())
}

/// What the shelf query costs as a library grows, and what a page costs instead.
///
/// The renderer asks for the whole shelf on every filter change — its grid is
/// windowed over the full array, so that is the shape it needs — but the tool
/// server used to do the same and then slice in memory. On a real 985-book
/// library that is roughly a megabyte of JSON, serialised, to answer "which
/// three books". This measures both ends and the payload between them.
#[test]
#[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
fn shelf_query_bench() -> Result<(), Box<dyn std::error::Error>> {
    use crate::library::repository::{self, BookQuery};

    const BOOKS: usize = 5000;
    let bench = Bench::new("bench-shelf");
    let layout = Layout::create(bench.dir.join("data")).expect("layout");
    let library = Library::open(&layout.data_dir).expect("open library");

    let seeded = Instant::now();
    library
        .with_tx(|tx| {
            // 97 authors shared across the shelf: `authors.name` is unique, and
            // a real library has far fewer authors than books anyway.
            for index in 0..97 {
                tx.execute(
                    "INSERT INTO authors (id, name, sort_name) VALUES (?1, ?2, ?2)",
                    rusqlite::params![format!("a{index}"), format!("作者 {index}")],
                )?;
            }
            for index in 0..BOOKS {
                tx.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, file_path, \
                 file_size, added_at, updated_at, language) \
                 VALUES (?1, ?2, ?2, 'epub', ?3, 'p', 1024, ?4, ?4, 'zh')",
                    rusqlite::params![
                        format!("b{index:05}"),
                        format!("书 {index}"),
                        format!("hash{index}"),
                        index as i64
                    ],
                )?;
                tx.execute(
                    "INSERT INTO book_authors (book_id, author_id, position) VALUES (?1, ?2, 0)",
                    rusqlite::params![format!("b{index:05}"), format!("a{}", index % 97)],
                )?;
            }
            Ok(())
        })
        .expect("seed");
    println!("\n{BOOKS} books seeded in {:.0} ms", ms(seeded.elapsed()));

    let full =
        library.with(|conn| repository::list(conn, &BookQuery::default())).expect("full list");
    let full_ms = {
        let started = Instant::now();
        for _ in 0..5 {
            let books =
                library.with(|conn| repository::list(conn, &BookQuery::default())).expect("list");
            assert_eq!(books.len(), BOOKS);
        }
        ms(started.elapsed()) / 5.0
    };
    let full_bytes = serde_json::to_vec(&full).expect("serialise").len();

    let page_ms = {
        let query = BookQuery { limit: Some(20), ..BookQuery::default() };
        let started = Instant::now();
        for _ in 0..20 {
            let books = library.with(|conn| repository::list(conn, &query)).expect("page");
            assert_eq!(books.len(), 20);
        }
        ms(started.elapsed()) / 20.0
    };
    let count_ms = {
        let query = BookQuery::default();
        let started = Instant::now();
        for _ in 0..20 {
            assert_eq!(library.with(|conn| repository::count(conn, &query)).expect("count"), BOOKS);
        }
        ms(started.elapsed()) / 20.0
    };

    println!(
        "full shelf  ({BOOKS} rows): {full_ms:.1} ms, {:.2} MB of JSON",
        full_bytes as f64 / 1e6
    );
    println!("page of 20:                {page_ms:.2} ms");
    println!("count:                     {count_ms:.2} ms");
    Ok(())
}
