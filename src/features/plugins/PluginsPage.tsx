import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Code, Plus, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetadataSourcesPanel } from "@/features/plugins/MetadataSourcesPanel";
import { useChatStream } from "@/hooks/useAi";
import { useDeleteSource, useSaveSource, useSources } from "@/hooks/useSource";
import { isDesktopRuntime } from "@/lib/ipc";
import type { SourceEntry } from "@/lib/bindings";
import type { SourceRules } from "@/types/ipc";

const BLANK_SOURCE: SourceRules = {
  name: "新书源",
  baseUrl: "https://",
  permissions: { hosts: [] },
  search: {
    url: "/search?kw={{keyword}}",
    list: "$.data.list[*]",
    title: "$.name",
    author: "$.author",
    intro: "$.intro",
    cover: "$.cover",
    bookUrl: "$.book_id",
  },
  book: { title: "$.title", author: "$.author", intro: "$.intro", cover: "" },
  chapters: { list: "$.data.chapters[*]", title: "$.name", url: "$.url" },
  content: { paragraphs: "$.data.content" },
};

// Kept in sync with the QuickJS check in src-tauri/src/library/io/script.rs.
const WIKISOURCE_SCRIPT = String.raw`function transform(input, stage) {
  var pages = input.query && input.query.pages;
  var id = pages && Object.keys(pages)[0];
  var page = id ? pages[id] : null;
  var url = "/w/api.php?action=query&prop=extracts&explaintext=1&pageids=" + id + "&format=json";
  if (stage === "search") {
    return {
      results: ((input.query && input.query.search) || []).map(function (item) {
        return {
          title: item.title,
          author: "",
          book_url: "/w/api.php?action=query&prop=extracts&explaintext=1&pageids=" + item.pageid + "&format=json"
        };
      })
    };
  }
  if (stage === "detail") {
    return { title: (page && page.title) || "", intro: ((page && page.extract) || "").slice(0, 200) };
  }
  if (stage === "chapters") {
    return { list: [{ title: (page && page.title) || "全文", url: url }] };
  }
  if (stage === "content") {
    var text = (page && page.extract) || "";
    return { paragraphs: text.split(/\n\s*\n/).filter(function (p) { return p.trim().length > 0; }) };
  }
  return input;
}`;

const SOURCE_PROMPT = [
  "给方册阅读器写一份书源 JSON 规则，只输出 JSON 对象，不要解释、不要代码块。",
  "字段：name, baseUrl(https), permissions:{hosts:[]},",
  "search:{url,list,title,author,intro,cover,bookUrl}, book:{title,author,intro,cover},",
  "chapters:{list,title,url}, content:{paragraphs}。",
  "规则是极简 JSONPath：$ 起头、.取字段、[*]取数组全部，不支持 [0] 或函数。",
  "搜索地址用 {{keyword}} 占关键词的位置。",
  "站点不是 JSON 接口就直说做不到，不要编造规则。",
].join("\n");

/** Models like fences; a source definition ends at its last brace either way. */
function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/** A real source: Wikisource, public-domain text, no key. Works out of the box
 *  once saved; not preinstalled because the public API rate-limits bursts. */
const SAMPLE_SOURCE: SourceRules = {
  name: "维基文库（公有领域）",
  baseUrl: "https://zh.wikisource.org",
  permissions: { hosts: [] },
  search: {
    url: "/w/api.php?action=query&list=search&srsearch={{keyword}}&format=json&srlimit=5",
    list: "$.results[*]",
    title: "$.title",
    author: "$.author",
    intro: "",
    cover: "",
    bookUrl: "$.book_url",
  },
  book: { title: "$.title", author: "", intro: "$.intro", cover: "" },
  chapters: { list: "$.list[*]", title: "$.title", url: "$.url" },
  content: { paragraphs: "$.paragraphs[*]" },
  script: { code: WIKISOURCE_SCRIPT },
};

interface Editor {
  id: string | null;
  text: string;
  category: string;
}

const NO_SOURCES: SourceEntry[] = [];

function categoryOf(entry: SourceEntry): string {
  return entry.def.category?.trim() || "未分类";
}

/** `https://example.com/api` → `example.com`; a half-typed base URL is shown
 *  as typed rather than swallowing the row. */
function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "未填地址";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function PluginsPage() {
  const navigate = useNavigate();
  const sources = useSources();
  const deleteSource = useDeleteSource();
  const save = useSaveSource();
  const chat = useChatStream();

  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("全部");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<Editor | null>(null);
  const [brief, setBrief] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = sources.data ?? NO_SOURCES;
  const categories = useMemo(() => {
    const names = new Set<string>(["全部"]);
    for (const entry of list) names.add(categoryOf(entry));
    return [...names];
  }, [list]);

  const visible = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return list.filter((entry) => {
      if (category !== "全部" && categoryOf(entry) !== category) return false;
      if (!q) return true;
      return [entry.name, hostOf(entry.def.baseUrl), categoryOf(entry)].some((value) =>
        value.toLowerCase().includes(q),
      );
    });
  }, [list, keyword, category]);

  const chosen = list.filter((entry) => selected.has(entry.id));
  const allSelected = visible.length > 0 && visible.every((entry) => selected.has(entry.id));
  const scriptCount = list.filter((entry) => !!entry.def.script?.code?.trim()).length;

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(visible.map((entry) => entry.id)));
  };

  const openNew = () => {
    setError(null);
    setEditing({ id: null, text: JSON.stringify(BLANK_SOURCE, null, 2), category: "" });
  };

  const openEdit = (entry: SourceEntry) => {
    setError(null);
    setEditing({
      id: entry.id,
      text: JSON.stringify(entry.def, null, 2),
      category: entry.def.category ?? "",
    });
  };

  const generateRules = async () => {
    const request = brief.trim();
    if (!request || !editing) return;
    setError(null);
    const answer = await chat.ask(request, {
      turns: 0,
      prompt: `${SOURCE_PROMPT}\n\n用户描述：${request}`,
    });
    if (!answer) {
      setError("没拿到 AI 回复，先检查 AI 设置");
      return;
    }
    const json = extractJson(answer.content);
    if (!json) {
      setError("AI 的回复里没有 JSON 对象");
      return;
    }
    try {
      const def = JSON.parse(json) as SourceRules;
      if (!def.name || !def.baseUrl || !def.search?.url || !def.search.list || !def.search.title) {
        throw new Error("缺少 name / baseUrl / search 必填项");
      }
      setEditing({ ...editing, text: JSON.stringify(def, null, 2) });
    } catch (err) {
      setError(`AI 给的规则不能用：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runSave = () => {
    if (!editing) return;
    let def: SourceRules;
    try {
      def = JSON.parse(editing.text) as SourceRules;
    } catch (err) {
      setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const categoryText = editing.category.trim();
    save.mutate(
      { id: editing.id, def: { ...def, category: categoryText || null } },
      {
        onSuccess: () => setEditing(null),
        onError: (err) => setError(String(err)),
      },
    );
  };

  const runDelete = async () => {
    setError(null);
    try {
      await Promise.all(chosen.map((entry) => deleteSource.mutateAsync(entry.id)));
      setSelected(new Set());
      setConfirming(false);
    } catch (err) {
      setError(String(err));
      setConfirming(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="插件"
        subtitle="书源是一份描述搜索、详情、章节与正文接口的规则；需要时也可以挂一段受限脚本。"
      />
      <div className="mx-auto max-w-5xl px-6 pb-16 lg:px-8">
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={category === name}
              onClick={() => setCategory(name)}
              className={
                category === name
                  ? "glass text-text-1 border-accent rounded-full border px-3 py-1.5 text-[12.5px]"
                  : "text-text-3 hover:text-text-1 rounded-full px-3 py-1.5 text-[12.5px] transition-colors"
              }
            >
              {name}
            </button>
          ))}
          <span className="text-text-3 ml-auto text-[12px]">
            共 {list.length} 个书源 · {scriptCount} 个带脚本
          </span>
        </div>

        <div className="mb-4 flex items-center gap-2">
          <GlassButton size="md" onClick={() => navigate("/")}>
            <ArrowLeft size={14} /> 书库
          </GlassButton>
          <GlassInput
            className="min-w-0 flex-1"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="按名称、主机或分类筛选"
            aria-label="搜索书源"
          />
          <GlassButton size="md" onClick={toggleAll} disabled={visible.length === 0}>
            {allSelected ? "取消全选" : "全选"}
          </GlassButton>
          <GlassButton size="md" onClick={openNew}>
            <Plus size={14} /> 新建书源
          </GlassButton>
        </div>

        {chosen.length > 0 && (
          <div className="glass mb-3 flex items-center gap-3 rounded-xl border px-3 py-2">
            <span className="text-text-2 text-[12.5px]">已选 {chosen.length} 个</span>
            <GlassButton size="sm" onClick={() => setConfirming(true)}>
              <Trash size={14} /> 删除所选
            </GlassButton>
          </div>
        )}

        {error && <p className="text-text-2 mb-3 text-[12.5px] break-all">{error}</p>}

        {visible.length === 0 ? (
          <p className="text-text-3 py-10 text-center text-[13px]">
            {list.length === 0
              ? "还没有书源。新建一个，在线找书才有东西可搜。"
              : "没有匹配的书源。"}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((entry) => (
              <li
                key={entry.id}
                className="glass flex items-center gap-3 rounded-xl border px-3 py-2.5"
              >
                <input
                  type="checkbox"
                  checked={selected.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                  aria-label={`选择${entry.name}`}
                  className="h-4 w-4 shrink-0"
                />
                <button
                  type="button"
                  className="press focus-visible:focus-ring text-text-1 min-w-0 flex-1 text-left"
                  onClick={() => openEdit(entry)}
                >
                  <span className="block truncate text-[13.5px] font-medium">{entry.name}</span>
                  <span className="text-text-3 block truncate text-[11.5px]">
                    {categoryOf(entry)} · {hostOf(entry.def.baseUrl)}
                    {entry.def.permissions?.hosts?.length
                      ? `，另可访问 ${entry.def.permissions.hosts.join("、")}`
                      : ""}
                  </span>
                </button>
                {!!entry.def.script?.code?.trim() && (
                  <Code size={15} aria-label="带脚本" className="text-text-3 shrink-0" />
                )}
                <GlassButton
                  size="sm"
                  disabled={deleteSource.isPending}
                  onClick={() => deleteSource.mutate(entry.id)}
                  aria-label={`删除${entry.name}`}
                >
                  <Trash size={14} />
                </GlassButton>
              </li>
            ))}
          </ul>
        )}

        <section className="glass mt-6 rounded-2xl border p-4">
          <h2 className="text-text-1 text-[14px] font-medium">脚本插件</h2>
          <p className="text-text-3 mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed">
            脚本目前写在书源定义的 <code>script.code</code> 里，运行在受限 QuickJS
            沙箱中，没有网络与文件接口，单次最多两秒。独立的脚本插件会放在这一页。
          </p>
        </section>

        <MetadataSourcesPanel />

        {confirming && (
          <GlassDialog
            open
            onOpenChange={(next) => !next && setConfirming(false)}
            title="删除书源"
            description={`将删除选中的 ${chosen.length} 个书源。已经下载的书不受影响。`}
            widthClass="w-[min(92vw,420px)]"
          >
            <div className="flex justify-end gap-2">
              <GlassButton size="md" onClick={() => setConfirming(false)}>
                取消
              </GlassButton>
              <GlassButton
                variant="primary"
                size="md"
                disabled={deleteSource.isPending}
                onClick={runDelete}
              >
                确认删除
              </GlassButton>
            </div>
          </GlassDialog>
        )}

        {editing && (
          <GlassDialog
            open
            onOpenChange={(next) => !next && setEditing(null)}
            title={editing.id ? "编辑书源" : "新建书源"}
            description="分类用于这一页的筛选；规则仍然是一份 JSON 文档。不知道从哪填起，先展开下面的说明。"
            widthClass="w-[min(94vw,680px)]"
          >
            {/* The help block and the JSON together outgrow a short window.
                One scroller for the form, with the actions outside it, so
                保存 never lands below the bottom edge of the screen.
                Not flex: a flex column shrinks the h-80 editor to two lines
                and fights its native resize handle. */}
            <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
              <div className="flex items-center gap-2">
                <span className="text-text-3 w-10 shrink-0 text-[12.5px]">分类</span>
                <GlassInput
                  className="min-w-0 flex-1"
                  value={editing.category}
                  onChange={(event) => setEditing({ ...editing, category: event.target.value })}
                  placeholder="留空归入未分类"
                  aria-label="书源分类"
                />
              </div>
              <details className="text-text-3 text-[12px]">
                <summary className="cursor-pointer">怎么填？先看说明和示例</summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
                  <li>目标网站得有返回 JSON 的搜索接口——书源读接口，不读网页。</li>
                  <li>
                    <code>baseUrl</code> 填网站根地址，<code>search.url</code>{" "}
                    填搜索路径，关键词的位置写成 <code>{"{{keyword}}"}</code>。
                  </li>
                  <li>
                    <code>list</code> 指向结果数组，<code>title</code> / <code>author</code> /{" "}
                    <code>bookUrl</code> 指向每一项的书名 / 作者 / 详情地址。
                  </li>
                  <li>
                    <code>book</code> / <code>chapters</code> / <code>content</code>{" "}
                    照同一套写法填详情、目录、正文；点下载时才用到。
                  </li>
                </ol>
                <p className="mt-2">
                  示例接的是维基文库的公有领域书目，可以直接保存试用；正文是整篇纯文本。
                </p>
                <GlassButton
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    setEditing((current) =>
                      current ? { ...current, text: JSON.stringify(SAMPLE_SOURCE, null, 2) } : null,
                    )
                  }
                >
                  填入示例
                </GlassButton>
                <div className="mt-3 border-t pt-3">
                  <p className="mb-2">有接口地址或一段返回样例？让 AI 写：</p>
                  <textarea
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    aria-label="书源需求描述"
                    placeholder={
                      '例如：站点是 https://example.com，搜索接口 /api/search?q=关键词，返回 {"list":[…]}'
                    }
                    className="glass text-text-1 focus-visible:border-accent focus-visible:bg-surface-2 h-20 w-full rounded-xl border p-2.5 text-[12px] outline-none"
                  />
                  <GlassButton
                    size="sm"
                    className="mt-2"
                    disabled={!isDesktopRuntime || chat.streaming || !brief.trim()}
                    onClick={() => void generateRules()}
                  >
                    {chat.streaming ? "生成中…" : "让 AI 写"}
                  </GlassButton>
                </div>
              </details>
              <textarea
                value={editing.text}
                onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                spellCheck={false}
                aria-label="书源规则"
                className="glass text-text-1 focus-visible:border-accent focus-visible:bg-surface-2 h-80 w-full rounded-xl border p-3 font-mono text-[12px] leading-relaxed outline-none"
              />
              {/* The backend refuses anything outside this list, redirects
                  included, so saying it here keeps the error unsurprising. */}
              <p className="text-text-3 text-[11.5px] leading-relaxed">
                书源只能访问 baseUrl
                的主机。接口返回的绝对地址若在别的主机（CDN、第二个域名），把它加进
                permissions.hosts。脚本写在 script.code 里。
              </p>
              {error && <p className="text-text-2 text-[12.5px] break-all">{error}</p>}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <GlassButton size="md" onClick={() => setEditing(null)}>
                取消
              </GlassButton>
              <GlassButton variant="primary" size="md" disabled={save.isPending} onClick={runSave}>
                保存
              </GlassButton>
            </div>
          </GlassDialog>
        )}
      </div>
    </div>
  );
}
