import { useState } from "react";
import { PaintBrush } from "@phosphor-icons/react";

import { AiErrorCard } from "@/components/common/AiErrorCard";
import { GlassButton } from "@/components/glass/button";
import { useAiConfig } from "@/hooks/useAi";
import { useCharacterPortrait, useGeneratePortrait } from "@/hooks/useGraph";
import type { GraphEntity } from "@/types/ipc";

/**
 * A character's portrait, or the way to get one.
 *
 * Renders nothing at all when no image backend is configured: a button that can
 * only fail with "先到设置里选一个后端" is worse than no button, and the settings
 * page is where that decision belongs.
 *
 * The picture is served from the resource protocol, which sends `no-store` — so
 * a redraw needs only a new URL to be picked up, and the nonce below is that new
 * URL. Without it the `<img>` keeps the same `src` and the browser keeps the old
 * bytes.
 */
export function PortraitCard({ bookId, entity }: { bookId: string; entity: GraphEntity }) {
  const config = useAiConfig();
  const stored = useCharacterPortrait(bookId, entity.name);
  const generate = useGeneratePortrait(bookId);
  const [appearance, setAppearance] = useState("");
  const [nonce, setNonce] = useState(0);

  if (!config.data?.imageBackend) return null;

  const url = generate.data ?? stored.data ?? null;
  const shown = url && nonce > 0 ? `${url}?v=${nonce}` : url;

  return (
    <div className="border-hairline mb-3 flex gap-3 border-b pb-3">
      {shown ? (
        <img
          src={shown}
          alt={`${entity.name} 的立绘`}
          className="border-hairline h-[132px] w-[88px] shrink-0 rounded-md border object-cover"
        />
      ) : (
        <div className="border-hairline text-text-3 flex h-[132px] w-[88px] shrink-0 items-center justify-center rounded-md border text-center text-[11px] leading-tight">
          还没有
          <br />
          立绘
        </div>
      )}

      <div className="min-w-0 flex-1 space-y-2">
        {!shown && (
          <input
            value={appearance}
            onChange={(event) => setAppearance(event.target.value)}
            placeholder="形象描述（可选）"
            aria-label="形象描述"
            className="glass text-text-1 placeholder:text-text-3 focus-visible:border-accent h-7 w-full rounded-full border px-2.5 text-[12px] transition-colors focus-visible:outline-none"
          />
        )}
        <GlassButton
          variant="subtle"
          size="sm"
          leading={<PaintBrush size={13} />}
          disabled={generate.isPending}
          onClick={() =>
            generate.mutate(
              { name: entity.name, appearance },
              { onSuccess: () => setNonce((value) => value + 1) },
            )
          }
        >
          {generate.isPending ? "正在画…" : shown ? "重画一张" : "生成立绘"}
        </GlassButton>
        {generate.isPending && (
          <p className="text-text-3 text-[11px] leading-relaxed">先写画面描述，再交给图像接口。</p>
        )}
        {generate.error ? <AiErrorCard message={String(generate.error)} /> : null}
      </div>
    </div>
  );
}
