import { BookOpen } from "@phosphor-icons/react";

import { useCoverPreview } from "@/hooks/useMetadata";
import { cn } from "@/lib/cn";

interface CoverThumbProps {
  /** The catalogue's picture. `null` means this candidate brought none. */
  url: string | null | undefined;
  /** Whether to fetch it now. A closed row passes `false`. */
  active?: boolean;
  /** The box, given by the caller: these sit in rows of different heights. */
  className?: string;
}

/**
 * A catalogue's cover, small enough to sit in a row.
 *
 * A candidate is chosen by its picture as much as by its title — 2014 年中信版
 * and 2017 年重印版 of one book differ by the cover on the shelf, and a list of
 * titles alone asks the reader to guess. Nothing is written: the bytes come
 * back as a data URL and live in the query cache.
 *
 * A picture that will not load leaves the placeholder. A missing thumbnail is
 * not a failure the reader has to hear about — the row still works, and the
 * cover is still downloaded on 保存 if they pick it.
 */
export function CoverThumb({ url, active = true, className }: CoverThumbProps) {
  const preview = useCoverPreview(url, active);
  return (
    <span
      className={cn(
        "bg-surface-1 text-text-3 flex shrink-0 items-center justify-center overflow-hidden rounded",
        className,
      )}
    >
      {preview.data ? (
        <img src={preview.data} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <BookOpen size={14} weight="duotone" />
      )}
    </span>
  );
}
