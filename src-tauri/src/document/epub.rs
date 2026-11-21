//! EPUB metadata: container → OPF → metadata / manifest.
//!
//! Deliberately hand rolled on top of `quick-xml` instead of pulling in an EPUB
//! crate: we need namespace-agnostic tag matching, a single forward pass over a
//! small document and full control over how much of the archive we read.

use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;

use quick_xml::escape::{escape, unescape};
use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::reader::Reader;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

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

/// The shelf-side fields that can be written back into an EPUB's OPF.
///
/// `None` means "leave what the file already says alone" — a补全 that only
/// filled the publisher must not erase a title the file got right. `authors`
/// is a list because `dc:creator` is repeatable and a book can have more than
/// one.
#[derive(Debug, Default)]
pub struct EpubMetaPatch {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub published_year: Option<i32>,
    /// The shelf's replacement cover. When present it overwrites the book's
    /// own cover entry; a book with no cover gets a new one wired into the OPF.
    pub cover: Option<CoverImage>,
}

/// Copies an EPUB, replacing the OPF metadata with the shelf's values.
///
/// The archive is rebuilt entry by entry so every word of every chapter and
/// the `mimetype`-first layout survive byte for byte; the OPF document's
/// Dublin Core fields are rewritten and, when the shelf has a replacement
/// cover, that one image entry is overwritten. Nothing on disk is touched —
/// the caller decides where the new bytes land. That separation is what lets
/// the book export and the Kindle sender share one implementation.
pub fn write_metadata(bytes: &[u8], patch: &EpubMetaPatch) -> AppResult<Vec<u8>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let opf_path = find_opf_path(&mut archive)?;
    let opf_bytes = read_entry(&mut archive, &opf_path, MAX_OPF_BYTES)?;
    let opf_xml = String::from_utf8_lossy(&opf_bytes);
    let document = OpfDocument::parse(&opf_xml)?;
    let base_dir = opf_path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();

    // Keep the book's existing cover entry name: other parts of the OPF may
    // reference it, and replacing bytes in place leaves every href intact.
    // A book without a cover gets a fresh entry next to the OPF.
    let cover_target = patch.cover.as_ref().map(|cover| match &document.cover_href {
        Some(href) => resolve_href(&base_dir, href),
        None => join_entry(&base_dir, &format!("cover.{}", cover.extension)),
    });
    let cover_is_new = patch.cover.is_some() && document.cover_href.is_none();

    let rewritten = rewrite_opf(&opf_xml, patch)?;
    let rewritten = rewrite_cover(&rewritten, &document, patch.cover.as_ref(), cover_is_new)?;

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let mut cover_written = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name()?.to_string();
        let options = SimpleFileOptions::default().compression_method(entry.compression());
        writer.start_file(name.as_str(), options)?;
        if name == opf_path {
            writer.write_all(rewritten.as_bytes())?;
        } else if cover_target.as_deref() == Some(name.as_str()) {
            writer.write_all(&patch.cover.as_ref().expect("cover patch present").bytes)?;
            cover_written = true;
        } else {
            std::io::copy(&mut entry, &mut writer)?;
        }
    }
    if let (Some(cover), Some(target)) = (patch.cover.as_ref(), cover_target.as_deref())
        && !cover_written
    {
        // The OPF named a cover the archive never had, or the book had none.
        // Append the image so the manifest reference is not left dangling.
        writer.start_file(target, SimpleFileOptions::default())?;
        writer.write_all(&cover.bytes)?;
    }
    Ok(writer.finish()?.into_inner())
}

fn join_entry(base_dir: &str, name: &str) -> String {
    if base_dir.is_empty() { name.to_string() } else { format!("{base_dir}/{name}") }
}

fn mime_of(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "image/png",
    }
}

/// Byte span of the `<item>` open tag carrying this id.
fn manifest_item_span(xml: &str, id: &str) -> Option<(usize, usize)> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e))
                if e.name().local_name().as_ref() == "item" && attribute(e, "id") == id =>
            {
                return Some((start, reader.buffer_position() as usize));
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
        buf.clear();
    }
}

/// Where a new manifest item can go: the offset of `</manifest>`, or the
/// span of a self-closing `<manifest/>` that has to be expanded first.
fn manifest_insert_point(xml: &str) -> AppResult<(usize, usize, bool)> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(ref e)) if e.name().local_name().as_ref() == "manifest" => {
                return Ok((start, reader.buffer_position() as usize, true));
            }
            Ok(Event::End(ref e)) if e.name().local_name().as_ref() == "manifest" => {
                return Ok((start, start, false));
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(AppError::Parse(format!("OPF 解析失败：{err}"))),
            _ => {}
        }
        buf.clear();
    }
    Err(AppError::Parse("OPF 缺少 manifest 段".into()))
}

/// Offset of the `<` opening a close tag, for inserting just before it.
fn close_tag_start(xml: &str, tag: &str) -> AppResult<usize> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buf) {
            Ok(Event::End(ref e)) if e.name().local_name().as_ref() == tag => return Ok(start),
            Ok(Event::Eof) => break,
            Err(err) => return Err(AppError::Parse(format!("OPF 解析失败：{err}"))),
            _ => {}
        }
        buf.clear();
    }
    Err(AppError::Parse(format!("OPF 缺少 {tag} 段")))
}

fn unique_manifest_id(manifest: &[ManifestItem], base: &str) -> String {
    if manifest.iter().all(|item| item.id != base) {
        return base.to_string();
    }
    (2..)
        .map(|index| format!("{base}-{index}"))
        .find(|candidate| manifest.iter().all(|item| item.id != *candidate))
        .unwrap_or_else(|| base.to_string())
}

/// Wires the shelf cover into the OPF: retag an existing cover when the image
/// format changed, or add the manifest entry and EPUB2 cover meta when the
/// book had none.
fn rewrite_cover(
    xml: &str,
    document: &OpfDocument,
    cover: Option<&CoverImage>,
    is_new: bool,
) -> AppResult<String> {
    let Some(cover) = cover else { return Ok(xml.to_string()) };
    let mime = mime_of(&cover.extension);

    if !is_new {
        let changed = document.manifest.iter().find(|item| {
            document.cover_href.as_deref() == Some(item.href.as_str()) && item.media_type != mime
        });
        if let Some(item) = changed
            && let Some((start, end)) = manifest_item_span(xml, &item.id)
        {
            let tag = &xml[start..end];
            let old = format!("media-type=\"{}\"", item.media_type);
            let replacement = tag.replace(&old, &format!("media-type=\"{mime}\""));
            if replacement != tag {
                let mut out = xml.to_string();
                out.replace_range(start..end, &replacement);
                return Ok(out);
            }
        }
        return Ok(xml.to_string());
    }

    let (manifest_at, manifest_end, self_closing) = manifest_insert_point(xml)?;
    let metadata_at = close_tag_start(xml, "metadata")?;
    let id = unique_manifest_id(&document.manifest, "cover-image");
    let name = format!("cover.{}", cover.extension);
    let item_tag = if self_closing {
        let open = xml[manifest_at..manifest_end].trim_end_matches("/>").trim_end().to_string();
        format!("{open}>{item}</manifest>", item = manifest_item_tag(&id, &name, mime))
    } else {
        manifest_item_tag(&id, &name, mime)
    };

    // Apply back-to-front so both offsets stay valid.
    let mut edits = vec![
        (manifest_at, manifest_end, item_tag),
        (metadata_at, metadata_at, format!("<meta name=\"cover\" content=\"{id}\"/>")),
    ];
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut out = xml.to_string();
    for (start, end, replacement) in edits {
        out.replace_range(start..end, &replacement);
    }
    Ok(out)
}

fn manifest_item_tag(id: &str, href: &str, mime: &str) -> String {
    format!("<item id=\"{id}\" href=\"{href}\" media-type=\"{mime}\" properties=\"cover-image\"/>")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpfField {
    Title,
    Creator,
    Language,
    Publisher,
    Description,
    Date,
}

impl OpfField {
    /// Recognises a Dublin Core element by local name, namespace prefix agnostic.
    fn from_start(element: &BytesStart<'_>) -> Option<Self> {
        match element.name().local_name().as_ref() {
            "title" => Some(Self::Title),
            "creator" => Some(Self::Creator),
            "language" => Some(Self::Language),
            "publisher" => Some(Self::Publisher),
            "description" => Some(Self::Description),
            "date" => Some(Self::Date),
            _ => None,
        }
    }

    fn local_name(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Creator => "creator",
            Self::Language => "language",
            Self::Publisher => "publisher",
            Self::Description => "description",
            Self::Date => "date",
        }
    }
}

/// Byte span of one metadata element, with its opening tag kept verbatim so
/// attributes such as `xml:lang` and `opf:file-as` survive the rewrite.
#[derive(Clone)]
struct FieldSpan {
    field: OpfField,
    start: usize,
    whole_end: usize,
    open: String,
    body_start: usize,
    body_end: usize,
    self_closing: bool,
}

fn field_from(span: FieldSpan, value: &str) -> (usize, usize, String) {
    if span.self_closing {
        let open = span.open.strip_suffix("/>").unwrap_or(&span.open);
        let name = open
            .trim_start_matches('<')
            .split(|c: char| c.is_whitespace() || c == '>')
            .next()
            .unwrap_or("dc:title");
        let escaped = escape(value).into_owned();
        (span.start, span.whole_end, format!("{open}>{escaped}</{name}>"))
    } else {
        (span.body_start, span.body_end, escape(value).into_owned())
    }
}

/// Collects the spans of the fields we can write, plus where `</metadata>` is.
/// A small event pass rather than string matching: descriptions may carry
/// nested markup, and only the outermost element's body may be replaced.
fn field_spans(xml: &str) -> AppResult<(Vec<FieldSpan>, usize)> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut in_metadata = false;
    let mut metadata_end = None;
    let mut open: Option<(OpfField, FieldSpan, usize)> = None;
    let mut spans = Vec::new();

    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) => {
                let tag = element.name().local_name();
                if tag.as_ref() == "metadata" {
                    in_metadata = true;
                } else if let Some(entry) = open.as_mut() {
                    entry.2 += 1;
                } else if in_metadata && let Some(field) = OpfField::from_start(&element) {
                    let body = reader.buffer_position() as usize;
                    open = Some((
                        field,
                        FieldSpan {
                            field,
                            start,
                            whole_end: 0,
                            open: xml[start..body].to_string(),
                            body_start: body,
                            body_end: 0,
                            self_closing: false,
                        },
                        1,
                    ));
                }
            }
            Ok(Event::Empty(element)) => {
                if in_metadata
                    && open.is_none()
                    && let Some(field) = OpfField::from_start(&element)
                {
                    let end = reader.buffer_position() as usize;
                    spans.push(FieldSpan {
                        field,
                        start,
                        whole_end: end,
                        open: xml[start..end].to_string(),
                        body_start: end,
                        body_end: end,
                        self_closing: true,
                    });
                }
            }
            Ok(Event::End(element)) => {
                let end = reader.buffer_position() as usize;
                if let Some((field, mut span, depth)) = open.take() {
                    if depth > 1 {
                        open = Some((field, span, depth - 1));
                    } else {
                        span.body_end = start;
                        span.whole_end = end;
                        spans.push(span);
                    }
                } else if element.name().local_name().as_ref() == "metadata" {
                    metadata_end = Some(start);
                    in_metadata = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(AppError::Parse(format!("OPF 解析失败：{err}"))),
            _ => {}
        }
        buf.clear();
    }
    let metadata_end =
        metadata_end.ok_or_else(|| AppError::Parse("EPUB 的 OPF 没有 metadata 段".into()))?;
    Ok((spans, metadata_end))
}

fn rewrite_opf(xml: &str, patch: &EpubMetaPatch) -> AppResult<String> {
    let (spans, metadata_end) = field_spans(xml)?;
    // Reuse the prefix the file already gives Dublin Core; fall back to `dc:`.
    let prefix = spans
        .iter()
        .find_map(|span| {
            let name = span.open.trim_start_matches('<');
            name.split_once(':').map(|(prefix, _)| format!("{prefix}:"))
        })
        .unwrap_or_else(|| "dc:".into());

    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut append: Vec<(usize, String)> = Vec::new();
    let year = patch.published_year.map(|value| value.to_string());
    let fields = [
        (OpfField::Title, patch.title.as_deref().filter(|v| !v.is_empty())),
        (OpfField::Creator, None),
        (OpfField::Language, patch.language.as_deref().filter(|v| !v.is_empty())),
        (OpfField::Publisher, patch.publisher.as_deref().filter(|v| !v.is_empty())),
        (OpfField::Description, patch.description.as_deref().filter(|v| !v.is_empty())),
        (OpfField::Date, year.as_deref()),
    ];

    for (field, value) in fields {
        let mine: Vec<&FieldSpan> = spans.iter().filter(|span| span.field == field).collect();
        if field == OpfField::Creator {
            if patch.authors.is_empty() {
                continue;
            }
            for (index, span) in mine.iter().enumerate() {
                match patch.authors.get(index) {
                    Some(author) => edits.push(field_from((*span).clone(), author)),
                    None => edits.push((span.start, span.whole_end, String::new())),
                }
            }
            let after = mine.last().map_or(metadata_end, |span| span.whole_end);
            for author in patch.authors.iter().skip(mine.len()) {
                append.push((
                    after,
                    format!("<{p}creator>{}</{p}creator>", escape(author), p = prefix),
                ));
            }
            continue;
        }
        let Some(value) = value else { continue };
        if let Some(first) = mine.first() {
            edits.push(field_from((*first).clone(), value));
            for span in mine.iter().skip(1) {
                edits.push((span.start, span.whole_end, String::new()));
            }
        } else {
            append.push((
                metadata_end,
                format!(
                    "<{p}{name}>{}</{p}{name}>",
                    escape(value),
                    p = prefix,
                    name = field.local_name()
                ),
            ));
        }
    }

    // Edits are applied back-to-front so their byte offsets stay valid. Inserting
    // two strings at the same offset puts the second one *before* the first, so
    // reversing the appends keeps the fields in declaration order.
    for (at, text) in append.into_iter().rev() {
        edits.push((at, at, text));
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut out = xml.to_string();
    for (start, end, replacement) in edits {
        out.replace_range(start..end, &replacement);
    }
    Ok(out)
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
fn find_opf_path<R: Read + Seek>(archive: &mut ZipArchive<R>) -> AppResult<String> {
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
fn read_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
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
    fn write_back_replaces_metadata_and_keeps_other_entries() {
        let dir = fixture::temp_dir("epub-write");
        let path = fixture::write_epub(
            &dir,
            "book.epub",
            OPF,
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        let source = std::fs::read(&path).expect("read fixture");

        let patch = EpubMetaPatch {
            title: Some("深度工作".into()),
            authors: vec!["卡尔·纽波特".into()],
            publisher: Some("江西人民出版社".into()),
            published_year: Some(2018),
            ..Default::default()
        };
        let rewritten = write_metadata(&source, &patch).expect("write metadata");

        let target = dir.join("rewritten.epub");
        std::fs::write(&target, &rewritten).expect("save rewritten epub");
        let meta = read_metadata(&target).expect("read rewritten epub");
        assert_eq!(meta.title, "深度工作");
        assert_eq!(meta.authors, ["卡尔·纽波特"], "多余的旧作者必须被删掉");
        assert_eq!(meta.publisher.as_deref(), Some("江西人民出版社"));
        assert_eq!(meta.language.as_deref(), Some("zh-CN"), "补丁没给的字段保留");
        assert_eq!(meta.description.as_deref(), Some("一本关于 Rust 的书。"));

        // The chapters and cover are copied, not re-created.
        let mut a = ZipArchive::new(Cursor::new(&source)).expect("source zip");
        let mut b = ZipArchive::new(Cursor::new(&rewritten)).expect("rewritten zip");
        assert_eq!(a.len(), b.len(), "条目数量必须不变");
        for index in 0..a.len() {
            let mut left = a.by_index(index).expect("source entry");
            let name = left.name().expect("source name").to_string();
            let mut right = b.by_index(index).expect("rewritten entry");
            assert_eq!(right.name().expect("rewritten name"), name, "条目顺序必须不变");
            if name == "OEBPS/content.opf" {
                continue;
            }
            let mut left_bytes = Vec::new();
            let mut right_bytes = Vec::new();
            left.read_to_end(&mut left_bytes).expect("read source entry");
            right.read_to_end(&mut right_bytes).expect("read rewritten entry");
            assert_eq!(left_bytes, right_bytes, "{name} 的字节必须原样保留");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_back_replaces_the_cover_bytes_in_place() {
        let dir = fixture::temp_dir("epub-write-cover");
        let path = fixture::write_epub(
            &dir,
            "book.epub",
            OPF,
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        let source = std::fs::read(&path).expect("read fixture");
        let replacement = b"\x89PNG\r\n\x1a\nnew-shelf-cover".to_vec();

        let patch = EpubMetaPatch {
            cover: Some(CoverImage { extension: "png".into(), bytes: replacement.clone() }),
            ..Default::default()
        };
        let rewritten = write_metadata(&source, &patch).expect("write");
        let target = dir.join("out.epub");
        std::fs::write(&target, &rewritten).expect("save");

        let meta = read_metadata(&target).expect("read");
        let cover = meta.cover.expect("封面还在");
        assert_eq!(cover.bytes, replacement, "补后的封面必须写进 EPUB");
        assert_eq!(cover.extension, "png");

        // Every other entry keeps its bytes and the original order.
        let mut a = ZipArchive::new(Cursor::new(&source)).expect("source");
        let mut b = ZipArchive::new(Cursor::new(&rewritten)).expect("rewritten");
        assert_eq!(a.len(), b.len());
        for index in 0..a.len() {
            let mut left = a.by_index(index).expect("entry");
            let name = left.name().expect("name").to_string();
            let mut right = b.by_index(index).expect("entry");
            assert_eq!(right.name().expect("name"), name);
            if name == "OEBPS/content.opf" || name == "OEBPS/images/cover.png" {
                continue;
            }
            let mut left_bytes = Vec::new();
            let mut right_bytes = Vec::new();
            left.read_to_end(&mut left_bytes).expect("read");
            right.read_to_end(&mut right_bytes).expect("read");
            assert_eq!(left_bytes, right_bytes, "{name} 不该被改动");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_back_retags_the_cover_when_the_image_format_changes() {
        let dir = fixture::temp_dir("epub-write-cover-mime");
        let path = fixture::write_epub(
            &dir,
            "book.epub",
            OPF,
            &[("OEBPS/images/cover.png", &fixture::png_bytes())],
        );
        let source = std::fs::read(&path).expect("read fixture");
        // A downloaded cover is usually a JPEG replacing the book's PNG.
        let jpeg = b"\xff\xd8\xff\xe0shelf-jpeg".to_vec();
        let patch = EpubMetaPatch {
            cover: Some(CoverImage { extension: "jpg".into(), bytes: jpeg.clone() }),
            ..Default::default()
        };
        let rewritten = write_metadata(&source, &patch).expect("write");

        let mut zip = ZipArchive::new(Cursor::new(&rewritten)).expect("zip");
        let opf = read_entry(&mut zip, "OEBPS/content.opf", MAX_OPF_BYTES).expect("opf");
        let opf = String::from_utf8(opf).expect("utf8");
        assert!(
            opf.contains("href=\"images/cover.png\" media-type=\"image/jpeg\""),
            "封面条目名不变，但媒体类型要跟着新图改：{opf}"
        );
        let mut cover = zip.by_name("OEBPS/images/cover.png").expect("cover entry");
        let mut bytes = Vec::new();
        cover.read_to_end(&mut bytes).expect("read cover");
        assert_eq!(bytes, jpeg, "条目名是旧的，字节是新的");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_back_adds_a_cover_to_a_book_without_one() {
        let dir = fixture::temp_dir("epub-write-cover-new");
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>无封面</dc:title></metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"#;
        let path = fixture::write_epub(&dir, "book.epub", opf, &[]);
        let source = std::fs::read(&path).expect("read fixture");
        let bytes = fixture::png_bytes();
        let patch = EpubMetaPatch {
            cover: Some(CoverImage { extension: "png".into(), bytes: bytes.clone() }),
            ..Default::default()
        };
        let rewritten = write_metadata(&source, &patch).expect("write");
        let target = dir.join("out.epub");
        std::fs::write(&target, &rewritten).expect("save");

        let meta = read_metadata(&target).expect("read");
        assert_eq!(meta.cover.as_ref().map(|cover| cover.bytes.as_slice()), Some(bytes.as_slice()));
        let mut zip = ZipArchive::new(Cursor::new(&rewritten)).expect("zip");
        let raw = read_entry(&mut zip, "OEBPS/content.opf", MAX_OPF_BYTES).expect("opf");
        let raw = String::from_utf8(raw).expect("utf8");
        assert!(raw.contains("<meta name=\"cover\" content=\"cover-image\"/>"), "{raw}");
        assert!(raw.contains("properties=\"cover-image\""), "{raw}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_back_expands_a_self_closing_manifest_for_a_new_cover() {
        let dir = fixture::temp_dir("epub-write-cover-selfclose");
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>T</dc:title></metadata>
  <manifest/>
</package>"#;
        let path = fixture::write_epub(&dir, "book.epub", opf, &[]);
        let source = std::fs::read(&path).expect("read fixture");
        let patch = EpubMetaPatch {
            cover: Some(CoverImage { extension: "png".into(), bytes: fixture::png_bytes() }),
            ..Default::default()
        };
        let rewritten = write_metadata(&source, &patch).expect("write");
        let target = dir.join("out.epub");
        std::fs::write(&target, &rewritten).expect("save");
        assert!(read_metadata(&target).expect("read").cover.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_back_escapes_and_appends_missing_fields() {
        let dir = fixture::temp_dir("epub-write-escape");
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="2.0"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>T &amp; T</dc:title></metadata>
  <manifest/>
</package>"#;
        let path = fixture::write_epub(&dir, "book.epub", opf, &[]);
        let source = std::fs::read(&path).expect("read fixture");

        let patch = EpubMetaPatch {
            title: Some("A <B> & \"C\"".into()),
            authors: vec!["甲".into(), "乙".into()],
            language: Some("zh".into()),
            ..Default::default()
        };
        let rewritten = write_metadata(&source, &patch).expect("write");
        let target = dir.join("out.epub");
        std::fs::write(&target, &rewritten).expect("save");
        let meta = read_metadata(&target).expect("read");
        // The OPF must hold valid escaped XML — that is what other readers see.
        // Our own reader double-unescapes `&lt;` today, so assert on the raw OPF.
        let mut zip = ZipArchive::new(Cursor::new(&rewritten)).expect("zip");
        let opf = read_entry(&mut zip, "OEBPS/content.opf", MAX_OPF_BYTES).expect("opf");
        let opf = String::from_utf8(opf).expect("utf8");
        assert!(opf.contains("A &lt;B&gt; &amp; &quot;C&quot;"), "{opf}");
        assert!(opf.contains("<dc:creator>甲</dc:creator>"), "{opf}");
        assert!(opf.contains("<dc:creator>乙</dc:creator>"), "{opf}");
        assert!(opf.contains("<dc:language>zh</dc:language>"), "{opf}");
        assert_eq!(meta.authors, ["甲", "乙"], "缺 creator 时按补丁顺序补齐");

        std::fs::remove_dir_all(&dir).ok();
    }

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
