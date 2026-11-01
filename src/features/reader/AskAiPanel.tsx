import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { DownloadSimple, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";

import { AiErrorCard } from "@/components/common/AiErrorCard";
import { Markdown } from "@/components/common/Markdown";
import { GlassIconButton } from "@/components/glass/button";
import { GlassInput, GlassSelect } from "@/components/glass/input";
import {
  useAiConfig,
  useAiConversations,
  useAppendAiMessage,
  useChatStream,
  useCreateAiConversation,
  useDeleteAiConversation,
  useExportAiConversation,
  useLoadAiConversation,
  useRenameAiConversation,
  type ChatTurn,
} from "@/hooks/useAi";
import { useIndexBook, useRagStatus } from "@/hooks/useRag";
import { useSavePath } from "@/hooks/useSavePath";
import {
  forgetConversation,
  rememberConversation,
  rememberedConversation,
} from "@/lib/aiConversationMemory";
import { completeAiConfig } from "@/lib/aiConfig";
import { cn } from "@/lib/cn";
import { showToast } from "@/stores/toasts";
import { TokenUsageBar } from "@/features/reader/TokenUsageBar";
import { ToolRow } from "@/features/reader/ToolRow";

// The two renderers behind a tool row carry a Markdown parser and a layout
// engine between them. Loading them with the reader would make every book open
// pay for a feature most sessions never touch.
const ToolArtifact = lazy(() =>
  import("@/features/reader/ToolArtifact").then((module) => ({ default: module.ToolArtifact })),
);
import type { RagHit, StoredMessage } from "@/types/ipc";

/**
 * The reading assistant's drawer: a conversation about this book.
 *
 * Three things it does that a single-question panel cannot, and each is the
 * reason for a piece of state below: the history is stored (so the switcher at
 * the top is real), the last exchange is sent back to the model (so a follow-up
 * can say "再展开一点"), and the answer's cost is shown (so a reader on a paid
 * endpoint is not guessing).
 *
 * The quoted selection is still the first-class case: with one in hand the
 * question is about that passage, and the backend is given no retrieval at all.
 */
export function AskAiPanel({
  bookId,
  selection,
  onClearSelection,
  chapterTitle,
  chapterIdx,
  paragraphs,
  onJump,
  seedQuestion = "",
}: {
  bookId: string;
  selection: string | null;
  onClearSelection: () => void;
  chapterTitle: string;
  /** The reader's position, for a spoiler-safe retrieval. */
  chapterIdx: number;
  paragraphs: string[];
  onJump: (hit: RagHit) => void;
  /** Pre-filled question, e.g. from a character card. Only an initial value. */
  seedQuestion?: string;
}) {
  const config = useAiConfig();
  const settings = config.data ? completeAiConfig(config.data) : null;
  const turnsToKeep = settings?.contextTurns ?? 8;
  const showUsage = settings?.showTokenUsage ?? true;

  const chat = useChatStream();
  const conversations = useAiConversations(bookId);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const loadConversation = useLoadAiConversation();
  const createConversation = useCreateAiConversation();
  const appendMessage = useAppendAiMessage();
  const renameConversation = useRenameAiConversation();
  const deleteConversation = useDeleteAiConversation();
  const exportConversation = useExportAiConversation();
  const { choose } = useSavePath();

  const [input, setInput] = useState(seedQuestion);
  const [ragMode, setRagMode] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const status = useRagStatus(bookId);
  const indexBook = useIndexBook(bookId);
  const ragReady = (status.data?.embeddingModel ?? "") !== "";
  const thisBookIndexed = (status.data?.bookChunks ?? 0) > 0;

  /** The open conversation's title, from the list — the transcript itself is
   *  owned by the stream hook and is not re-read. */
  const currentTitle =
    (conversations.data ?? []).find((entry) => entry.id === conversationId)?.title ?? "";

  const startNew = () => {
    setConversationId(null);
    setRenaming(false);
    rememberConversation(bookId, null);
    chat.reset();
  };

  const open = async (id: string) => {
    if (!id) {
      startNew();
      return;
    }
    try {
      const loaded = await loadConversation.mutateAsync(id);
      setConversationId(id);
      rememberConversation(bookId, id);
      chat.hydrate(loaded.messages.map(toTurn));
    } catch (error) {
      // A pointer to a conversation that no longer exists — deleted from
      // another window, or by a reset. Drop it rather than fail on every open.
      forgetConversation(bookId);
      showToast("error", String(error));
    }
  };

  /**
   * Reopens the conversation the reader was last in.
   *
   * The drawer unmounts this panel when it closes, so the stream state goes with
   * it. Every message is already in the database; without this the reader would
   * have to find their own conversation in the dropdown after every close.
   *
   * The ref is the guard, not the dependency list: `open` is rebuilt every
   * render, and this has to run exactly once per mount.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const remembered = rememberedConversation(bookId);
    if (!remembered) return;
    void open(remembered);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || chat.streaming) return;
    setInput("");

    // The conversation is created before the question is stored, so the row
    // exists by the time the first message needs a parent.
    let id = conversationId;
    if (!id) {
      try {
        const created = await createConversation.mutateAsync(bookId);
        id = created.id;
        setConversationId(id);
        rememberConversation(bookId, id);
      } catch (error) {
        showToast("error", String(error));
        return;
      }
    }

    await appendMessage
      .mutateAsync({ id, role: "user", content: trimmed })
      .catch((error: unknown) => showToast("error", String(error)));

    const answer = await chat.ask(trimmed, {
      turns: turnsToKeep,
      // The chapter is packed around the first question only: after that the
      // history already carries it, and sending a whole chapter every turn is
      // the most expensive way to say the same thing twice. A quoted passage is
      // small and specific enough to travel every time.
      prompt: selection
        ? `引用片段：\n${selection}\n\n问题：${trimmed}`
        : chat.turns.length === 0
          ? // The number is here for the tools, not for the reader: without it the
            // model can only guess which chapter `read_chapter` should read, and
            // a guessed chapter is worse than none.
            `当前章节：第 ${chapterIdx + 1} 章「${chapterTitle}」\n\n${paragraphs.join("\n")}\n\n问题：${trimmed}`
          : trimmed,
      agent: ragMode
        ? { bookId, maxChapter: settings?.spoilerSafe ? chapterIdx : null }
        : undefined,
    });

    // A failed stream is already on screen; storing half an answer would make it
    // look like the model said something it did not.
    if (answer) {
      await appendMessage
        .mutateAsync({
          id,
          role: "assistant",
          content: answer.content,
          reasoning: answer.reasoning || null,
          citations: answer.citations,
          usage: answer.usage,
          tools: answer.tools,
        })
        .catch((error: unknown) => showToast("error", String(error)));
    }
  };

  const onExport = async () => {
    if (!conversationId) return;
    const title = currentTitle || "AI 对话";
    const path = await choose({
      defaultPath: `${title}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    try {
      await exportConversation.mutateAsync({ id: conversationId, path });
      showToast("success", "已导出对话");
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const onDelete = async () => {
    if (!conversationId) return;
    try {
      await deleteConversation.mutateAsync(conversationId);
      startNew();
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const onRename = async () => {
    if (!conversationId) return;
    const title = draftTitle.trim();
    setRenaming(false);
    if (!title) return;
    try {
      await renameConversation.mutateAsync({ id: conversationId, title });
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const empty = chat.turns.length === 0;
  const quickQuestions = settings?.quickQuestions ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline flex items-center gap-1.5 border-b px-3 py-2">
        {renaming ? (
          <GlassInput
            value={draftTitle}
            // Focus on mount, through a ref: `autoFocus` is what the a11y rule
            // forbids, and the reader has just clicked 重命名 — the field is
            // exactly where they are about to type.
            ref={(node) => node?.focus()}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={onRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onRename();
              if (event.key === "Escape") setRenaming(false);
            }}
            aria-label="对话标题"
            className="min-w-0 flex-1"
          />
        ) : (
          <GlassSelect
            value={conversationId ?? ""}
            onChange={(event) => {
              setRenaming(false);
              void open(event.target.value);
            }}
            aria-label="对话"
            className="min-w-0 flex-1"
          >
            <option value="">新对话</option>
            {(conversations.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title || "未命名对话"}
              </option>
            ))}
          </GlassSelect>
        )}
        <GlassIconButton size="sm" variant="subtle" label="新建对话" onClick={startNew}>
          <Plus size={14} />
        </GlassIconButton>
        <GlassIconButton
          size="sm"
          variant="subtle"
          label="重命名对话"
          disabled={!conversationId}
          onClick={() => {
            setDraftTitle(currentTitle);
            setRenaming(true);
          }}
        >
          <PencilSimple size={14} />
        </GlassIconButton>
        <GlassIconButton
          size="sm"
          variant="subtle"
          label="导出对话"
          disabled={!conversationId}
          onClick={onExport}
        >
          <DownloadSimple size={14} />
        </GlassIconButton>
        <GlassIconButton
          size="sm"
          variant="subtle"
          label="删除对话"
          disabled={!conversationId}
          onClick={onDelete}
        >
          <Trash size={14} />
        </GlassIconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {selection && !ragMode && empty && (
          <div className="glass mb-3 rounded-lg p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-text-3 text-[11px]">引用片段</p>
              <button
                type="button"
                aria-label="清除引用"
                onClick={onClearSelection}
                className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
            <p className="text-text-2 line-clamp-4 text-[12.5px] leading-relaxed">{selection}</p>
          </div>
        )}

        {chat.turns.map((turn) => (
          <Turn
            key={turn.id}
            turn={turn}
            streaming={chat.streaming}
            showUsage={showUsage}
            price={settings?.tokenPrice}
            onJump={onJump}
          />
        ))}

        {chat.error && (
          <div className="mt-2">
            <AiErrorCard message={chat.error} />
          </div>
        )}

        {empty && !chat.streaming && !chat.error && (
          <p className="text-text-3 text-[13px] leading-relaxed">
            选中正文点「问
            AI」可以针对片段提问；不带引用时，助手会读整章再回答。同一本书里的对话会保存下来，下次可以接着问。
          </p>
        )}
      </div>

      {empty && quickQuestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {quickQuestions.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => void ask(question)}
              className="glass text-text-2 hover:text-text-1 focus-visible:focus-ring rounded-full px-2.5 py-1 text-[12px] transition-colors"
            >
              {question}
            </button>
          ))}
        </div>
      ) : null}

      {/* Always offered: even with no embedding model the assistant can still
          read a chapter, draw a map or count words — the search tool is the only
          one that needs an index, and it says so itself when it is missing. */}
      <div className="border-hairline flex items-center justify-between gap-2 border-t px-3 py-2">
        <button
          type="button"
          aria-pressed={ragMode}
          onClick={() => setRagMode((on) => !on)}
          className={cn(
            "focus-visible:focus-ring rounded-full border px-2.5 py-1 text-[12px] transition-colors",
            ragMode
              ? "bg-accent text-on-accent border-transparent"
              : "border-hairline text-text-2 hover:text-text-1",
          )}
        >
          让助手查书
        </button>
        {ragMode && ragReady && !thisBookIndexed && (
          <button
            type="button"
            disabled={indexBook.build.isPending}
            onClick={() => indexBook.build.mutate()}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 text-[12px] transition-colors disabled:opacity-60"
          >
            {indexBook.build.isPending && indexBook.progress
              ? `索引中 ${indexBook.progress.done}/${indexBook.progress.total}`
              : "本书未索引，点此建立"}
          </button>
        )}
        {ragMode && !ragReady && (
          <span className="text-text-3 text-[11px]">未配置向量模型，只能读章节</span>
        )}
      </div>

      <form
        className="border-hairline flex items-center gap-2 border-t px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input);
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={
            ragMode ? "就全书内容提问…" : selection ? "就这段内容提问…" : "就本章内容提问…"
          }
          aria-label="问题"
          disabled={chat.streaming}
          className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent h-8 min-w-0 flex-1 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none disabled:opacity-60"
        />
        {/* While a turn runs the same slot is the way out of it. A disabled
            button and no stop would leave the panel locked for as long as the
            model keeps calling tools. */}
        {chat.streaming ? (
          <button
            type="button"
            onClick={chat.cancel}
            className="focus-visible:focus-ring border-hairline text-text-2 hover:text-text-1 shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            停止
          </button>
        ) : (
          <button
            type="submit"
            disabled={input.trim() === ""}
            className="focus-visible:focus-ring bg-accent text-on-accent rounded-full px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            提问
          </button>
        )}
      </form>
    </div>
  );
}

/** One exchange: the question in a quiet block, the answer as prose. */
function Turn({
  turn,
  streaming,
  showUsage,
  price,
  onJump,
}: {
  turn: ChatTurn;
  streaming: boolean;
  showUsage: boolean;
  price: Parameters<typeof TokenUsageBar>[0]["price"];
  onJump: (hit: RagHit) => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="mb-3 flex justify-end">
        <p className="bg-surface-2 text-text-1 max-w-[85%] rounded-2xl rounded-br-sm px-3 py-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
          {turn.content}
        </p>
      </div>
    );
  }

  // A turn with nothing in it is either the answer being written or one that
  // failed; the second is already reported by the error card below it.
  if (!turn.content && !streaming) return null;
  const thinking = streaming && !turn.content;

  return (
    <div className="mb-4">
      {turn.reasoning ? (
        <details className="mb-2">
          <summary className="text-text-3 hover:text-text-2 cursor-pointer text-[11px] transition-colors select-none">
            思考过程
          </summary>
          <p className="text-text-3 border-hairline mt-1.5 border-l pl-2.5 text-[12px] leading-relaxed whitespace-pre-wrap">
            {turn.reasoning}
          </p>
        </details>
      ) : null}

      {turn.tools?.map((tool, index) => (
        // Index as the key: two searches in one turn are the same component with
        // no identity of their own, and the list only ever grows at the end.
        // oxlint-disable-next-line react/no-array-index-key
        <ToolRow key={index} tool={tool} onJump={onJump}>
          {tool.mindmap || tool.wordcloud ? (
            <Suspense fallback={null}>
              <ToolArtifact tool={tool} />
            </Suspense>
          ) : null}
        </ToolRow>
      ))}

      {thinking ? (
        <p className="text-text-3 text-[12.5px]">正在思考…</p>
      ) : (
        <Markdown text={turn.content} />
      )}

      {turn.citations && turn.citations.length > 0 ? (
        <div className="border-hairline mt-2 border-t pt-2">
          <p className="text-text-3 mb-1 text-[11px]">来源</p>
          <ul className="space-y-1">
            {turn.citations.map((hit, index) => (
              <li key={`${hit.bookId}-${hit.chapterIdx}-${hit.startChar}`}>
                <button
                  type="button"
                  onClick={() => onJump(hit)}
                  className="focus-visible:focus-ring text-text-2 hover:text-accent w-full rounded-md text-left text-[12px] leading-relaxed transition-colors"
                >
                  [{index + 1}] 《{hit.bookTitle}》 第 {hit.chapterIdx + 1} 章
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showUsage && turn.usage ? <TokenUsageBar usage={turn.usage} price={price} /> : null}
    </div>
  );
}

/** A stored message as a renderable turn. */
function toTurn(message: StoredMessage): ChatTurn {
  return {
    id: `stored-${message.id}`,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    reasoning: message.reasoning ?? undefined,
    citations: message.citations,
    usage: message.usage,
    tools: message.tools,
  };
}
