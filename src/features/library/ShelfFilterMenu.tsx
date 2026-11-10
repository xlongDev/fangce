import type { ReactNode } from "react";
import { Funnel } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassMenu } from "@/components/glass/menu";
import { CHIP, CHIP_IDLE, CHIP_ON } from "@/features/library/TagBar";
import {
  NO_FILTERS,
  activeFilterCount,
  toggleValue,
  type ShelfFilters,
} from "@/features/library/shelfQuery";
import { cn } from "@/lib/cn";
import type { BookFormat, Facet, LibraryFacets, ReadingStatus } from "@/types/ipc";

/**
 * The shelf's 筛选 panel: one chip per value, per dimension.
 *
 * The counts are not decoration. A panel of bare values makes the reader pick
 * blind, and the one thing a big library cannot afford is a filter that turns
 * out to lead nowhere. They come from `book.facets`, which counts each
 * dimension with its own filter cleared — so the value you are already using
 * never disappears, and the ones that would empty the grid read as zero.
 */

const STATUS_LABELS: Record<Exclude<ReadingStatus, "any">, string> = {
  // 未开始 rather than 未读: `progress <= 0` also covers a book that was opened
  // and closed again, and 未读 would be a lie about the second kind.
  unread: "未开始",
  reading: "在读",
  finished: "已读完",
};

const COVER_LABELS: Record<"has" | "none", string> = {
  has: "有封面",
  none: "无封面",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-1 py-1.5">
      <p className="text-text-3 mb-1 text-[11px]">{title}</p>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function OptionChip({
  on,
  count,
  onClick,
  children,
}: {
  on: boolean;
  /** `undefined` while the counts are still loading — then the chip stays live. */
  count?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  // A zero count is still shown, but not offered: the value exists in the
  // library, it just has nothing left under the other filters. Hiding it would
  // look like the shelf lost books.
  const empty = count === 0 && !on;
  return (
    <button
      type="button"
      // The panel is a `role="menu"`, so its options are checkboxes rather than
      // plain buttons: a filter chip is a choice that stays open, which is
      // exactly what `menuitemcheckbox` describes.
      role="menuitemcheckbox"
      aria-checked={on}
      disabled={empty}
      onClick={onClick}
      className={cn(
        CHIP,
        "h-7 px-2.5",
        on ? CHIP_ON : CHIP_IDLE,
        empty && "cursor-not-allowed opacity-35 hover:bg-transparent",
      )}
    >
      <span className="max-w-48 truncate">{children}</span>
      {count !== undefined && <span className="text-text-3 tabular-nums">{count}</span>}
    </button>
  );
}

/** The count beside one value, or `undefined` while `facets` has not arrived. */
function countOf(list: Facet[] | undefined, value: string): number | undefined {
  return list?.find((facet) => facet.value === value)?.count;
}

export function ShelfFilterMenu({
  filters,
  onChange,
  facets,
}: {
  filters: ShelfFilters;
  onChange: (next: ShelfFilters) => void;
  /** `undefined` until the first count comes back. */
  facets: LibraryFacets | undefined;
}) {
  const active = activeFilterCount(filters);
  const toggleFormat = (format: BookFormat) =>
    onChange({ ...filters, formats: toggleValue(filters.formats, format) });
  const toggleText = (key: "languages" | "publishers", value: string) =>
    onChange({ ...filters, [key]: toggleValue(filters[key], value) });

  return (
    <GlassMenu
      label="筛选书库"
      widthClass="w-72"
      // `glass-2` + `shadow-panel` rather than the default `glass`: this panel
      // opens over the cover grid, and at elevation 1 the covers read straight
      // through the labels. This is the same pair `GlassDialog` uses — a sheet
      // that floats over content, not a card resting inside a pane.
      panelClassName="glass-solid"
      trigger={
        <GlassButton size="md">
          <Funnel size={15} weight={active > 0 ? "fill" : "regular"} />
          筛选
          {active > 0 && (
            <span className="bg-accent text-on-accent flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] tabular-nums">
              {active}
            </span>
          )}
        </GlassButton>
      }
    >
      <div className="max-h-[min(70vh,540px)] overflow-y-auto">
        <Section title="阅读状态">
          {(["unread", "reading", "finished"] as const).map((value) => (
            <OptionChip
              key={value}
              on={filters.status === value}
              count={countOf(facets?.status, value)}
              onClick={() =>
                onChange({ ...filters, status: filters.status === value ? "any" : value })
              }
            >
              {STATUS_LABELS[value]}
            </OptionChip>
          ))}
        </Section>

        <Section title="文件格式">
          {(facets?.formats ?? []).map((facet) => {
            const format = facet.value as BookFormat;
            return (
              <OptionChip
                key={facet.value}
                on={filters.formats.includes(format)}
                count={facet.count}
                onClick={() => toggleFormat(format)}
              >
                {facet.value.toUpperCase()}
              </OptionChip>
            );
          })}
        </Section>

        <Section title="封面">
          {(["has", "none"] as const).map((value) => (
            <OptionChip
              key={value}
              on={filters.hasCover === (value === "has")}
              count={countOf(facets?.covers, value)}
              onClick={() =>
                onChange({
                  ...filters,
                  hasCover: filters.hasCover === (value === "has") ? null : value === "has",
                })
              }
            >
              {COVER_LABELS[value]}
            </OptionChip>
          ))}
        </Section>

        {(facets?.languages.length ?? 0) > 0 && (
          <Section title="语言">
            {facets?.languages.map((facet) => (
              <OptionChip
                key={facet.value}
                on={filters.languages.includes(facet.value)}
                count={facet.count}
                onClick={() => toggleText("languages", facet.value)}
              >
                {facet.value}
              </OptionChip>
            ))}
          </Section>
        )}

        {(facets?.publishers.length ?? 0) > 0 && (
          <Section title="出版社">
            {facets?.publishers.map((facet) => (
              <OptionChip
                key={facet.value}
                on={filters.publishers.includes(facet.value)}
                count={facet.count}
                onClick={() => toggleText("publishers", facet.value)}
              >
                {facet.value}
              </OptionChip>
            ))}
          </Section>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between border-t px-1 pt-1.5">
        <span className="text-text-3 text-[11px]">
          {facets === undefined ? "正在统计…" : active > 0 ? `已筛 ${active} 项` : "全部书籍"}
        </span>
        <button
          type="button"
          role="menuitem"
          disabled={active === 0}
          onClick={() => onChange(NO_FILTERS)}
          className="press focus-visible:focus-ring text-text-2 hover:text-text-1 rounded-md px-1.5 py-0.5 text-[11px] disabled:opacity-35"
        >
          清空筛选
        </button>
      </div>
    </GlassMenu>
  );
}
