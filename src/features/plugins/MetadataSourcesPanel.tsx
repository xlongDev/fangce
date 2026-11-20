import { useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import {
  useDeleteMetadataSource,
  useMetadataSources,
  useSaveMetadataSource,
} from "@/hooks/useMetadata";
import type { CustomSourceDef, CustomSourceEntry } from "@/lib/bindings";

const BLANK: CustomSourceDef = {
  name: "我的目录",
  baseUrl: "https://",
  searchUrl: "/api/search?q={{query}}",
  list: "$.data[*]",
  title: "$.title",
  authors: "$.author",
  intro: "",
  publisher: "",
  publishedYear: "",
  language: "",
  isbn: "",
  rating: "",
  cover: "",
};

interface Editor {
  id: string | null;
  text: string;
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "未填地址";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Reader-defined metadata catalogues. Separate from book sources: these map a
 *  JSON response onto book metadata, while those download chapter text. */
export function MetadataSourcesPanel() {
  const sources = useMetadataSources();
  const save = useSaveMetadataSource();
  const remove = useDeleteMetadataSource();
  const [editing, setEditing] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entries = sources.data ?? [];

  const openNew = () => {
    setError(null);
    setEditing({ id: null, text: JSON.stringify(BLANK, null, 2) });
  };

  const openEdit = (entry: CustomSourceEntry) => {
    setError(null);
    setEditing({ id: entry.id, text: JSON.stringify(entry.def, null, 2) });
  };

  const runSave = () => {
    if (!editing) return;
    let def: CustomSourceDef;
    try {
      def = JSON.parse(editing.text) as CustomSourceDef;
    } catch (err) {
      setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    save.mutate(
      { id: editing.id, def },
      { onSuccess: () => setEditing(null), onError: (err) => setError(String(err)) },
    );
  };

  return (
    <section className="glass mt-8 rounded-2xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-text-1 text-[14px] font-medium">元数据来源</h2>
          <p className="text-text-3 mt-1 max-w-[68ch] text-[12.5px] leading-relaxed">
            自己加一个书目接口：搜索地址里的 <code>{"{{query}}"}</code> 会换成书名，规则从书源那一套
            JSONPath 里来。只能访问填写的主机，封面仍只从内置目录的图片服务器取。
          </p>
        </div>
        <GlassButton size="md" onClick={openNew}>
          <Plus size={14} /> 新建
        </GlassButton>
      </div>

      {error && <p className="text-text-2 mt-3 text-[12.5px] break-all">{error}</p>}

      {entries.length === 0 ? (
        <p className="text-text-3 py-6 text-center text-[12.5px]">
          还没有自定义来源。内置的豆瓣与 NeoDB 一直可用；这一节是加自己的目录。
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
              <button
                type="button"
                className="press focus-visible:focus-ring text-text-1 min-w-0 flex-1 text-left"
                onClick={() => openEdit(entry)}
              >
                <span className="block truncate text-[13.5px] font-medium">{entry.name}</span>
                <span className="text-text-3 block truncate text-[11.5px]">
                  {hostOf(entry.def.baseUrl)}
                </span>
              </button>
              <GlassButton
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(entry.id)}
                aria-label={`删除${entry.name}`}
              >
                <Trash size={14} />
              </GlassButton>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <GlassDialog
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={editing.id ? "编辑元数据来源" : "新建元数据来源"}
          description="一份 JSON 文档：主机、搜索地址与字段规则。"
          widthClass="w-[min(94vw,680px)]"
        >
          <div className="space-y-3">
            <textarea
              value={editing.text}
              onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              spellCheck={false}
              aria-label="元数据来源规则"
              className="glass text-text-1 focus-visible:border-accent focus-visible:bg-surface-2 h-80 w-full rounded-xl border p-3 font-mono text-[12px] leading-relaxed outline-none"
            />
            <p className="text-text-3 text-[11.5px] leading-relaxed">
              只能访问 baseUrl 的主机，且必须
              HTTPS。必填：name、baseUrl、searchUrl、list、title；其余规则留空即不补那个字段。
            </p>
            {error && <p className="text-text-2 text-[12.5px] break-all">{error}</p>}
            <div className="flex justify-end gap-2">
              <GlassButton size="md" onClick={() => setEditing(null)}>
                取消
              </GlassButton>
              <GlassButton variant="primary" size="md" disabled={save.isPending} onClick={runSave}>
                保存
              </GlassButton>
            </div>
          </div>
        </GlassDialog>
      )}
    </section>
  );
}
