import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/layout/PageHeader";
import { SearchPanel } from "@/features/search/SearchPanel";
import { readerPathForHit } from "@/features/search/snippet";
import type { SearchHit } from "@/types/ipc";

/** Library-wide search: every hit opens the reader at the matching chapter. */
export function SearchPage() {
  const navigate = useNavigate();

  const onPick = (hit: SearchHit, needle: string) => navigate(readerPathForHit(hit, needle));

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="全文检索" subtitle="在所有已导入的书籍正文里查找，结果按相关度排序。" />

      <div className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        {/* No material on this one: the page already sits inside a `glass-2`
            pane, and a `glass` surface on top of it is two translucent layers
            stacked, which reads as the content behind a sheet of grey. The
            stats page — blocks on the pane, nothing under them — is the shape
            every page is moving to. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <SearchPanel onPick={onPick} />
        </div>
      </div>
    </div>
  );
}
