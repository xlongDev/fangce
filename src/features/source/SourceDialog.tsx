import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  ArrowUUpLeft,
  CircleNotch,
  DownloadSimple,
  Globe,
  MagnifyingGlass,
  Plus,
  Trash,
} from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { Reveal } from "@/components/motion/Reveal";
import { SourcePicker, sourcePickerOpen } from "@/features/source/SourcePicker";
import { staggerDelay, useMotion } from "@/lib/motion";
import {
  useDeleteSource,
  useSaveSource,
  useSourceDownload,
  useSourceSearch,
  useSources,
} from "@/hooks/useSource";
import type { SourceRules } from "@/types/ipc";

const BLANK_SOURCE: SourceRules = {
  name: "新书源",
  baseUrl: "https://",
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

interface Editor {
  id: string | null;
  text: string;
}

export function SourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<"search" | "manage">("search");
  const [editing, setEditing] = useState<Editor | null>(null);

  if (!open) return null;

  return (
    <GlassDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          {view === "manage" ? "管理书源" : "在线找书"}
        </span>
      }
      description={
        view === "manage"
          ? "书源是一份 JSON 规则，描述如何调用一个网站的搜索、详情、章节和正文接口。"
          : "选一个书源，用书名或作者搜索，下载后自动进书架。"
      }
      widthClass="w-[min(94vw,560px)]"
      // An open source picker takes Escape for itself: the key folds the list
      // away, and the dialog stays. See `SourcePicker.sourcePickerOpen`.
      onEscapeKeyDown={(event) => {
        if (sourcePickerOpen()) event.preventDefault();
      }}
    >
      {/* Keyed so the pane remounts and rises in: search, the source list and
          the JSON editor differ enough that cutting between them reads as a
          jump rather than a step sideways. */}
      <Reveal key={view === "search" ? "search" : editing ? "editor" : "manage"}>
        {view === "search" ? (
          <SearchView onManage={() => setView("manage")} />
        ) : editing ? (
          <SourceEditor editor={editing} onBack={() => setEditing(null)} />
        ) : (
          <ManageView
            onNew={() => setEditing({ id: null, text: JSON.stringify(BLANK_SOURCE, null, 2) })}
            onEdit={(entry) =>
              setEditing({ id: entry.id, text: JSON.stringify(entry.def, null, 2) })
            }
            onBack={() => setView("search")}
          />
        )}
      </Reveal>
    </GlassDialog>
  );
}

function SearchView({ onManage }: { onManage: () => void }) {
  const queryClient = useQueryClient();
  const sources = useSources();
  const m = useMotion();
  const [sourceId, setSourceId] = useState("");
  const [keyword, setKeyword] = useState("");

  const search = useSourceSearch();
  const { download, progress } = useSourceDownload();
  const [message, setMessage] = useState<string | null>(null);

  const list = sources.data ?? [];
  const activeId = sourceId || list[0]?.id || "";
  const results = search.data;
  const searching = search.isPending;

  const runSearch = () => {
    if (!activeId) return;
    search.mutate({ sourceId: activeId, keyword }, { onSuccess: () => setMessage(null) });
  };

  const runDownload = (bookUrl: string) => {
    download.mutate(
      { sourceId: activeId, bookUrl },
      {
        onSuccess: (result) => {
          setMessage(
            result.duplicate ? `《${result.title}》已在书架上` : `《${result.title}》已加入书架`,
          );
          void queryClient.invalidateQueries({ queryKey: ["books"] });
        },
        onError: (error) => setMessage(String(error)),
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SourcePicker
          sources={list.map((entry) => ({ id: entry.id, name: entry.name }))}
          value={activeId}
          onChange={setSourceId}
        />
        <GlassButton size="md" onClick={onManage}>
          管理
        </GlassButton>
      </div>

      <div className="flex items-center gap-2">
        <GlassInput
          // The shared input ships `w-full`, which in this flex line makes it
          // claim the whole row and squeezes the button beside it. `flex-1
          // min-w-0` is the canonical flex child: it fills the space that is
          // left over and can shrink below its content, leaving the button its
          // natural width. (`SourcePicker` above already works this way.)
          className="min-w-0 flex-1"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runSearch();
          }}
          placeholder="书名或作者"
          aria-label="搜索关键词"
        />
        <GlassButton
          variant="primary"
          size="md"
          disabled={!activeId || !keyword.trim() || searching}
          onClick={runSearch}
        >
          {searching ? (
            <motion.span
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, ease: "linear", duration: 0.9 }}
              className="inline-flex"
            >
              <CircleNotch size={14} />
            </motion.span>
          ) : (
            <MagnifyingGlass size={14} />
          )}
          {searching ? "搜索中" : "搜索"}
        </GlassButton>
      </div>

      {list.length === 0 ? (
        <NoSourcesState onManage={onManage} />
      ) : (
        <>
          {searching && <SearchSkeleton />}

          {search.isError && (
            <p className="text-text-2 glass rounded-xl border px-3 py-2 text-[12.5px]">
              {String(search.error)}
            </p>
          )}

          {results && !searching && results.length === 0 && (
            <p className="text-text-3 py-6 text-center text-sm">没有找到匹配的书。</p>
          )}

          {!!results?.length && (
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {/* Staggered, and capped: a result set is a list the eye reads top
                  down, so the rows arrive in order — but a long one still finishes
                  together instead of trickling in. */}
              {results.map((book, index) => (
                <motion.li
                  key={book.url}
                  initial={{ opacity: 0, y: m.rise }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...m.enter, delay: staggerDelay(index, m.stagger) }}
                  className="glass hover:bg-surface-2 flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-text-1 truncate text-[13.5px] font-medium">
                      {book.title}
                      {book.author && (
                        <span className="text-text-3 ml-2 text-xs">{book.author}</span>
                      )}
                    </p>
                    {book.intro && (
                      <p className="text-text-3 mt-1 line-clamp-2 text-[12px] leading-relaxed">
                        {book.intro}
                      </p>
                    )}
                  </div>
                  <GlassButton
                    size="sm"
                    disabled={download.isPending}
                    onClick={() => runDownload(book.url)}
                  >
                    <DownloadSimple size={14} /> 下载
                  </GlassButton>
                </motion.li>
              ))}
            </ul>
          )}
        </>
      )}

      {(download.isPending || message) && (
        <motion.p
          initial={{ opacity: 0, y: m.rise }}
          animate={{ opacity: 1, y: 0 }}
          transition={m.enter}
          className="text-text-2 flex items-center gap-2 text-[12.5px]"
        >
          {download.isPending && (
            <motion.span
              animate={m.reduce ? { rotate: 0 } : { rotate: 360 }}
              transition={
                m.reduce ? { duration: 0 } : { repeat: Infinity, ease: "linear", duration: 0.9 }
              }
              className="text-accent inline-flex"
            >
              <CircleNotch size={13} />
            </motion.span>
          )}
          {download.isPending && progress
            ? `正在下载 ${progress.done}/${progress.total}：${progress.chapter}`
            : message}
        </motion.p>
      )}
    </div>
  );
}

/**
 * The shelf with no sources, which used to be a sentence telling the reader to
 * go find the 管理 button. The empty state carries its own way out now: the
 * one action that fills it, right here.
 */
function NoSourcesState({ onManage }: { onManage: () => void }) {
  const m = useMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={m.enter}
      className="flex flex-col items-center px-4 py-8 text-center"
    >
      <div className="relative mb-4">
        <span aria-hidden className="bg-accent-soft absolute -inset-4 rounded-full blur-2xl" />
        <span className="glass text-text-2 relative flex h-12 w-12 items-center justify-center rounded-2xl">
          <Globe size={22} weight="duotone" />
        </span>
      </div>
      <p className="text-text-1 text-[13.5px] font-medium">还没有书源</p>
      <p className="text-text-2 mt-1 max-w-[36ch] text-[12.5px] leading-relaxed">
        书源描述了一个网站的搜索与章节接口。添加一个之后，就能在这里搜书名，直接下载进书架。
      </p>
      <GlassButton variant="primary" size="md" className="mt-4" onClick={onManage}>
        <Plus size={14} /> 添加书源
      </GlassButton>
    </motion.div>
  );
}

/** Result rows' shape while a search is in flight, so the list does not jump
 *  into existence whole. The sweep itself is the shared `.skeleton`. */
function SearchSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="glass flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="skeleton h-3.5 rounded-full" style={{ width: `${64 - row * 14}%` }} />
            <div className="skeleton h-2.5 rounded-full" style={{ width: `${88 - row * 18}%` }} />
          </div>
          <div className="skeleton h-8 w-16 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function ManageView({
  onNew,
  onEdit,
  onBack,
}: {
  onNew: () => void;
  onEdit: (entry: { id: string; name: string; def: SourceRules }) => void;
  onBack: () => void;
}) {
  const sources = useSources();
  const deleteSource = useDeleteSource();

  const list = sources.data ?? [];

  return (
    <div className="space-y-3">
      {list.length === 0 && (
        <p className="text-text-3 py-4 text-center text-[12.5px]">
          一个书源都没有。新建一个，搜索才有东西可搜。
        </p>
      )}
      <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
        {list.map((entry) => (
          <li
            key={entry.id}
            className="glass flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
          >
            <button
              type="button"
              className="press focus-visible:focus-ring text-text-1 min-w-0 flex-1 truncate text-left text-[13.5px] font-medium"
              onClick={() => onEdit(entry)}
            >
              {entry.name}
            </button>
            <GlassButton
              size="sm"
              disabled={deleteSource.isPending}
              onClick={() => deleteSource.mutate(entry.id)}
            >
              <Trash size={14} />
            </GlassButton>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-2">
        <GlassButton size="md" onClick={onBack}>
          <ArrowUUpLeft size={14} /> 返回
        </GlassButton>
        <GlassButton variant="primary" size="md" onClick={onNew}>
          <Plus size={14} /> 新建书源
        </GlassButton>
      </div>
    </div>
  );
}

function SourceEditor({ editor, onBack }: { editor: Editor; onBack: () => void }) {
  const save = useSaveSource();
  const [text, setText] = useState(editor.text);
  const [error, setError] = useState<string | null>(null);

  const runSave = () => {
    let def: SourceRules;
    try {
      def = JSON.parse(text) as SourceRules;
    } catch (err) {
      setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    save.mutate(
      { id: editor.id, def },
      { onSuccess: onBack, onError: (err) => setError(String(err)) },
    );
  };

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        aria-label="书源规则"
        className="glass text-text-1 focus-visible:border-accent focus-visible:bg-surface-2 h-72 w-full rounded-xl border p-3 font-mono text-[12px] leading-relaxed outline-none"
      />
      {error && <p className="text-text-2 text-[12.5px] break-all">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <GlassButton size="md" onClick={onBack}>
          取消
        </GlassButton>
        <GlassButton variant="primary" size="md" disabled={save.isPending} onClick={runSave}>
          保存
        </GlassButton>
      </div>
    </div>
  );
}
