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
