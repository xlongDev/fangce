import { useState } from "react";
import { ArrowUUpLeft } from "@phosphor-icons/react";

import { useGraphBuild, useGraphQuery, useGraphStatus } from "@/hooks/useGraph";

/** The knowledge-graph drawer: build it, browse entities, follow relations. */
export function GraphPanel({
  bookId,
  onOpenChapter,
}: {
  bookId: string;
  onOpenChapter: (chapterIdx: number) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const status = useGraphStatus(bookId);
  const view = useGraphQuery(bookId, selected);
  const build = useGraphBuild(bookId);

  if (status.isPending || view.isPending) {
    return <p className="text-text-3 px-4 py-3 text-[13px]">正在加载…</p>;
  }

  const building = build.build.isPending;
  const empty = (status.data?.entities ?? 0) === 0;

  if (empty && selected === null) {
    const model = status.data?.model ?? "";
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center px-5 py-6 text-center">
        <p className="text-text-1 text-[13px] leading-relaxed">这本书还没有知识图谱。</p>
        <p className="text-text-3 mt-1.5 text-[12.5px] leading-relaxed">
          {model
            ? "点下面开始抽取：AI 会逐章读取正文，整理人物、地点与它们之间的关系。"
            : "先到设置里配置 AI 模型，才能抽取实体与关系。"}
        </p>
        {model && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={building}
              onClick={() => build.build.mutate()}
              className="focus-visible:focus-ring bg-accent text-on-accent rounded-full px-4 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {building && build.progress
                ? `抽取中 ${build.progress.done}/${build.progress.total} 章`
                : "抽取全书"}
            </button>
            {building && !build.progress && (
              <p className="text-text-3 text-[12px]">正在读取章节…</p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (selected !== null) {
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
          <p className="text-text-1 truncate text-[13px] font-medium">{selected}</p>
          <p className="text-text-3 ml-auto shrink-0 text-[11px]">
            {view.data?.relations.length ?? 0} 条关系
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {(view.data?.relations.length ?? 0) === 0 ? (
            <p className="text-text-3 text-[13px] leading-relaxed">没有抽到与它相关的关系。</p>
          ) : (
            <ul className="space-y-3">
              {view.data?.relations.map((relation) => (
                <li
                  key={`${relation.subject}-${relation.relation}-${relation.object}-${relation.chapterIdx}`}
                  className="border-hairline border-b pb-3 last:border-0 last:pb-0"
                >
                  <button
                    type="button"
                    onClick={() => onOpenChapter(relation.chapterIdx)}
                    className="focus-visible:focus-ring w-full rounded-md text-left transition-colors"
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
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {building && build.progress && (
        <p className="text-text-3 border-hairline border-b px-4 py-2 text-[12px]">
          重新抽取中 {build.progress.done}/{build.progress.total} 章
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-text-3 text-[11px]">
            {status.data?.entities} 个实体 · {status.data?.relations} 条关系 · 按出现次数排序
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
        <ul className="flex flex-wrap gap-2">
          {view.data?.entities.map((entity) => (
            <li key={entity.name}>
              <button
                type="button"
                onClick={() => setSelected(entity.name)}
                className="focus-visible:focus-ring glass text-text-1 hover:border-accent rounded-full border px-2.5 py-1 text-[12.5px] transition-colors"
              >
                {entity.name}
                <span className="text-text-3 ml-1.5 text-[11px]">{entity.mentions}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
