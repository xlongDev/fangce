import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { CircleNotch, DownloadSimple, Globe, MagnifyingGlass, Plus } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { GlassDialog } from "@/components/glass/overlay";
import { SourcePicker, sourcePickerOpen } from "@/features/source/SourcePicker";
import { staggerDelay, useMotion } from "@/lib/motion";
import { useSourceDownload, useSourceSearch, useSources } from "@/hooks/useSource";

/** Search stays in the dialog because it is an action on the shelf. Editing and
 *  batch management moved to `/plugins`; both entry points land there. */
export function SourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  if (!open) return null;

  const manage = () => {
    onClose();
    navigate("/plugins");
  };

  return (
    <GlassDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="在线找书"
      description="选一个书源，用书名或作者搜索，下载后自动进书架。"
      widthClass="w-[min(94vw,560px)]"
      // An open source picker takes Escape for itself: the key folds the list
      // away, and the dialog stays. See `SourcePicker.sourcePickerOpen`.
      onEscapeKeyDown={(event) => {
        if (sourcePickerOpen()) event.preventDefault();
      }}
    >
      <SearchView onManage={manage} />
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
