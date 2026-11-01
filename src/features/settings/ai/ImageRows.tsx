import { GlassInput, GlassSelect } from "@/components/glass/input";
import { Row } from "@/features/settings/section";
import type { Setter } from "@/features/settings/ai/fields";
import type { AiConfigFull } from "@/lib/aiConfig";

/**
 * The two backends that exist, and the one that means "off".
 *
 * ColorTxt ships eight; five of those exist for field differences — a
 * `return_base64` here, a `response_format` there — each of which is a 400
 * waiting to happen on a machine nobody can test. These two cover a local
 * install and every reseller that speaks the OpenAI shape.
 */
const BACKENDS = [
  { value: "", label: "关闭" },
  { value: "a1111", label: "本地 Stable Diffusion WebUI" },
  { value: "openai_compat", label: "OpenAI 兼容图像接口" },
];

/**
 * Character portraits: where the picture is drawn.
 *
 * Off by default and off by an explicit row, because the two calls it makes —
 * the chat model writing a prompt, then the image service drawing it — are both
 * billed, and a reader who has a chat key but no way to draw should not have to
 * discover this by pressing a button that fails.
 */
export function ImageRows({ draft, set }: { draft: AiConfigFull; set: Setter }) {
  const backend = draft.imageBackend;

  return (
    <>
      <Row
        label="文生图后端"
        hint="给角色卡生成立绘。会先用对话模型写画面描述，再交给图像接口出图 —— 两次都要花钱，所以默认关闭。"
      >
        <GlassSelect
          value={backend}
          onChange={(event) => set("imageBackend", event.target.value)}
          aria-label="文生图后端"
        >
          {BACKENDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </GlassSelect>
      </Row>

      {backend !== "" && (
        <Row
          label="图像接口地址"
          hint="留空则用后端默认地址。本地 WebUI 是 http://127.0.0.1:7860。"
        >
          <GlassInput
            value={draft.imageBaseUrl}
            onChange={(event) => set("imageBaseUrl", event.target.value)}
            placeholder={
              backend === "a1111" ? "http://127.0.0.1:7860" : "https://api.openai.com/v1"
            }
            aria-label="图像接口地址"
            spellCheck={false}
          />
        </Row>
      )}

      {backend !== "" && (
        <Row label="图像 API Key" hint="本地服务通常不需要。">
          <GlassInput
            type="password"
            value={draft.imageApiKey}
            onChange={(event) => set("imageApiKey", event.target.value)}
            placeholder="本地服务留空"
            aria-label="图像 API Key"
            autoComplete="off"
          />
        </Row>
      )}

      {backend === "openai_compat" && (
        <Row label="图像模型" hint="例如 gpt-image-1、dall-e-3。dall-e 会自动改用 b64 返回。">
          <GlassInput
            value={draft.imageModel}
            onChange={(event) => set("imageModel", event.target.value)}
            placeholder="gpt-image-1"
            aria-label="图像模型"
            spellCheck={false}
          />
        </Row>
      )}
    </>
  );
}
