import { create } from "zustand";

import { AI_SETTINGS } from "@/lib/routes";

export type ToastTone = "error" | "success";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Where to send the reader when the message is about something they can fix. */
  action?: { label: string; to: string };
}

/** Long enough to read a sentence, short enough that a stack clears itself. */
const TIMEOUT_MS = 6_000;

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

/**
 * Transient error and success messages.
 *
 * Deliberately a store rather than query state: nothing here comes from the
 * backend, and the read path is the whole app rather than one route.
 */
export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],

  push: (toast) => {
    // A retried save that keeps failing would otherwise stack the same line
    // every few seconds; one copy on screen already says it.
    const shown = get().toasts.some((t) => t.tone === toast.tone && t.message === toast.message);
    if (shown) return;

    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => get().dismiss(id), TIMEOUT_MS);
  },

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/**
 * Errors that name a missing setting get a way to go and set it.
 *
 * Recognised here rather than at each call site: the message is already the
 * thing that knows, and there are a dozen places that report one. A reader who
 * is told their key is wrong should not have to remember where the key lives.
 *
 * Only the AI vocabulary is matched. A bare `401` would also catch WebDAV's
 * "读取云端状态失败：HTTP 401" and send the reader to the wrong group — a
 * failure that is one click away from being worse than no link at all.
 */
const AI_SETTINGS_HINT = /API ?Key|模型|接口地址|鉴权|密钥/i;

/** The non-React entry point — the query cache reports failures from outside a component. */
export function showToast(tone: ToastTone, message: string): void {
  const action =
    tone === "error" && AI_SETTINGS_HINT.test(message)
      ? { label: "去设置", to: AI_SETTINGS }
      : undefined;
  useToasts.getState().push({ tone, message, action });
}
