//! Rewriting the attributes only Kindle writes, and splitting a book that has
//! no headings at all.

use std::borrow::Cow;

use crate::document::{
    LINK_FIELD_SEPARATOR, LINK_PARAGRAPH_PREFIX, RawChapter, WALLPAPER_PARAGRAPH_PREFIX,
};

use super::MAX_CHAPTER_CHARS;
use super::index::{PosResolver, chapter_index};

/// Renames Kindle's `recindex` image attribute into a `src` the shared HTML
/// parser understands.
///
/// KF8 marks illustrations with `<img recindex="00047">`: a 1-based decimal
/// record number into the shared resource pool, with no `src` at all. The
/// parser only reads `src`/`href`, so the attribute is renamed in place to
/// `src="kindle:recindex:00047"`. `lowrecindex` is a different attribute that
/// contains the same letters, hence the alphanumeric boundary guard.
pub(super) fn rewrite_recindex(html: &str) -> Cow<'_, str> {
    const NEEDLE: &str = "recindex=\"";
    let mut out = String::new();
    let mut rest = html;
    while let Some(at) = rest.find(NEEDLE) {
        if rest[..at].chars().next_back().is_some_and(|char| char.is_ascii_alphanumeric()) {
            // Part of a longer attribute name; copy it verbatim.
            out.push_str(&rest[..at + NEEDLE.len()]);
            rest = &rest[at + NEEDLE.len()..];
            continue;
        }
        let value_at = at + NEEDLE.len();
        let Some(value_len) = rest[value_at..].find('"') else { break };
        out.push_str(&rest[..at]);
        out.push_str("src=\"kindle:recindex:");
        out.push_str(&rest[value_at..value_at + value_len]);
        out.push('"');
        rest = &rest[value_at + value_len + 1..];
    }
    if out.is_empty() {
        return Cow::Borrowed(html);
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// The wallpaper marker for a slice, taken from its `<body>` class.
///
/// Kindle paints whole pages with `background-image: url(kindle:embed:N…)`
/// inside a linked flow — no `<img>` anywhere in the document text, so the
/// shared parser sees nothing. The wallpaper belongs to the page's own
/// `<body class=…>` rule; other rules in the same stylesheet paint other
/// pages (the copyright page, fonts), so collecting every url in sight pulled
/// in a stranger's wallpaper and showed a near-white texture page that read
/// as blank. KF8 assembles documents from skeleton fragments, which puts the
/// `<body>` tag just before the slice, so the class is looked up in the raw
/// text behind `slice_start`. Every slice gets its marker: part-title pages
/// show the art alone, text pages (the copyright page) read off the paper.
pub(super) fn flow_backgrounds(raw: &str, slice_start: usize) -> Vec<String> {
    const BODY_CLASS: &str = "<body class=\"";
    const URL_PREFIX: &str = "url(kindle:embed:";
    let Some(at) = raw[..slice_start].rfind(BODY_CLASS) else { return Vec::new() };
    let from = at + BODY_CLASS.len();
    let Some(class_len) = raw[from..].find('"') else { return Vec::new() };
    let class = &raw[from..from + class_len];
    // The class's declaration block: the first ".class" occurrence whose next
    // character opens a block (".calibre3" must not match ".calibre31").
    let mut cursor = 0usize;
    let block = loop {
        let Some(found) = raw[cursor..].find(&format!(".{class}")) else { return Vec::new() };
        let after = cursor + found + class.len() + 1;
        if raw[after..].trim_start().starts_with('{') {
            let block = &raw[after..];
            let Some(block_end) = block.find('}') else { return Vec::new() };
            break &block[..block_end];
        }
        cursor = after;
    };
    let Some(found) = block.find(URL_PREFIX) else { return Vec::new() };
    let rest = &block[found + URL_PREFIX.len()..];
    let id: &str = rest.split(['?', ')']).next().unwrap_or("");
    // Flows also reference fonts as bare `url(kindle:embed:N)` inside
    // @font-face; real artwork always declares its mime.
    let Some(mime) = rest
        .split("mime=")
        .nth(1)
        .and_then(|tail| tail.split(')').next())
        .filter(|mime| mime.starts_with("image/"))
    else {
        return Vec::new();
    };
    vec![format!("{WALLPAPER_PARAGRAPH_PREFIX}kindle:embed:{id}?mime={mime}")]
}

/// Rewrites MOBI6 `filepos` anchor attributes into internal links the shared
/// HTML parser understands. Kindle anchors never carry a real href alongside,
/// so the attribute name is replaced in place; anything unparseable stays.
pub(super) fn link_filepos(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() + 64);
    let mut at = 0usize;
    while let Some(rel) = html[at..].find("filepos") {
        let hit = at + rel;
        out.push_str(&html[at..hit]);
        let mut cursor = hit + "filepos".len();
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'=') {
            cursor += 1;
        }
        let quoted = matches!(bytes.get(cursor), Some(b'"') | Some(b'\''));
        if quoted {
            cursor += 1;
        }
        let start = cursor;
        while bytes.get(cursor).is_some_and(|byte| byte.is_ascii_digit()) {
            cursor += 1;
        }
        if cursor == start {
            out.push_str("filepos");
            at = hit + "filepos".len();
            continue;
        }
        out.push_str(&format!("href=\"kindle:filepos:{}\"", &html[start..cursor]));
        at = cursor + usize::from(quoted);
    }
    out.push_str(&html[at..]);
    out
}

/// Rewrites in-book link markers to chapter indices; anything the position
/// tables cannot explain degrades to its plain text.
pub(super) fn resolve_links(
    chapters: &mut [RawChapter],
    resolver: &PosResolver,
    boundaries: &[usize],
) {
    for chapter in chapters {
        for paragraph in &mut chapter.paragraphs {
            let Some(payload) = paragraph.strip_prefix(LINK_PARAGRAPH_PREFIX) else { continue };
            let Some((target, text)) = payload.split_once(LINK_FIELD_SEPARATOR) else { continue };
            let resolved =
                resolver.resolve(target).and_then(|offset| chapter_index(boundaries, offset));
            *paragraph = match resolved {
                Some(index) => {
                    format!("{LINK_PARAGRAPH_PREFIX}{index}{LINK_FIELD_SEPARATOR}{text}")
                }
                None => text.to_string(),
            };
        }
    }
}

/// Splits every chapter longer than [`MAX_CHAPTER_CHARS`] at a paragraph
/// boundary, numbering the parts so the table of contents stays readable.
pub(super) fn split_oversized(chapters: &mut Vec<RawChapter>) {
    let mut index = 0;
    while index < chapters.len() {
        let total: usize = chapters[index].paragraphs.iter().map(|p| p.chars().count()).sum();
        if total <= MAX_CHAPTER_CHARS {
            index += 1;
            continue;
        }
        let chapter = chapters.remove(index);
        let base = chapter.title.unwrap_or_else(|| crate::document::untitled_section(index + 1));
        let mut parts: Vec<RawChapter> = Vec::new();
        let mut current = RawChapter::default();
        let mut size = 0usize;
        for paragraph in chapter.paragraphs {
            let chars = paragraph.chars().count();
            if size + chars > MAX_CHAPTER_CHARS && !current.paragraphs.is_empty() {
                current.title = Some(format!("{base}（{}）", parts.len() + 1));
                parts.push(std::mem::take(&mut current));
                size = 0;
            }
            size += chars;
            current.paragraphs.push(paragraph);
        }
        if !current.paragraphs.is_empty() {
            current.title = Some(format!("{base}（{}）", parts.len() + 1));
            parts.push(current);
        }
        let added = parts.len();
        for (offset, part) in parts.into_iter().enumerate() {
            chapters.insert(index + offset, part);
        }
        index += added;
    }
}
