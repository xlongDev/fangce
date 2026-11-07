//! `notes.recap` — one paragraph tying together the reader's own highlights.
//!
//! This is an *arrangement*, not a ghost writer: the material is only what the
//! reader highlighted and wrote themselves, and the prompt is told not to add
//! opinions or plot the notes never mention. A model asked to "write reading
//! notes" invents a reader; one asked to sort the notes that exist cannot.
//!
//! The stream is the same `ai://stream` channel the guide and the chapter recap
//! use, so incremental rendering, the error card and 停止 all come for free.

use tauri::{AppHandle, State};

use crate::ai::chat::{ChatMessage, Role};
use crate::ai::is_ready;
use crate::error::{AppError, AppResult};
use crate::library::annotations::{self, Annotation};
use crate::state::AppState;

use super::ai::{NOT_CONFIGURED, StreamArgs, blank, emit, run_stream};

/// The instructions a notes recap is written under.
pub const PROMPT: &str = "\
你在把一位读者自己的划线和笔记整理成一段回顾，帮他想起自己在这本书里留意过什么。\
只依据下面给出的划线原文与读者写的笔记，不推测书里没给出的情节，不替读者发表观点，不评价书的好坏。\
用简体中文，200 到 400 字，按阅读顺序把分散的笔记串成连贯的一段，突出读者反复留意的东西和想法的变化。\
不要逐条罗列，不要写「第一条笔记」「你提到」，不要用列表，不要开场白和结语。\
如果笔记之间看不出关联，就按主题如实叙述，不要硬编一条主线。只输出回顾正文。";

/// The most material one request carries.
const MATERIAL_CHARS: usize = 14_000;

/// One highlight's text is a snippet, but a reader can mark a whole page.
const MAX_QUOTE_CHARS: usize = 400;
const MAX_NOTE_CHARS: usize = 600;

/// `notes.recap` — streams a review of one book's annotated highlights.
///
/// The backend reads the annotations itself rather than taking them from the
/// renderer: one source of truth, and a command whose only input is a book id.
#[tauri::command]
#[specta::specta]
pub async fn notes_recap(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    book_id: String,
) -> AppResult<()> {
    let config = crate::ai::config(&state.library)?;
    if !is_ready(&config) {
        return Err(AppError::InvalidArgument(NOT_CONFIGURED.into()));
    }

    let rows = state.library.with(|conn| annotations::list(conn, &book_id))?;
    let material = material(&rows);
    if material.is_empty() {
        return Err(AppError::InvalidArgument("这本书还没有写过笔记的划线".into()));
    }

    // The recap carries its own instructions. `with_system_extra` leaves a
    // conversation alone when it already opens with a system message, so the
    // reader's assistant persona cannot reshape this into a chat answer.
    let messages = vec![
        ChatMessage::new(Role::System, PROMPT.to_string()),
        ChatMessage::new(Role::User, material),
    ];

    let result = run_stream(
        &app,
        &state,
        StreamArgs {
            request_id: &request_id,
            config: &config,
            messages,
            citations: Vec::new(),
            tools: None,
            book_id: Some(&book_id),
            max_chapter: None,
            context: None,
        },
    )
    .await;

    match result {
        Ok(_) => Ok(()),
        Err(err) => {
            let mut delta = blank(&request_id);
            delta.done = true;
            delta.error = Some(err.to_string());
            emit(&app, delta);
            Err(err)
        }
    }
}

/// The annotated highlights, in reading order, as the model's material.
///
/// A highlight with no note is a passage the reader marked, not something they
/// said; including it would have the model write about the book instead of
/// about the reader's notes. Blank notes are folded away at write time, but a
/// row imported from another reader's clippings can still carry whitespace.
///
/// Order belongs to the caller: `annotations::list` already sorts by
/// `(chapter_idx, start_char)`, and a pure function that sorted again would be
/// a second rule for the same thing.
fn material(annotations: &[Annotation]) -> String {
    let lines: Vec<String> = annotations
        .iter()
        .filter_map(|annotation| {
            let note = annotation.note.as_deref()?.trim();
            if note.is_empty() {
                return None;
            }
            let quote: String = annotation.text.trim().chars().take(MAX_QUOTE_CHARS).collect();
            let note: String = note.chars().take(MAX_NOTE_CHARS).collect();
            Some(format!("第 {} 章\n划线：{quote}\n笔记：{note}\n\n", annotation.chapter_idx + 1))
        })
        .collect();
    fit(&lines, MATERIAL_CHARS)
}

/// Fits the lines into `budget`, sampling evenly rather than truncating: a
/// recap built from only the opening notes describes a reader who stopped
/// reading. The first and the last always survive.
fn fit(lines: &[String], budget: usize) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let total: usize = lines.iter().map(|line| line.chars().count()).sum();
    if total <= budget {
        return lines.concat();
    }
    if lines.len() == 1 {
        return lines[0].chars().take(budget).collect();
    }

    let average = (total / lines.len()).max(1);
    let want = (budget / average).clamp(2, lines.len());
    let mut out = String::new();
    for slot in 0..want {
        out.push_str(&lines[slot * (lines.len() - 1) / (want - 1)]);
    }
    out.push_str(&format!("（共 {} 条笔记，按阅读顺序均匀抽取了 {want} 条。）\n", lines.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marked(chapter_idx: usize, text: &str, note: Option<&str>) -> Annotation {
        Annotation {
            id: format!("a{chapter_idx}"),
            book_id: "b".into(),
            chapter_idx,
            start_char: 0,
            end_char: text.chars().count(),
            text: text.into(),
            cfi: None,
            color: None,
            style: None,
            note: note.map(str::to_string),
            created_at: 1,
        }
    }

    #[test]
    fn a_highlight_without_a_note_is_not_the_reader_saying_anything() {
        let rows = vec![marked(0, "林昭走进大殿。", None), marked(1, "雨还没有停。", Some("  "))];
        assert_eq!(material(&rows), "");
    }

    #[test]
    fn only_noted_highlights_are_included_in_reading_order() {
        // Ordered the way `annotations::list` hands them over.
        let rows = vec![
            marked(0, "第一段原文", None),
            marked(1, "第二段原文", Some("第二条的笔记")),
            marked(2, "第三段原文", Some("第三条的笔记")),
        ];
        let text = material(&rows);
        assert!(text.starts_with("第 2 章"), "没有笔记的第一章要跳过：{text}");
        assert!(text.contains("划线：第三段原文"), "{text}");
        assert!(text.contains("笔记：第二条的笔记"), "{text}");
        assert!(!text.contains("第一段原文"), "没有笔记的划线不该进去：{text}");
        assert!(
            text.find("第二条的笔记").expect("第二条") < text.find("第三条的笔记").expect("第三条"),
            "顺序要保持：{text}"
        );
    }

    #[test]
    fn a_short_set_of_notes_travels_whole() {
        let rows = vec![marked(0, "甲", Some("想法甲")), marked(1, "乙", Some("想法乙"))];
        let text = material(&rows);
        assert!(text.contains("想法甲") && text.contains("想法乙"), "{text}");
        assert!(!text.contains("均匀抽取"), "没截断就不该有省略说明：{text}");
    }

    #[test]
    fn a_long_set_of_notes_keeps_the_first_and_the_last() {
        let rows: Vec<Annotation> = (0..200)
            .map(|idx| marked(idx, "原文", Some(&format!("第 {idx} 条笔记").repeat(20))))
            .collect();
        let text = material(&rows);

        assert!(text.contains("第 0 条笔记"), "开头必须在：{text}");
        assert!(text.contains("第 199 条笔记"), "结尾必须在：{text}");
        assert!(text.contains("均匀抽取了"), "抽样要说明：{text}");
        assert!(
            text.chars().count() < MATERIAL_CHARS + 1500,
            "抽样后仍远超预算：{}",
            text.chars().count()
        );
    }

    #[test]
    fn one_very_long_note_is_cut_without_panicking() {
        let text = fit(&["字".repeat(20_000)], 1000);
        assert_eq!(text.chars().count(), 1000);
    }

    #[test]
    fn a_long_quote_and_note_are_each_bounded() {
        let rows = vec![marked(0, &"原".repeat(2000), Some(&"想".repeat(2000)))];
        let text = material(&rows);
        assert!(text.chars().count() < MAX_QUOTE_CHARS + MAX_NOTE_CHARS + 40, "{text}");
        assert!(text.contains("笔记："), "{text}");
    }
}
