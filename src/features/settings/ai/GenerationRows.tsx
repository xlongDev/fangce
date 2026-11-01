import { Plus, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput, GlassRange } from "@/components/glass/input";
import { Row } from "@/features/settings/section";
import { Block, NumberRow, SwitchRow } from "@/features/settings/ai/fields";
import type { Setter } from "@/features/settings/ai/fields";
import type { AiConfigFull } from "@/lib/aiConfig";

export interface GenerationRowsProps {
  draft: AiConfigFull;
  set: Setter;
  /** Disabled in the browser build, where the backend's defaults do not exist. */
  canRestoreQuestions: boolean;
  onRestoreQuestions: () => void;
}

/**
 * The knobs that shape an answer.
 *
 * Every one of these is sent with the request rather than stored in the model,
 * which is why they live here and not in a per-book setting: a reader tunes them
 * once and forgets them.
 */
export function GenerationRows({
  draft,
  set,
  canRestoreQuestions,
  onRestoreQuestions,
}: GenerationRowsProps) {
  return (
    <>
      <Row
        label="温度"
        hint="控制回答的随机程度：越低越稳定、越贴近检索结果；越高越发散。建议 0.3～0.7。"
      >
        <div className="flex w-full items-center gap-3">
          <GlassRange
            min={0}
            max={2}
            step={0.1}
            value={draft.temperature}
            onChange={(event) => set("temperature", Number(event.target.value))}
            aria-label="温度"
          />
          <span className="text-text-2 w-9 shrink-0 text-right text-[13px] tabular-nums">
            {draft.temperature.toFixed(1)}
          </span>
        </div>
      </Row>
      <NumberRow
        label="最大 Token 数"
        hint="单次回复允许生成的最大长度。过小会截断长回答，过大则更慢、更耗额度。"
        value={draft.maxTokens}
        min={64}
        max={32000}
        step={256}
        onChange={(next) => set("maxTokens", next)}
      />
      <NumberRow
        label="上下文轮数"
        hint="发给模型的历史对话保留几轮（一问一答算一轮）。越大越连贯，也越占 Token。"
        value={draft.contextTurns}
        min={1}
        max={40}
        onChange={(next) => set("contextTurns", next)}
      />
      <NumberRow
        label="工具调用轮数"
        hint="单次提问里，模型最多可以来回调用几次检索工具。复杂问题可以调高；工具能力随下一版落地，这里先存着。"
        value={draft.maxToolRounds}
        min={1}
        max={16}
        onChange={(next) => set("maxToolRounds", next)}
      />
      <SwitchRow
        label="深度思考"
        hint="让支持推理的模型先想再答，思考过程会折叠显示。识别不出服务商时不发送任何参数；开启后温度固定为 1。"
        checked={draft.deepThinking}
        onChange={(next) => set("deepThinking", next)}
      />

      <Block
        title="快速提问"
        hint="还没有对话时，输入框上方会显示这几个问题，点一下直接发送。"
        action={
          <button
            type="button"
            onClick={onRestoreQuestions}
            disabled={!canRestoreQuestions}
            className="text-text-3 hover:text-text-1 focus-visible:focus-ring shrink-0 rounded text-xs transition-colors disabled:pointer-events-none disabled:opacity-40"
          >
            恢复默认
          </button>
        }
      >
        <div className="mt-2.5 space-y-1.5">
          {draft.quickQuestions.map((question, index) => (
            // Index as the key on purpose: these rows have no identity of their
            // own (the text *is* the value), and a key derived from the text
            // would remount the input on every keystroke and drop the caret.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index} className="flex items-center gap-2">
              <GlassInput
                value={question}
                onChange={(event) =>
                  set(
                    "quickQuestions",
                    draft.quickQuestions.map((entry, at) =>
                      at === index ? event.target.value : entry,
                    ),
                  )
                }
                aria-label={`快速提问 ${index + 1}`}
                placeholder="问点什么…"
                className="min-w-0"
              />
              <GlassButton
                variant="subtle"
                size="sm"
                aria-label={`删除第 ${index + 1} 条快速提问`}
                onClick={() =>
                  set(
                    "quickQuestions",
                    draft.quickQuestions.filter((_, at) => at !== index),
                  )
                }
                leading={<Trash size={13} />}
              />
            </div>
          ))}
          {draft.quickQuestions.length === 0 ? (
            <p className="text-text-3 text-[12px]">还没有快速提问。</p>
          ) : null}
        </div>
        <div className="mt-2 flex gap-2">
          <GlassButton
            variant="subtle"
            size="sm"
            onClick={() => set("quickQuestions", [...draft.quickQuestions, ""])}
            disabled={draft.quickQuestions.length >= 12}
            leading={<Plus size={13} />}
          >
            添加一项
          </GlassButton>
        </div>
      </Block>
    </>
  );
}
