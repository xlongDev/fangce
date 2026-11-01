//! Token accounting for one answer.
//!
//! Three vendors spell the same three numbers differently, and none of them is
//! wrong — so the shapes are normalised here, once, instead of in the UI:
//!
//! | what | OpenAI | DeepSeek | Anthropic-shaped gateways |
//! |---|---|---|---|
//! | input | `prompt_tokens` | `prompt_tokens` | `input_tokens` |
//! | cached input | `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` | `cache_read_input_tokens` |
//! | output | `completion_tokens` | `completion_tokens` | `output_tokens` |
//!
//! A provider that reports nothing yields `None`, and the UI then shows no bar
//! rather than a row of zeros — "0 tokens" and "unknown" are different claims.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What one answer consumed. `cached` is a subset of `input`, not an addition
/// to it: the cache-hit price is cheaper, not extra.
#[derive(specta::Type, Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u32,
    pub cached: u32,
    pub output: u32,
}

impl TokenUsage {
    /// `None` when the payload carries no counts at all.
    pub fn from_value(usage: &Value) -> Option<Self> {
        let input = uint(usage, &["prompt_tokens", "input_tokens"]);
        let output = uint(usage, &["completion_tokens", "output_tokens"]);
        if input == 0 && output == 0 {
            return None;
        }
        // Clamped: a gateway that reports more cached tokens than input tokens
        // is wrong, and the bar must not render a negative slice.
        let cached =
            uint(usage, &["prompt_cache_hit_tokens", "cache_read_input_tokens", "cached_tokens"])
                .max(uint_at(usage, &["prompt_tokens_details", "cached_tokens"]))
                .min(input);
        Some(Self { input, cached, output })
    }

    /// Adds one round's counts to another — a multi-round agent turn reports
    /// per round, and the reader wants the total.
    pub fn merge(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_add(other.input),
            cached: self
                .cached
                .saturating_add(other.cached)
                .min(self.input.saturating_add(other.input)),
            output: self.output.saturating_add(other.output),
        }
    }
}

/// First of `names` that holds a number at the top level.
fn uint(value: &Value, names: &[&str]) -> u32 {
    names.iter().find_map(|name| value.get(*name).and_then(as_u32)).unwrap_or(0)
}

/// First of `names` that holds a number one level down, e.g.
/// `prompt_tokens_details.cached_tokens`.
fn uint_at(value: &Value, path: &[&str]) -> u32 {
    let mut cursor = value;
    for step in path {
        match cursor.get(*step) {
            Some(next) => cursor = next,
            None => return 0,
        }
    }
    as_u32(cursor).unwrap_or(0)
}

/// JSON numbers arrive as `u64`, `i64` or `f64` depending on the provider.
fn as_u32(value: &Value) -> Option<u32> {
    let number = value.as_u64().or_else(|| value.as_f64().map(|float| float.max(0.0) as u64))?;
    Some(u32::try_from(number).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_shape() {
        let usage = json!({
            "prompt_tokens": 1200,
            "completion_tokens": 340,
            "total_tokens": 1540,
            "prompt_tokens_details": { "cached_tokens": 1024 },
        });
        assert_eq!(
            TokenUsage::from_value(&usage),
            Some(TokenUsage { input: 1200, cached: 1024, output: 340 })
        );
    }

    #[test]
    fn deepseek_shape() {
        let usage = json!({
            "prompt_tokens": 900,
            "completion_tokens": 100,
            "prompt_cache_hit_tokens": 512,
            "prompt_cache_miss_tokens": 388,
        });
        assert_eq!(
            TokenUsage::from_value(&usage),
            Some(TokenUsage { input: 900, cached: 512, output: 100 })
        );
    }

    #[test]
    fn anthropic_shaped_gateway() {
        let usage = json!({
            "input_tokens": 700,
            "output_tokens": 50,
            "cache_read_input_tokens": 640,
        });
        assert_eq!(
            TokenUsage::from_value(&usage),
            Some(TokenUsage { input: 700, cached: 640, output: 50 })
        );
    }

    #[test]
    fn a_payload_with_no_counts_is_unknown_not_zero() {
        assert_eq!(TokenUsage::from_value(&json!({})), None);
        assert_eq!(TokenUsage::from_value(&json!({ "total_tokens": 42 })), None);
    }

    #[test]
    fn a_cached_count_larger_than_the_input_is_clamped() {
        let usage = json!({ "prompt_tokens": 10, "completion_tokens": 1, "cached_tokens": 99 });
        assert_eq!(
            TokenUsage::from_value(&usage),
            Some(TokenUsage { input: 10, cached: 10, output: 1 })
        );
    }

    #[test]
    fn floats_and_negative_numbers_are_tolerated() {
        let usage = json!({ "prompt_tokens": 12.0, "completion_tokens": -3 });
        assert_eq!(
            TokenUsage::from_value(&usage),
            Some(TokenUsage { input: 12, cached: 0, output: 0 })
        );
    }

    #[test]
    fn merging_adds_rounds_without_letting_cached_exceed_input() {
        let first = TokenUsage { input: 100, cached: 60, output: 10 };
        let second = TokenUsage { input: 50, cached: 50, output: 5 };
        assert_eq!(first.merge(second), TokenUsage { input: 150, cached: 110, output: 15 });
    }
}
