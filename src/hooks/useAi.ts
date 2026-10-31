import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc, onAiStream } from "@/lib/ipc";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { AiConfig, AiMessage, RagHit } from "@/types/ipc";
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

/** One question and its streamed answer. A new send replaces the old exchange:
 * a reading assistant answers one thing at a time, and history belongs to the
 * annotations phase, not here.
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

  /** Retrieval-backed variant; citations arrive on the final stream event. */
  const askRag = useCallback(
    (question: string, bookId: string | null) =>
      start((requestId) => ipc.ragChat(requestId, question, bookId)),
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

  return { ...state, send, askRag, sendDigest, reset };
}
