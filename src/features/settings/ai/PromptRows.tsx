import { Block } from "@/features/settings/ai/fields";
import type { Setter } from "@/features/settings/ai/fields";
import type { AiConfigFull } from "@/lib/aiConfig";

export interface PromptRowsProps {
  draft: AiConfigFull;
  set: Setter;
  /** The backend's built-in prompt; `undefined` in the browser build. */
  defaultPrompt: string | undefined;
}

/**
 * The assistant's voice, in two parts.
 *
 * Split from the endpoint because they are edited at different times and for
 * different reasons: the address is set once and forgotten, the prompt is what a
 * reader tweaks after a few answers they did not like. Keeping them in one card
 * made that card taller than the pane it scrolls in.
 */
export function PromptRows({ draft, set, defaultPrompt }: PromptRowsProps) {
  return (
    <>
      <Block
        title="系统提示词"
        hint="每次提问都会附带，决定助手的语气与边界。"
        action={
          <button
            type="button"
            onClick={() => defaultPrompt && set("systemPrompt", defaultPrompt)}
            disabled={!defaultPrompt}
            className="text-text-3 hover:text-text-1 focus-visible:focus-ring shrink-0 rounded text-xs transition-colors disabled:pointer-events-none disabled:opacity-40"
          >
            恢复默认
          </button>
        }
      >
        <textarea
          value={draft.systemPrompt}
          onChange={(event) => set("systemPrompt", event.target.value)}
          rows={3}
          aria-label="系统提示词"
          spellCheck={false}
          className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 mt-2.5 min-h-[76px] w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed transition-colors focus-visible:outline-none"
        />
      </Block>
      <Block
        title="附加系统提示词"
        hint="接在系统提示词后面。不想动默认语气、只想补一句时用它，比如「这是网络小说，别端着」。"
      >
        <textarea
          value={draft.systemPromptExtra}
          onChange={(event) => set("systemPromptExtra", event.target.value)}
          rows={2}
          aria-label="附加系统提示词"
          spellCheck={false}
          placeholder="留空则不加"
          className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent focus-visible:bg-surface-2 mt-2.5 min-h-[56px] w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed transition-colors focus-visible:outline-none"
        />
      </Block>
    </>
  );
}
