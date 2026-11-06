import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowsClockwise,
  Broom,
  DotsThreeVertical,
  DownloadSimple,
  EyeSlash,
  PencilSimple,
  Plus,
  Sparkle,
  Trash,
  X,
} from "@phosphor-icons/react";

import { AiErrorCard } from "@/components/common/AiErrorCard";
import { AiSpeechButton } from "@/components/common/AiSpeechButton";
import { Markdown } from "@/components/common/Markdown";
import { GlassIconButton } from "@/components/glass/button";
import { GlassInput, GlassSelect } from "@/components/glass/input";
import { GlassMenu, GlassMenuItem } from "@/components/glass/menu";
import {
  useAiConfig,
  useAiConversations,
  useAppendAiMessage,
  useChatStream,
  useClearAiConversations,
  useCreateAiConversation,
  useDeleteAiConversation,
  useExportAiConversation,
  useLoadAiConversation,
  useRenameAiConversation,
  useSaveAiConfig,
  type ChatTurn,
} from "@/hooks/useAi";
import {
  useClearIndex,
  useClearLibrary,
  useIndexBook,
  useRagStatus,
  useRebuildLibrary,
} from "@/hooks/useRag";
import { useSavePath } from "@/hooks/useSavePath";
import { setToolsEnabled, toolsEnabled } from "@/lib/aiToolPreference";
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
import type { AiConfig, RagHit, StoredMessage } from "@/types/ipc";

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
  // On unless the reader turned it off: tools the model cannot see are tools
  // it cannot pick, and 「梳理人物关系」 without them is a paragraph.
  const [ragMode, setRagMode] = useState(toolsEnabled);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const status = useRagStatus(bookId);
  const indexBook = useIndexBook(bookId);
  const ragReady = (status.data?.embeddingModel ?? "") !== "";
  const thisBookIndexed = (status.data?.bookChunks ?? 0) > 0;
  const bookStale = status.data?.bookStale ?? false;
  const staleBooks = status.data?.staleBooks ?? 0;
  const libraryChunks = status.data?.libraryChunks ?? 0;

  const saveConfig = useSaveAiConfig();
  const clearIndex = useClearIndex(bookId);
  const library = useRebuildLibrary();
  const clearLibrary = useClearLibrary();
  const clearConversations = useClearAiConversations(bookId);
  /** Which deletion the strip under the header is asking about, if any. Both
   *  are irreversible, and both live behind one confirm rather than two. */
  const [confirming, setConfirming] = useState<"none" | "one" | "all">("none");

  /**
   * Writes one preference back to the config.
   *
   * The panel's chips and the settings page edit the same switches, so the
   * panel saves rather than keeping a copy: a reader who turns 防剧透 on here
   * should find it on there, and the backend reads only the stored value.
   */
  const setPreference = (
    patch: Partial<Pick<AiConfig, "deepThinking" | "spoilerSafe" | "model">>,
  ) => {
    if (!config.data) return;
    saveConfig.mutate({ ...config.data, ...patch });
  };

  /** The open conversation's title, from the list — the transcript itself is
   *  owned by the stream hook and is not re-read. */
  const currentTitle =
    (conversations.data ?? []).find((entry) => entry.id === conversationId)?.title ?? "";
  const conversationCount = (conversations.data ?? []).length;

  /**
   * The models the reader can pick without opening settings.
   *
   * Only what the app already knows: the one in use, plus the ones an OC Ferry
   * import brought in. A hand-typed endpoint has no model list to ask for, and
   * inventing one would be a dropdown of guesses.
   */
  const modelChoices = [
    ...new Set([settings?.model ?? "", ...(settings?.importedModels ?? [])].filter(Boolean)),
  ];

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
  // Only the newest answer may start itself when a stream ends. Every older
  // turn sees the same falling edge, so passing `streaming` to all of them
  // would start one voice per turn at the same `done`.
  const lastAssistantId = chat.turns.reduce<string | null>(
    (last, turn) => (turn.role === "assistant" ? turn.id : last),
    null,
  );

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
        {/* Everything that is not "ask another question" lives behind one
            button. The header has 272px to spend and the switcher needs most of
            it: five 38px buttons left the conversation's own title 50px, which
            is not a title, it is an ellipsis. */}
        <GlassMenu
          label="对话与索引"
          trigger={
            <GlassIconButton size="sm" variant="subtle" label="更多">
              <DotsThreeVertical size={14} />
            </GlassIconButton>
          }
        >
          <GlassMenuItem
            icon={<PencilSimple size={14} />}
            label="重命名对话"
            disabled={!conversationId}
            onClick={() => {
              setDraftTitle(currentTitle);
              setRenaming(true);
            }}
          />
          <GlassMenuItem
            icon={<DownloadSimple size={14} />}
            label="导出对话"
            disabled={!conversationId}
            onClick={() => void onExport()}
          />
          <GlassMenuItem
            icon={<Trash size={14} />}
            tone="danger"
            label="删除这个对话"
            disabled={!conversationId}
            onClick={() => setConfirming("one")}
          />
          <div className="border-hairline my-1.5 border-t" />
          <GlassMenuItem
            icon={<ArrowsClockwise size={14} />}
            label={
              indexBook.build.isPending && indexBook.progress
                ? `重建中 ${indexBook.progress.done}/${indexBook.progress.total}`
                : "重建本书索引"
            }
            disabled={!ragReady || indexBook.build.isPending}
            onClick={() => indexBook.build.mutate()}
          />
          <GlassMenuItem
            icon={<Broom size={14} />}
            label="清除本书索引"
            disabled={!thisBookIndexed || clearIndex.isPending}
            onClick={() => clearIndex.mutate()}
          />
          <div className="border-hairline my-1.5 border-t" />
          {staleBooks > 0 && (
            <p className="text-text-3 px-2.5 py-1 text-[11.5px] leading-relaxed">
              有 {staleBooks} 本书的索引是旧模型建的
            </p>
          )}
          <GlassMenuItem
            icon={<ArrowsClockwise size={14} />}
            label={
              library.build.isPending && library.progress
                ? `重建中 ${library.progress.done}/${library.progress.total} 本`
                : "重建全库索引"
            }
            disabled={!ragReady || libraryChunks === 0 || library.build.isPending}
            onClick={() => library.build.mutate()}
          />
          <GlassMenuItem
            icon={<Broom size={14} />}
            label="清除全库索引"
            disabled={libraryChunks === 0 || clearLibrary.isPending}
            onClick={() => clearLibrary.mutate()}
          />
          <div className="border-hairline my-1.5 border-t" />
          <GlassMenuItem
            icon={<Trash size={14} />}
            tone="danger"
            label="清除本书对话"
            disabled={conversationCount === 0}
            onClick={() => setConfirming("all")}
          />
        </GlassMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* Deleting is the one action here that cannot be undone, so it asks
            in the place the transcript was — not in a menu row that closes on
            the same click that asked. */}
        {confirming !== "none" && (
          <div className="glass mb-3 rounded-lg p-2.5">
            <p className="text-text-2 text-[12px] leading-relaxed">
              {confirming === "one"
                ? "删除这个对话，不能恢复。"
                : `删除本书的 ${conversationCount} 个对话，不能恢复。`}
            </p>
            <div className="mt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirming("none")}
                className="focus-visible:focus-ring text-text-3 hover:text-text-1 text-[12px] transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                disabled={
                  confirming === "all" ? clearConversations.isPending : deleteConversation.isPending
                }
                onClick={() => {
                  if (confirming === "one") {
                    void onDelete().then(() => setConfirming("none"));
                    return;
                  }
                  clearConversations.mutate(undefined, {
                    onSuccess: () => {
                      setConfirming("none");
                      startNew();
                    },
                    onError: (error) => showToast("error", String(error)),
                  });
                }}
                className="focus-visible:focus-ring text-danger text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                确定删除
              </button>
            </div>
          </div>
        )}

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
            canAutoPlay={turn.role === "assistant" && turn.id === lastAssistantId}
            showUsage={showUsage}
            price={settings?.tokenPrice}
            onJump={onJump}
            speechChapter={chapterTitle}
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
          onClick={() => {
            const next = !ragMode;
            setRagMode(next);
            setToolsEnabled(next);
          }}
          className={cn(
            "focus-visible:focus-ring rounded-full border px-2.5 py-1 text-[12px] transition-colors",
            ragMode
              ? "bg-accent text-on-accent border-transparent"
              : "border-hairline text-text-2 hover:text-text-1",
          )}
        >
          让助手查书
        </button>
        {/* What the switch actually turns on. The label promises looking things
            up; it also unlocks the character card, the mind map and the word
            cloud, and a reader who only reads "查书" will never ask for those. */}
        {!ragMode && (
          <span className="text-text-3 truncate text-[11px]">检索 · 人物卡 · 导图 · 词云</span>
        )}
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
        {/* Retrieval filters on the embedding model, so a book indexed under
            the previous one looks fine here and answers nothing. Saying so is
            the difference between "the assistant is dumb" and "rebuild this". */}
        {ragMode && ragReady && thisBookIndexed && bookStale && (
          <button
            type="button"
            disabled={indexBook.build.isPending}
            onClick={() => indexBook.build.mutate()}
            title="换了向量模型之后，旧索引检索不到"
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 truncate text-[12px] transition-colors disabled:opacity-60"
          >
            {indexBook.build.isPending && indexBook.progress
              ? `重建中 ${indexBook.progress.done}/${indexBook.progress.total}`
              : "索引是旧模型建的，点此重建"}
          </button>
        )}
        {ragMode && !ragReady && (
          <span className="text-text-3 text-[11px]">未配置向量模型，只能读章节</span>
        )}
      </div>

      {/* Three switches that change what the next answer costs or what it is
          allowed to say — kept next to the input, where the reader is about to
          spend the money, rather than in the settings page they would have to
          leave the book to open. */}
      <div className="border-hairline flex items-center gap-1.5 border-t px-3 py-2">
        <Toggle
          label="深度思考"
          icon={<Sparkle size={12} />}
          on={settings?.deepThinking ?? false}
          onToggle={() => setPreference({ deepThinking: !(settings?.deepThinking ?? false) })}
        />
        <Toggle
          label="防剧透"
          icon={<EyeSlash size={12} />}
          on={settings?.spoilerSafe ?? false}
          onToggle={() => setPreference({ spoilerSafe: !(settings?.spoilerSafe ?? false) })}
        />
        {modelChoices.length > 1 && (
          <select
            value={settings?.model ?? ""}
            onChange={(event) => setPreference({ model: event.target.value })}
            aria-label="模型"
            title={settings?.model}
            className="border-hairline text-text-2 hover:text-text-1 focus-visible:focus-ring ml-auto max-w-[46%] min-w-0 appearance-none truncate rounded-full border bg-transparent py-1 pr-2 pl-2.5 text-[11.5px] transition-colors [&>option]:text-black"
          >
            {modelChoices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
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

/** One of the switches above the input.
 *
 *  A pressed chip rather than a checkbox: both of these are "on for the next
 *  answer", they sit two pixels from the button that spends the money, and at
 *  12px a box and a label read as one grey line.
 */
function Toggle({
  label,
  icon,
  on,
  onToggle,
}: {
  label: string;
  icon: ReactNode;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "focus-visible:focus-ring inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11.5px] transition-colors",
        on ? "border-accent text-accent" : "border-hairline text-text-3 hover:text-text-2",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** One exchange: the question in a quiet block, the answer as prose. */
function Turn({
  turn,
  streaming,
  showUsage,
  price,
  onJump,
  speechChapter,
  canAutoPlay,
}: {
  turn: ChatTurn;
  streaming: boolean;
  showUsage: boolean;
  price: Parameters<typeof TokenUsageBar>[0]["price"];
  onJump: (hit: RagHit) => void;
  /** Where the answer came from, shown under its title in the player. */
  speechChapter: string;
  /** Only the newest answer watches the stream's falling edge. */
  canAutoPlay: boolean;
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

      {/* One control per answer, not one for the drawer: the queue belongs to
          the turn the reader chose, and only that turn can stop it. Reasoning,
          tool artefacts and the citation list are deliberately not spoken.
          Drawn even while the answer is still being written — a button that
          mounts only on `done` cannot see the falling edge that starts
          「生成完自动朗读」. */}
      <div className="mt-1 flex justify-end">
        <AiSpeechButton
          id={`turn:${turn.id}`}
          text={turn.content}
          title="AI 助手"
          chapter={speechChapter}
          disabled={streaming || turn.content === ""}
          streaming={canAutoPlay ? streaming : false}
          label="朗读这条回答"
        />
      </div>

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
