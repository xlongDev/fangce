/**
 * The endpoints worth offering by name.
 *
 * Every one of them speaks the same OpenAI-compatible `/chat/completions`, which
 * is why this is a list of addresses rather than a list of adapters. The note is
 * the one thing a reader cannot guess from the name: whether it needs a key, and
 * where to get one.
 *
 * Order is "what most readers here will pick first": local runtimes, then the
 * Chinese providers, then the international ones, then the escape hatch.
 */
export interface AiProvider {
  id: string;
  label: string;
  baseUrl: string;
  note: string;
}

export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: "lmstudio",
    label: "本地 LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    note: "本地运行，通常不需要 Key",
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    note: "本地运行，通常不需要 Key",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    note: "需要 Key，platform.deepseek.com",
  },
  {
    id: "dashscope",
    label: "阿里云通义（DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    note: "需要 Key，百炼控制台",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    note: "需要 Key，open.bigmodel.cn",
  },
  {
    id: "moonshot",
    label: "Moonshot（Kimi）",
    baseUrl: "https://api.moonshot.cn/v1",
    note: "需要 Key，platform.moonshot.cn",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    note: "需要 Key，siliconflow.cn",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    note: "需要 Key，platform.minimaxi.com",
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    note: "需要 Key，鉴权头是 api-key 而不是 Bearer",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    note: "需要 Key，platform.openai.com",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "需要 Key，一个 Key 走多家模型",
  },
  {
    id: "gemini",
    label: "Google Gemini（OpenAI 兼容）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    note: "需要 Google AI Studio 的 Key",
  },
  {
    id: "agnes",
    label: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    note: "需要 Key",
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容服务",
    baseUrl: "",
    note: "自己填接口地址",
  },
];

/**
 * Which preset the current address is, or `custom`.
 *
 * Matched on the address rather than remembered in state: a saved config has no
 * `provider` field, and inferring it here means an address typed by hand (or
 * restored from a backup) still lands on the right row instead of on nothing.
 */
export function providerFor(baseUrl: string): AiProvider {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return (
    AI_PROVIDERS.find((provider) => provider.baseUrl !== "" && provider.baseUrl === trimmed) ??
    (AI_PROVIDERS.at(-1) as AiProvider)
  );
}
