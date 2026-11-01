import { useState } from "react";
import { ChatCircleText, Database, SlidersHorizontal, Sparkle } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { Actions, Feedback, SettingsGroup, Unsaved } from "@/features/settings/section";
import { SecretsNotice } from "@/features/settings/SecretsNotice";
import { ConnectionRows } from "@/features/settings/ai/ConnectionRows";
import { GenerationRows } from "@/features/settings/ai/GenerationRows";
import { PromptRows } from "@/features/settings/ai/PromptRows";
import { RetrievalRows } from "@/features/settings/ai/RetrievalRows";
import {
  useAiConfig,
  useAiDefaults,
  useAiDefaultSystemPrompt,
  useAiListModels,
  useDetectOcFerry,
  useProbeLocalEmbeddings,
  useSaveAiConfig,
  useTestAiConfig,
} from "@/hooks/useAi";
import {
  completeAiConfig,
  hostLabel,
  rememberProfileKey,
  switchProfile,
  type AiConfigFull,
} from "@/lib/aiConfig";
import type { AiConfig, OcFerryDiscovery } from "@/types/ipc";

type Status = { tone: "ok" | "bad"; text: string } | null;

/**
 * The AI settings, in three groups that share one draft and one save button.
 *
 * Split by what a reader is doing — connecting, tuning, or checking what it cost
 * — rather than by which struct the field lives on. They share a save because
 * they share a config: a per-group save would let the group you are not looking
 * at write stale values over the one you just changed.
 *
 * The rail still has a single "AI 助手" entry; `anchor` keeps the three DOM ids
 * distinct so the deep link and the jump land on the first.
 */
export function AiSection() {
  const config = useAiConfig();
  const defaults = useAiDefaults();
  if (!config.data) return null;
  return (
    <AiForm
      // Remounting on a stored change is what resets the form to what the
      // backend actually has, clamping and all.
      key={config.dataUpdatedAt}
      initial={completeAiConfig(config.data)}
      defaults={defaults.data ?? null}
    />
  );
}

function AiForm({ initial, defaults }: { initial: AiConfigFull; defaults: AiConfig | null }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<Status>(null);
  const [models, setModels] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<OcFerryDiscovery | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const save = useSaveAiConfig();
  const test = useTestAiConfig();
  const listModels = useAiListModels();
  const probeLocal = useProbeLocalEmbeddings();
  const detect = useDetectOcFerry();
  const defaultPrompt = useAiDefaultSystemPrompt();

  const set = <K extends keyof AiConfigFull>(key: K, value: AiConfigFull[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = (Object.keys(initial) as (keyof AiConfigFull)[]).some(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(initial[key]),
  );

  const onSwitchProfile = (id: string) => setDraft((prev) => switchProfile(prev, id));

  const onAddProfile = () =>
    setDraft((prev) => {
      const id = `p-${crypto.randomUUID()}`;
      return {
        ...prev,
        // The current key stays with the profile being left; the new one starts
        // blank, which is the only honest default for "another endpoint".
        profileKeys: rememberProfileKey(prev),
        profiles: [
          ...prev.profiles,
          { id, name: hostLabel(prev.baseUrl), baseUrl: prev.baseUrl, model: prev.model },
        ],
        activeProfileId: id,
        apiKey: "",
      };
    });

  const onDeleteProfile = () =>
    setDraft((prev) => {
      const remaining = prev.profiles.filter((entry) => entry.id !== prev.activeProfileId);
      if (remaining.length === 0) return prev;
      const next = remaining[0] as (typeof remaining)[number];
      return switchProfile({ ...prev, profiles: remaining }, next.id);
    });

  const onListModels = () => {
    setStatus(null);
    listModels.mutate(draft, {
      onSuccess: (fetched) => {
        setModels(fetched);
        // Only an empty field adopts the first model: a reader who typed an id
        // (or was given one by OC Ferry) must not have it replaced.
        if (!draft.model.trim()) set("model", fetched[0] ?? "");
        setStatus({ tone: "ok", text: `拉到 ${fetched.length} 个模型，从下拉里选一个。` });
      },
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  /** The embedding endpoint can differ from the chat one, so it needs its own
   *  probe — a typo there otherwise only shows up as a failed index build. */
  const onTestEmbedding = () => {
    setStatus(null);
    listModels.mutate(
      {
        ...draft,
        baseUrl: draft.embeddingBaseUrl.trim() || draft.baseUrl,
        apiKey: draft.embeddingApiKey.trim() || draft.apiKey,
      },
      {
        onSuccess: (found) =>
          setStatus({ tone: "ok", text: `向量接口连上了，${found.length} 个模型可用。` }),
        onError: (error) => setStatus({ tone: "bad", text: String(error) }),
      },
    );
  };

  /** Finds a local runtime and fills the embedding address and model from it.
   *  Only the address and the model: a local runtime needs no key, and the
   *  reader's chat key must not be overwritten by a probe. */
  const onProbeLocal = () => {
    setStatus(null);
    probeLocal.mutate(undefined, {
      onSuccess: (found) => {
        const first = found[0];
        if (!first) {
          setStatus({
            tone: "bad",
            text: "没找到本机的 Ollama 或 LM Studio。装好并启动后再点一次，或者手动填地址。",
          });
          return;
        }
        setDraft((prev) => ({
          ...prev,
          embeddingBaseUrl: first.baseUrl,
          embeddingModel: prev.embeddingModel.trim() || (first.models[0] ?? ""),
        }));
        setStatus({
          tone: "ok",
          text: `找到 ${first.name}，已填好向量接口地址${first.models[0] ? `与模型「${first.models[0]}」` : ""}。${first.fallback ? "（没认出嵌入模型，列表里是全部模型）" : ""}`,
        });
      },
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onDetect = () => {
    setStatus(null);
    setDiscovered(null);
    detect.mutate(undefined, {
      onSuccess: (found) => {
        setDiscovered(found);
        setPicked(found.models);
        setStatus({
          tone: "ok",
          text: `已连上 OC Ferry，检测到 ${found.models.length} 个可用模型，勾选后导入。`,
        });
      },
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onTogglePick = (model: string) =>
    setPicked((prev) =>
      prev.includes(model) ? prev.filter((id) => id !== model) : [...prev, model],
    );

  const onToggleAll = () => {
    if (!discovered) return;
    setPicked((prev) => (prev.length === discovered.models.length ? [] : discovered.models));
  };

  const onImportPicked = () => {
    if (!discovered || picked.length === 0) {
      setStatus({ tone: "bad", text: "请至少选择一个模型。" });
      return;
    }
    const first = picked[0] ?? "";
    setDraft((prev) => ({
      ...prev,
      apiKey: discovered.apiKey,
      baseUrl: discovered.baseUrl,
      importedModels: picked,
      model: picked.includes(prev.model) ? prev.model : first,
    }));
    setStatus({
      tone: "ok",
      text: `已导入 ${picked.length} 个模型，当前使用「${picked.includes(draft.model) ? draft.model : first}」。记得点保存。`,
    });
    setDiscovered(null);
  };

  const onTest = () => {
    setStatus(null);
    test.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "连接成功，接口、Key 与模型都可用。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSave = () => {
    setStatus(null);
    save.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "已保存。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  return (
    <>
      <SettingsGroup
        id="ai"
        icon={Sparkle}
        title="AI 阅读助手"
        description="划词解释、翻译与整章问答都走这里配置的接口。"
        badge={<Unsaved dirty={dirty} />}
      >
        <ConnectionRows
          draft={draft}
          set={set}
          models={models}
          listing={listModels.isPending}
          onListModels={onListModels}
          discovered={discovered}
          picked={picked}
          onTogglePick={onTogglePick}
          onToggleAll={onToggleAll}
          onImportPicked={onImportPicked}
          onCancelDiscovery={() => setDiscovered(null)}
          onSwitchProfile={onSwitchProfile}
          onAddProfile={onAddProfile}
          onDeleteProfile={onDeleteProfile}
        />

        <Actions>
          <GlassButton variant="subtle" size="sm" onClick={onDetect} disabled={detect.isPending}>
            {detect.isPending ? "正在检测…" : "检测本地 OC Ferry"}
          </GlassButton>
          <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
            {test.isPending ? "正在连接…" : "测试连接"}
          </GlassButton>
          <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
            {save.isPending ? "正在保存…" : "保存"}
          </GlassButton>
          <Feedback status={status} />
        </Actions>

        <SecretsNotice />
      </SettingsGroup>

      <SettingsGroup
        id="ai"
        anchor="ai-prompt"
        icon={ChatCircleText}
        title="AI 提示词"
        description="助手的语气与边界。每次提问都会附带，和上面填的接口一起保存。"
        badge={<Unsaved dirty={dirty} />}
      >
        <PromptRows draft={draft} set={set} defaultPrompt={defaultPrompt.data} />
      </SettingsGroup>

      <SettingsGroup
        id="ai"
        anchor="ai-generation"
        icon={SlidersHorizontal}
        title="AI 生成参数"
        description="一条回答有多长、记得多少、想不想。改动随上面的「保存」一起生效。"
        badge={<Unsaved dirty={dirty} />}
      >
        <GenerationRows
          draft={draft}
          set={set}
          canRestoreQuestions={defaults !== null}
          onRestoreQuestions={() =>
            defaults && set("quickQuestions", defaults.quickQuestions ?? [])
          }
        />
      </SettingsGroup>

      <SettingsGroup
        id="ai"
        anchor="ai-retrieval"
        icon={Database}
        title="AI 检索与用量"
        description="全书检索的索引配置，以及一条回答花了多少。"
        badge={<Unsaved dirty={dirty} />}
      >
        <RetrievalRows
          draft={draft}
          set={set}
          onTestEmbedding={onTestEmbedding}
          testingEmbedding={listModels.isPending}
          onProbeLocal={onProbeLocal}
          probingLocal={probeLocal.isPending}
        />
      </SettingsGroup>
    </>
  );
}
