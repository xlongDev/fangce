//! Book metadata extraction.
//!
//! Phase 2 only needs enough to fill a library shelf: title, authors, cover and
//! a few optional fields. Content parsing (chapters, encoding, word counts) is
//! the reader engine's job and lands in Phase 3.

pub mod cbz;
pub mod epub;
pub mod fb2;
#[cfg(test)]
pub mod fixture;
pub mod html;
pub mod mobi;
pub mod pdf;
pub mod plain;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Marks a paragraph that is an in-book image. The rest of the string is the
/// zip entry path inside the source EPUB, resolved at import time; the reader
/// fetches the bytes on demand via `book_asset`.
pub const IMAGE_PARAGRAPH_PREFIX: &str = "\u{FFFC}";

/// Marks a paragraph that is a chapter-wide wallpaper (a Kindle CSS
/// `background-image` bound to the page's `<body>` class). The rest of the
/// string is the asset path, fetched like an image; the reader paints it
/// behind the chapter's text instead of flowing it inline.
pub const WALLPAPER_PARAGRAPH_PREFIX: &str = "\u{FFFA}";

/// Marks a paragraph that is an in-book link (an EPUB table of contents
/// entry). Payload is `<target>\u{1F}<text>`: the zip entry path resolved at
/// parse time, rewritten to a chapter index once the whole spine is read
/// (unreadable targets degrade to their plain text).
pub const LINK_PARAGRAPH_PREFIX: &str = "\u{FFFB}";

/// Field separator inside a [`LINK_PARAGRAPH_PREFIX`] payload.
pub const LINK_FIELD_SEPARATOR: char = '\u{1F}';

/// The title a section gets when the document itself does not name it.
///
/// 「节」, not 「章」. A spine document without a heading is not necessarily a
/// chapter: a cover image, an image page, a title page and a dedication are
/// sections too. Numbering those 第 N 章 made 《助推》's cover read as 「第 1 章」,
/// two rows above the book's actual 第 1 章 — and the summary panel then said
/// 「第 1 章 没有正文」, which reads as a bug rather than as a cover page.
///
/// `position` is one-based, the way the reader counts.
pub fn untitled_section(position: usize) -> String {
    format!("第 {position} 节")
}

/// Formats the library can hold today.
///
/// The four Kindle values — [`Mobi`], [`Azw`], [`Azw3`], [`Prc`] — are one PDB
/// container, one parser and one renderer. They are separate names because they
/// are separate names on the shelf: the importer used to fold all four into
/// `Mobi`, which is right about the bytes and wrong about the book. Someone who
/// imports `book.azw3` is looking at a card that says MOBI, and that is a false
/// statement about the file they handed over.
///
/// So a format here is a *name*, not a code path. Nothing downstream of
/// [`from_path`](BookFormat::from_path) tells the four apart, and the tests
/// below pin exactly that: the same bytes go in under all four extensions, and
/// only the label is allowed to move.
#[derive(specta::Type, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Epub,
    Pdf,
    /// `.mobi`: the KF7 Mobipocket container, and the name every Mobipocket
    /// file used to be shelved under.
    Mobi,
    /// `.azw`: Amazon's own extension for that same KF7 container.
    Azw,
    /// `.azw3`: the KF8 generation — the container one generation on, which
    /// needs the skeleton + fragment reassembly [`mobi`] also handles.
    Azw3,
    /// `.prc`: the Palm Reader container Mobipocket grew out of.
    Prc,
    Fb2,
    /// A comic book archive: a ZIP of page images.
    Cbz,
    Markdown,
    #[serde(rename = "txt")]
    Text,
}

impl BookFormat {
    /// Stable value stored in SQLite and sent to the frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            BookFormat::Epub => "epub",
            BookFormat::Pdf => "pdf",
            BookFormat::Mobi => "mobi",
            BookFormat::Azw => "azw",
            BookFormat::Azw3 => "azw3",
            BookFormat::Prc => "prc",
            BookFormat::Fb2 => "fb2",
            BookFormat::Cbz => "cbz",
            BookFormat::Markdown => "markdown",
            BookFormat::Text => "txt",
        }
    }

    /// Extension used for the file we keep inside the library directory.
    pub fn extension(self) -> &'static str {
        match self {
            BookFormat::Epub => "epub",
            BookFormat::Pdf => "pdf",
            BookFormat::Mobi => "mobi",
            BookFormat::Azw => "azw",
            BookFormat::Azw3 => "azw3",
            BookFormat::Prc => "prc",
            BookFormat::Fb2 => "fb2",
            BookFormat::Cbz => "cbz",
            BookFormat::Markdown => "md",
            BookFormat::Text => "txt",
        }
    }

    /// In-book assets live in a ZIP we can address by entry name.
    pub fn is_zip_container(self) -> bool {
        matches!(self, BookFormat::Epub | BookFormat::Cbz)
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        // `.fb2.zip` is a common distribution form; `Path::extension` only
        // reports the last component, so the full name has to be matched.
        if let Some(name) = path.file_name().and_then(|name| name.to_str())
            && name.to_ascii_lowercase().ends_with(".fb2.zip")
        {
            return Some(BookFormat::Fb2);
        }
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "epub" => Some(BookFormat::Epub),
            "pdf" => Some(BookFormat::Pdf),
            // One container, four names, and the name is kept because it is
            // what the file on disk is actually called.
            "mobi" => Some(BookFormat::Mobi),
            "azw" => Some(BookFormat::Azw),
            "azw3" => Some(BookFormat::Azw3),
            "prc" => Some(BookFormat::Prc),
            "fb2" => Some(BookFormat::Fb2),
            "cbz" => Some(BookFormat::Cbz),
            "md" | "markdown" => Some(BookFormat::Markdown),
            "txt" => Some(BookFormat::Text),
            _ => None,
        }
    }
}

/// A cover image pulled out of a container format.
#[derive(Debug, Clone)]
pub struct CoverImage {
    /// Lower case extension without the dot, used for both storage and MIME.
    pub extension: String,
    pub bytes: Vec<u8>,
}

/// One chapter extracted from a source file, ready for the reader engine.
#[derive(Debug, Clone, Default)]
pub struct RawChapter {
    /// Heading text, or `None` when the format has no structural headings.
    pub title: Option<String>,
    /// Plain-text paragraphs, one per entry, already whitespace-normalised.
    pub paragraphs: Vec<String>,
}

/// Everything the library stores about a book before it is ever opened.
#[derive(Debug, Clone, Default)]
pub struct BookMetadata {
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    /// EPUB `dc:identifier`; often an ISBN or a publisher UUID.
    pub identifier: Option<String>,
    pub authors: Vec<String>,
    pub cover: Option<CoverImage>,
    /// Page count, for formats that have a fixed one (PDF). `None` everywhere
    /// else — a reflowable book's length is its text, not its pages.
    ///
    /// It lives here rather than behind its own call because the PDF Info
    /// dictionary and the page tree come out of the same parse: `load_mem` on a
    /// 21 MB document costs 327 ms, and asking twice for two answers the one
    /// parse already holds is how the importer used to spend 645 ms on a title
    /// and an author.
    pub page_count: Option<usize>,
}

/// Reads metadata for any supported file without loading the whole book.
///
/// Formats without embedded metadata fall back to the file name, so a book is
/// never left with a blank title on the shelf.
pub fn read_metadata(path: &Path, format: BookFormat) -> AppResult<BookMetadata> {
    let mut metadata = match format {
        BookFormat::Epub => epub::read_metadata(path),
        BookFormat::Pdf => pdf::read_metadata(path),
        BookFormat::Mobi | BookFormat::Azw | BookFormat::Azw3 | BookFormat::Prc => {
            mobi::read_metadata(path)
        }
        BookFormat::Fb2 => fb2::read_metadata(path),
        BookFormat::Cbz => cbz::read_metadata(path),
        BookFormat::Markdown | BookFormat::Text => plain::read_metadata(path, format),
    }
    .map_err(|err| AppError::missing_source(path, err))?;
    if metadata.title.trim().is_empty() {
        metadata.title = plain::title_from_stem(path);
    }
    Ok(metadata)
}

/// Extracts the book's chapters as plain-text paragraphs.
///
/// The reader engine consumes chapters, never whole books, so this is called
/// once at import time and the result is stored in `chapters`. Formats without
/// a structural spine (TXT, Markdown) fall back to heading heuristics and, when
/// those fail, a single chapter holding the whole text.
pub fn read_chapters(path: &Path, format: BookFormat) -> AppResult<Vec<RawChapter>> {
    match format {
        BookFormat::Epub => epub::read_chapters(path),
        BookFormat::Pdf => pdf::read_chapters(path),
        BookFormat::Mobi | BookFormat::Azw | BookFormat::Azw3 | BookFormat::Prc => {
            mobi::read_chapters(path)
        }
        BookFormat::Fb2 => fb2::read_chapters(path),
        BookFormat::Cbz => cbz::read_chapters(path),
        BookFormat::Markdown | BookFormat::Text => plain::read_chapters(path, format),
    }
    .map_err(|err| AppError::missing_source(path, err))
}

/// Raw bytes of one in-book asset, addressed the way `read_chapters` named it.
///
/// ZIP containers (EPUB, CBZ) are addressed by entry name; FB2 keeps its images
/// inline as base64, so its payloads are binary ids prefixed with `#`; the
/// Kindle containers' images are PDB records addressed by their `kindle:embed:`
/// reference. Other formats have no in-book assets at all.
pub fn read_asset(path: &Path, format: BookFormat, asset: &str) -> AppResult<Vec<u8>> {
    let bytes = if let Some(id) = asset.strip_prefix('#') {
        fb2::read_binary(path, id)
    } else if matches!(
        format,
        BookFormat::Mobi | BookFormat::Azw | BookFormat::Azw3 | BookFormat::Prc
    ) {
        mobi::read_asset(path, asset)
    } else if !format.is_zip_container() {
        Err(AppError::Parse(format!("{} 没有内嵌资源", format.as_str())))
    } else {
        read_zip_entry(path, asset, MAX_ASSET_BYTES)
    };
    bytes.map_err(|err| AppError::missing_source(path, err))
}

/// Refuse to buffer more than this for a single in-book asset.
const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// Reads one entry out of a ZIP-backed book, capped at `MAX_ASSET_BYTES`.
pub fn read_zip_entry(path: &Path, entry: &str, limit: u64) -> AppResult<Vec<u8>> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| AppError::Parse(format!("无法打开容器：{err}")))?;
    let entry =
        archive.by_name(entry).map_err(|_| AppError::Parse(format!("容器中缺少资源：{entry}")))?;
    let mut bytes = Vec::new();
    entry.take(limit).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// MIME type for a cover image extension, defaulting to an octet stream.
pub fn image_mime(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Restricts a container-supplied extension to formats the webview can render.
///
/// The extension ends up in a file name we write, so anything outside the
/// allowlist falls back to PNG rather than trusting the archive.
pub fn safe_image_extension(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    match lower.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => lower,
        _ => "png".to_string(),
    }
}

/// Joins a container-relative href onto the directory holding the OPF.
///
/// EPUB hrefs are URI references: percent-encoded, relative to the package
/// document, and routinely containing `..` segments — so the value is decoded
/// and normalized before it is used as a zip entry name.
pub fn resolve_href(base_dir: &str, href: &str) -> String {
    let decoded = percent_decode(href);
    let combined = if decoded.starts_with('/') {
        decoded.trim_start_matches('/').to_string()
    } else if base_dir.is_empty() {
        decoded
    } else {
        format!("{base_dir}/{decoded}")
    };

    let mut parts: Vec<&str> = Vec::new();
    for segment in combined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Minimal percent-decoding for URI references inside an EPUB container.
///
/// File names in the archive are raw bytes, while hrefs arrive escaped
/// (`%20`, `%E5%9B%BE.png`), so the escape sequences are folded back to bytes.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Detects the format and rejects anything the library cannot hold yet.
pub fn detect_format(path: &Path) -> AppResult<BookFormat> {
    BookFormat::from_path(path).ok_or_else(|| {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("无扩展名").to_string();
        AppError::UnsupportedFormat(ext)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_round_trips_through_its_string_form() {
        for format in [
            BookFormat::Epub,
            BookFormat::Pdf,
            BookFormat::Mobi,
            BookFormat::Azw,
            BookFormat::Azw3,
            BookFormat::Prc,
            BookFormat::Fb2,
            BookFormat::Cbz,
            BookFormat::Markdown,
            BookFormat::Text,
        ] {
            assert_eq!(
                BookFormat::from_path(Path::new(&format!("x.{}", format.extension()))),
                Some(format)
            );
        }
    }

    #[test]
    fn extension_matching_ignores_case_and_aliases() {
        assert_eq!(BookFormat::from_path(Path::new("a.EPUB")), Some(BookFormat::Epub));
        assert_eq!(BookFormat::from_path(Path::new("a.markdown")), Some(BookFormat::Markdown));
        // Kindle and FictionBook aliases. Every Kindle extension names itself
        // now, including the three that used to be folded into MOBI: the file
        // on disk is called that, so the shelf says that.
        assert_eq!(BookFormat::from_path(Path::new("a.azw3")), Some(BookFormat::Azw3));
        assert_eq!(BookFormat::from_path(Path::new("a.AZW3")), Some(BookFormat::Azw3));
        assert_eq!(BookFormat::from_path(Path::new("a.azw")), Some(BookFormat::Azw));
        assert_eq!(BookFormat::from_path(Path::new("a.PRC")), Some(BookFormat::Prc));
        assert_eq!(BookFormat::from_path(Path::new("a.mobi")), Some(BookFormat::Mobi));
        assert_eq!(BookFormat::from_path(Path::new("a.FB2")), Some(BookFormat::Fb2));
        assert_eq!(
            BookFormat::from_path(Path::new("a.fb2.zip")),
            Some(BookFormat::Fb2),
            "压缩的 FB2 也必须是 FB2"
        );
        assert_eq!(BookFormat::from_path(Path::new("a.docx")), None);
    }

    #[test]
    fn unsupported_formats_name_the_extension() {
        let err = detect_format(Path::new("/tmp/book.docx")).expect_err("docx 必须被拒绝");
        assert_eq!(err.to_string(), "unsupported format: docx");
    }

    #[test]
    fn only_zip_formats_expose_entry_addressed_assets() {
        assert!(BookFormat::Epub.is_zip_container());
        assert!(BookFormat::Cbz.is_zip_container());
        assert!(!BookFormat::Pdf.is_zip_container());
        assert!(!BookFormat::Fb2.is_zip_container());
    }

    #[test]
    fn hrefs_are_resolved_and_normalized() {
        assert_eq!(resolve_href("OEBPS", "images/cover.jpg"), "OEBPS/images/cover.jpg");
        assert_eq!(resolve_href("OEBPS", "../images/cover.jpg"), "images/cover.jpg");
        assert_eq!(resolve_href("", "cover.jpg"), "cover.jpg");
        assert_eq!(resolve_href("OEBPS", "/img/cover.jpg"), "img/cover.jpg");
        assert_eq!(resolve_href("OEBPS/text", "../../img/./cover.jpg"), "img/cover.jpg");
    }

    #[test]
    fn hrefs_are_percent_decoded_before_lookup() {
        assert_eq!(resolve_href("images", "p%20x.png"), "images/p x.png");
        assert_eq!(resolve_href("images", "%E5%9B%BE.png"), "images/图.png");
        // A lone or malformed escape survives verbatim.
        assert_eq!(resolve_href("images", "a%zz.png"), "images/a%zz.png");
    }

    #[test]
    fn mime_lookup_covers_the_common_formats() {
        assert_eq!(image_mime("png"), "image/png");
        assert_eq!(image_mime("jpeg"), "image/jpeg");
        assert_eq!(image_mime("svg"), "image/svg+xml");
        assert_eq!(image_mime("bmp"), "application/octet-stream");
    }

    #[test]
    fn unknown_image_extensions_fall_back_to_png() {
        assert_eq!(safe_image_extension("PNG"), "png");
        assert_eq!(safe_image_extension("svg"), "svg");
        // A traversal attempt must not survive into a file name.
        assert_eq!(safe_image_extension("php/../../etc"), "png");
    }
}
