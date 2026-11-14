import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowCounterClockwise,
  PencilSimple,
  Sparkle,
  Star,
  Tag,
  MagicWand,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog, OverlayPortal } from "@/components/glass/overlay";
import { SPRING, useMotion } from "@/lib/motion";
import { AiErrorCard } from "@/components/common/AiErrorCard";
import { useAiConfig } from "@/hooks/useAi";
import { useSetMetadataMany } from "@/hooks/useLibrary";
import { isDesktopRuntime, ipc } from "@/lib/ipc";
import { demoEnabled } from "@/lib/demo";
import { useFillRun } from "@/stores/fillRun";
import { useGuideBatch } from "@/stores/guideBatch";
import { BatchFillDialog } from "@/features/library/BatchFillDialog";
import { AiTagDialog } from "@/features/library/AiTagDialog";
import { BatchMetaDialog } from "@/features/library/BatchMetaDialog";
import type { ShelfSelection } from "@/features/library/useShelfSelection";

/**
 * The batch bar, and the confirmation it asks for.
 *
 * `anchorRef` is the shelf's scroller: the bar is `position: fixed` in the
 * shell's overlay host, and that host is the *window* — so a plain `left: 50%`
 * is the window's middle while the shelf sits ~130px right of it (the
 * sidebar). The placement is therefore written as the pane's gutters (padding
 * on a full-width wrapper) rather than as a `left` on the bar.
 */
export function ShelfBatchBar({
  anchorRef,
  selection,
  busy,
  mode = "shelf",
}: {
  anchorRef: RefObject<HTMLElement | null>;
  selection: ShelfSelection;
  busy: { favorite: boolean; delete: boolean };
  /** The bin's bar offers two actions, not six: nothing on a trashed book can
   *  be labelled, favourited or summarised — it is not on the shelf. */
  mode?: "shelf" | "trash";
}) {
  const m = useMotion();
  const trashed = mode === "trash";
  const barRef = useRef<HTMLDivElement>(null);
  const [guideConfirm, setGuideConfirm] = useState(false);
  /** The batch metadata sheet. Its own dialog rather than a mode of the
   *  per-book one: that sheet starts from one book's values, and a batch has
   *  no values to start from — only fields the reader may or may not fill. */
  const [metaOpen, setMetaOpen] = useState(false);
  /** The AI labelling sheet. Its ids are frozen when it opens: a reader who
   *  ticks another book behind the dialog is not asking for a second model
   *  call about it. */
  const [tagIds, setTagIds] = useState<string[] | null>(null);
  /** The catalogue fill sheet. It owns its own selection of ids, because the
   *  batch it proposes for is fixed when it opens — a reader who ticks another
   *  book behind the dialog is not asking for a new lookup. */
  const [fillIds, setFillIds] = useState<string[] | null>(null);
  const setMetadataMany = useSetMetadataMany();
  /** 整架补全的进度。名字避开下面导读批处理那个 `run`。 */
  const fillRun = useFillRun();

  /** Which books already have a cached guide, so the confirm dialog can skip
   *  them out of the queue and out of the token estimate. Refetched on open:
   *  a run that just finished wrote new entries, and the store cannot reach
   *  this cache to invalidate it. */
  const cached = useQuery({
    queryKey: ["ai", "guide-status"],
    queryFn: () => ipc.aiGuideStatus(),
    enabled: isDesktopRuntime,
  });
  const cachedIds = useMemo(() => new Set(cached.data ?? []), [cached.data]);

  /** The books a run would actually generate, right now. */
  const pending = useMemo(
    () => selection.selectedBooks.filter((book) => !cachedIds.has(book.id)),
    [selection.selectedBooks, cachedIds],
  );

  const { data: config } = useAiConfig();
  const ready = !!config && config.model.trim() !== "" && config.baseUrl.trim() !== "";

  /** The global run: its progress is the shell's pill, the bar only forbids a
   *  second one. */
  const run = useGuideBatch((s) => s.run);
  const inFlight = run !== null && run.status !== "done";

  /**
   * Where the bar belongs, horizontally.
   *
   * Not a style preference: an absolutely positioned box with a `left` and no
   * `right` is shrink-to-fit against the space between that `left` and the
   * viewport edge, so a bar told to sit at the pane's centre was silently
   * capped at (viewport − centre) wide. At 1280 that is 765px and the bar
   * needed 510, so nothing showed; at the ~1080 window in the bug report it is
   * ~416px, and every label in the bar wrapped to one character per line —
   * 已选 0 本 and 取消收藏 stacked vertically. Padding on a full-width wrapper
   * has no such ceiling, and `justify-center` inside it centres on the pane.
   *
   * Written straight onto the element instead of into state: the sidebar
   * animates its own width over ~340ms, so this tracks the spring frame by
   * frame, and a re-render per frame is the one thing the shelf's windowed
   * grid cannot afford.
   *
   * `anchorRef.parentElement` is the page's own root, which is the pane's
   * content box — the pane carries no padding of its own.
   */
  useLayoutEffect(() => {
    if (!selection.managing) return;
    const pane = anchorRef.current?.parentElement;
    const bar = barRef.current;
    if (!pane || !bar) return;
    const place = () => {
      const box = pane.getBoundingClientRect();
      bar.style.paddingLeft = `${box.left}px`;
      bar.style.paddingRight = `${window.innerWidth - box.right}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [selection.managing, anchorRef]);

  const openGuideConfirm = () => {
    void cached.refetch();
    setGuideConfirm(true);
  };

  return (
    <>
      <OverlayPortal>
        {/* No scrim behind the bar.
            One used to sit here — a `fixed inset-0 z-30` button whose job was
            "click outside to exit". It also covered the shelf, and the shelf
            is the thing this mode is *for*: every click on a card landed on
            the scrim instead, so the mode exited and nothing was ever
            selected (measured in both engines: the topmost element at a
            card's centre was the scrim, not the card). A selection mode whose
            selection surface is behind a dismiss layer is not a mode.
            The way out is 完成, or Escape — see the key handler in
            `useShelfSelection`.

            The wrapper is always mounted, with the bar itself inside
            `AnimatePresence`: the placement effect writes the pane's gutters
            onto it as padding, and a `fixed inset-x-0` box has no width
            ceiling for those gutters to run into. Empty it is zero-height and
            `pointer-events-none`, so it costs nothing between uses. */}
        <div
          ref={barRef}
          className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center"
        >
          <AnimatePresence>
            {selection.managing && (
              <motion.div
                initial={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                transition={m.panel}
                // Centred by the wrapper's flex, not by a `-translate-x-1/2`:
                // motion writes `transform` for the spring, and the half-width
                // nudge is only safe in a property it does not touch. The
                // `whitespace-nowrap` is the last line of defence — a label
                // that wrapped to one character per line is what this bug
                // looked like from the outside.
                className="glass-2 shadow-panel pointer-events-auto flex items-center gap-1.5 rounded-2xl p-2 pl-4 whitespace-nowrap"
                data-batch-bar
              >
                <span className="text-text-2 mr-1 text-sm whitespace-nowrap">
                  已选{" "}
                  <motion.span
                    key={selection.count}
                    initial={{ y: 8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={SPRING.tap}
                    className="text-text-1 inline-block font-semibold tabular-nums"
                  >
                    {selection.count}
                  </motion.span>{" "}
                  本
                </span>
                <GlassButton size="sm" variant="subtle" onClick={selection.toggleAll}>
                  {selection.allSelected ? "取消全选" : "全选"}
                </GlassButton>
                {trashed ? (
                  <>
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0}
                      onClick={selection.restore}
                    >
                      <ArrowCounterClockwise size={13} /> 恢复
                    </GlassButton>
                    <GlassButton
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      disabled={selection.count === 0 || busy.delete}
                      onClick={selection.openDelete}
                    >
                      彻底删除
                    </GlassButton>
                  </>
                ) : (
                  <>
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0}
                      onClick={selection.requestTags}
                    >
                      <Tag size={13} /> 打标签
                    </GlassButton>
                    {/* Beside 打标签: the same question — what is this book
                        about — answered by a model instead of by the reader.
                        Still the reader's call: nothing is written until the
                        preview is confirmed. */}
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0 || !isDesktopRuntime}
                      onClick={() => setTagIds(selection.selectedBooks.map((book) => book.id))}
                    >
                      <Sparkle size={13} /> AI 标签
                    </GlassButton>
                    {/* Beside 打标签 because both are "describe these books":
                        the label is the reader's own word, the metadata is the
                        book's. */}
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0}
                      onClick={() => setMetaOpen(true)}
                    >
                      <PencilSimple size={13} /> 编辑信息
                    </GlassButton>
                    {/* Next to 编辑信息: the same question — "what does this
                        book say about itself" — answered by a catalogue
                        instead of by the reader. */}
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      // Enabled in the demo build too: it serves canned
                      // proposals, which is what lets a browser test open this
                      // sheet at all.
                      // A run keeps going after the dialog is closed, so the bar
                      // has to say so — otherwise the reader closes it, sees
                      // nothing happening, and starts a second one.
                      disabled={
                        !fillRun.running &&
                        (selection.count === 0 || (!isDesktopRuntime && !demoEnabled()))
                      }
                      onClick={() => setFillIds(selection.selectedBooks.map((book) => book.id))}
                    >
                      <MagicWand size={13} />
                      {fillRun.running ? `补全中 ${fillRun.done}/${fillRun.total}` : "补全信息"}
                    </GlassButton>
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0 || busy.favorite}
                      onClick={() => selection.favorite(true)}
                    >
                      <Star size={13} /> 收藏
                    </GlassButton>
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0 || busy.favorite}
                      onClick={() => selection.favorite(false)}
                    >
                      取消收藏
                    </GlassButton>
                    <GlassButton
                      size="sm"
                      variant="subtle"
                      disabled={selection.count === 0 || inFlight || !isDesktopRuntime}
                      onClick={openGuideConfirm}
                    >
                      {/* Same mark as the reader's AI 导读 button. */}
                      <Sparkle size={13} /> 生成导读
                    </GlassButton>
                    <GlassButton
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      disabled={selection.count === 0 || busy.delete}
                      onClick={selection.openDelete}
                    >
                      删除
                    </GlassButton>
                    <GlassButton size="sm" variant="primary" onClick={selection.exit}>
                      完成
                    </GlassButton>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </OverlayPortal>

      <GlassDialog
        open={selection.deleteOpen}
        onOpenChange={(next) => {
          if (!next) selection.closeDelete();
        }}
        title={
          trashed
            ? `彻底删除选中的 ${selection.count} 本书？`
            : `删除选中的 ${selection.count} 本书？`
        }
        // Two different sentences, because they are two different operations:
        // one can be undone from the bin, the other cannot be undone at all.
        description={
          trashed
            ? "书籍文件、封面、笔记和阅读进度会一并删除，此操作无法撤销。"
            : "选中的书籍会移到回收站，可以随时恢复。"
        }
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton variant="subtle" onClick={selection.closeDelete} disabled={busy.delete}>
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            onClick={selection.confirmDelete}
            disabled={busy.delete}
          >
            {trashed ? "彻底删除" : "删除"}
          </GlassButton>
        </div>
      </GlassDialog>

      <BatchFillDialog
        open={fillIds !== null}
        ids={fillIds ?? []}
        onClose={() => setFillIds(null)}
      />

      <AiTagDialog open={tagIds !== null} ids={tagIds ?? []} onClose={() => setTagIds(null)} />

      <BatchMetaDialog
        open={metaOpen}
        count={selection.count}
        busy={setMetadataMany.isPending}
        onCancel={() => setMetaOpen(false)}
        onSave={(patch) =>
          setMetadataMany.mutate(
            { ids: selection.selectedBooks.map((book) => book.id), patch },
            { onSuccess: () => setMetaOpen(false) },
          )
        }
      />

      {/* Batch AI guides: confirm (with the token estimate), then hand the run
          to the global store — progress floats as a shell-level pill, and the
          reader keeps using the app. 停止 takes effect between books on
          purpose: a stream cancelled midway comes back as Ok with a stump, and
          a stump must not be cached. */}
      <GlassDialog
        open={guideConfirm}
        onOpenChange={setGuideConfirm}
        title="批量生成 AI 导读"
        widthClass="w-[min(92vw,440px)]"
      >
        <div className="space-y-3">
          <p className="text-text-2 text-sm leading-relaxed">
            选中 {selection.count} 本
            {selection.count > pending.length &&
              `，其中 ${selection.count - pending.length} 本已有导读会自动跳过`}
            。
            {pending.length > 0
              ? `将为 ${pending.length} 本新生成；每本约消耗 1 万 tokens（导读只读书名、目录和几段章节开头，素材有固定上限，输出约一千字），共约 ${pending.length} 万 tokens，实际随模型不同略有出入。`
              : "所选书籍都已生成过导读，没有需要新建的。"}
          </p>
          {!ready && <AiErrorCard message="还没有配置 AI 模型，先到设置里填写接口地址与模型名称" />}
          <div className="flex justify-end gap-2 pt-1">
            <GlassButton variant="subtle" onClick={() => setGuideConfirm(false)}>
              取消
            </GlassButton>
            <GlassButton
              variant="primary"
              disabled={pending.length === 0 || !ready}
              onClick={() => {
                setGuideConfirm(false);
                void useGuideBatch.getState().start(pending);
              }}
            >
              开始生成
            </GlassButton>
          </div>
        </div>
      </GlassDialog>
    </>
  );
}
