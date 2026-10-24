import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaretDown, ImageSquare, Plus, X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";
import { GlassSwitch } from "@/components/glass/input";
import { useResolvedTheme } from "@/hooks/useTheme";
import {
  DEFAULT_AUTO_SCROLL_SPEED,
  DEFAULT_MARGIN_X,
  DEFAULT_MARGIN_Y,
  HIGHLIGHT_COLORS,
  LINE_HEIGHTS,
  MAX_AUTO_SCROLL_SPEED,
  MAX_FONT_SIZE,
  MAX_MARGIN_X,
  MAX_MARGIN_Y,
  MAX_RULER_LINES,
  MAX_RULER_OPACITY,
  MAX_RULER_SCROLL_TRIGGER,
  MIN_AUTO_SCROLL_SPEED,
  MIN_FONT_SIZE,
  MIN_MARGIN_X,
  MIN_MARGIN_Y,
  MIN_RULER_LINES,
  MIN_RULER_OPACITY,
  MIN_RULER_SCROLL_TRIGGER,
  MARGIN_X_PRESETS,
  PAGE_NUMBER_SCOPES,
  PAGE_THEMES,
  PDF_NIGHTS,
  isPresetRulerColor,
  pageIsNight,
  PARA_GAPS,
  RULER_COLORS,
  useBookSettings,
} from "@/stores/reader";
import { useFonts } from "@/hooks/useFonts";
import { useSettings } from "@/stores/settings";
import { ZH_MODES } from "@/features/reader/zhConvert";
import {
  FONT_STACKS,
  catalogFontOptions,
  customFontKey,
  LAYOUT_MODES,
  WRITING_MODES,
  PAGE_TRANSITIONS,
  READING_SURFACES,
  resolveSurface,
} from "@/features/reader/theme";
import { SPEECH_GRANULARITIES, SPEECH_PLAYER_STYLES } from "@/features/reader/speech";
import { ColorPicker } from "@/features/reader/ColorPicker";
import { TTS_WASH_STYLES, parseWashHex, washInk } from "@/features/reader/ttsWash";
import { SPRING } from "@/lib/motion";

/** The colour a first custom pick starts from — the palette's own green, so the
 *  pad opens on something instead of on black. */
const RULER_CUSTOM_FALLBACK = "#7cd92c";

/**
 * Reading typography and viewing preferences. Every control writes straight
 * into the persisted reader store; the page re-renders live off the same
 * store, so nothing here needs an "apply" step.
 */
export function SettingsPanel({
  bookId = null,
  verticalAvailable = false,
  zhAvailable = false,
  boldAvailable = false,
}: {
  /** The book this panel belongs to: its typography and paper are its own. */
  bookId?: string | null;
  verticalAvailable?: boolean;
  zhAvailable?: boolean;
  boldAvailable?: boolean;
}) {
  const settings = useBookSettings(bookId);
  const { update } = settings;
  const fonts = useFonts().data ?? [];
  // The stacks every machine already has. A catalogue face is adopted into the
  // app document exactly the way these are declared in it, so the picker need
  // not know the difference between the two.
  const downloadedFonts = useSettings((state) => state.downloadedFonts);
  const catalog = useMemo(() => catalogFontOptions(downloadedFonts), [downloadedFonts]);
  const appTheme = useResolvedTheme();
  // The picker edits the surface of the appearance currently active — and
  // "active" now means what the page is wearing, which is the reader's own
  // choice rather than the app theme. Pinning the page to 夜间 therefore
  // edits the night paper, even in a light shell.
  const pageNight = pageIsNight(settings.pageTheme, appTheme === "dark");
  const surfaceField = pageNight ? "nightSurface" : "surface";
  const activeSurface = pageNight ? settings.nightSurface : settings.surface;
  // Inverting a book's pictures is a night-page decision, and a surface is
  // absolute: the switch is offered on the dark ones, whichever appearance
  // the shell is in.
  const nightPage = resolveSurface(activeSurface, settings.customSurface).mode === "dark";
  const fileRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();
  // A colour outside the presets is the custom one; the wheel bead shows it.
  const custom = isPresetRulerColor(settings.rulerColor) ? null : settings.rulerColor;
  // The wash's ink: `null` is the app's accent, not "no colour".
  const wash = settings.speechWashColor;
  const quickColors = [...HIGHLIGHT_COLORS.map(({ hex }) => hex), ...settings.speechWashColors];
  /** The ruler's pad is folded away until its bead is pressed: a full picker is
   *  a lot of control for a colour most readers never change. */
  const [rulerPicker, setRulerPicker] = useState(false);

  const pickImage = async (file: File) => {
    update({ surface: "custom", customSurface: await compressImage(file) });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <Section title="排版">
        <Group label="排版模式">
          <Chips
            options={LAYOUT_MODES}
            value={settings.layoutMode}
            onChange={(key) => update({ layoutMode: key })}
          />
        </Group>

        <Group label="字体">
          <Chips
            // The stacks every machine already has first, then the catalogue
            // fonts the reader installed, then whatever they imported. A custom
            // entry carries no `stack` of its own: `resolveFont` derives the
            // family from the key, which is what keeps the picker a plain list
            // of names.
            options={[
              ...FONT_STACKS,
              ...catalog,
              ...fonts.map((font) => ({ key: customFontKey(font.id), label: font.name })),
            ]}
            value={settings.fontFamily}
            onChange={(key) => update({ fontFamily: key })}
          />
        </Group>
        <Group label="字号">
          <div className="flex items-center gap-2">
            <Stepper
              label="缩小字号"
              onClick={() => settings.setFontSize(settings.fontSize - 1)}
              disabled={settings.fontSize <= MIN_FONT_SIZE}
            >
              A
            </Stepper>
            <span className="text-text-2 w-8 text-center text-xs tabular-nums">
              {settings.fontSize}
            </span>
            <Stepper
              label="放大字号"
              onClick={() => settings.setFontSize(settings.fontSize + 1)}
              disabled={settings.fontSize >= MAX_FONT_SIZE}
            >
              A+
            </Stepper>
          </div>
        </Group>
        {/* 正文加粗 sits above the 书籍排版 gate rather than inside it: it is
            the one accessibility override in this panel — the reader who needs
            it needs it in the book's own layout too — and 跟随书籍 is the
            default, so a gate would leave it doing nothing out of the box.
            Offered wherever the app sets the body text itself: a PDF page is a
            canvas from pdf.js and a comic entry is a plate, and neither has a
            weight to change. */}
        {boldAvailable && (
          <Group label="正文加粗">
            <Chips
              options={[
                { key: false, label: "常规" },
                { key: true, label: "加粗" },
              ]}
              value={settings.bodyBold}
              onChange={(value) => update({ bodyBold: value })}
            />
            <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
              正文统一用加粗字重。字体带粗体面的用真粗体，只有单面的由浏览器合成。
            </p>
          </Group>
        )}
        {/* 使用书籍排版: the book's own paragraph styles stand, so the three
            settings below it have nothing to win — they only appear when the
            reader takes the layout back, the way readest hides them. */}
        <Group label="书籍排版">
          <Chips
            options={[
              { key: true, label: "跟随书籍" },
              { key: false, label: "自定义" },
            ]}
            value={settings.bookTypography}
            onChange={(value) => update({ bookTypography: value })}
          />
          <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
            跟随书籍：行距、段距与缩进用书里排好的，字体用原书字体。
          </p>
        </Group>
        {!settings.bookTypography && (
          <>
            <Group label="行间距">
              <Chips
                options={LINE_HEIGHTS.map((_, index) => ({
                  key: index,
                  label: LINE_HEIGHT_LABELS[index]!,
                }))}
                value={settings.lineHeightIdx}
                onChange={(index) => update({ lineHeightIdx: index })}
              />
            </Group>
            <Group label="段间距">
              <Chips
                options={PARA_GAPS.map((_, index) => ({
                  key: index,
                  label: PARA_GAP_LABELS[index]!,
                }))}
                value={settings.paraGapIdx}
                onChange={(index) => update({ paraGapIdx: index })}
              />
            </Group>
          </>
        )}
        <Group label="页边距">
          <div className="w-full min-w-0">
            <div className="flex flex-wrap gap-1.5">
              {MARGIN_X_PRESETS.map((preset, index) => {
                const active = nearestMargin(settings.marginX) === preset;
                // 窄 and 标准 also carry the vertical default: both are the
                // compact end of the scale, where a reader who has dragged 上下
                // away wants it back, and the wider two only speak for 左右.
                const resetVertical = preset <= DEFAULT_MARGIN_X;
                return (
                  <motion.button
                    key={preset}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      update(
                        resetVertical
                          ? { marginX: preset, marginY: DEFAULT_MARGIN_Y }
                          : { marginX: preset },
                      )
                    }
                    whileTap={reduce ? undefined : { scale: 0.94 }}
                    transition={SPRING.tap}
                    className={cn(
                      "border-hairline text-text-2 hover:text-text-1 relative rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      active && "border-accent text-accent",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="margin-preset-pill"
                        className="bg-accent-soft absolute inset-0 rounded-full"
                        transition={reduce ? { duration: 0 } : SPRING.layout}
                      />
                    )}
                    <span className="relative">{MARGIN_LABELS[index]!}</span>
                  </motion.button>
                );
              })}
            </div>
            <SliderRow
              label="左右"
              readout={`${Math.round(settings.marginX)} px`}
              min={MIN_MARGIN_X}
              max={MAX_MARGIN_X}
              value={settings.marginX}
              onChange={(value) => update({ marginX: value })}
            />
            <SliderRow
              label="上下"
              readout={`${Math.round(settings.marginY)} px`}
              min={MIN_MARGIN_Y}
              max={MAX_MARGIN_Y}
              value={settings.marginY}
              onChange={(value) => update({ marginY: value })}
            />
          </div>
        </Group>
        {!settings.bookTypography && (
          <Group label="段首缩进">
            <Chips
              options={[
                { key: false, label: "关闭" },
                { key: true, label: "缩进两字" },
              ]}
              value={settings.indent}
              onChange={(value) => update({ indent: value })}
            />
          </Group>
        )}
        {/* Offered on a book with a paginator only: prose and PDF are laid out
            here instead, and a setting that does nothing where it is shown is
            worse than one that is not shown. */}
        {verticalAvailable && (
          <Group label="排版方向">
            <Chips
              options={WRITING_MODES}
              value={settings.writingMode}
              onChange={(value) => update({ writingMode: value })}
            />
            <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
              跟随书籍：书是竖排就竖排。竖排是古籍与日漫的排法——字自上而下，行自右向左。
            </p>
          </Group>
        )}
        {/* 标点符号 → 替换引号, the readest layout: it only means something while
            the layout is vertical (a western quote rotated with the line is the
            thing being fixed), and a setting that does nothing where it is shown
            is worse than one that is not shown. */}
        {verticalAvailable && settings.writingMode === "vertical" && (
          <Group label="替换引号">
            <Chips
              options={[
                { key: false, label: "关闭" },
                { key: true, label: "替换" },
              ]}
              value={settings.quoteReplace}
              onChange={(value) => update({ quoteReplace: value })}
            />
            <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
              把西文引号 “ ” ‘ ’ 换成竖排角引号 ﹁ ﹂ ﹃ ﹄，只改显示不改书源。
            </p>
          </Group>
        )}
        {/* 简繁转换, the readest placement: a text-level rewrite, offered
            wherever the book has flowing text. Nine modes are too many for a
            pill row, so the Select carries them; the header shortcut can be
            hidden from its own menu or from here. */}
        {zhAvailable && (
          <Group label="简繁转换">
            <Select
              label="简繁转换模式"
              options={ZH_MODES}
              value={settings.zhConvert}
              onChange={(key) => update({ zhConvert: key })}
            />
            <div className="flex w-full items-start gap-3">
              <p className="text-text-3 min-w-0 flex-1 text-[12px] leading-relaxed">
                只改显示不改书源：检索与朗读语料仍是原文。台湾、香港变体含当地习惯用语。
              </p>
              <GlassSwitch
                checked={settings.zhToolbarButton}
                onCheckedChange={(next) => update({ zhToolbarButton: next })}
                ariaLabel="在工具栏显示简繁转换按钮"
              />
            </div>
          </Group>
        )}
        <Group label="阅读标尺">
          <Chips
            options={[
              { key: false, label: "关闭" },
              { key: true, label: "开启" },
            ]}
            value={settings.readingRuler}
            onChange={(value) => update({ readingRuler: value })}
          />
          <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
            在页面上留一条亮带、其余压暗，长段落不容易串行。带上下来拖动即可挪位置。
          </p>
          {/* Only where it does something: a ruler that is off has no band for
              these to describe. */}
          {settings.readingRuler && (
            <>
              <SliderRow
                label="突出显示行数"
                readout={`${settings.rulerLines} 行`}
                min={MIN_RULER_LINES}
                max={MAX_RULER_LINES}
                value={settings.rulerLines}
                onChange={(value) => update({ rulerLines: value })}
              />
              <div className="mt-2 flex items-center gap-2.5">
                <span className="text-text-3 shrink-0 text-[12px]">尺子颜色</span>
                <div className="flex items-center gap-1.5">
                  {RULER_COLORS.map(({ key, hex, label }) => (
                    <button
                      key={key}
                      type="button"
                      aria-label={label}
                      title={label}
                      onClick={() => update({ rulerColor: key })}
                      className={cn(
                        "focus-visible:focus-ring flex h-5 w-5 items-center justify-center rounded-full transition-transform",
                        settings.rulerColor === key ? "scale-110" : "hover:scale-105",
                      )}
                      style={
                        settings.rulerColor === key
                          ? {
                              boxShadow: `0 0 0 2px var(--glass-btn), 0 0 0 3.5px ${hex ?? "var(--text-3)"}`,
                            }
                          : undefined
                      }
                    >
                      <span
                        aria-hidden
                        className="block h-3.5 w-3.5 rounded-full"
                        style={
                          hex ? { backgroundColor: hex } : { border: "1px solid var(--text-3)" }
                        }
                      />
                    </button>
                  ))}
                  {/* 无极颜色：一颗珠子，点开在下面摊出取色区（`ColorPicker`）。
                      珠子显示当前自定义色；没有时转一圈色相，读作「这里可以随便挑」。
                      和 `ColorField` 一样不用原生 `<input type="color">`：那会把选择
                      交给系统，跑到面板外面去。 */}
                  <button
                    type="button"
                    aria-label="自定义颜色"
                    aria-pressed={custom !== null}
                    title="自定义颜色"
                    onClick={() => setRulerPicker((open) => !open)}
                    className={cn(
                      "focus-visible:focus-ring relative flex h-5 w-5 items-center justify-center rounded-full transition-transform",
                      custom ? "scale-110" : "hover:scale-105",
                    )}
                    style={
                      custom
                        ? { boxShadow: `0 0 0 2px var(--glass-btn), 0 0 0 3.5px ${custom}` }
                        : undefined
                    }
                  >
                    <span
                      aria-hidden
                      className="block h-3.5 w-3.5 rounded-full"
                      style={
                        custom
                          ? { backgroundColor: custom }
                          : {
                              background:
                                "conic-gradient(from 40deg, #f76f6f, #ffd12e, #7cd92c, #56aee2, #b08fe8, #f76f6f)",
                            }
                      }
                    />
                  </button>
                </div>
              </div>
              {/* Outside the row it belongs to: a pad is a block, and as a flex
                  item it would be squeezed into the gap after the beads. */}
              {rulerPicker && (
                <ColorPicker
                  className="mt-2"
                  value={custom ?? RULER_CUSTOM_FALLBACK}
                  onChange={(hex) => update({ rulerColor: hex })}
                />
              )}
              <SliderRow
                label="不透明度"
                readout={`${Math.round(settings.rulerOpacity * 100)}%`}
                min={Math.round(MIN_RULER_OPACITY * 100)}
                max={Math.round(MAX_RULER_OPACITY * 100)}
                value={Math.round(settings.rulerOpacity * 100)}
                onChange={(value) => update({ rulerOpacity: value / 100 })}
              />
              {/* Only where it does something: the trigger line is the scrolled
                  layout's auto-scroll, and the paged layouts have no scrolling
                  for the band to hand its step to. */}
              {settings.layoutMode === "scroll" && (
                <SliderRow
                  label="自动滚动起点"
                  readout={`${Math.round(settings.rulerScrollTrigger * 100)}%`}
                  min={Math.round(MIN_RULER_SCROLL_TRIGGER * 100)}
                  max={Math.round(MAX_RULER_SCROLL_TRIGGER * 100)}
                  value={Math.round(settings.rulerScrollTrigger * 100)}
                  onChange={(value) => update({ rulerScrollTrigger: value / 100 })}
                />
              )}
            </>
          )}
        </Group>
      </Section>

      <Section title="页面">
        <Group label="页码">
          <Chips
            options={PAGE_NUMBER_SCOPES}
            value={settings.pageNumbers}
            onChange={(value) => update({ pageNumbers: value })}
          />
        </Group>
        <Group label="翻页动画">
          <Chips
            options={PAGE_TRANSITIONS}
            value={settings.pageTransition}
            onChange={(key) => update({ pageTransition: key })}
          />
        </Group>

        <Group label="手柄翻页">
          <Chips
            options={[
              { key: true, label: "开启" },
              { key: false, label: "关闭" },
            ]}
            value={settings.gamepadPaging}
            onChange={(value) => update({ gamepadPaging: value })}
          />
          <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
            手柄的 L1 /
            R1、方向键左右、摇杆左右都能翻页；摇杆上下移动阅读标尺。关闭后手柄不再操作阅读。
          </p>
        </Group>

        <Group label="PDF 页面">
          <div className="w-full min-w-0">
            {/* Each row is its own flex box, and the slider carries `mt-2` of
                its own: without that the chips below it sat in the slider's
                line box and ended up tighter than every other pair of rows in
                the panel. Same rhythm as 页边距. */}
            <div className="flex flex-wrap gap-1.5">
              <Chips
                options={[
                  { key: true, label: "铺满屏幕" },
                  { key: false, label: "页边留白" },
                ]}
                value={settings.pdfFill}
                onChange={(value) => update({ pdfFill: value })}
              />
            </div>
            <SliderRow
              label="双页间距"
              readout={`${Math.round(settings.pdfGap)} px`}
              min={0}
              max={48}
              value={settings.pdfGap}
              onChange={(value) => update({ pdfGap: value })}
            />
            {/* A PDF is a document: 跟随主题 (the default) gives it the colours
              it was published with in the day and the night palette at night,
              and 原色 / 夜间反色 pin either. Independent of the paper surface —
              pinning 夜间 darkens a light page too. The second row asks about a
              *picture*, so it only appears where a picture is being re-mapped:
              跟随主题 in the day renders nothing to invert, and the row would be
              a switch with no effect. */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chips
                options={PDF_NIGHTS}
                value={settings.pdfNight}
                onChange={(key) => update({ pdfNight: key })}
              />
              {pageIsNight(settings.pdfNight, pageNight) && (
                <Chips
                  options={[
                    { key: false, label: "图片保色" },
                    { key: true, label: "图片反色" },
                  ]}
                  value={settings.pdfInvertImages}
                  onChange={(value) => update({ pdfInvertImages: value })}
                />
              )}
            </div>
            <p className="text-text-3 mt-2 w-full text-[11px] leading-relaxed">
              跟随主题：白天保持文件原色，切到夜间才反色。PDF 是文档，不因为外壳变暗就被重新上墨。
            </p>
          </div>
        </Group>
      </Section>

      <Section title="外观">
        <Group label="书页配色">
          <Chips
            options={PAGE_THEMES}
            // `null` is 跟随主题 — the shipped default. The page wears the app
            // theme until the reader pins it here.
            value={settings.pageTheme ?? "follow"}
            onChange={(value) => update({ pageTheme: value })}
          />
          {/* A pinned page is also the fast one: switching the app theme then
              leaves the book alone, instead of making foliate re-inject its
              stylesheet into every loaded section and re-paginate them all. */}
          {(settings.pageTheme ?? "follow") === "follow" ? (
            <p className="text-text-3 mt-2 text-[11px] leading-relaxed">
              跟随主题时，切换主题会重排整本书；固定为日间或夜间则不会。
            </p>
          ) : (
            <p className="text-text-3 mt-2 text-[11px] leading-relaxed">
              书页已固定，切换主题只改界面，不再重排这本书。
            </p>
          )}
        </Group>
        <Group label="阅读背景">
          <div className="grid w-full grid-cols-4 gap-1.5">
            {READING_SURFACES.map((surface) => {
              const on = activeSurface === surface.key;
              return (
                <motion.button
                  key={surface.key}
                  type="button"
                  aria-pressed={on}
                  title={surface.label}
                  onClick={() => update({ [surfaceField]: surface.key })}
                  whileTap={reduce ? undefined : { scale: 0.96 }}
                  transition={SPRING.tap}
                  // `min-w-0`: a grid item's automatic minimum size is its
                  // content, so a label wider than the column would blow the
                  // track out and spill past the panel's padding.
                  className="flex min-w-0 flex-col items-center gap-1"
                >
                  {/* A miniature of the page itself — its paper, its ink, and
                      three lines of pretend text. The old picker was a 12 px
                      colour dot next to a name, which meant choosing by
                      reading rather than by looking; the thing that actually
                      differs between these surfaces is how text sits on them,
                      and that is exactly what a flat dot cannot show. */}
                  <span className="relative block w-full">
                    <span
                      className="border-hairline relative block aspect-[3/4] w-full overflow-hidden rounded-sm border"
                      style={{ background: surface.background }}
                    >
                      <span className="absolute inset-x-1.5 top-2 flex flex-col gap-[3px]">
                        {[0.92, 0.78, 0.52].map((width) => (
                          <span
                            key={width}
                            className="block h-[2px] rounded-full"
                            style={{
                              background: surface.fg,
                              opacity: 0.5,
                              width: `${width * 100}%`,
                            }}
                          />
                        ))}
                      </span>
                    </span>
                    {/* One ring, travelling: switching surfaces reads as the
                        same selection moving, not two things blinking. */}
                    {on && (
                      <motion.span
                        layoutId="surface-ring"
                        className="border-accent pointer-events-none absolute -inset-[3px] rounded-[calc(var(--radius-sm)+3px)] border-2"
                        transition={reduce ? { duration: 0 } : SPRING.layout}
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      "max-w-full truncate text-[10.5px] leading-none transition-colors",
                      on ? "text-accent" : "text-text-3",
                    )}
                  >
                    {surface.label}
                  </span>
                </motion.button>
              );
            })}
            <SurfaceImageButton
              on={activeSurface === "custom"}
              onPick={() => fileRef.current?.click()}
              reduce={reduce}
            />
          </div>
          {activeSurface === "custom" && (
            <button
              type="button"
              onClick={() => {
                update({ [surfaceField]: "standard", customSurface: null });
              }}
              className="focus-visible:focus-ring text-text-3 hover:text-text-1 px-1 text-[12px] transition-colors"
            >
              移除
            </button>
          )}
          {appTheme === "dark" && (
            <p className="text-text-3 mt-1.5 text-[12px]">
              当前为深色外观的阅读背景，浅色外观可在浅色模式下单独设置
            </p>
          )}
        </Group>

        {nightPage && (
          <Group label="夜间图片">
            {/* Off keeps a photograph a photograph; on is for pages whose art is
              one bright bitmap (a comic, a scanned plate) and would otherwise
              glare. PDFs keep their own switch below. */}
            <Chips
              options={[
                { key: false, label: "原色" },
                { key: true, label: "反色" },
              ]}
              value={settings.invertBookImages}
              onChange={(value) => update({ invertBookImages: value })}
            />
          </Group>
        )}
      </Section>

      <Section title="朗读">
        <Group label="朗读高亮">
          <Chips
            options={SPEECH_GRANULARITIES}
            value={settings.speechGranularity}
            onChange={(key) => update({ speechGranularity: key })}
          />
        </Group>

        <Group label="高亮样式">
          <Select
            label="高亮样式"
            options={TTS_WASH_STYLES}
            value={settings.speechWashStyle}
            onChange={(key) => update({ speechWashStyle: key })}
          />
        </Group>

        {/* Everything for one colour in one place: the disc says what the wash
            will look like, the field takes any hex the reader already has (from
            a design tool, from the colour they used in another app), and the
            picker below is for one they do not have yet. `null` is a real
            choice — the app's own accent — so the disc wears the token rather
            than a hex copied out of it, and the row offers the way back. */}
        <Group label="高亮颜色">
          <ColorField
            value={wash}
            display={washInk(null, pageNight)}
            onChange={(hex) => update({ speechWashColor: hex })}
            onReset={() => update({ speechWashColor: null })}
          />
        </Group>

        {/* The palette the reader already knows from the selection toolbar, then
            whatever they pinned off the wheel. One list, so a colour they chose
            is findable again without remembering its hex.

            Its own flex with a wider gap than the group's: the selected disc
            wears an outline, and the group's 6px would have that ring land on
            the disc beside it. */}
        <Group label="快速颜色">
          <div className="flex flex-wrap items-center gap-2.5">
            {quickColors.map((hex) => {
              const active = wash === hex;
              return (
                <span key={hex} className="group relative">
                  <button
                    type="button"
                    aria-label={`高亮颜色 ${hex}`}
                    aria-pressed={active}
                    onClick={() => update({ speechWashColor: hex })}
                    className="block size-6 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: hex,
                      outline: active ? "2px solid var(--accent)" : undefined,
                      outlineOffset: active ? 2 : undefined,
                    }}
                  />
                  {settings.speechWashColors.includes(hex) && (
                    <button
                      type="button"
                      aria-label="移除这个颜色"
                      onClick={() =>
                        update({
                          speechWashColors: settings.speechWashColors.filter((c) => c !== hex),
                        })
                      }
                      className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-red-500 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <X size={9} weight="bold" />
                    </button>
                  )}
                </span>
              );
            })}
            {wash !== null && !quickColors.includes(wash) && (
              <button
                type="button"
                onClick={() => update({ speechWashColors: [...settings.speechWashColors, wash] })}
                className="border-hairline text-text-3 hover:text-text-1 focus-visible:focus-ring inline-flex size-6 items-center justify-center rounded-full border transition-colors"
              >
                <Plus size={12} weight="bold" />
                <span className="sr-only">固定当前颜色</span>
              </button>
            )}
          </div>
        </Group>

        <Group label="播放器样式">
          <Chips
            options={SPEECH_PLAYER_STYLES}
            value={settings.speechPlayerStyle}
            onChange={(key) => update({ speechPlayerStyle: key })}
          />
        </Group>

        {/* The bar is a second, always-on-top window, so it is the one setting
            in here worth a sentence: what it does is not visible until the
            reader puts the app away while listening. */}
        <Group label="悬浮播放条">
          <div className="flex w-full items-start gap-3">
            <p className="text-text-3 min-w-0 flex-1 text-[12px] leading-relaxed">
              最小化或关闭主窗口后，正在朗读时会在桌面底部浮出一条播放条，可以直接控制播放。
            </p>
            <GlassSwitch
              checked={settings.speechMiniPlayer}
              onCheckedChange={(next) => update({ speechMiniPlayer: next })}
              ariaLabel="悬浮播放条"
            />
          </div>
        </Group>

        <Group label="自动滚动速度">
          <div className="w-full min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {AUTO_SCROLL_PRESETS.map((preset) => (
                  <motion.button
                    key={preset.speed}
                    type="button"
                    aria-pressed={nearestPreset(settings.autoScrollSpeed).speed === preset.speed}
                    onClick={() => update({ autoScrollSpeed: preset.speed })}
                    whileTap={reduce ? undefined : { scale: 0.94 }}
                    transition={SPRING.tap}
                    className={cn(
                      "border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      nearestPreset(settings.autoScrollSpeed).speed === preset.speed &&
                        "border-accent text-accent",
                    )}
                  >
                    {preset.label}
                  </motion.button>
                ))}
              </div>
              <motion.button
                type="button"
                onClick={() => update({ autoScrollSpeed: DEFAULT_AUTO_SCROLL_SPEED })}
                whileTap={reduce ? undefined : { scale: 0.94 }}
                transition={SPRING.tap}
                className={cn(
                  "text-text-3 hover:text-text-1 shrink-0 text-[12px] transition-colors",
                  settings.autoScrollSpeed === DEFAULT_AUTO_SCROLL_SPEED && "opacity-40",
                )}
              >
                恢复默认
              </motion.button>
            </div>
            <SliderRow
              label="速度"
              readout={`${Math.round(settings.autoScrollSpeed)} px/秒`}
              min={MIN_AUTO_SCROLL_SPEED}
              max={MAX_AUTO_SCROLL_SPEED}
              value={settings.autoScrollSpeed}
              onChange={(value) => update({ autoScrollSpeed: value })}
            />
          </div>
        </Group>
      </Section>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void pickImage(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/** A settings row: label on top, controls flow below it left-aligned. */
/**
 * A cluster of related groups.
 *
 * The panel carries fourteen controls; laid out as one column they read as an
 * undifferentiated list, and the reader has to work out that 字号 belongs with
 * 行间距 but not with 翻页动画. Four named clusters give it a shape without
 * hiding anything behind a disclosure triangle — this is a drawer, not a
 * settings window.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-hairline border-t pt-3 first:border-0 first:pt-0">
      <h3 className="text-text-3 mb-2 text-[11px] tracking-[0.12em]">{title}</h3>
      <div>{children}</div>
    </section>
  );
}

/** The custom-paper swatch: same footprint as the built-in pages, so the grid
 *  stays even. */
function SurfaceImageButton({
  on,
  onPick,
  reduce,
}: {
  on: boolean;
  onPick: () => void;
  reduce: boolean | null;
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={on}
      title="自定义图片"
      onClick={onPick}
      whileTap={reduce ? undefined : { scale: 0.96 }}
      transition={SPRING.tap}
      className="flex min-w-0 flex-col items-center gap-1"
    >
      <span className="relative block w-full">
        <span className="border-hairline bg-surface-1 text-text-3 flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-sm border">
          <ImageSquare size={14} />
        </span>
        {on && (
          <motion.span
            layoutId="surface-ring"
            className="border-accent pointer-events-none absolute -inset-[3px] rounded-[calc(var(--radius-sm)+3px)] border-2"
            transition={reduce ? { duration: 0 } : SPRING.layout}
          />
        )}
      </span>
      <span
        className={cn(
          "max-w-full truncate text-[10.5px] leading-none transition-colors",
          on ? "text-accent" : "text-text-3",
        )}
      >
        自定义
      </span>
    </motion.button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-hairline border-b py-3 last:border-0">
      <p className="text-text-3 mb-2 text-[12px]">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

interface ChipOption<K extends string | number | boolean> {
  key: K;
  label: string;
}

/** A segmented row of pill toggles; the selected one carries the accent.
 *
 * A soft accent disc springs between the options of one group (shared
 * layoutId scoped by useId), so switching reads as one highlight travelling
 * instead of two pills blinking. */
function Chips<K extends string | number | boolean>({
  options,
  value,
  onChange,
}: {
  options: ChipOption<K>[];
  value: K;
  onChange: (value: K) => void;
}) {
  const reduce = useReducedMotion();
  const groupId = useId();
  return (
    <>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <motion.button
            key={String(option.key)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.key)}
            whileTap={reduce ? undefined : { scale: 0.94 }}
            transition={SPRING.tap}
            className={cn(
              "border-hairline text-text-2 hover:text-text-1 relative rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              active && "border-accent text-accent",
            )}
          >
            {active && (
              <motion.span
                layoutId={`chips-${groupId}`}
                className="bg-accent-soft absolute inset-0 rounded-full"
                transition={reduce ? { duration: 0 } : SPRING.layout}
              />
            )}
            <span className="relative">{option.label}</span>
          </motion.button>
        );
      })}
    </>
  );
}

/**
 * The wash's ink: a disc, a hex field, and the system picker.
 *
 * The field keeps its own draft while it is being typed into, so the store only
 * ever sees a colour that parsed — a half-typed `#56a` must never reach the
 * renderers, and an unusable value puts the old ink back on blur rather than
 * leaving the reader with a field that disagrees with the page. No effect syncs
 * the draft: it can only be stale mid-edit, and every way out of an edit (blur,
 * Enter, Escape) resolves it.
 *
 * The disc is the theme token when nothing is chosen, which is why `value` and
 * `display` are separate: `null` still has a colour on screen, it just is not
 * the reader's.
 */
function ColorField({
  value,
  display,
  onChange,
  onReset,
}: {
  value: string | null;
  display: string;
  onChange: (hex: string) => void;
  /** Back to the theme's own ink. Only offered once it has been left. */
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const unusable = draft !== null && draft !== "" && parseWashHex(draft) === null;

  return (
    <>
      <div className="flex w-full items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "border-hairline size-6 shrink-0 rounded-full border",
            value === null && "bg-accent",
          )}
          style={value === null ? undefined : { backgroundColor: value }}
        />
        <input
          type="text"
          aria-label="高亮颜色十六进制值"
          aria-invalid={unusable || undefined}
          spellCheck={false}
          autoComplete="off"
          value={draft ?? value ?? display}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft === null) return;
            const hex = parseWashHex(draft);
            if (hex !== null) onChange(hex);
            setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setDraft(null);
          }}
          className={cn(
            "bg-surface-1 text-text-1 focus-visible:focus-ring h-6 w-[84px] shrink-0 rounded-sm border px-2 font-mono text-[11px] outline-none",
            unusable ? "border-red-500/70" : "border-hairline",
          )}
        />
        {value !== null && (
          <button
            type="button"
            onClick={onReset}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 px-1 text-[12px] transition-colors"
          >
            跟随主题色
          </button>
        )}
      </div>
      <ColorPicker value={value ?? display} onChange={onChange} className="w-full" />
    </>
  );
}

/** A dropdown, for a list too long to lay out as pills: five wash shapes with
 *  names to read would wrap into a block that no longer scans as one control.
 *
 * The house `<select>` is ShelfToolbar's: the native control carries the
 * behaviour and the keyboard, and the chrome around it is drawn by hand. */
function Select<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ChipOption<K>[];
  value: K;
  onChange: (value: K) => void;
}) {
  return (
    <div className="border-hairline bg-surface-1 focus-within:focus-ring relative inline-flex h-8 items-center rounded-md border">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as K)}
        className="text-text-1 appearance-none bg-transparent pr-7 pl-2.5 text-[12px] outline-none [&>option]:text-black"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <CaretDown
        size={12}
        className="text-text-3 pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
      />
    </div>
  );
}

function Stepper({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      whileTap={reduce || disabled ? undefined : { scale: 0.94 }}
      transition={SPRING.tap}
      className="border-hairline text-text-2 hover:text-text-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:opacity-40"
    >
      {children}
    </motion.button>
  );
}

const LINE_HEIGHT_LABELS = ["紧凑", "标准", "宽松", "特宽"];
const PARA_GAP_LABELS = ["紧凑", "标准", "宽松", "特宽"];
const MARGIN_LABELS = ["窄", "标准", "宽松", "特宽"];

/** The margin preset closest to `value`, highlighted so fine-tuning keeps context. */
function nearestMargin(value: number): number {
  return MARGIN_X_PRESETS.reduce((best, preset) =>
    Math.abs(preset - value) < Math.abs(best - value) ? preset : best,
  );
}

/** How often a drag may write to the store while the thumb is still moving.
 *
 * A margin write is not a number in a store: it re-columnises the whole
 * section (about a second on a book whose text is a single section), and
 * 左右 writes three attributes. One write per input event therefore freezes
 * the drag outright — the thumb moves a pixel, the page stops for a second,
 * three times over. The thumb follows the pointer through local state, the
 * value lands at most once per window, and the last one always lands on
 * release. */
const SLIDER_COMMIT_MS = 120;

/** A slider row: label on the left, live value on the right, accent fill. */
export function SliderRow({
  label,
  readout,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  readout: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  /** Where the thumb is right now, while it is down. */
  const [draft, setDraft] = useState<number | null>(null);
  /** The value the drag last asked for, and the window it is waiting out. */
  const pending = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const shown = draft ?? Math.round(value);

  /** Hands the store whatever the drag last asked for, right now. */
  const commit = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    onChange(next);
  };

  // A panel that closes mid-drag still owes the store the value it was
  // showing: `pointerup` never arrives for a thumb that was taken away.
  const latest = useRef({ commit });
  useEffect(() => {
    latest.current.commit = commit;
  });
  useEffect(() => () => latest.current.commit(), []);

  const move = (next: number) => {
    setDraft(next);
    pending.current = next;
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      commit();
    }, SLIDER_COMMIT_MS);
  };

  /** Release hands the input back to the store. */
  const release = () => {
    commit();
    setDraft(null);
  };

  return (
    <div className="mt-2 flex items-center gap-2.5">
      <span className="text-text-3 shrink-0 text-[12px]">{label}</span>
      <input
        type="range"
        aria-label={label === "速度" ? "自动滚动速度微调" : `${label}微调`}
        className="range min-w-0 flex-1"
        min={min}
        max={max}
        step={1}
        value={shown}
        style={{
          ["--range-fill" as string]: `${((shown - min) / (max - min)) * 100}%`,
        }}
        onChange={(event) => move(Number(event.currentTarget.value))}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyUp={release}
        onBlur={release}
      />
      <span className="text-accent w-[72px] shrink-0 text-right text-[12px] font-semibold tabular-nums">
        {readout}
      </span>
    </div>
  );
}

/** Suggested auto-scroll speeds; the slider fine-tunes between them. */
const AUTO_SCROLL_PRESETS = [
  { speed: 20, label: "慢" },
  { speed: 40, label: "适中" },
  { speed: 80, label: "快" },
  { speed: 160, label: "极快" },
];

/** The preset closest to `speed`, highlighted so fine-tuning keeps context. */
function nearestPreset(speed: number): (typeof AUTO_SCROLL_PRESETS)[number] {
  return AUTO_SCROLL_PRESETS.reduce((best, preset) =>
    Math.abs(preset.speed - speed) < Math.abs(best.speed - speed) ? preset : best,
  );
}

/**
 * Downscales a picked image into a JPEG data URL capped at 1600px on the long
 * edge. The result lives in localStorage, so a full-size photo would blow the
 * quota; a background never needs more pixels than the viewport.
 */
async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}
