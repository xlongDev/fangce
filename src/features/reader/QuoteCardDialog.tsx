import { useEffect, useRef, useState } from "react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { useSavePath } from "@/hooks/useSavePath";
import { useReadingSurface } from "@/hooks/useReadingSurface";
import { useBook } from "@/hooks/useReader";
import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { downloadBytes } from "@/lib/local/save";
import { filename } from "@/lib/filename";
import { useBookSettings } from "@/stores/reader";
import type { Annotation } from "@/types/ipc";

import { annotationLink, renderQuoteCard } from "./quoteCard";
import { resolveFont, type ReadingSurface } from "./theme";

/**
 * The card, seen before it is kept.
 *
 * The suggestions doc called this the lightbox, and that is what it is: the
 * reader presses the share glyph on a highlight, the card is already drawn on
 * their own paper, and 保存图片 is the only decision left. Rendering happens
 * on open — not on mount of the row — because the canvas is one element
 * shared by whichever highlight was last pressed.
 *
 * The paper, the font and the cover are the reader's *current* ones, which is
 * the whole point of the card: what they share is a page from the book as
 * they are reading it. A reader who switches to 护眼 gets warm cards; one who
 * reads at night gets dark ones. The surface comes from `useReadingSurface` —
 * the same resolution the reading page itself uses, because a second one
 * written out by hand is a second answer, and this file shipped exactly that
 * bug once: it read the day surface unconditionally, so every card drawn on a
 * night page wore the day paper no matter which surface was picked.
 */

type Face = "loading" | "ready" | "too-long";

/** The surface's paper as a canvas can fill it.
 *
 *  Two surfaces (纸纹, 亚麻) paint a repeating line texture over their colour
 *  and one (自定义) paints a user image; `fillStyle` takes neither. The tint
 *  is the same colour underneath the texture, and the texture is a screen
 *  treatment that a still image does not need.
 *
 *  **Translucent papers go the same way.** 标准 is deliberately
 *  `rgba(…, 0.72)` so the shell's ground and its glows show through the page —
 *  a property of a *live* page and not of a PNG, which has nothing behind it.
 *  Filling with it left every shared card 72% opaque, and the reader's image
 *  viewer showed the dark ground through their page. The tint is that colour
 *  at full opacity, which is what the card needs to be. */
function solidPaper(surface: ReadingSurface): string {
  return isOpaqueColour(surface.background) ? surface.background : surface.tint;
}

/** Whether a CSS colour can be painted as a page's paper: opaque, and a colour
 *  rather than a gradient, a texture or an image. */
function isOpaqueColour(value: string): boolean {
  if (/^#[0-9a-f]{6}$/i.test(value)) return true;
  if (/^rgb\(/i.test(value)) return true;
  const alpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(value)?.[1];
  return alpha !== undefined && Number(alpha) >= 1;
}

/** The PNG bytes, or the reason there are none. */
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("这一页画不出来"))),
      "image/png",
    );
  });
}

export function QuoteCardDialog({
  annotation,
  open,
  onOpenChange,
}: {
  annotation: Annotation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bookId = annotation?.bookId ?? null;
  const book = useBook(bookId);
  const surface = useReadingSurface(bookId);
  const fontKey = useBookSettings(bookId).fontFamily;
  // The cover the library minted for this session, decoded through an <img> —
  // the only thing that hands the renderer a bitmap, and the same element the
  // reader's own header is already showing. It is stored *with the URL it came
  // from* and read back through that URL, so a book with no cover — or a
  // different one — cannot inherit the previous book's picture while its own
  // is still loading. It rides along visually hidden: the preview is the
  // canvas, not this.
  const coverUrl = book.data?.coverUrl ?? null;
  const [loadedCover, setLoadedCover] = useState<{
    url: string;
    img: HTMLImageElement;
  } | null>(null);
  const cover = loadedCover?.url === coverUrl ? loadedCover.img : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The canvas lives inside a Radix portal, which mounts its children one
  // commit late (a `mounted` flag set in a layout effect). An effect that
  // only watched `open` would run against a DOM that has no canvas yet, so
  // the ref callback flips this and the draw re-runs when it lands.
  const [canvasReady, setCanvasReady] = useState(false);
  const [face, setFace] = useState<Face>("loading");
  const { choose: choosePath, error: panelError } = useSavePath();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // `canvasReady` is the portal's late mount: the effect runs again the
    // commit the canvas lands, and skips until then.
    if (!open || !annotation || !book.data || !canvasReady) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    setFace("loading");
    void renderQuoteCard(canvas, {
      quote: annotation.text,
      title: book.data.title,
      authors: book.data.authors,
      progress: book.data.progress ?? null,
      chapterIdx: annotation.chapterIdx,
      ink: annotation.color,
      paper: solidPaper(surface),
      foreground: surface.fg,
      font: resolveFont(fontKey),
      link: annotationLink(book.data.id, annotation.id),
      cover,
    }).then((drawn) => {
      if (alive) setFace(drawn ? "ready" : "too-long");
    });
    return () => {
      alive = false;
    };
  }, [open, annotation, book.data, surface, fontKey, cover, canvasReady]);

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaveError(null);
    setSaving(true);
    try {
      const blob = await canvasBlob(canvas);
      const name = `${filename(book.data?.title ?? "金句卡片", "金句卡片")}.png`;
      if (!isDesktopRuntime) {
        // No save panel and no filesystem: the download takes the name the
        // panel would have offered, the same fallback the notes export uses.
        downloadBytes(blob, name);
        onOpenChange(false);
        return;
      }
      const path = await choosePath({
        title: "保存金句卡片",
        defaultPath: name,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (path === null) return;
      // The bytes are the frontend's — this only puts them where the reader
      // pointed, the contract `notes.export` already follows.
      await ipc.cardSave(path, [...new Uint8Array(await blob.arrayBuffer())]);
      onOpenChange(false);
    } catch (error) {
      setSaveError(String(error instanceof Error ? error.message : error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <GlassDialog
      open={open}
      onOpenChange={onOpenChange}
      title="金句卡片"
      description="画的是你正在读的那张纸：你的字体、你的标注颜色、你的进度。右下角的二维码在 方册 里打开这一句。"
      widthClass="w-[min(92vw,420px)]"
    >
      <div className="flex justify-center">
        <canvas
          ref={(node) => {
            canvasRef.current = node;
            setCanvasReady(node !== null);
          }}
          className="border-hairline w-[300px] rounded-xl border"
          aria-label="金句卡片预览"
        />
      </div>
      {coverUrl && (
        <img
          src={coverUrl}
          alt=""
          aria-hidden="true"
          className="sr-only"
          onLoad={(event) => setLoadedCover({ url: coverUrl, img: event.currentTarget })}
          onError={() => setLoadedCover(null)}
        />
      )}
      {face === "loading" && <p className="text-text-3 mt-3 text-center text-xs">正在绘制…</p>}
      {face === "too-long" && (
        <p className="text-danger mt-3 text-center text-xs leading-relaxed">
          这一句有 {annotation?.text.length ?? 0} 字，卡片装不下。选短一点的一句再来。
        </p>
      )}
      {(saveError ?? panelError) && (
        <p className="text-danger mt-3 text-xs">{saveError ?? panelError}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={() => onOpenChange(false)}>
          取消
        </GlassButton>
        <GlassButton
          variant="primary"
          disabled={face !== "ready" || saving}
          onClick={() => void save()}
        >
          {saving ? "正在保存…" : "保存图片"}
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
