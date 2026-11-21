//! Reads this app's own Markdown export back into highlights.

use super::{Clipping, Parsed, carries_link, linked_book_id};

/// The file is written to be *read* — a quoted passage, the note under it, a
/// link home — so the parse is a small state machine over those blocks rather
/// than a table lookup. Three things make it tractable:
///
/// - Headings are told apart by their *text*, not their level. `## 第 3 章` is a
///   chapter in a single-book file and `## 《书名》` is a book in a cross-book
///   one, so the level means nothing on its own.
/// - The quoted passage is the run of `> ` lines at the start of an entry, and
///   everything between that run and the link is the note. A note that itself
///   opens with `> ` would be swallowed into the passage; that is the one shape
///   this cannot read, and it is worth less than the alternative (a note
///   containing a line break splitting the entry in two).
/// - The link is *optional*. A file pasted through a note app may come back
///   with the links dropped, and a highlight without its link is still a
///   highlight — a heading ends the entry just as well.
///
/// Ink and shape ride in an HTML comment on the link line, where the page
/// reader ignores them but this parser does not — so both exports bring back
/// what was read, what was written about it, and the colour it was written in.
/// Ink the exporter folded into a link line, as `<!-- ink:color=#ffd12e;style=underline -->`.
///
/// Absent is absent: an older export, or an entry with no colour chosen, has no
/// comment and gets `None` — which is a different fact from a chosen yellow.
fn linked_ink(line: &str) -> (Option<String>, Option<String>) {
    let Some(rest) = line.split_once("<!-- ink:").map(|(_, rest)| rest) else {
        return (None, None);
    };
    let Some(body) = rest.split_once("-->").map(|(body, _)| body) else {
        return (None, None);
    };
    let mut color = None;
    let mut style = None;
    for pair in body.split(';') {
        if let Some(value) = pair.trim().strip_prefix("color=") {
            color = (!value.is_empty()).then(|| value.to_string());
        } else if let Some(value) = pair.trim().strip_prefix("style=") {
            style = (!value.is_empty()).then(|| value.to_string());
        }
    }
    (color, style)
}

pub fn parse_markdown(source: &str) -> Parsed {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let normalised = source.replace("\r\n", "\n").replace('\r', "\n");

    let mut parsed = Parsed::default();
    let mut title = String::new();
    let mut chapter: Option<usize> = None;
    let mut passage: Vec<String> = Vec::new();
    let mut note: Vec<String> = Vec::new();
    // Once the quote has ended, everything is the note — including lines that
    // happen to start with `> `.
    let mut in_note = false;

    let flush = |passage: &mut Vec<String>,
                 note: &mut Vec<String>,
                 in_note: &mut bool,
                 title: &str,
                 chapter: Option<usize>,
                 parsed: &mut Parsed| {
        let text = passage.join("\n").trim().to_string();
        let written = note.join("\n").trim().to_string();
        // Cleared either way: a heading that ends an entry with nothing in it
        // (the summary line under a title, say) must not leave its text lying
        // around for the next entry to pick up.
        passage.clear();
        note.clear();
        *in_note = false;
        if text.is_empty() {
            return;
        }
        parsed.highlights.push(Clipping {
            title: title.to_string(),
            // The line under a book heading is the author in a cross-book file
            // and a summary in a single-book one, and the two cannot be told
            // apart without knowing which shape this is. So the author is not
            // read at all: the title came out of the same database and is exact,
            // and `Catalog` matches on it alone.
            author: String::new(),
            // Stamped by the caller when the link line arrives: the link closes
            // the entry, so it is not known yet at the moment this runs.
            book_id: None,
            text,
            note: (!written.is_empty()).then_some(written),
            color: None,
            style: None,
            chapter_idx: chapter,
        });
    };

    for line in normalised.lines() {
        if let Some(heading) = line.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            if let Some(idx) = chapter_number(heading) {
                // A new chapter ends whatever came before it, link or no link.
                flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
                chapter = Some(idx);
            } else {
                flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
                title = heading_title(heading);
                chapter = None;
            }
            continue;
        }
        if carries_link(line) {
            let before = parsed.highlights.len();
            flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
            // The link closes the entry above it, so it and the ink in its
            // comment are stamped onto the highlight `flush` just pushed — and
            // only when it pushed one. An entry that ended at a heading instead
            // would otherwise hand its id and colour to its predecessor.
            if parsed.highlights.len() > before {
                let last = parsed.highlights.last_mut().expect("just pushed");
                last.book_id = linked_book_id(line);
                let (color, style) = linked_ink(line);
                last.color = color;
                last.style = style;
            }
            continue;
        }
        if let Some(quoted) = line.strip_prefix("> ") {
            if in_note {
                note.push(line.to_string());
            } else {
                passage.push(quoted.to_string());
            }
            continue;
        }
        // A bare `>` is an empty line inside the quote, which `quote` writes as
        // `> ` and a hand-edited file may write without the space.
        if line.trim() == ">" && !in_note {
            passage.push(String::new());
            continue;
        }
        if line.trim().is_empty() {
            // The blank between the quote and the note. Inside the note, a
            // blank is part of it.
            if !passage.is_empty() {
                in_note = true;
            }
            if in_note {
                note.push(String::new());
            }
            continue;
        }
        in_note = true;
        note.push(line.to_string());
    }
    flush(&mut passage, &mut note, &mut in_note, &title, chapter, &mut parsed);
    parsed
}

/// The book a heading names, or empty when it names none.
fn heading_title(text: &str) -> String {
    let Some(open) = text.find('《') else {
        return String::new();
    };
    let Some(close) = text[open..].find('》') else {
        return String::new();
    };
    text[open + '《'.len_utf8()..open + close].trim().to_string()
}

/// The chapter a heading names, as the zero-based index annotations use.
///
/// Both exports write `第 N 章` with `N = idx + 1`, a number and never a title:
/// a title looked up by that index would be off by however much the two lists
/// differ (see `export`). This reads the number back.
fn chapter_number(text: &str) -> Option<usize> {
    let rest = text.trim().strip_prefix('第')?;
    rest.strip_suffix('章')?.trim().parse::<usize>().ok()?.checked_sub(1)
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{LINK, blocks};
    use super::*;

    #[test]
    fn markdown_reads_the_quote_the_note_and_the_chapter() {
        let source = blocks(&[
            "# 《Piranesi》标注与笔记",
            "Susanna Clarke · 2 条标注 · 1 条有笔记",
            "## 第 2 章",
            "> The Moon rose over the Halls.",
            "月亮升起来了",
            &format!("[在 方册 中打开]({LINK})"),
            "> A second one.",
            &format!("[在 方册 中打开]({LINK})"),
        ]);
        let parsed = parse_markdown(&source);

        assert_eq!(parsed.highlights.len(), 2);
        assert_eq!(parsed.highlights[0].title, "Piranesi");
        assert_eq!(parsed.highlights[0].text, "The Moon rose over the Halls.");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("月亮升起来了"));
        // `第 2 章` is index 1 — written one-based, read back zero-based.
        assert_eq!(parsed.highlights[0].chapter_idx, Some(1));
        // The chapter carries to the next entry rather than resetting.
        assert_eq!(parsed.highlights[1].chapter_idx, Some(1));
        assert_eq!(parsed.highlights[1].note, None);
        // A highlight with no note is not a note.
        assert_eq!(parsed.notes, 0);
    }

    #[test]
    fn markdown_reads_a_cross_book_export_as_several_books() {
        let source = blocks(&[
            "# 笔记导出",
            "2 本书 · 2 条标注",
            "## 《Piranesi》",
            "Susanna Clarke",
            "### 第 1 章",
            "> The Beauty of the House.",
            &format!("[在 方册 中打开]({LINK})"),
            "## 《三体》",
            "刘慈欣",
            "### 第 3 章",
            "> 不要回答。",
            &format!("[在 方册 中打开]({LINK})"),
        ]);
        let parsed = parse_markdown(&source);

        let seen: Vec<(&str, Option<usize>)> = parsed
            .highlights
            .iter()
            .map(|clipping| (clipping.title.as_str(), clipping.chapter_idx))
            .collect();
        // The author line between the book heading and the chapter heading is
        // not mistaken for a highlight, and the summary under the file's own
        // title is not either.
        assert_eq!(seen, vec![("Piranesi", Some(0)), ("三体", Some(2))]);
    }

    #[test]
    fn markdown_keeps_a_multi_line_passage_and_note_together() {
        let source = blocks(&[
            "# 《Piranesi》标注与笔记",
            "## 第 1 章",
            "> First line.\n> Second line.",
            "A note that\nspans lines.",
            &format!("[在 方册 中打开]({LINK})"),
        ]);
        let parsed = parse_markdown(&source);

        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "First line.\nSecond line.");
        assert_eq!(parsed.highlights[0].note.as_deref(), Some("A note that\nspans lines."));
    }

    #[test]
    fn markdown_still_reads_an_entry_whose_link_was_stripped() {
        // A file pasted through a note app may come back with the links gone.
        // A heading ends the entry just as well, so the highlight survives.
        let source =
            blocks(&["# 《Piranesi》标注与笔记", "## 第 1 章", "> The Beauty of the House."]);
        let parsed = parse_markdown(&source);

        assert_eq!(parsed.highlights.len(), 1);
        assert_eq!(parsed.highlights[0].text, "The Beauty of the House.");
        assert_eq!(parsed.highlights[0].chapter_idx, Some(0));
    }

    #[test]
    fn markdown_reads_ink_from_the_link_comment() {
        let source = blocks(&[
            "# 《Piranesi》标注与笔记",
            "## 第 1 章",
            "> The Beauty of the House.",
            &format!("[在 方册 中打开]({LINK}) <!-- ink:color=#ffd12e;style=squiggly -->"),
        ]);
        let parsed = parse_markdown(&source);
        assert_eq!(parsed.highlights[0].color.as_deref(), Some("#ffd12e"));
        assert_eq!(parsed.highlights[0].style.as_deref(), Some("squiggly"));

        // No comment — an older export, or no colour chosen — is not yellow.
        let plain = blocks(&[
            "# 《Piranesi》标注与笔记",
            "## 第 1 章",
            "> The Beauty of the House.",
            &format!("[在 方册 中打开]({LINK})"),
        ]);
        assert_eq!(parse_markdown(&plain).highlights[0].color, None);
    }

    /// The link is the exact half of the file, and both shapes carry it.
    #[test]
    fn a_link_names_the_book_it_came_from() {
        let markdown = parse_markdown(
            "# 《三体》标注与笔记\n\n\
             3 条标注\n\n\
             ## 第 1 章\n\n\
             > 你好\n\n\
             [在 方册 中打开](fangce://book/b1?annotation=a1)\n",
        );
        assert_eq!(markdown.highlights[0].book_id.as_deref(), Some("b1"));
        // The query is the highlight, not the book, and is dropped.
        assert_ne!(markdown.highlights[0].book_id.as_deref(), Some("a1"));

        // A file pasted through a note app may come back with the links gone.
        // Nothing is invented in their place.
        let stripped = parse_markdown("# 《三体》标注与笔记\n\n## 第 1 章\n\n> 你好\n");
        assert_eq!(stripped.highlights[0].book_id, None);
    }

    /// The link closes the entry, so it must not leak onto the next one — nor
    /// onto the previous one when the entry it closed held no passage.
    #[test]
    fn a_link_belongs_to_the_entry_above_it_and_to_no_other() {
        let source = "# 《三体》标注与笔记\n\n\
                      ## 第 1 章\n\n\
                      > 第一条\n\n\
                      [在 方册 中打开](fangce://book/b1?annotation=a1)\n\n\
                      > 第二条\n\n\
                      [在 方册 中打开](fangce://book/b2?annotation=a2)\n\n\
                      ## 第 2 章\n\n\
                      > 第三条\n";
        let parsed = parse_markdown(source);
        let ids: Vec<Option<&str>> =
            parsed.highlights.iter().map(|entry| entry.book_id.as_deref()).collect();
        assert_eq!(ids, vec![Some("b1"), Some("b2"), None]);
    }
}
