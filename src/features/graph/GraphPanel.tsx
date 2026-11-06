import { useState } from "react";
import { ArrowUUpLeft } from "@phosphor-icons/react";

import { AiErrorCard } from "@/components/common/AiErrorCard";
import { AiSpeechButton } from "@/components/common/AiSpeechButton";
import { useGraphBuild, useGraphQuery, useGraphStatus } from "@/hooks/useGraph";
import { PortraitCard } from "@/features/graph/PortraitCard";
import type { GraphEntity } from "@/types/ipc";

/** The kinds the extractor is asked for, in the order a reader looks for them.
 *
 *  A book's graph is mostly places and objects, and the reader who opens this
 *  panel usually wants the people. A flat list sorted by mentions put 地点 and
 *  物品 between 人物 and pushed the characters off the first screen — so the
 *  kinds are a filter, and 人物 is what it opens on.
 */
const KINDS = ["人物", "地点", "组织", "物品", "概念"] as const;
const OTHER = "其他";

function kindOf(entity: GraphEntity): string {
  const kind = entity.kind.trim();
  return kind === "" ? OTHER : kind;
}

/** Where a kind sorts: the asked-for ones in order, everything else after. */
function rankOf(kind: string): number {
  const index = KINDS.indexOf(kind as (typeof KINDS)[number]);
  return index === -1 ? KINDS.length : index;
}

/** Entities grouped by kind, in reading order, with the unexpected kinds last. */
function groupByKind(entities: GraphEntity[]): { kind: string; items: GraphEntity[] }[] {
  const buckets = new Map<string, GraphEntity[]>();
  for (const entity of entities) {
    const kind = kindOf(entity);
    const bucket = buckets.get(kind);
    if (bucket) bucket.push(entity);
    else buckets.set(kind, [entity]);
  }

  return [...buckets.entries()]
    .map(([kind, items]) => ({ kind, items }))
    .toSorted((a, b) => rankOf(a.kind) - rankOf(b.kind) || a.kind.localeCompare(b.kind, "zh"));
}

/** The knowledge-graph drawer: build it, browse entities, follow relations. */
export function GraphPanel({
  bookId,
  onOpenChapter,
  onAskAbout,
}: {
  bookId: string;
  onOpenChapter: (chapterIdx: number) => void;
  /** Hands the character to the assistant. `undefined` hides the button. */
  onAskAbout?: (name: string) => void;
}) {
  const [selected, setSelected] = useState<GraphEntity | null>(null);
  /** `null` means "whatever the graph suggests", not "all" — the fallback
   *  below decides, and an explicit 全部 is its own value. */
  const [picked, setPicked] = useState<string | null>(null);
  const status = useGraphStatus(bookId);
  const view = useGraphQuery(bookId, selected?.name ?? null);
  const build = useGraphBuild(bookId);

  if (status.isPending || view.isPending) {
    return <p className="text-text-3 px-4 py-3 text-[13px]">正在加载…</p>;
  }

  const building = build.build.isPending;
  const empty = (status.data?.entities ?? 0) === 0;

  if (empty && selected === null) {
    const model = status.data?.model ?? "";
    // No model, no graph — and that is a failure the reader has to be told
    // about, not a grey line they have to read. The same card the guide shows
    // for the same reason, with the backend's own sentence for it
    // (`commands::ai::NOT_CONFIGURED`) so the toast and the panel agree.
    if (!model) {
      return (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <AiErrorCard message="还没有配置 AI 模型，先到设置里填写接口地址与模型名称" />
          <p className="text-text-3 mt-3 text-[12.5px] leading-relaxed">
            AI 逐章读正文，抽出人物、地点与它们之间的关系。
          </p>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center px-5 py-6 text-center">
        <p className="text-text-1 text-[13px] leading-relaxed">这本书还没有知识图谱。</p>
        <p className="text-text-3 mt-1.5 text-[12.5px] leading-relaxed">
          点下面开始抽取：AI 会逐章读取正文，整理人物、地点与它们之间的关系。
        </p>
        <div className="mt-4 flex flex-col items-center gap-2">
          <button
            type="button"
            disabled={building}
            onClick={() => build.build.mutate()}
            className="glass-liquid text-accent focus-visible:focus-ring rounded-full px-4 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {building && build.progress
              ? `抽取中 ${build.progress.done}/${build.progress.total} 章`
              : "抽取全书"}
          </button>
          {building && !build.progress && <p className="text-text-3 text-[12px]">正在读取章节…</p>}
        </div>
      </div>
    );
  }

  if (selected !== null) {
    const relations = view.data?.relations ?? [];
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-hairline flex items-center gap-2 border-b px-4 py-2.5">
          <button
            type="button"
            aria-label="返回实体列表"
            onClick={() => setSelected(null)}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors"
          >
            <ArrowUUpLeft size={15} />
          </button>
          <div className="min-w-0">
            <p className="text-text-1 truncate text-[13px] font-medium">{selected.name}</p>
            <p className="text-text-3 truncate text-[11px]">
              {kindOf(selected)} · 提及 {selected.mentions} 次 · {relations.length} 条关系
            </p>
          </div>
          {onAskAbout && (
            <button
              type="button"
              onClick={() => onAskAbout(selected.name)}
              className="focus-visible:focus-ring border-hairline text-text-2 hover:text-accent ml-auto shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors"
            >
              问助手
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <PortraitCard bookId={bookId} entity={selected} />
          {relations.length === 0 ? (
            <p className="text-text-3 text-[13px] leading-relaxed">没有抽到与它相关的关系。</p>
          ) : (
            <ul className="space-y-3">
              {relations.map((relation) => (
                <li
                  key={`${relation.subject}-${relation.relation}-${relation.object}-${relation.chapterIdx}`}
                  className="border-hairline relative border-b pb-3 last:border-0 last:pb-0"
                >
                  {/* The row jumps to its chapter, so the speaker is a sibling
                      rather than a button inside a button. */}
                  <button
                    type="button"
                    onClick={() => onOpenChapter(relation.chapterIdx)}
                    className="focus-visible:focus-ring w-full rounded-md pr-8 text-left transition-colors"
                  >
                    <p className="text-text-1 text-[13px]">
                      {relation.subject} <span className="text-accent">{relation.relation}</span>{" "}
                      {relation.object}
                    </p>
                    {relation.evidence && (
                      <p className="text-text-3 mt-1 line-clamp-2 text-[12px] leading-relaxed">
                        {relation.evidence}
                      </p>
                    )}
                    <p className="text-text-3 mt-1 text-[11px]">第 {relation.chapterIdx + 1} 章</p>
                  </button>
                  {relation.evidence && (
                    <AiSpeechButton
                      className="absolute top-0 right-0"
                      id={`evidence:${bookId}:${relation.subject}:${relation.object}:${relation.chapterIdx}`}
                      text={relation.evidence}
                      title="图谱证据"
                      chapter={`第 ${relation.chapterIdx + 1} 章`}
                      label="朗读这段证据"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const groups = groupByKind(view.data?.entities ?? []);
  const fallback = groups.some((group) => group.kind === "人物") ? "人物" : "all";
  const active = picked ?? fallback;
  const shown = active === "all" ? groups : groups.filter((group) => group.kind === active);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {building && build.progress && (
        <p className="text-text-3 border-hairline border-b px-4 py-2 text-[12px]">
          重新抽取中 {build.progress.done}/{build.progress.total} 章
        </p>
      )}
      <div className="border-hairline shrink-0 border-b px-4 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-text-3 text-[11px]">
            {status.data?.entities} 个实体 · {status.data?.relations} 条关系
          </p>
          <button
            type="button"
            disabled={building}
            onClick={() => build.build.mutate()}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 shrink-0 text-[12px] transition-colors disabled:opacity-60"
          >
            {building ? "抽取中…" : "重新抽取"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip
            label="全部"
            count={view.data?.entities.length ?? 0}
            active={active === "all"}
            onClick={() => setPicked("all")}
          />
          {groups.map((group) => (
            <FilterChip
              key={group.kind}
              label={group.kind}
              count={group.items.length}
              active={active === group.kind}
              onClick={() => setPicked(group.kind)}
            />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {shown.map((group) => (
          <section key={group.kind} className="mb-3 last:mb-0">
            {active === "all" && <p className="text-text-3 mb-1.5 text-[11px]">{group.kind}</p>}
            <ul className="flex flex-wrap gap-2">
              {group.items.map((entity) => (
                <li key={entity.name}>
                  <button
                    type="button"
                    onClick={() => setSelected(entity)}
                    className="focus-visible:focus-ring glass text-text-1 hover:border-accent rounded-full border px-2.5 py-1 text-[12.5px] transition-colors"
                  >
                    {entity.name}
                    <span className="text-text-3 ml-1.5 text-[11px]">{entity.mentions}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One kind in the filter row. The count is the whole point of it — a reader
 *  picks 人物 because it says how many there are. */
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "bg-accent text-on-accent focus-visible:focus-ring rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors"
          : "focus-visible:focus-ring border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors"
      }
    >
      {label}
      <span className={active ? "ml-1.5 opacity-70" : "text-text-3 ml-1.5"}>{count}</span>
    </button>
  );
}
