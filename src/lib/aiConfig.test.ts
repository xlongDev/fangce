import { describe, expect, it } from "vitest";

import { completeAiConfig, hostLabel, keyOfProfile, switchProfile } from "@/lib/aiConfig";
import type { AiConfig } from "@/types/ipc";

const base: AiConfig = { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-a", model: "m" };

describe("completeAiConfig", () => {
  it("fills every field the wire format leaves optional", () => {
    const full = completeAiConfig(base);
    expect(full.temperature).toBe(0.7);
    expect(full.maxTokens).toBe(4096);
    expect(full.contextTurns).toBe(8);
    expect(full.maxToolRounds).toBe(8);
    expect(full.ragTopK).toBe(6);
    expect(full.showTokenUsage).toBe(true);
    expect(full.spoilerSafe).toBe(false);
    expect(full.importedModels).toEqual([]);
    expect(full.profiles).toEqual([]);
    expect(full.profileKeys).toEqual({});
    expect(full.quickQuestions).toEqual([]);
    expect(full.tokenPrice).toEqual({ inputCached: 0, inputMiss: 0, output: 0 });
  });

  it("keeps what the backend did send, including a zero temperature", () => {
    const full = completeAiConfig({ ...base, temperature: 0, contextTurns: 2 });
    expect(full.temperature).toBe(0);
    expect(full.contextTurns).toBe(2);
  });
});

describe("keyOfProfile", () => {
  const config = completeAiConfig({
    ...base,
    activeProfileId: "a",
    profiles: [
      { id: "a", name: "甲", baseUrl: "https://a.example/v1", model: "m" },
      { id: "b", name: "乙", baseUrl: "https://b.example/v1", model: "m" },
    ],
    profileKeys: { a: "sk-a", b: "sk-b" },
  });

  it("reads the saved key of the profile it is asked about", () => {
    expect(keyOfProfile(config, "b")).toBe("sk-b");
  });

  it("falls back to the flat key for the active profile", () => {
    // A profile saved before keys were per-profile has no entry of its own.
    const legacy = completeAiConfig({ ...base, activeProfileId: "a", profiles: config.profiles });
    expect(keyOfProfile(legacy, "a")).toBe("sk-a");
    expect(keyOfProfile(legacy, "b")).toBe("");
  });
});

describe("switchProfile", () => {
  const config = completeAiConfig({
    ...base,
    activeProfileId: "a",
    profiles: [
      { id: "a", name: "甲", baseUrl: "https://a.example/v1", model: "ma" },
      { id: "b", name: "乙", baseUrl: "https://b.example/v1", model: "mb" },
    ],
    profileKeys: { a: "sk-a", b: "sk-b" },
  });

  it("copies the snapshot into the flat fields the backend actually reads", () => {
    const switched = switchProfile(config, "b");
    expect(switched.baseUrl).toBe("https://b.example/v1");
    expect(switched.model).toBe("mb");
    expect(switched.apiKey).toBe("sk-b");
    expect(switched.activeProfileId).toBe("b");
  });

  it("remembers the key of the profile being left", () => {
    const switched = switchProfile(config, "b");
    expect(switched.profileKeys.a).toBe("sk-a");
  });

  it("does nothing for an id that is not saved", () => {
    expect(switchProfile(config, "gone")).toBe(config);
  });
});

describe("hostLabel", () => {
  it("names a profile after its host", () => {
    expect(hostLabel("https://api.deepseek.com/v1")).toBe("api.deepseek.com");
    expect(hostLabel("http://127.0.0.1:1234/v1")).toBe("本地");
    expect(hostLabel("http://localhost:11434/v1")).toBe("本地");
  });

  it("has something to say about an empty address", () => {
    expect(hostLabel("")).toBe("新方案");
  });
});
