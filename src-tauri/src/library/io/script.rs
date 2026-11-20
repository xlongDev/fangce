//! Layer 2 for online book sources: a restricted JS transform for the cases
//! the tiny JSON rule language cannot express (non-JSON responses, computed
//! fields, conditional shapes).
//!
//! The sandbox is deliberately boring: a fresh QuickJS runtime per call, no
//! host objects except `log`, no network and no file APIs at all. Values cross
//! the boundary as JSON text (`JSON.parse` in, `JSON.stringify` out) instead
//! of a hand-written conversion layer. A script receives the response as its
//! first argument and the pipeline stage (`search` / `detail` / `chapters` /
//! `content`) as its second, and must define:
//!
//! ```js
//! function transform(input, stage) { return input; }
//! ```

use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Optional JS transform stored with a source definition.
#[derive(specta::Type, Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceScript {
    /// JS source defining a global `transform(input, stage)` function.
    pub code: String,
}

const MAX_CODE_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MEMORY_LIMIT: usize = 16 * 1024 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(2);

impl SourceScript {
    pub fn validate(&self) -> AppResult<()> {
        if self.code.len() > MAX_CODE_BYTES {
            return Err(AppError::InvalidArgument(format!("脚本不能超过 {MAX_CODE_BYTES} 字节")));
        }
        Ok(())
    }

    /// Runs `transform(input, stage)` in a fresh sandbox and returns its JSON
    /// result, which then flows through the ordinary JSON rules unchanged.
    pub fn apply(&self, input: &Value, stage: &str) -> AppResult<Value> {
        self.validate()?;
        let runtime =
            Runtime::new().map_err(|err| AppError::Message(format!("脚本引擎启动失败：{err}")))?;
        // No `rust-alloc` / custom allocator feature: QuickJS owns its heap,
        // so this limit is real rather than a no-op.
        runtime.set_memory_limit(MEMORY_LIMIT);
        let deadline = Instant::now() + TIME_LIMIT;
        runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

        let context = Context::full(&runtime)
            .map_err(|err| AppError::Message(format!("脚本引擎初始化失败：{err}")))?;
        context.with(|ctx| {
            let log = Function::new(ctx.clone(), |message: String| {
                tracing::info!(target: "source.script", "{message}");
            })
            .map_err(|err| AppError::Message(format!("脚本日志接口注册失败：{err}")))?;
            ctx.globals()
                .set("log", log)
                .map_err(|err| AppError::Message(format!("脚本日志接口注册失败：{err}")))?;

            // serde_json strings are valid JS string literals, so the input
            // cannot break out of the expression no matter what the site sent.
            // The value is serialized twice on purpose: JSON.parse takes the
            // JSON *text* as a JS string argument, not the parsed object.
            let input_json = serde_json::to_string(input)?;
            let input_literal = serde_json::to_string(&input_json)?;
            let stage_literal = serde_json::to_string(stage)?;
            let source = format!(
                "{}\n;JSON.stringify(transform(JSON.parse({input_literal}), {stage_literal}))",
                self.code
            );
            let output: String = ctx
                .eval(source)
                .map_err(|err| AppError::Message(format!("脚本在 {stage} 阶段执行失败：{err}")))?;
            if output.len() > MAX_OUTPUT_BYTES {
                return Err(AppError::Message(format!("脚本在 {stage} 阶段返回了过大的结果")));
            }
            serde_json::from_str(&output).map_err(|err| {
                AppError::Message(format!("脚本在 {stage} 阶段返回的不是合法 JSON：{err}"))
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::SourceScript;

    fn script(code: &str) -> SourceScript {
        SourceScript { code: code.into() }
    }

    #[test]
    fn a_script_can_reshape_a_response_before_the_rules_run() {
        let out = script(
            r#"function transform(input, stage) {
                 return { data: { list: [{ title: stage + ":" + input.q }] } };
               }"#,
        )
        .apply(&json!({ "q": "海边的卡夫卡" }), "search")
        .unwrap();
        assert_eq!(out, json!({"data":{"list":[{"title":"search:海边的卡夫卡"}]}}));
    }

    #[test]
    fn a_script_can_read_raw_text_when_the_site_is_not_json() {
        let out = script(
            r#"function transform(html) {
                 var m = /<h1>(.*?)<\/h1>/.exec(html);
                 return { title: m ? m[1] : "" };
               }"#,
        )
        .apply(&json!("<html><h1>书名</h1></html>"), "detail")
        .unwrap();
        assert_eq!(out, json!({"title":"书名"}));
    }

    #[test]
    fn a_script_cannot_loop_forever() {
        let started = std::time::Instant::now();
        let err = script("function transform() { while (true) {} }")
            .apply(&json!({}), "search")
            .unwrap_err();
        assert!(err.to_string().contains("search"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
    }

    #[test]
    fn a_script_cannot_reach_the_network_or_the_filesystem() {
        // QuickJS has no fetch, XMLHttpRequest or fs. This is a shape check of
        // the sandbox, not a penetration test.
        let err = script("function transform() { return fetch('https://example.com'); }")
            .apply(&json!({}), "search")
            .unwrap_err();
        assert!(err.to_string().contains("执行失败"), "{err}");
    }

    #[test]
    #[ignore = "microbenchmark: prints the per-call cost of a fresh sandbox"]
    fn runtime_startup_cost() {
        let transform = script("function transform(input) { return input; }");
        let rounds = 100;
        let started = std::time::Instant::now();
        for _ in 0..rounds {
            transform.apply(&json!({ "a": 1 }), "search").unwrap();
        }
        println!("script apply: {:?}/call", started.elapsed() / rounds);
    }

    #[test]
    fn oversized_code_is_rejected_at_save_time() {
        let big = script(&format!("function transform() {{ return '{}'; }}", "x".repeat(70_000)));
        assert!(big.validate().is_err());
    }
}
