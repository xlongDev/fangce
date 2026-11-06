import { useState, type PointerEvent } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import {
  DotsThreeVertical,
  DownloadSimple,
  Export,
  FolderOpen,
  PaintBrush,
  Plus,
  Sparkle,
  Trash,
  UserCircle,
} from "@phosphor-icons/react";

import { AiErrorCard } from "@/components/common/AiErrorCard";
import { GlassIconButton } from "@/components/glass/button";
import { GlassMenu, GlassMenuItem } from "@/components/glass/menu";
import { useAiConfig } from "@/hooks/useAi";
import {
  useAddCharacter,
  useCharacters,
  useClearCharacters,
  useExportCharacters,
  useGeneratePortrait,
  useImportCharacters,
} from "@/hooks/useGraph";
import { useSavePath } from "@/hooks/useSavePath";
import { cn } from "@/lib/cn";
import { isDesktopRuntime, ipc } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";

/** Whether the wall tilts under the pointer. A display preference, not a
 *  setting the backend needs, so it stays in the renderer's own storage —
 *  same place the assistant's tool switch lives. */
const EFFECT_KEY = "fangce:character-cards:tilt";

/**
 * The character wall: one card per person the graph found, plus the ways to
 * fill the gaps by hand.
 *
 * It is the graph panel's 人物 filter turned into something you look at rather
 * than scan: the portrait is the point, and a list of names cannot show one.
 * Everything else — who they are, what they did — is one tap away in the
 * assistant, which is why a card carries no relations.
 */
export function CharacterPanel({
  bookId,
  onAskAbout,
}: {
  bookId: string;
  /** Hands the character to the assistant. `undefined` makes cards inert. */
  onAskAbout?: (name: string) => void;
}) {
  const cards = useCharacters(bookId);
  const add = useAddCharacter(bookId);
  const clear = useClearCharacters(bookId);
  const exportPack = useExportCharacters(bookId);
  const importPack = useImportCharacters(bookId);
  const draw = useGeneratePortrait(bookId);
  const config = useAiConfig();
  const { choose } = useSavePath();

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [tilt, setTilt] = useState(() => localStorage.getItem(EFFECT_KEY) !== "off");

  const items = cards.data ?? [];
  const canDraw = Boolean(config.data?.imageBackend);

  const toggleTilt = () => {
    const next = !tilt;
    setTilt(next);
    localStorage.setItem(EFFECT_KEY, next ? "on" : "off");
  };

  const onExport = async () => {
    const path = await choose({
      defaultPath: "角色卡包.zip",
      filters: [{ name: "角色卡包", extensions: ["zip"] }],
    });
    if (!path) return;
    try {
      const count = await exportPack.mutateAsync(path);
      showToast("success", `已导出 ${count} 张角色卡`);
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const onImport = async () => {
    try {
      const picked = await openFile({
        multiple: false,
        filters: [{ name: "角色卡包", extensions: ["zip"] }],
      });
      if (typeof picked !== "string") return;
      const count = await importPack.mutateAsync(picked);
      showToast("success", `已导入 ${count} 张角色卡`);
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const submit = () => {
    const name = draft.trim();
    if (!name) return;
    add.mutate(name, {
      onSuccess: () => {
        setDraft("");
        setAdding(false);
      },
      onError: (error) => showToast("error", String(error)),
    });
  };

  if (cards.isPending) {
    return <p className="text-text-3 px-4 py-3 text-[13px]">正在加载…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline flex items-center gap-2 border-b px-3 py-2">
        <p className="text-text-3 min-w-0 flex-1 truncate text-[11px]">
          {items.length === 0 ? "" : "点击卡片问助手"}
        </p>
        <GlassMenu
          label="角色卡"
          trigger={
            <GlassIconButton size="sm" variant="subtle" label="更多">
              <DotsThreeVertical size={14} />
            </GlassIconButton>
          }
        >
          <GlassMenuItem
            icon={<Sparkle size={14} />}
            label={tilt ? "卡片效果 · 已开" : "卡片效果 · 已关"}
            onClick={toggleTilt}
          />
          <GlassMenuItem
            icon={<FolderOpen size={14} />}
            label="打开立绘目录"
            disabled={!isDesktopRuntime}
            onClick={() =>
              void ipc
                .graphOpenPortraits(bookId)
                .catch((error: unknown) => showToast("error", String(error)))
            }
          />
          <div className="border-hairline my-1.5 border-t" />
          <GlassMenuItem
            icon={<Export size={14} />}
            label="导出角色卡包"
            disabled={items.length === 0 || exportPack.isPending}
            onClick={() => void onExport()}
          />
          <GlassMenuItem
            icon={<DownloadSimple size={14} />}
            label="导入角色卡包"
            disabled={!isDesktopRuntime || importPack.isPending}
            onClick={() => void onImport()}
          />
        </GlassMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-text-3 text-[13px]">当前文件暂无角色</p>
            <p className="text-text-3 mt-1.5 text-[12px] leading-relaxed">
              角色来自知识图谱里的人物。抽取一遍，或者在这里手动加一个。
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-2.5">
            {items.map((card) => (
              <li key={card.name} className="relative">
                <button
                  type="button"
                  onClick={() => onAskAbout?.(card.name)}
                  onPointerMove={(event) => {
                    if (tilt) applyTilt(event);
                  }}
                  onPointerLeave={clearTilt}
                  className={cn(
                    "border-hairline bg-surface-2 group relative block w-full overflow-hidden rounded-lg border text-left transition-[transform,box-shadow] duration-150 ease-out",
                    tilt && "hover:shadow-glass will-change-transform",
                    tilt &&
                      "[transform:perspective(700px)_rotateX(var(--rx,0deg))_rotateY(var(--ry,0deg))] motion-reduce:[transform:none]",
                  )}
                >
                  <span className="block aspect-[2/3] w-full">
                    {card.portrait ? (
                      <img
                        src={card.portrait}
                        alt={`${card.name} 的立绘`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-text-3 flex h-full flex-col items-center justify-center gap-1.5">
                        <UserCircle size={26} className="opacity-40" />
                        <span className="text-[11px]">还没有立绘</span>
                      </span>
                    )}
                  </span>
                  {/* The glare is what turns a skew into a card: the highlight
                      follows the pointer, so the surface reads as catching the
                      light rather than as a rectangle being rotated. */}
                  {tilt && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 [background:radial-gradient(140px_circle_at_var(--mx,50%)_var(--my,50%),rgb(255_255_255/0.4),transparent_70%)] group-hover:opacity-100"
                    />
                  )}
                  {/* Two treatments, because the scrim exists for one reason:
                      white text over a picture. A card with no picture has no
                      picture to sit on, and a black wash there is just a grey
                      smear across an empty box. */}
                  <span
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-0 px-2 pb-1.5",
                      card.portrait ? "bg-gradient-to-t from-black/75 to-transparent pt-6" : "pt-2",
                    )}
                  >
                    <span
                      className={cn(
                        "block truncate text-[12.5px] font-medium",
                        card.portrait ? "text-white" : "text-text-1",
                      )}
                    >
                      {card.name}
                    </span>
                    <span
                      className={cn(
                        "block text-[10.5px]",
                        card.portrait ? "text-white/60" : "text-text-3",
                      )}
                    >
                      提及 {card.mentions} 次
                    </span>
                  </span>
                </button>
                {/* Sibling, not a child: a button inside a button is invalid
                    HTML and the browser drops the inner one's click. */}
                {canDraw && (
                  <button
                    type="button"
                    aria-label={card.portrait ? `重画 ${card.name}` : `画 ${card.name}`}
                    disabled={draw.isPending}
                    onClick={() =>
                      draw.mutate(
                        { name: card.name, appearance: "" },
                        { onError: (error) => showToast("error", String(error)) },
                      )
                    }
                    className="focus-visible:focus-ring absolute top-1.5 right-1.5 rounded-full bg-black/45 p-1.5 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white disabled:opacity-50"
                  >
                    <PaintBrush size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {draw.error ? (
          <div className="mt-3">
            <AiErrorCard message={String(draw.error)} />
          </div>
        ) : null}
      </div>

      {adding && (
        <div className="border-hairline flex items-center gap-2 border-t px-3 py-2">
          <input
            value={draft}
            ref={(node) => node?.focus()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") setAdding(false);
            }}
            placeholder="角色名"
            aria-label="角色名"
            className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent h-7 min-w-0 flex-1 rounded-full border px-3 text-[12.5px] transition-colors focus-visible:outline-none"
          />
          <button
            type="button"
            disabled={add.isPending || draft.trim() === ""}
            onClick={submit}
            className="focus-visible:focus-ring bg-accent text-on-accent shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            添加
          </button>
        </div>
      )}

      <div className="border-hairline flex items-center gap-3 border-t px-3 py-2">
        <span className="text-text-3 text-[11.5px]">共 {items.length} 个</span>
        {confirmClear ? (
          <>
            <span className="text-text-3 min-w-0 flex-1 truncate text-[11.5px]">
              连立绘一起删除，不能恢复。
            </span>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 shrink-0 text-[12px] transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate(undefined, {
                  onSuccess: () => setConfirmClear(false),
                  onError: (error) => showToast("error", String(error)),
                })
              }
              className="focus-visible:focus-ring text-danger shrink-0 text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              确定清空
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="focus-visible:focus-ring text-text-2 hover:text-text-1 ml-auto inline-flex shrink-0 items-center gap-1 text-[12px] transition-colors"
            >
              <Plus size={12} />
              添加角色
            </button>
            <button
              type="button"
              disabled={items.length === 0}
              onClick={() => setConfirmClear(true)}
              className="focus-visible:focus-ring text-text-3 hover:text-danger inline-flex shrink-0 items-center gap-1 text-[12px] transition-colors disabled:opacity-40"
            >
              <Trash size={12} />
              清空
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Tilts a card toward the pointer, writing the two angles as CSS variables.
 *
 *  Directly on the node rather than through state: this fires on every pointer
 *  move across the grid, and a re-render per move would make the wall of a
 *  hundred cards the slowest thing in the reader.
 */
function applyTilt(event: PointerEvent<HTMLElement>) {
  const node = event.currentTarget;
  const rect = node.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width - 0.5;
  const y = (event.clientY - rect.top) / rect.height - 0.5;
  node.style.setProperty("--ry", `${(x * 16).toFixed(2)}deg`);
  node.style.setProperty("--rx", `${(-y * 16).toFixed(2)}deg`);
  node.style.setProperty("--mx", `${((x + 0.5) * 100).toFixed(1)}%`);
  node.style.setProperty("--my", `${((y + 0.5) * 100).toFixed(1)}%`);
}

function clearTilt(event: PointerEvent<HTMLElement>) {
  const node = event.currentTarget;
  node.style.setProperty("--ry", "0deg");
  node.style.setProperty("--rx", "0deg");
}
