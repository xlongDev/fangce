import type { AiConfig } from "@/types/ipc";

/**
 * `AiConfig` as the form wants it: every field present, nothing nullable.
 *
 * The generated type mirrors the wire format, where a field the backend filled
 * with `#[serde(default)]` is optional and a float is nullable. The backend does
 * always send all of them — `config()` deserializes with the defaults — so this
 * narrows rather than re-declares, and a new field on the Rust struct flows
 * through without being added here twice.
 */
export type AiConfigFull = { [K in keyof AiConfig]-?: NonNullable<AiConfig[K]> };

/**
 * The numbers, for the one place that has no backend: the browser preview.
 *
 * Deliberately **not** the authority — `AiConfig::default()` in Rust is, and the
 * settings page asks for it (`ai.defaults`) whenever it needs to restore
 * something. This copy exists so the offline form can render at all.
 */
export const AI_CONFIG_DEFAULTS = {
  temperature: 0.7,
  maxTokens: 4096,
  contextTurns: 8,
  maxToolRounds: 8,
  ragTopK: 6,
} as const;

/** Fills every optional field, so the form never reads `undefined`. */
export function completeAiConfig(config: AiConfig): AiConfigFull {
  return {
    ...config,
    importedModels: config.importedModels ?? [],
    systemPrompt: config.systemPrompt ?? "",
    embeddingModel: config.embeddingModel ?? "",
    embeddingBaseUrl: config.embeddingBaseUrl ?? "",
    embeddingApiKey: config.embeddingApiKey ?? "",
    rerankModel: config.rerankModel ?? "",
    deeplKey: config.deeplKey ?? "",
    profiles: config.profiles ?? [],
    activeProfileId: config.activeProfileId ?? "",
    profileKeys: config.profileKeys ?? {},
    temperature: config.temperature ?? AI_CONFIG_DEFAULTS.temperature,
    maxTokens: config.maxTokens ?? AI_CONFIG_DEFAULTS.maxTokens,
    contextTurns: config.contextTurns ?? AI_CONFIG_DEFAULTS.contextTurns,
    maxToolRounds: config.maxToolRounds ?? AI_CONFIG_DEFAULTS.maxToolRounds,
    systemPromptExtra: config.systemPromptExtra ?? "",
    deepThinking: config.deepThinking ?? false,
    showTokenUsage: config.showTokenUsage ?? true,
    tokenPrice: config.tokenPrice ?? { inputCached: 0, inputMiss: 0, output: 0 },
    quickQuestions: config.quickQuestions ?? [],
    spoilerSafe: config.spoilerSafe ?? false,
    ragTopK: config.ragTopK ?? AI_CONFIG_DEFAULTS.ragTopK,
  };
}

/**
 * The key saved for one profile, falling back to the active one.
 *
 * The active profile's key is mirrored into `apiKey`, so a profile saved before
 * keys were per-profile still switches without asking the reader to retype it.
 */
export function keyOfProfile(config: AiConfigFull, profileId: string): string {
  if (config.profileKeys[profileId] !== undefined) return config.profileKeys[profileId];
  return profileId === config.activeProfileId ? config.apiKey : "";
}

/**
 * Records the key currently in the form under the profile currently active.
 *
 * Nothing is recorded when there is no active profile yet (a fresh install) or
 * no key typed — an empty entry in `profileKeys` would read as "this profile has
 * a key" to everything that looks.
 */
export function rememberProfileKey(config: AiConfigFull): Record<string, string> {
  if (!config.activeProfileId || !config.apiKey) return config.profileKeys;
  return { ...config.profileKeys, [config.activeProfileId]: config.apiKey };
}

/**
 * Switches to another saved profile: the snapshot is copied back into the flat
 * fields, which are the only thing the backend reads at runtime.
 *
 * The current profile's key is written into `profileKeys` first, so the one being
 * left does not lose it — the backend does the same on save, and doing it here
 * too means the in-flight draft is consistent before it is saved.
 */
export function switchProfile(config: AiConfigFull, profileId: string): AiConfigFull {
  const target = config.profiles.find((profile) => profile.id === profileId);
  if (!target) return config;
  return {
    ...config,
    apiKey: keyOfProfile(config, profileId),
    baseUrl: target.baseUrl,
    model: target.model,
    activeProfileId: profileId,
    profileKeys: rememberProfileKey(config),
  };
}

/**
 * A name for a new profile, derived from its host the way the backend does.
 *
 * Only used to pre-fill the "save as a new profile" prompt; the backend renames
 * it from the address anyway if the reader leaves it blank.
 */
export function hostLabel(baseUrl: string): string {
  const withoutScheme = baseUrl.trim().replace(/^[a-z]+:\/\//i, "");
  const host = withoutScheme.split("/")[0]?.split(":")[0] ?? "";
  if (!host) return "新方案";
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(host)) return "本地";
  return host;
}
