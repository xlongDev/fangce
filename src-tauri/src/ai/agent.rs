//! The model↔tool loop.
//!
//! One question may take several round trips: the model asks for a tool, reads
//! the answer, and either asks for another or finally says something. The whole
//! loop lives here, and the parts worth testing are pure — the decision of what
//! to do after a round, and the shape of the messages handed back to the model.
//!
//! Three things bound it, because an unbounded agent loop is how a question
//! turns into a bill:
//!
//! - `max_tool_rounds` from the settings, so the reader decides how deep.
//! - A round with no tool calls ends the loop, which is also what makes a model
//!   that cannot call tools work: it simply answers.
//! - Every tool returns a message rather than raising, so one failure does not
//!   end the exchange.

use crate::ai::AiConfig;
use crate::ai::chat::{self, ChatMessage, Role, StreamEvent, ToolCall, ToolDef};
use crate::ai::tools::{self, ToolCallView, ToolContext};
use crate::ai::usage::TokenUsage;
use crate::error::AppResult;

/// What happened during one turn, as the panel needs it.
pub enum AgentEvent {
    Text(String),
    Reasoning(String),
    /// One call finished — the panel draws a row for it.
    Tool(ToolCallView),
}

/// What the turn produced.
pub struct AgentOutcome {
    /// The final answer. Empty when the model only called tools.
    pub text: String,
    pub usage: Option<TokenUsage>,
    /// How many tool calls ran, for logging.
    pub tool_calls: usize,
}

/// What to do after one round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    /// The model answered; the turn is over.
    Done,
    /// It wants tools and there is budget left.
    Tools,
    /// It wants tools but the budget is spent.
    BudgetSpent,
}

fn next_step(calls: &[ToolCall], rounds_used: u32, max_rounds: u32) -> Next {
    if calls.is_empty() {
        return Next::Done;
    }
    if rounds_used >= max_rounds.max(1) {
        return Next::BudgetSpent;
    }
    Next::Tools
}

/// Runs one question to completion, emitting as it goes.
pub async fn run(
    client: &reqwest::Client,
    config: &AiConfig,
    mut messages: Vec<ChatMessage>,
    tools: Option<Vec<ToolDef>>,
    ctx: &ToolContext<'_>,
    sink: &mut (dyn FnMut(AgentEvent) + Send),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> AppResult<AgentOutcome> {
    let mut usage: Option<TokenUsage> = None;
    let mut rounds: u32 = 0;
    let mut ran: usize = 0;
    let mut answered = String::new();

    loop {
        // Checked between rounds as well as inside the stream: a reader who
        // stops while the model is still thinking gets the next round skipped
        // rather than a bill for it.
        if cancelled() {
            tracing::info!(rounds, "读者停止了这一轮");
            return Ok(AgentOutcome { text: answered, usage, tool_calls: ran });
        }

        let mut text = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();
        let mut round_usage: Option<TokenUsage> = None;

        chat::stream_chat(client, config, messages.clone(), tools.clone(), &mut |event| {
            match event {
                StreamEvent::Delta(chunk) => {
                    text.push_str(&chunk);
                    sink(AgentEvent::Text(chunk));
                }
                StreamEvent::Reasoning(chunk) => sink(AgentEvent::Reasoning(chunk)),
                StreamEvent::ToolCall(delta) => chat::absorb_tool_call(&mut calls, &delta),
                StreamEvent::Usage(counts) => {
                    round_usage = Some(match round_usage {
                        Some(previous) => previous.merge(counts),
                        None => counts,
                    });
                }
                StreamEvent::Finish(_) | StreamEvent::Done => {}
            }
            !cancelled()
        })
        .await?;

        if let Some(counts) = round_usage {
            // Accumulated across rounds, and handed back on the outcome rather
            // than streamed: a running total that ticks up mid-answer reads as
            // noise, and the number a reader wants is the one for the turn.
            usage = Some(match usage {
                Some(previous) => previous.merge(counts),
                None => counts,
            });
        }

        answered = text.clone();

        // Stopped between the answer and the calls it asked for: the tools are
        // not run. The reader said no, and a search is not free.
        if cancelled() {
            tracing::info!(rounds, "读者在工具调用前停止了");
            return Ok(AgentOutcome { text: answered, usage, tool_calls: ran });
        }

        match next_step(&calls, rounds, config.max_tool_rounds) {
            Next::Done => return Ok(AgentOutcome { text, usage, tool_calls: ran }),
            Next::BudgetSpent => {
                // Say so rather than looping: the model asked for something the
                // reader's budget does not allow, and the answer so far is what
                // they get.
                tracing::info!(rounds, "工具调用轮数用尽");
                return Ok(AgentOutcome { text, usage, tool_calls: ran });
            }
            Next::Tools => {
                // The assistant turn that asked is part of the transcript, and
                // every provider requires it to be echoed back verbatim before
                // the tool replies can follow.
                let mut asked = ChatMessage::new(Role::Assistant, text);
                asked.tool_calls = calls.clone();
                messages.push(asked);

                for (index, call) in calls.iter_mut().enumerate() {
                    // A provider that omits the id still needs one on the reply,
                    // or the next request is rejected outright.
                    if call.id.is_empty() {
                        call.id = format!("call_{rounds}_{index}");
                    }
                    let outcome = tools::run(ctx, call).await;
                    sink(AgentEvent::Tool(outcome.view));

                    let mut reply = ChatMessage::new(Role::Tool, outcome.for_model);
                    reply.tool_call_id = Some(call.id.clone());
                    messages.push(reply);
                    ran += 1;
                }
                rounds += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call() -> ToolCall {
        ToolCall { id: "c1".into(), name: "search_book".into(), arguments: "{}".into() }
    }

    /* --------------------------------------------------- against a mock */

    /// One SSE frame, as the provider would write it.
    fn sse(frames: &[&str]) -> String {
        let mut out = String::new();
        for frame in frames {
            out.push_str("data: ");
            out.push_str(frame);
            out.push_str("\n\n");
        }
        out.push_str("data: [DONE]\n\n");
        out
    }

    /// A scripted OpenAI-compatible endpoint: one canned reply per request, and
    /// every request body kept for the assertions.
    ///
    /// The agent loop is the one path that cannot be checked without a server —
    /// it is the only place where a parsed `tool_calls`, a tool's reply and a
    /// second round have to line up. A mock that speaks the protocol is the
    /// closest thing to a real model that runs in CI.
    struct MockChat {
        base_url: String,
        seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    fn mock_chat(replies: Vec<String>) -> MockChat {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = seen.clone();

        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let request = read_request(&mut stream);
                if let Ok(mut slot) = captured.lock() {
                    slot.push(request);
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(reply.as_bytes());
            }
        });

        MockChat { base_url: format!("http://127.0.0.1:{port}"), seen }
    }

    /// Reads one whole request, headers and body, so the reply never lands
    /// before the client has finished sending.
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::Read;
        let mut raw = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            raw.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&raw).to_string();
            let Some(split) = text.find("\r\n\r\n") else { continue };
            let length = text[..split]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if !name.eq_ignore_ascii_case("content-length") {
                        return None;
                    }
                    value.trim().parse::<usize>().ok()
                })
                .unwrap_or(0);
            if raw.len() >= split + 4 + length {
                break;
            }
        }
        String::from_utf8_lossy(&raw).to_string()
    }

    /// A library with one book and one chapter, enough for a tool to read.
    struct Harness {
        dir: std::path::PathBuf,
        library: crate::db::Library,
    }

    impl Harness {
        fn new(tag: &str) -> Self {
            let dir = crate::document::fixture::temp_dir(tag);
            let layout = crate::db::Layout::create(dir.clone()).expect("layout");
            let library = crate::db::Library::open(&layout.data_dir).expect("open");
            library
                .with(|conn| {
                    conn.execute(
                        "INSERT INTO books (id, title, sort_title, format, content_hash, \
                         file_path, file_size, added_at, updated_at) \
                         VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO chapters (book_id, idx, title, content, chars) \
                         VALUES ('b', 0, '第一章', ?1, ?2)",
                        rusqlite::params![
                            "林昭走进大殿。林昭看着殿中的世界，世界一片安静。林昭没有走。",
                            30
                        ],
                    )?;
                    Ok(())
                })
                .expect("seed");
            Self { dir, library }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn a_tool_call_runs_and_its_reply_travels_back_to_the_model() {
        let harness = Harness::new("agent-tool-loop");
        let mock = mock_chat(vec![
            sse(&[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"wordcloud","arguments":"{\"scope\":\"chapter\",\"chapter\":1}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ]),
            sse(&[
                r#"{"choices":[{"delta":{"content":"这一章最常出现的是林昭。"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            ]),
        ]);

        let config = AiConfig { base_url: mock.base_url.clone(), ..AiConfig::default() };
        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let ctx = ToolContext {
            library: &harness.library,
            client: &client,
            config: &config,
            book_id: Some("b"),
            max_chapter: None,
            cancelled: &|| false,
        };
        let mut events: Vec<String> = Vec::new();
        let mut sink = |event: AgentEvent| {
            events.push(match event {
                AgentEvent::Text(text) => format!("text:{text}"),
                AgentEvent::Reasoning(text) => format!("reasoning:{text}"),
                AgentEvent::Tool(view) => format!("tool:{}", view.name),
            });
        };

        let outcome = tauri::async_runtime::block_on(run(
            &client,
            &config,
            vec![ChatMessage::new(Role::User, "这一章的高频词")],
            Some(tools::definitions()),
            &ctx,
            &mut sink,
            &|| false,
        ))
        .expect("run");

        assert_eq!(outcome.text, "这一章最常出现的是林昭。");
        assert_eq!(outcome.tool_calls, 1);
        assert!(events.contains(&"tool:wordcloud".to_string()), "{events:?}");

        // The second round has to carry the assistant's `tool_calls` and the
        // tool's reply — every provider rejects a `role: tool` message whose
        // parent is missing, and that failure looks like a broken model.
        let seen = mock.seen.lock().expect("lock");
        assert_eq!(seen.len(), 2, "应当有两轮请求");
        assert!(seen[1].contains("\"role\":\"tool\""), "{}", seen[1]);
        assert!(seen[1].contains("\"tool_call_id\":\"call_1\""), "{}", seen[1]);
        assert!(seen[1].contains("\"tool_calls\""), "{}", seen[1]);
    }

    #[test]
    fn a_model_that_answers_without_tools_gets_one_round() {
        let harness = Harness::new("agent-plain");
        let mock = mock_chat(vec![sse(&[
            r#"{"choices":[{"delta":{"content":"不用查，我知道。"}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
        ])]);

        let config = AiConfig { base_url: mock.base_url.clone(), ..AiConfig::default() };
        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let ctx = ToolContext {
            library: &harness.library,
            client: &client,
            config: &config,
            book_id: Some("b"),
            max_chapter: None,
            cancelled: &|| false,
        };
        let mut sink = |_: AgentEvent| {};

        let outcome = tauri::async_runtime::block_on(run(
            &client,
            &config,
            vec![ChatMessage::new(Role::User, "你好")],
            Some(tools::definitions()),
            &ctx,
            &mut sink,
            &|| false,
        ))
        .expect("run");

        assert_eq!(outcome.text, "不用查，我知道。");
        assert_eq!(outcome.tool_calls, 0);
        assert_eq!(mock.seen.lock().expect("lock").len(), 1);
    }

    #[test]
    fn no_tool_calls_ends_the_turn() {
        assert_eq!(next_step(&[], 0, 8), Next::Done);
    }

    #[test]
    fn a_tool_call_inside_the_budget_runs() {
        assert_eq!(next_step(&[call()], 0, 8), Next::Tools);
        assert_eq!(next_step(&[call()], 7, 8), Next::Tools);
    }

    #[test]
    fn the_budget_is_a_hard_stop() {
        assert_eq!(next_step(&[call()], 8, 8), Next::BudgetSpent);
        assert_eq!(next_step(&[call()], 9, 8), Next::BudgetSpent);
    }

    #[test]
    fn a_zero_budget_still_allows_one_round() {
        // A budget of zero cannot come from the form (it is clamped to 1..16),
        // so this is only the defensive floor: one round always runs, because a
        // model that answers without tools must not be blocked by a mis-set
        // number. The second round is where the floor stops it.
        assert_eq!(next_step(&[call()], 0, 0), Next::Tools);
        assert_eq!(next_step(&[call()], 1, 0), Next::BudgetSpent);
        assert_eq!(next_step(&[], 0, 0), Next::Done);
    }
}
