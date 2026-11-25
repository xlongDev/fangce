import { GlassInput } from "@/components/glass/input";
import { Row } from "@/features/settings/section";
import type { Setter } from "@/features/settings/ai/fields";
import type { AiConfigFull } from "@/lib/aiConfig";

/**
 * A reader's own read-aloud service.
 *
 * One OpenAI-compatible `/audio/speech` endpoint, one model, one voice. Empty
 * address means off: the service catalogue and the platform's own voices are
 * then all there is, which is what a reader who never configured anything sees.
 *
 * There is no backend selector — unlike image generation, there is only one
 * wire shape worth supporting here, and a selector for one option is a setting
 * nobody can change.
 */
export function TtsRows({ draft, set }: { draft: AiConfigFull; set: Setter }) {
  const on = draft.ttsBaseUrl.trim() !== "";

  return (
    <>
      <Row
        label="自定义语音接口地址"
        hint="OpenAI 兼容的 /audio/speech 地址，填到 /v1 为止。留空即用 Edge 与系统语音。"
      >
        <GlassInput
          value={draft.ttsBaseUrl}
          onChange={(event) => set("ttsBaseUrl", event.target.value)}
          placeholder="https://api.openai.com/v1"
          aria-label="自定义语音接口地址"
          spellCheck={false}
        />
      </Row>

      {on && (
        <>
          <Row label="语音 API Key" hint="本地服务通常不需要。">
            <GlassInput
              type="password"
              value={draft.ttsApiKey}
              onChange={(event) => set("ttsApiKey", event.target.value)}
              placeholder="本地服务留空"
              aria-label="语音 API Key"
              autoComplete="off"
            />
          </Row>
          <Row label="语音模型" hint="例如 tts-1、gpt-4o-mini-tts，或本地服务的模型名。">
            <GlassInput
              value={draft.ttsModel}
              onChange={(event) => set("ttsModel", event.target.value)}
              placeholder="tts-1"
              aria-label="语音模型"
              spellCheck={false}
            />
          </Row>
          <Row label="音色" hint="服务认识的名字，例如 nova、alloy。会单独出现在朗读的音色列表里。">
            <GlassInput
              value={draft.ttsVoice}
              onChange={(event) => set("ttsVoice", event.target.value)}
              placeholder="nova"
              aria-label="音色"
              spellCheck={false}
            />
          </Row>
          <p className="text-text-3 px-5 py-3 text-[11.5px] leading-relaxed">
            自定义接口不提供逐字时间戳，朗读时会整句高亮；语速仍在播放侧调整，改语速不会重新合成。
            改完音色名或模型后，重新点朗读即可生效。
          </p>
        </>
      )}
    </>
  );
}
