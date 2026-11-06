//! EPUB metadata: container → OPF → metadata / manifest.
//!
//! Deliberately hand rolled on top of `quick-xml` instead of pulling in an EPUB
//! crate: we need namespace-agnostic tag matching, a single forward pass over a
//! small document and full control over how much of the archive we read.

use std::io::Read;
use std::path::Path;

use quick_xml::escape::unescape;
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::reader::Reader;
use zip::ZipArchive;

use super::html::{self, attribute, chapter_from_blocks};
use super::{
    BookMetadata, CoverImage, LINK_FIELD_SEPARATOR, LINK_PARAGRAPH_PREFIX, RawChapter, resolve_href,
};
use crate::error::{AppError, AppResult};

const CONTAINER_ENTRY: &str = "META-INF/container.xml";

/// Refuse to buffer more than this for an OPF document. Real ones are a few KB.
const MAX_OPF_BYTES: u64 = 8 * 1024 * 1024;

/// Refuse to buffer more than this for a cover image.
const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;

/// Refuse to buffer more than this for a single spine document. Real chapters
/// are a few dozen KB; this only guards against a pathological archive.
const MAX_CHAPTER_BYTES: u64 = 8 * 1024 * 1024;

/// Opens the container, resolves the OPF entry and parses it.
///
/// Returns the archive, the parsed OPF, and the directory the OPF lives in —
/// the base every href inside it resolves against. Both entry points need
/// exactly this preamble, so the container and OPF rules only change here.
fn open_opf(path: &Path) -> AppResult<(ZipArchive<std::fs::File>, OpfDocument, String)> {
    let file = std::fs::File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|err| AppError::Parse(format!("无法打开 EPUB 容器：{err}")))?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf_bytes = read_entry(&mut archive, &opf_path, MAX_OPF_BYTES)?;
    let opf_xml = String::from_utf8_lossy(&opf_bytes).into_owned();
    let document = OpfDocument::parse(&opf_xml)?;

    let base_dir = opf_path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
    Ok((archive, document, base_dir))
}

/// Reads metadata and cover from an EPUB without touching the spine content.
pub fn read_metadata(path: &Path) -> AppResult<BookMetadata> {
    let (mut archive, document, base_dir) = open_opf(path)?;

    let mut metadata = document.metadata;
    metadata.cover = document.cover_href.as_deref().and_then(|href| {
        let entry = resolve_href(&base_dir, href);
        read_entry(&mut archive, &entry, MAX_COVER_BYTES)
            .ok()
            .map(|bytes| CoverImage { extension: extension_of(&entry), bytes })
    });

    Ok(metadata)
}

/// Extracts chapters by walking the spine, turning each XHTML document into
/// plain-text paragraphs. The first heading inside a document becomes its
/// title; otherwise the chapter is numbered.
pub fn read_chapters(path: &Path) -> AppResult<Vec<RawChapter>> {
    let (mut archive, document, base_dir) = open_opf(path)?;

    let mut chapters = Vec::new();
    // Spine entry path → chapter index, for rewriting in-book link targets.
    let mut entry_index: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

    for idref in &document.spine {
        let Some(item) = document.manifest.iter().find(|item| &item.id == idref) else {
            continue;
        };
        if !is_html_media_type(&item.media_type) {
            continue;
        }
        let entry = resolve_href(&base_dir, &item.href);
        let bytes = match read_entry(&mut archive, &entry, MAX_CHAPTER_BYTES) {
            Ok(bytes) => bytes,
            Err(err) => {
                tracing::warn!(entry, error = %err, "读取章节内容失败，已跳过");
                continue;
            }
        };
        let html = String::from_utf8_lossy(&bytes).into_owned();
        let chapter_dir = entry.rsplit_once('/').map_or("", |(dir, _)| dir);
        let mut chapter = chapter_from_blocks(html::parse_html(&html, chapter_dir));
        // A spine document with no readable prose (a pure-SVG cover that
        // failed to resolve, an empty shell) would render as a blank page;
        // drop it instead of numbering the void.
        if chapter.paragraphs.is_empty() {
            continue;
        }
        if chapter.title.is_none() {
            chapter.title = Some(super::untitled_section(chapters.len() + 1));
        }
        entry_index.insert(entry, chapters.len());
        chapters.push(chapter);
    }

    // In-book links point at spine entry paths; now that every chapter has an
    // index, rewrite the targets. Anything unresolvable degrades to its text.
    for chapter in &mut chapters {
        for paragraph in &mut chapter.paragraphs {
            if let Some(payload) = paragraph.strip_prefix(LINK_PARAGRAPH_PREFIX)
                && let Some((target, text)) = payload.split_once(LINK_FIELD_SEPARATOR)
                && let Some(idx) = entry_index.get(target)
            {
                *paragraph = format!("{LINK_PARAGRAPH_PREFIX}{idx}{LINK_FIELD_SEPARATOR}{text}");
            } else if paragraph.starts_with(LINK_PARAGRAPH_PREFIX) {
                *paragraph = paragraph
                    .split_once(LINK_FIELD_SEPARATOR)
                    .map_or(String::new(), |(_, text)| text.to_string());
            }
        }
    }

    if chapters.is_empty() {
        return Err(AppError::Parse("EPUB spine 中没有可读的文本章节".into()));
    }
    Ok(chapters)
}

/// Returns the OPF path declared by `META-INF/container.xml`.
fn find_opf_path(archive: &mut ZipArchive<std::fs::File>) -> AppResult<String> {
    let bytes = read_entry(archive, CONTAINER_ENTRY, MAX_OPF_BYTES)?;
    let xml = String::from_utf8_lossy(&bytes).into_owned();
    let mut reader = Reader::from_str(&xml);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(element)) | Ok(Event::Start(element)) => {
                if element.name().local_name().as_ref() == "rootfile" {
                    let path = attribute(&element, "full-path");
                    if !path.is_empty() {
                        return Ok(path);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                return Err(AppError::Parse(format!("container.xml 解析失败：{err}")));
            }
            _ => {}
        }
        buf.clear();
    }

    Err(AppError::Parse("container.xml 中没有可定位的 rootfile".into()))
}

/// Reads one zip entry into memory, capped at `limit` bytes.
fn read_entry(
    archive: &mut ZipArchive<std::fs::File>,
    name: &str,
    limit: u64,
) -> AppResult<Vec<u8>> {
    let entry =
        archive.by_name(name).map_err(|_| AppError::Parse(format!("EPUB 缺少条目：{name}")))?;
    let mut limited = entry.take(limit);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn extension_of(path: &str) -> String {
    Path::new(path).extension().and_then(|ext| ext.to_str()).unwrap_or("png").to_ascii_lowercase()
}

/// What the current text run belongs to.
#[derive(Clone, Copy)]
enum Kind {
    Title,
    Creator,
    Language,
    Identifier,
    Publisher,
    Description,
    Subtitle,
}

impl Kind {
    /// Local tag name that opens this field, matched without the namespace.
    fn from_tag(tag: &str) -> Option<Self> {
        match tag {
            "title" => Some(Kind::Title),
            "creator" => Some(Kind::Creator),
            "language" => Some(Kind::Language),
            "identifier" => Some(Kind::Identifier),
            "publisher" => Some(Kind::Publisher),
            "description" => Some(Kind::Description),
            "subtitle" => Some(Kind::Subtitle),
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

/// Streaming OPF reader. Holds only metadata plus the manifest.
#[derive(Default)]
struct OpfParser {
    in_metadata: bool,
    in_manifest: bool,
    field: Option<Kind>,
    /// Tag that will close the current field; `meta` for EPUB3 subtitles.
    field_tag: String,
    text: String,
    metadata: BookMetadata,
    cover_id: Option<String>,
    manifest: Vec<ManifestItem>,
    /// Spine order as `idref` values, in reading order.
    spine: Vec<String>,
}

impl OpfParser {
    fn on_start(&mut self, element: &BytesStart<'_>) -> AppResult<()> {
        let tag = element.name().local_name().as_ref().to_string();
        let tag = tag.as_str();

        if tag == "metadata" {
            self.in_metadata = true;
        } else if tag == "manifest" {
            self.in_manifest = true;
        } else if tag == "item" && self.in_manifest {
            self.manifest.push(manifest_item(element));
        } else if tag == "itemref" {
            let idref = attribute(element, "idref");
            if !idref.is_empty() {
                self.spine.push(idref);
            }
        } else if tag == "meta" && self.in_metadata {
            self.on_meta(element);
        } else if let Some(kind) = Kind::from_tag(tag)
            && self.in_metadata
        {
            self.field = Some(kind);
            self.field_tag = tag.to_string();
            self.text.clear();
        }
        Ok(())
    }

    /// EPUB2 stores the cover as `<meta name="cover" content="<manifest id>">`;
    /// EPUB3 uses `<meta property="dcterms:alternative">` for the subtitle.
    fn on_meta(&mut self, element: &BytesStart<'_>) {
        let name = attribute(element, "name");
        let property = attribute(element, "property");
        let content = attribute(element, "content");

        if name.eq_ignore_ascii_case("cover") && !content.is_empty() {
            self.cover_id = Some(content);
        } else if property == "dcterms:alternative" && self.metadata.subtitle.is_none() {
            self.field = Some(Kind::Subtitle);
            self.field_tag = "meta".to_string();
            self.text.clear();
        }
    }

    fn on_text(&mut self, text: &str) {
        if self.field.is_some() {
            self.text.push_str(text);
        }
    }

    fn on_end(&mut self, element: &BytesEnd<'_>) {
        let tag = element.name().local_name().as_ref().to_string();
        let tag = tag.as_str();

        match tag {
            "metadata" => self.in_metadata = false,
            "manifest" => self.in_manifest = false,
            _ => {}
        }
        if self.field.is_some() && tag == self.field_tag {
            self.flush();
        }
    }

    /// Commits the buffered text to whichever field is open.
    fn flush(&mut self) {
        let Some(kind) = self.field.take() else { return };
        let text = self.text.trim().to_string();
        self.text.clear();
        if text.is_empty() {
            return;
        }
        match kind {
            Kind::Title => {
                if self.metadata.title.is_empty() {
                    self.metadata.title = text;
                }
            }
            Kind::Creator => self.metadata.authors.push(text),
            Kind::Language => self.metadata.language = Some(text),
            Kind::Identifier => self.metadata.identifier = Some(text),
            Kind::Publisher => self.metadata.publisher = Some(text),
            Kind::Description => self.metadata.description = Some(text),
            Kind::Subtitle => self.metadata.subtitle = Some(text),
        }
    }

    fn cover_href(&self) -> Option<String> {
        // 1. EPUB2: the manifest id referenced by <meta name="cover">.
        if let Some(id) = &self.cover_id {
            let found = self.manifest.iter().find(|item| item.id == *id && !item.href.is_empty());
            if let Some(item) = found {
                return Some(item.href.clone());
            }
        }
        // 2. EPUB3: an item carrying the cover-image property.
        let by_property = self.manifest.iter().find(|item| {
            !item.href.is_empty()
                && item.properties.split_whitespace().any(|token| token == "cover-image")
        });
        if let Some(item) = by_property {
            return Some(item.href.clone());
        }
        // 3. Last resort: an image whose file name mentions a cover.
        self.manifest
            .iter()
            .find(|item| {
                item.media_type.starts_with("image/")
                    && item
                        .href
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .to_ascii_lowercase()
                        .contains("cover")
            })
            .map(|item| item.href.clone())
    }
}

/// Metadata plus the resolved cover location, before the image is read.
#[derive(Debug)]
struct OpfDocument {
    metadata: BookMetadata,
    cover_href: Option<String>,
    manifest: Vec<ManifestItem>,
    spine: Vec<String>,
}

impl OpfDocument {
    fn parse(xml: &str) -> AppResult<Self> {
        let mut reader = Reader::from_str(xml);
        let mut parser = OpfParser::default();
        let mut buf = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(element)) => parser.on_start(&element)?,
                // A self-closing element opens and closes in one event.
                Ok(Event::Empty(element)) => {
                    parser.on_start(&element)?;
                    let end = element.to_end();
                    parser.on_end(&end);
                }
                Ok(Event::End(element)) => parser.on_end(&element),
                Ok(Event::Text(element)) => {
                    if let Ok(text) = unescape(&element) {
                        parser.on_text(&text);
                    }
                }
                Ok(Event::Eof) => break,
                Err(err) => return Err(AppError::Parse(format!("OPF 解析失败：{err}"))),
                _ => {}
            }
            buf.clear();
        }

        parser.flush();
        let cover_href = parser.cover_href();
        Ok(Self {
            metadata: parser.metadata,
            cover_href,
            manifest: parser.manifest,
            spine: parser.spine,
        })
    }
}

fn manifest_item(element: &BytesStart<'_>) -> ManifestItem {
    let mut item = ManifestItem::default();
    for attr in element.attributes().flatten() {
        let value = unescape(&attr.value).unwrap_or_default().trim().to_string();
        match attr.key.local_name().as_ref() {
            "id" => item.id = value,
            "href" => item.href = value,
            "media-type" => item.media_type = value,
            "properties" => item.properties = value,
            _ => {}
        }
    }
    item
}

fn is_html_media_type(media_type: &str) -> bool {
    media_type == "application/xhtml+xml" || media_type == "text/html"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::fixture;

    const OPF: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>  Rust 程序设计语言  </dc:title>
    <dc:creator>Steve Klabnik</dc:creator>
    <dc:creator>Carol Nichols</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier>urn:isbn:9781593278281</dc:identifier>
    <dc:publisher>No Starch Press</dc:publisher>
    <dc:description>一本关于 Rust 的书。</dc:description>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>"#;

    #[test]
    fn reads_dublin_core_metadata() {
        let metadata = OpfDocument::parse(OPF).expect("parse").metadata;

        assert_eq!(metadata.title, "Rust 程序设计语言", "标题必须去掉首尾空白");
        assert_eq!(metadata.authors, ["Steve Klabnik", "Carol Nichols"]);
        assert_eq!(metadata.language.as_deref(), Some("zh-CN"));
        assert_eq!(metadata.publisher.as_deref(), Some("No Starch Press"));
        assert_eq!(metadata.identifier.as_deref(), Some("urn:isbn:9781593278281"));
        assert_eq!(metadata.description.as_deref(), Some("一本关于 Rust 的书。"));
    }

    #[test]
    fn cover_is_resolved_through_the_meta_reference() {
        let document = OpfDocument::parse(OPF).expect("parse");
        assert_eq!(document.cover_href.as_deref(), Some("images/cover.png"));
    }

    #[test]
    fn cover_falls_back_to_the_cover_image_property() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>T</dc:title></metadata>
  <manifest><item id="c" href="img/c.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>
</package>"#;
        assert_eq!(
            OpfDocument::parse(opf).expect("parse").cover_href.as_deref(),
            Some("img/c.jpg")
        );
    }

    #[test]
    fn cover_falls_back_to_a_cover_named_image() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>T</dc:title></metadata>
  <manifest><item id="x" href="images/Cover-Final.jpg" media-type="image/jpeg"/></manifest>
</package>"#;
        assert_eq!(
            OpfDocument::parse(opf).expect("parse").cover_href.as_deref(),
            Some("images/Cover-Final.jpg")
        );
    }

    #[test]
    fn epub3_subtitle_comes_from_dcterms_alternative() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title>主标题</dc:title>
    <meta property="dcterms:alternative">副标题</meta>
  </metadata>
</package>"#;
        let metadata = OpfDocument::parse(opf).expect("parse").metadata;
        assert_eq!(metadata.title, "主标题");
        assert_eq!(metadata.subtitle.as_deref(), Some("副标题"));
    }

    #[test]
    fn markup_inside_a_description_is_stripped_to_text() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:description><p>第一段</p><p>第二段</p></dc:description></metadata>
</package>"#;
        let metadata = OpfDocument::parse(opf).expect("parse").metadata;
        assert_eq!(metadata.description.as_deref(), Some("第一段第二段"));
    }

    #[test]
    fn a_broken_opf_reports_a_parse_error() {
        // Mismatched close tags are caught by the reader's well-formedness check.
        let err = OpfDocument::parse("<package><metadata></package>").expect_err("必须报错");
        assert!(err.to_string().starts_with("parse error:"));
    }

    #[test]
    fn end_to_end_reads_metadata_and_cover_out_of_the_zip() {
        let dir = fixture::temp_dir("epub-read");
        let path = fixture::write_epub(
            &dir,
            "book.epub",
            OPF,
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );

        let metadata = read_metadata(&path).expect("read epub");
        assert_eq!(metadata.title, "Rust 程序设计语言");
        assert_eq!(metadata.authors.len(), 2);

        let cover = metadata.cover.expect("封面必须被提取");
        assert_eq!(cover.extension, "png");
        assert_eq!(cover.bytes, fixture::png_bytes());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_container_entry_is_a_parse_error() {
        let dir = fixture::temp_dir("epub-bad");
        let path = dir.join("broken.epub");
        std::fs::write(&path, b"not a zip").expect("write");

        let err = read_metadata(&path).expect_err("必须报错");
        assert!(err.to_string().starts_with("parse error:"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn chapters_follow_the_spine_order() {
        let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>书</dc:title><dc:creator>作者</dc:creator></metadata>
  <manifest>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#;
        let dir = fixture::temp_dir("epub-chapters");
        let path = fixture::write_epub(
            &dir,
            "book.epub",
            opf,
            &[
                (
                    "OEBPS/text/c1.xhtml",
                    "<html><body><h1>甲</h1><p>正文甲</p></body></html>".as_bytes(),
                ),
                (
                    "OEBPS/text/c2.xhtml",
                    "<html><body><h1>乙</h1><p>正文乙</p></body></html>".as_bytes(),
                ),
            ],
        );

        let chapters = read_chapters(&path).expect("read chapters");
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title.as_deref(), Some("甲"));
        assert_eq!(chapters[0].paragraphs, ["甲", "正文甲"]);
        assert_eq!(chapters[1].title.as_deref(), Some("乙"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn spine_links_resolve_to_chapter_indices_and_empty_documents_vanish() {
        let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>书</dc:title></metadata>
  <manifest>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="text/toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="toc"/><itemref idref="c1"/></spine>
</package>"#;
        let dir = fixture::temp_dir("epub-links");
        let path = fixture::write_epub(
            &dir,
            "book.epub",
            opf,
            &[
                // A pure-SVG shell: yields no prose, must not become a blank page.
                (
                    "OEBPS/text/cover.xhtml",
                    r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><svg><image xlink:href="../img/c.jpg"/></svg></body></html>"#.as_bytes(),
                ),
                (
                    "OEBPS/text/toc.xhtml",
                    "<html><body><p><a href=\"c1.xhtml\">正文甲</a></p></body></html>".as_bytes(),
                ),
                (
                    "OEBPS/text/c1.xhtml",
                    "<html><body><h1>甲</h1><p>正文甲</p></body></html>".as_bytes(),
                ),
            ],
        );

        let chapters = read_chapters(&path).expect("read chapters");
        assert_eq!(chapters.len(), 3, "SVG 封面要成为图片章节");
        assert_eq!(chapters[0].paragraphs, ["\u{FFFC}OEBPS/img/c.jpg"]);
        assert_eq!(chapters[1].paragraphs, ["\u{FFFB}2\u{1F}正文甲"]);
        assert_eq!(chapters[2].paragraphs, ["甲", "正文甲"]);

        // And a genuinely empty spine document is dropped rather than
        // becoming a blank page.
        let opf = opf
            .replace(
                "<itemref idref=\"cover\"/>",
                "<itemref idref=\"void\"/>",
            )
            .replace(
                "<item id=\"toc\"",
                "<item id=\"void\" href=\"text/void.xhtml\" media-type=\"application/xhtml+xml\"/>\n    <item id=\"toc\"",
            );
        let path = fixture::write_epub(
            &dir,
            "book2.epub",
            &opf,
            &[
                ("OEBPS/text/void.xhtml", "<html><body></body></html>".as_bytes()),
                (
                    "OEBPS/text/toc.xhtml",
                    "<html><body><p><a href=\"c1.xhtml\">正文甲</a></p></body></html>".as_bytes(),
                ),
                (
                    "OEBPS/text/c1.xhtml",
                    "<html><body><h1>甲</h1><p>正文甲</p></body></html>".as_bytes(),
                ),
            ],
        );

        let chapters = read_chapters(&path).expect("read chapters");
        assert_eq!(chapters.len(), 2, "空白 spine 文档必须被丢弃");
        assert_eq!(chapters[0].paragraphs, ["\u{FFFB}1\u{1F}正文甲"]);

        std::fs::remove_dir_all(&dir).ok();
    }
}
