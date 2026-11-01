import { Plus, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput, GlassSelect } from "@/components/glass/input";
import { Row } from "@/features/settings/section";
import type { Setter } from "@/features/settings/ai/fields";
import { AI_PROVIDERS, providerFor } from "@/features/settings/ai/providers";
import { cn } from "@/lib/cn";
import type { AiConfigFull } from "@/lib/aiConfig";
import type { OcFerryDiscovery } from "@/lib/bindings";

export interface ConnectionRowsProps {
  draft: AiConfigFull;
  set: Setter;
  /** Ids pulled from `GET /models` this session. */
  models: string[];
  listing: boolean;
  onListModels: () => void;
  discovered: OcFerryDiscovery | null;
  picked: string[];
  onTogglePick: (model: string) => void;
  onToggleAll: () => void;
  onImportPicked: () => void;
  onCancelDiscovery: () => void;
  onSwitchProfile: (id: string) => void;
  onAddProfile: () => void;
  onDeleteProfile: () => void;
}

/**
 * Endpoint, credentials and voice.
 *
 * The provider picker and the address field write the same value on purpose: the
 * preset fills the address, and editing the address does **not** switch the
 * preset back — a reader behind a proxy or on a fork of the endpoint is editing
 * the address, not choosing a different vendor.
 */
export function ConnectionRows({
  draft,
  set,
  models,
  listing,
  onListModels,
  discovered,
  picked,
  onTogglePick,
  onToggleAll,
  onImportPicked,
  onCancelDiscovery,
  onSwitchProfile,
  onAddProfile,
  onDeleteProfile,
}: ConnectionRowsProps) {
  const provider = providerFor(draft.baseUrl);
  const profile = draft.profiles.find((entry) => entry.id === draft.activeProfileId);
  // OC Ferry's imported ids and a freshly pulled list are the same thing to the
  // reader: models this endpoint offers. One picker, whichever filled it.
  const options = draft.importedModels.length > 0 ? draft.importedModels : models;

  return (
    <>
      <Row
        label="配置方案"
        hint="切换方案时，接口地址、模型和 Key 一起换。每个方案各自记住自己的 Key，切回来不用重填。"
      >
        <div className="flex w-full items-center gap-2">
          <GlassSelect
            value={draft.activeProfileId}
            onChange={(event) => onSwitchProfile(event.target.value)}
            aria-label="配置方案"
          >
            {draft.profiles.length === 0 ? <option value="">默认</option> : null}
            {draft.profiles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </GlassSelect>
          <GlassButton
            variant="subtle"
            size="sm"
            onClick={onAddProfile}
            aria-label="新增方案"
            title="以当前设置为底，新增一个方案"
            leading={<Plus size={13} />}
          />
          <GlassButton
            variant="subtle"
            size="sm"
            onClick={onDeleteProfile}
            disabled={draft.profiles.length <= 1}
            aria-label="删除方案"
            title="删除当前方案"
            leading={<Trash size={13} />}
          />
        </div>
      </Row>
      {profile ? (
        <Row label="方案名称" hint="只影响这里的下拉菜单，不会发给模型。">
          <GlassInput
            value={profile.name}
            onChange={(event) =>
              set(
                "profiles",
                draft.profiles.map((entry) =>
                  entry.id === profile.id ? { ...entry, name: event.target.value } : entry,
                ),
              )
            }
            placeholder="例如 本地 Qwen"
            aria-label="方案名称"
          />
        </Row>
      ) : null}
      <Row label="服务商" hint={provider.note}>
        <GlassSelect
          value={provider.id}
          onChange={(event) => {
            const next = AI_PROVIDERS.find((entry) => entry.id === event.target.value);
            // The escape hatch keeps whatever is typed: switching to "自定义" is
            // an invitation to edit the address, not a reason to erase it.
            if (next?.baseUrl) set("baseUrl", next.baseUrl);
          }}
          aria-label="服务商"
        >
          {AI_PROVIDERS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </GlassSelect>
      </Row>
      <Row
        label="接口地址"
        hint="OpenAI 兼容端点。本地模型（Ollama、LM Studio）填 http://127.0.0.1 开头即可。"
      >
        <GlassInput
          value={draft.baseUrl}
          onChange={(event) => set("baseUrl", event.target.value)}
          placeholder="https://api.openai.com/v1"
          aria-label="接口地址"
          spellCheck={false}
        />
      </Row>
      <Row
        label="API Key"
        hint="只存在本地数据库，并用系统钥匙串加密保存，不会离开这台机器。本地模型可留空。"
      >
        <GlassInput
          type="password"
          value={draft.apiKey}
          onChange={(event) => set("apiKey", event.target.value)}
          placeholder="sk-…"
          aria-label="API Key"
          autoComplete="off"
        />
      </Row>
      <Row label="模型名称" hint="可以直接手填任意 ID，不依赖下面的列表。">
        <div className="w-full space-y-2">
          <div className="flex w-full items-center gap-2">
            <GlassInput
              value={draft.model}
              onChange={(event) => set("model", event.target.value)}
              placeholder="gpt-4o-mini"
              aria-label="模型名称"
              spellCheck={false}
              className="min-w-0"
            />
            <GlassButton
              variant="subtle"
              size="sm"
              onClick={onListModels}
              disabled={listing}
              className="shrink-0"
            >
              {listing ? "拉取中…" : "拉取模型"}
            </GlassButton>
          </div>
          {options.length > 0 ? (
            <GlassSelect
              value={options.includes(draft.model) ? draft.model : ""}
              onChange={(event) => {
                if (event.target.value) set("model", event.target.value);
              }}
              aria-label="可选模型"
            >
              <option value="">从 {options.length} 个模型中选…</option>
              {options.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </GlassSelect>
          ) : null}
        </div>
      </Row>
      <Row
        label="DeepL API Key"
        hint="可选。填了之后划词翻译走 DeepL（免费版 Key 以 :fx 结尾），更即时、更准；留空则用上面的 AI 模型翻译。"
      >
        <GlassInput
          type="password"
          value={draft.deeplKey}
          onChange={(event) => set("deeplKey", event.target.value)}
          placeholder="DeepL-Auth-Key…"
          aria-label="DeepL API Key"
          autoComplete="off"
        />
      </Row>

      {discovered ? (
        <div className="glass m-4 rounded-lg p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-text-1 text-sm">
              检测到 {discovered.models.length} 个可用模型
            </span>
            <button
              type="button"
              className="text-text-2 hover:text-text-1 text-xs"
              onClick={onToggleAll}
            >
              {picked.length === discovered.models.length ? "全不选" : "全选"}
            </button>
          </div>
          <div className="max-h-52 space-y-1 overflow-auto">
            {discovered.models.map((model) => {
              const on = picked.includes(model);
              return (
                <button
                  key={model}
                  type="button"
                  onClick={() => onTogglePick(model)}
                  aria-pressed={on}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    on ? "bg-accent/15 text-text-1" : "text-text-2 hover:bg-surface-2",
                  )}
                >
                  <span
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 rounded border",
                      on ? "border-accent bg-accent" : "border-hairline",
                    )}
                  />
                  <span className="truncate">{model}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2">
            <GlassButton size="sm" onClick={onImportPicked} disabled={picked.length === 0}>
              导入所选（{picked.length}）
            </GlassButton>
            <GlassButton variant="subtle" size="sm" onClick={onCancelDiscovery}>
              取消
            </GlassButton>
          </div>
        </div>
      ) : null}
    </>
  );
}
