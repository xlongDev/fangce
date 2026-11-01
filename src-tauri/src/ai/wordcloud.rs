//! Chinese word frequency, for the word-cloud tool.
//!
//! Segmentation runs here rather than in the renderer: `jieba-rs` embeds its
//! dictionary in the binary (a few MB), and the alternative — a JavaScript
//! segmenter — would put that same dictionary into the bundle the reader
//! downloads. The backend also has the text already, so counting costs one pass
//! over chapters it would have read anyway.
//!
//! What counts as a word is the whole job. Chinese has no spaces, so "的" and
//! "了" would otherwise outrank every character in the book; one-character
//! tokens are dropped outright because in a novel they are mostly pronouns and
//! particles, and the few that matter (a one-character name) are not worth the
//! noise floor they cost.

use std::collections::HashMap;
use std::sync::OnceLock;

use jieba_rs::Jieba;
use serde::{Deserialize, Serialize};

/// One word and how often it appears.
#[derive(specta::Type, Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCount {
    pub word: String,
    pub count: u32,
}

/// How much text one call may chew through. A 5.5 M-character book segments in a
/// couple of seconds; the cap is here so a library-wide scan cannot turn one
/// question into a minute of work.
pub const MAX_CHARS: usize = 4_000_000;

/// A single `Jieba` costs ~10 MB of dictionary and a moment to build, so it is
/// built once per process rather than per call.
fn segmenter() -> &'static Jieba {
    static JIEBA: OnceLock<Jieba> = OnceLock::new();
    JIEBA.get_or_init(Jieba::new)
}

/// Function words and narration filler. Not exhaustive on purpose: a long list
/// is a thing to maintain, and the top of a frequency table is dominated by the
/// same twenty words in every book.
const STOPWORDS: &[&str] = &[
    "一个",
    "没有",
    "什么",
    "自己",
    "我们",
    "你们",
    "他们",
    "她们",
    "它们",
    "这个",
    "那个",
    "这些",
    "那些",
    "这样",
    "那样",
    "这么",
    "那么",
    "怎么",
    "为什么",
    "因为",
    "所以",
    "但是",
    "可是",
    "如果",
    "虽然",
    "然后",
    "于是",
    "而且",
    "并且",
    "或者",
    "还是",
    "就是",
    "只是",
    "已经",
    "可以",
    "应该",
    "能够",
    "不会",
    "不能",
    "不是",
    "也是",
    "还有",
    "有些",
    "一样",
    "一起",
    "一下",
    "一点",
    "一直",
    "现在",
    "时候",
    "地方",
    "东西",
    "事情",
    "问题",
    "知道",
    "觉得",
    "看着",
    "说道",
    "说着",
    "起来",
    "出来",
    "过来",
    "进去",
    "出去",
    "回来",
    "上去",
    "下去",
    "这里",
    "那里",
    "哪里",
    "似乎",
    "仿佛",
    "忽然",
    "突然",
    "终于",
    "不过",
];

fn is_stopword(word: &str) -> bool {
    STOPWORDS.contains(&word)
}

/// Characters that are never part of a word worth showing.
fn is_noise(word: &str) -> bool {
    word.chars().all(|c| {
        c.is_ascii_punctuation()
            || c.is_whitespace()
            || c.is_ascii_digit()
            || matches!(
                c,
                '，' | '。'
                    | '！'
                    | '？'
                    | '；'
                    | '：'
                    | '、'
                    | '「'
                    | '」'
                    | '『'
                    | '』'
                    | '（'
                    | '）'
                    | '《'
                    | '》'
                    | '…'
                    | '—'
                    | '·'
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
            )
    })
}

/// Counts words across `texts` and returns the `limit` most frequent.
///
/// Ties are broken alphabetically so two runs over the same book produce the
/// same list — a word cloud that reshuffles on every ask reads as random.
pub fn top_words<'a>(texts: impl Iterator<Item = &'a str>, limit: usize) -> Vec<WordCount> {
    let jieba = segmenter();
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for text in texts {
        for word in jieba.cut(text, true) {
            if word.chars().count() < 2 || is_noise(word) || is_stopword(word) {
                continue;
            }
            *counts.entry(word).or_insert(0) += 1;
        }
    }

    let mut words: Vec<WordCount> = counts
        .into_iter()
        .map(|(word, count)| WordCount { word: word.to_string(), count })
        .collect();
    words.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.word.cmp(&b.word)));
    words.truncate(limit.max(1));
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_words_rise_to_the_top() {
        // `hmm` on: an unknown two-character name is a word, not two characters
        // that the length filter would drop.
        let text = "林昭走进大殿。林昭看着殿中的世界，世界一片安静。林昭没有走。";
        let words = top_words(std::iter::once(text), 10);
        assert_eq!(words[0].word, "林昭");
        assert_eq!(words[0].count, 3);
        assert!(words.iter().any(|entry| entry.word == "世界"), "{words:?}");
        assert!(words.iter().any(|entry| entry.word == "大殿"), "{words:?}");
    }

    #[test]
    fn function_words_and_single_characters_are_dropped() {
        let words = top_words(std::iter::once("的了是在和就都而及与着过地得"), 10);
        assert!(words.is_empty(), "全是虚词与单字：{words:?}");
    }

    #[test]
    fn punctuation_and_digits_never_appear() {
        let words = top_words(std::iter::once("第一章 1234 。，，！！"), 10);
        assert!(words.iter().all(|entry| !entry.word.contains('，')), "{words:?}");
        assert!(words.iter().all(|entry| !entry.word.contains('1')), "{words:?}");
    }

    #[test]
    fn the_limit_is_respected_and_ties_are_stable() {
        let text = "甲甲 乙乙 丙丙 丁丁";
        let first = top_words(std::iter::once(text), 2);
        let second = top_words(std::iter::once(text), 2);
        assert_eq!(first.len(), 2);
        assert_eq!(first, second, "同样的输入必须给同样的表");
    }

    #[test]
    fn several_texts_are_counted_together() {
        let words = top_words(["林昭", "林昭"].into_iter(), 5);
        assert_eq!(words[0].word, "林昭");
        assert_eq!(words[0].count, 2);
    }

    #[test]
    fn an_empty_book_has_no_words() {
        assert!(top_words(std::iter::empty(), 80).is_empty());
    }
}
