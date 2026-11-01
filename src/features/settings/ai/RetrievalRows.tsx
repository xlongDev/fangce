import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { Row } from "@/features/settings/section";
import { NumberRow, SwitchRow } from "@/features/settings/ai/fields";
import type { Setter } from "@/features/settings/ai/fields";
import type { AiConfigFull } from "@/lib/aiConfig";

export interface RetrievalRowsProps {
  draft: AiConfigFull;
  set: Setter;
  /** Probes the embedding endpoint, which may not be the chat one. */
  onTestEmbedding: () => void;
  testingEmbedding: boolean;
  /** Looks for a local runtime and fills the two fields above. */
  onProbeLocal: () => void;
  probingLocal: boolean;
}

/**
 * Retrieval, and what an answer cost.
 *
 * The prices sit here rather than in a group of their own because they only
 * exist to explain the usage bar, and the switch that shows that bar is two rows
 * up — a reader who turns the bar off should not have to scroll past three
 * number fields they will never see used.
 */
export function RetrievalRows({
  draft,
  set,
  onTestEmbedding,
  testingEmbedding,
  onProbeLocal,
  probingLocal,
}: RetrievalRowsProps) {
  const price = draft.tokenPrice;

  return (
    <>
      <Row
        label="向量接口地址"
        hint="留空则沿用上面的对话接口。填本地 Ollama（http://127.0.0.1:11434/v1）就能让嵌入在本地跑、对话仍在云端 —— 建索引不花 Token。"
      >
        <div className="w-full space-y-1.5">
          <div className="flex w-full items-center gap-2">
            <GlassInput
              value={draft.embeddingBaseUrl}
              onChange={(event) => set("embeddingBaseUrl", event.target.value)}
              placeholder="留空 = 与对话模型相同"
              aria-label="向量接口地址"
              spellCheck={false}
              className="min-w-0"
            />
            <GlassButton
              variant="subtle"
              size="sm"
              onClick={onTestEmbedding}
              disabled={testingEmbedding}
              className="shrink-0"
            >
              {testingEmbedding ? "检测中…" : "检测"}
            </GlassButton>
          </div>
          <button
            type="button"
            onClick={onProbeLocal}
            disabled={probingLocal}
            className="text-text-3 hover:text-text-1 focus-visible:focus-ring block w-full rounded text-left text-[11.5px] transition-colors disabled:opacity-50"
          >
            {probingLocal ? "正在找本机的服务…" : "找本机的 Ollama / LM Studio"}
          </button>
        </div>
      </Row>
      <Row label="向量 API Key" hint="留空则沿用对话模型的 Key。本地服务通常不需要。">
        <GlassInput
          type="password"
          value={draft.embeddingApiKey}
          onChange={(event) => set("embeddingApiKey", event.target.value)}
          placeholder="留空 = 与对话模型相同"
          aria-label="向量 API Key"
          autoComplete="off"
        />
      </Row>
      <Row label="向量模型" hint="用于全书检索问答（RAG）。留空则只有划词与整章问答。">
        <GlassInput
          value={draft.embeddingModel}
          onChange={(event) => set("embeddingModel", event.target.value)}
          placeholder="text-embedding-3-small / nomic-embed-text"
          aria-label="向量模型"
          spellCheck={false}
        />
      </Row>
      <Row
        label="重排模型"
        hint="可选。检索问答的第二阶段精排（Cohere 兼容 /rerank，如 bge-reranker-v2-m3）。留空则直接用向量排序。"
      >
        <GlassInput
          value={draft.rerankModel}
          onChange={(event) => set("rerankModel", event.target.value)}
          placeholder="bge-reranker-v2-m3"
          aria-label="重排模型"
          spellCheck={false}
        />
      </Row>
      <NumberRow
        label="检索原文条数"
        hint="回答时交给模型的相关片段数量。越大参考越多，也越慢；一般 3～8 条就够。"
        value={draft.ragTopK}
        min={1}
        max={20}
        onChange={(next) => set("ragTopK", next)}
        suffix="条"
      />
      <SwitchRow
        label="防剧透"
        hint="只检索当前阅读位置之前的章节。问到后面还没读的内容时，助手会直说检索不到。"
        checked={draft.spoilerSafe}
        onChange={(next) => set("spoilerSafe", next)}
      />
      <SwitchRow
        label="显示 Token 消耗"
        hint="在每条回答下方显示输入、缓存命中与输出 Token。关掉后价格设置也一并隐藏。"
        checked={draft.showTokenUsage}
        onChange={(next) => set("showTokenUsage", next)}
      />
      {draft.showTokenUsage ? (
        <>
          <NumberRow
            label="输入价格（缓存命中）"
            hint="每百万 Token 的价格，单位：元。缓存命中通常比未命中便宜一个数量级。"
            value={price.inputCached ?? 0}
            min={0}
            max={100000}
            step={0.01}
            onChange={(next) => set("tokenPrice", { ...price, inputCached: next })}
            suffix="元 / 百万"
          />
          <NumberRow
            label="输入价格（缓存未命中）"
            hint="只填这一项时，全部输入 Token 都按它计算。"
            value={price.inputMiss ?? 0}
            min={0}
            max={100000}
            step={0.01}
            onChange={(next) => set("tokenPrice", { ...price, inputMiss: next })}
            suffix="元 / 百万"
          />
          <NumberRow
            label="输出价格"
            hint="填了输出价、并且至少填了一个输入价，才会计算总花费。留 0 表示不计算。"
            value={price.output ?? 0}
            min={0}
            max={100000}
            step={0.01}
            onChange={(next) => set("tokenPrice", { ...price, output: next })}
            suffix="元 / 百万"
          />
        </>
      ) : null}
    </>
  );
}
