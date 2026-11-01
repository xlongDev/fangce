import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, onAiStream } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { trimHistory } from "@/lib/aiChat";
import type {
  AiConfig,
  AiMessage,
  Conversation,
  ConversationSummary,
  RagHit,
  StoredMessage,
  LocalEmbeddingEndpoint,
  TokenUsage,
  ToolCallView,
} from "@/types/ipc";
import type { OcFerryDiscovery } from "@/lib/bindings";

/** Browser dev mode has no backend; the settings form still needs a shape. */
const OFFLINE_CONFIG: AiConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  systemPrompt: "",
  embeddingModel: "",
  rerankModel: "",
  deeplKey: "",
};

/** Persisted AI config. `staleTime: Infinity` — it only changes through this app. */
export function useAiConfig() {
  return useQuery<AiConfig>({
    queryKey: ["ai", "config"],
    queryFn: desktopQuery(OFFLINE_CONFIG, () => ipc.aiGetConfig()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Saves the config; the query is refreshed so the form shows what is stored. */
export function useSaveAiConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: AiConfig) => ipc.aiSetConfig(config),
    meta: { silent: true },
    // `onSettled` would run on failure too, where `saved` is `undefined` — and
    // writing that into the cache blanks the form it is meant to refresh.
    onSuccess: (saved) => {
      queryClient.setQueryData(["ai", "config"], saved);
    },
  });
}

/** Proves endpoint, key and model work together. Does not persist anything. */
export function useTestAiConfig() {
  return useMutation({
    mutationFn: (config: AiConfig) => ipc.aiTest(config),
    meta: { silent: true },
  });
}

/** The built-in system prompt, so the settings page can restore it without a
 *  hand-kept copy drifting from the backend's. Static for a session. */
export function useAiDefaultSystemPrompt() {
  return useQuery<string>({
    queryKey: ["ai", "default-system-prompt"],
    queryFn: desktopQuery("", () => ipc.aiDefaultSystemPrompt()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * A fully populated default config, from the backend.
 *
 * The browser has none — it also has no settings to restore, so the buttons that
 * need this are disabled there rather than filled with a second copy of the
 * numbers that could drift from `AiConfig::default()`.
 */
export function useAiDefaults() {
  return useQuery<AiConfig | null>({
    queryKey: ["ai", "defaults"],
    queryFn: desktopQuery(null, () => ipc.aiDefaults()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Looks for a local runtime (Ollama, LM Studio) and its embedding models.
 *
 *  The cheap answer to "I want embeddings on this machine": the runtime the
 *  reader already has embeds better than anything this app would bundle, and
 *  finding its port is the only part that was ever manual.
 */
export function useProbeLocalEmbeddings() {
  return useMutation<LocalEmbeddingEndpoint[], unknown, void>({
    mutationFn: () => ipc.aiProbeLocalEmbeddings(),
    meta: { silent: true },
  });
}

/** `GET {baseUrl}/models`, for the model picker. */
export function useAiListModels() {
  return useMutation<string[], unknown, AiConfig>({
    mutationFn: (config) => ipc.aiListModels(config),
    meta: { silent: true },
  });
}

/** Detects a running OC Ferry on the loopback and returns its endpoint, key and
 *  vetted model ids, so the AI settings can be pointed at it without copying. */
export function useDetectOcFerry() {
  return useMutation<OcFerryDiscovery, unknown, void>({
    mutationFn: () => ipc.aiDetectOcFerry(),
    meta: { silent: true },
  });
}

interface ChatState {
  /** Answer accumulated so far. */
  text: string;
  streaming: boolean;
  error: string | null;
  /** RAG sources, set on the final event of a retrieval-backed answer. */
  citations: RagHit[];
}

const IDLE: ChatState = { text: "", streaming: false, error: null, citations: [] };

/** One question and its streamed answer, for the surfaces that ask exactly one:
 *  the selection toolbar and the reading guide.
 *
 *  A conversation belongs to [`useChatStream`]; this stays single-shot on
 *  purpose, because "explain this paragraph" has no history to keep.
 */
export function useAiChat() {
  const [state, setState] = useState<ChatState>(IDLE);
  // Read inside the event listener, written inside callbacks — never during
  // render — so a late stream from an abandoned request is dropped, not shown.
  const activeRequest = useRef<string | null>(null);

  useTauriEvent(onAiStream, (delta) => {
    if (delta.requestId !== activeRequest.current) return;
    if (delta.error) {
      setState({ text: "", streaming: false, error: delta.error, citations: [] });
      return;
    }
    setState((prev) => ({
      text: delta.text === null ? prev.text : prev.text + delta.text,
      streaming: !delta.done,
      error: null,
      citations: delta.citations ?? prev.citations,
    }));
  });

  // `unknown`, not `void`: the generated commands resolve to `null` for a
  // Rust `()`, and nothing here reads the value — only `.catch` matters.
  const start = useCallback((run: (requestId: string) => Promise<unknown>) => {
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    setState({ text: "", streaming: true, error: null, citations: [] });
    run(requestId).catch((err: unknown) => {
      if (activeRequest.current !== requestId) return;
      setState({ text: "", streaming: false, error: String(err), citations: [] });
    });
  }, []);

  const send = useCallback(
    (messages: AiMessage[]) => start((requestId) => ipc.aiChat(requestId, messages)),
    [start],
  );

  /**
   * The reading guide for one book. The backend answers from its own cache when
   * a guide exists, so this is safe to call on every panel open; `refresh`
   * writes a new one.
   */
  const sendDigest = useCallback(
    (bookId: string, refresh = false) =>
      start((requestId) => ipc.aiDigest(requestId, bookId, refresh)),
    [start],
  );

  const reset = useCallback(() => {
    activeRequest.current = null;
    setState(IDLE);
  }, []);

  return { ...state, send, sendDigest, reset };
}

/** One rendered exchange. The panel draws these; the hook grows the last one. */
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  citations?: RagHit[];
  usage?: TokenUsage | null;
  /** Calls the model made while producing this answer, in order. */
  tools?: ToolCallView[];
}

/** What a finished answer amounts to, handed back so the caller can store it. */
export interface FinishedAnswer {
  content: string;
  reasoning: string;
  citations: RagHit[];
  usage: TokenUsage | null;
  tools: ToolCallView[];
}

interface StreamState {
  turns: ChatTurn[];
  streaming: boolean;
  error: string | null;
}

const EMPTY: StreamState = { turns: [], streaming: false, error: null };

export interface AskOptions {
  /** Let the assistant look things up itself (tools) instead of answering from
   *  the chapter in hand. */
  agent?: { bookId: string | null; maxChapter: number | null };
  /** How many past exchanges travel with the question. */
  turns: number;
  /**
   * What the model is sent, when it is not simply the question — the chapter in
   * hand, or the passage being quoted. The *stored* turn is always the bare
   * question: the transcript is what the reader asked, not what was packed
   * around it.
   */
  prompt?: string;
}

/**
 * A conversation with the assistant: history, streaming, reasoning and usage.
 *
 * `ask` resolves on the *final stream event*, not when the command returns —
 * those are two different moments, and the assembled answer is only complete at
 * the first of them. Resolving there is what lets the caller store exactly what
 * was said without racing the last delta.
 */
export function useChatStream() {
  const [state, setState] = useState<StreamState>(EMPTY);
  const activeRequest = useRef<string | null>(null);
  /** The turns as of the last write, readable from an event handler. */
  const turnsRef = useRef<ChatTurn[]>([]);
  const assembled = useRef<FinishedAnswer>({
    content: "",
    reasoning: "",
    citations: [],
    usage: null,
    tools: [],
  });
  const settle = useRef<((answer: FinishedAnswer | null) => void) | null>(null);

  const commit = useCallback((turns: ChatTurn[]) => {
    turnsRef.current = turns;
    setState((prev) => ({ ...prev, turns }));
  }, []);

  useTauriEvent(onAiStream, (delta) => {
    if (delta.requestId !== activeRequest.current) return;

    if (delta.error) {
      setState((prev) => ({ ...prev, streaming: false, error: delta.error ?? null }));
      settle.current?.(null);
      settle.current = null;
      return;
    }

    if (delta.text) assembled.current.content += delta.text;
    if (delta.reasoning) assembled.current.reasoning += delta.reasoning;
    // A tool row arrives as its own event, in the order the calls ran, and is
    // kept for the whole turn so the panel can draw the map the model asked for.
    if (delta.tool) assembled.current.tools = [...assembled.current.tools, delta.tool];
    if (delta.done) {
      assembled.current.citations = delta.citations ?? [];
      assembled.current.usage = delta.usage ?? null;
    }

    // The last turn is the answer being written; a delta is appended to it in
    // place rather than kept in a second "live" string, so what is on screen and
    // what gets stored are the same value.
    const turns = turnsRef.current.map((turn, index) =>
      index === turnsRef.current.length - 1 && turn.role === "assistant"
        ? {
            ...turn,
            content: assembled.current.content,
            reasoning: assembled.current.reasoning || undefined,
            citations: delta.done ? assembled.current.citations : turn.citations,
            usage: delta.done ? assembled.current.usage : turn.usage,
            tools: assembled.current.tools,
          }
        : turn,
    );
    commit(turns);
    setState((prev) => ({ ...prev, streaming: !delta.done, error: null }));

    if (delta.done) {
      settle.current?.(assembled.current);
      settle.current = null;
    }
  });

  /**
   * Sends one question. Resolves with the answer, or `null` when the stream
   * failed — a failed turn is already reported through `error`, and the caller
   * must not store half an answer.
   */
  const ask = useCallback(
    (question: string, options: AskOptions): Promise<FinishedAnswer | null> => {
      const trimmed = question.trim();
      if (!trimmed) return Promise.resolve(null);

      // An answer that failed leaves an empty assistant turn on screen. It is
      // not part of the conversation — sending it back would tell the model it
      // once said nothing.
      const history = trimHistory(
        turnsRef.current
          .filter((turn) => turn.content.trim() !== "")
          .map((turn) => ({ role: turn.role, content: turn.content })),
        options.turns,
      );
      const requestId = crypto.randomUUID();
      activeRequest.current = requestId;
      assembled.current = { content: "", reasoning: "", citations: [], usage: null, tools: [] };

      const next: ChatTurn[] = [
        ...turnsRef.current,
        { id: crypto.randomUUID(), role: "user", content: trimmed },
        { id: crypto.randomUUID(), role: "assistant", content: "" },
      ];
      turnsRef.current = next;
      setState({ turns: next, streaming: true, error: null });

      const run = options.agent
        ? ipc.aiAgentChat(
            requestId,
            // Same text the plain path sends: the chapter in hand on the first
            // turn, the quote when there is one. The tools are *additional* to
            // what the reader can already see, not a replacement for it — a
            // book with no index would otherwise leave the model with nothing.
            options.prompt ?? trimmed,
            options.agent.bookId,
            history,
            options.agent.maxChapter,
          )
        : ipc.aiChat(requestId, [...history, { role: "user", content: options.prompt ?? trimmed }]);

      return new Promise<FinishedAnswer | null>((resolve) => {
        settle.current = resolve;
        run.catch((err: unknown) => {
          if (activeRequest.current !== requestId) return;
          setState((prev) => ({ ...prev, streaming: false, error: String(err) }));
          settle.current?.(null);
          settle.current = null;
        });
      });
    },
    [],
  );

  /** Replaces the conversation with a stored one (or empties it). */
  const hydrate = useCallback((turns: ChatTurn[]) => {
    activeRequest.current = null;
    settle.current?.(null);
    settle.current = null;
    turnsRef.current = turns;
    setState({ turns, streaming: false, error: null });
  }, []);

  const reset = useCallback(() => hydrate([]), [hydrate]);

  /**
   * Asks the turn in flight to stop.
   *
   * The panel does not settle anything here: the backend stops at the next chunk
   * or the next round and sends its own `done`, which is what resolves `ask`
   * with the text that did arrive. Settling locally would race that event and
   * could store a shorter answer than the one on screen.
   */
  const cancel = useCallback(() => {
    const id = activeRequest.current;
    if (!id) return;
    void ipc.aiCancel(id).catch(() => {
      // Nothing to do: the turn is already over, or the id was never registered.
    });
  }, []);

  return { ...state, ask, cancel, hydrate, reset };
}

/* ------------------------------------------------------------------ history */

/** The conversations of one book, newest first. */
export function useAiConversations(bookId: string | null) {
  return useQuery<ConversationSummary[]>({
    queryKey: ["ai", "conversations", bookId],
    queryFn: desktopQuery<ConversationSummary[]>([], () =>
      bookId ? ipc.aiConversationList(bookId) : Promise.resolve([]),
    ),
  });
}

/** One conversation with its messages, loaded on demand.
 *
 *  A mutation rather than a query on purpose: the panel needs it *once*, at the
 *  moment the reader picks a conversation, and then owns the turns itself.
 *  Keeping it as a live query would mean re-hydrating the transcript every time
 *  storing an answer invalidated it — which is exactly when it must not.
 */
export function useLoadAiConversation() {
  return useMutation<Conversation, unknown, string>({
    mutationFn: (id) => ipc.aiConversationGet(id),
    meta: { silent: true },
  });
}

/** Creates a conversation and refreshes the switcher. */
export function useCreateAiConversation() {
  const queryClient = useQueryClient();
  return useMutation<ConversationSummary, unknown, string | null>({
    mutationFn: (bookId) => ipc.aiConversationCreate(bookId),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai", "conversations"] }),
  });
}

/** Stores one finished turn. */
export function useAppendAiMessage() {
  const queryClient = useQueryClient();
  return useMutation<
    StoredMessage,
    unknown,
    {
      id: string;
      role: "user" | "assistant";
      content: string;
      reasoning?: string | null;
      citations?: RagHit[];
      usage?: TokenUsage | null;
      /** What the assistant looked up or drew; kept with the message so a
       *  mind map survives closing the panel. */
      tools?: ToolCallView[];
    }
  >({
    mutationFn: ({ id, role, content, reasoning, citations, usage, tools }) =>
      ipc.aiConversationAppend(
        id,
        role,
        content,
        reasoning ?? null,
        citations ?? [],
        usage ?? null,
        tools ?? [],
      ),
    meta: { silent: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai", "conversations"] }),
  });
}

export function useRenameAiConversation() {
  const queryClient = useQueryClient();
  return useMutation<null, unknown, { id: string; title: string }>({
    mutationFn: ({ id, title }) => ipc.aiConversationRename(id, title),
    meta: { silent: true },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai", "conversations"] });
      queryClient.invalidateQueries({ queryKey: ["ai", "conversation"] });
    },
  });
}

export function useDeleteAiConversation() {
  const queryClient = useQueryClient();
  return useMutation<null, unknown, string>({
    mutationFn: (id) => ipc.aiConversationDelete(id),
    meta: { silent: true },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai", "conversations"] });
      queryClient.invalidateQueries({ queryKey: ["ai", "conversation"] });
    },
  });
}

/** Writes one conversation out as Markdown, through the native save panel. */
export function useExportAiConversation() {
  return useMutation<null, unknown, { id: string; path: string }>({
    mutationFn: ({ id, path }) => ipc.aiConversationExport(id, path),
    meta: { silent: true },
  });
}
