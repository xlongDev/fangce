import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Archive,
  ArrowsClockwise,
  ArrowSquareOut,
  BookOpenText,
  CloudArrowUp,
  Monitor,
  Moon,
  Sun,
  Info,
  Palette,
  Sparkle,
  Trash,
  TextAa,
} from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { GlassInput, GlassSwitch } from "@/components/glass/input";
import { useSettings, type ThemeMode } from "@/stores/settings";
import { resetAllSettings } from "@/stores/reset";
import { showToast } from "@/stores/toasts";
import { useSystemInfo } from "@/hooks/useSystemInfo";
import { useSavePath } from "@/hooks/useSavePath";
import { useAiConfig, useSaveAiConfig, useTestAiConfig } from "@/hooks/useAi";
import { useSaveSyncConfig, useSyncConfig, useSyncNow, useTestSyncConfig } from "@/hooks/useSync";
import { useDeleteDictionary, useDictionaries, useImportDictionary } from "@/hooks/useDictionaries";
import { useDeleteFont, useFonts, useImportFont } from "@/hooks/useFonts";
import { useDownloadCatalogFont, useRemoveCatalogFont } from "@/hooks/useCatalogFonts";
import { CATALOG_FONTS, catalogSheetBytes, type CatalogFont } from "@/lib/fontCatalog";
import { useUpdater, type UpdateState } from "@/stores/updater";
import { useExportBackup, useStageBackup } from "@/hooks/useBackup";
import { isDesktopRuntime } from "@/lib/ipc";
import { acceptOf, pickFiles as pickBrowserFiles } from "@/lib/pickFile";
import { formatFileSize } from "@/features/library/format";
import {
  Actions,
  Feedback,
  Row,
  SECTIONS,
  SettingsGroup,
  type SectionId,
} from "@/features/settings/section";
import { KeymapSection } from "@/features/settings/KeymapSection";
import { SecretsNotice } from "@/features/settings/SecretsNotice";
import type { AiConfig, SyncChange, SyncConfig, SyncReport, SyncTally } from "@/types/ipc";
import { cn } from "@/lib/cn";
import { SPRING } from "@/lib/motion";

/**
 * Whether the pane has nowhere left to scroll.
 *
 * Its own function because the scroll handler and a rail jump both need it and
 * have to mean the same thing by it — including that a pane taller than its
 * content is *not* at the end, or the last group would be highlighted from the
 * first frame. The last two groups cannot be scrolled to the top at all: the
 * pane stops at the bottom, and that is the case a jump has to recognise as
 * having arrived.
 */
function scrolledToEnd(root: HTMLElement): boolean {
  const scrollable = root.scrollHeight > root.clientHeight + 8;
  return scrollable && root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
}

/**
 * Where in the pane a jump can actually put a group.
 *
 * Asking for more than the pane can scroll clamps to the bottom, so a group past
 * the end is as far up as the bottom and nowhere further. This is the question a
 * jump's arrival is about — "is the pane where it can get to?" — and asking
 * `scrolledToEnd` instead answers it wrongly in the case that matters: a pane
 * parked at its bottom, asked for a group further *up*, is at the end and has
 * not moved at all, so the claim was dropped on the spot and the sight-line rule
 * below lit the last group while the pane went on to show 同步.
 */
function reachableTop(root: HTMLElement, top: number): number {
  return Math.min(top, root.scrollHeight - root.clientHeight);
}

const THEMES: readonly { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  // Light → system → dark, the same scale as the sidebar's own switcher: three
  // points from explicit to explicit, with the automatic choice in the middle.
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "dark", label: "深色", icon: Moon },
];

export function SettingsPage() {
  const theme = useSettings((s) => s.theme);
  const transparency = useSettings((s) => s.transparency);
  const setTheme = useSettings((s) => s.setTheme);
  const setTransparency = useSettings((s) => s.setTransparency);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SectionId>("appearance");
  const reduce = useReducedMotion();
  /** Each group's offset in the scroll container, cached — reading `offsetTop`
   *  per scroll frame would force a layout on every one of them. */
  const offsets = useRef<{ id: SectionId; top: number }[]>([]);
  /**
   * How many groups the cache was built from.
   *
   * A group that is not in the DOM yet when the cache is built is not watched by
   * the `ResizeObserver` either, and when it arrives every group below it *moves
   * without changing size* — a change no observer reports. Both `AI 助手` and
   * `同步` return `null` until their configs resolve, so this is the normal case
   * and not a corner: measured on the demo shelf, 关于 was cached at 1414 against
   * a real 2562, the AI form's height missing from everything below it. The
   * sight-line rule takes the last group whose top has passed the line, so with
   * that cache *every* group answered as passed and the rail read 关于 from the
   * first screen down — and a jump was told the pane had nowhere left to scroll,
   * which is how a click on 同步 ended up lighting 关于.
   */
  const counted = useRef(-1);

  const measure = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    // One query for both the count and the offsets: the count is what says the
    // cache is still about the same set of groups.
    const found = root.querySelectorAll("[data-section]");
    counted.current = found.length;
    offsets.current = SECTIONS.map((section) => ({
      id: section.id,
      top: root.querySelector<HTMLElement>(`[data-section="${section.id}"]`)?.offsetTop ?? 0,
    }));
  }, []);

  /** The jump the rail asked for, held until the pane finishes travelling. */
  const jumping = useRef<{ id: SectionId; top: number } | null>(null);

  /**
   * Where a finished jump left the pane.
   *
   * A smooth scroll that asked for more than the pane has keeps emitting events
   * at the position it stopped at — and the rule below reads that position as
   * "nowhere left to scroll", which is its signal to hand the highlight to the
   * *last* group. So the tail of the jump's own scroll arrives looking exactly
   * like the reader having scrolled to the bottom, and the rail lights the wrong
   * entry the moment a jump lands on a group that cannot reach the top.
   *
   * Held as a position rather than released on a deadline: the difference
   * between the two is *where* the pane is, not *when* the event arrived, and a
   * runner handing out scroll events five times a second is slower than any
   * settle timer that would be reasonable here. An event at this position is the
   * jump's own tail and is ignored; the first one at a different position is the
   * reader, and the rule resumes.
   */
  const settled = useRef<number | null>(null);

  /**
   * Which section the rail highlights: the last one whose top has passed a
   * sight-line 15% down the pane. An observer band was the first attempt, but
   * it reports the first section touching the band, which is the *previous*
   * one right after a rail jump — and it never reaches a short last group.
   */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // A form mounts once its config resolves and changes every offset below
    // it, so re-measure on layout changes rather than on a timer.
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    /** Measure, and start watching every group the response contains. */
    const sync = () => {
      for (const section of root.querySelectorAll("[data-section]")) resize.observe(section);
      measure();
    };
    sync();

    // Released a beat after the pane stops moving, not the moment it arrives:
    // a smooth scroll that asks for more than the pane has keeps emitting
    // events at the same position, and releasing on the first of them would
    // let the next one fall through to the sight-line rules.
    let settle: number | undefined;

    const onScroll = () => {
      // A group can arrive after this effect ran — see `counted` — and re-reading
      // the offsets costs a query and no layout, where reading them per frame
      // would not.
      if (root.querySelectorAll("[data-section]").length !== counted.current) sync();

      // A jump owns the highlight while it is claimed. Two things go wrong
      // otherwise, and both read as the rail ignoring the click: the smooth
      // scroll passes through every group on the way, ticking the highlight
      // through each of them; and the last two groups cannot reach the top at
      // all — the pane runs out of scroll and stops at the bottom, where the
      // rule below hands the highlight to the final group. Measured on a
      // 1280×900 pane: 重置 asks for 2020 against a maximum of 1835.
      const jump = jumping.current;
      if (jump) {
        // "Arrived" is where the pane can put this group, so running out of
        // scroll is an arrival too — that is as far as it is ever going to get.
        if (Math.abs(root.scrollTop - reachableTop(root, jump.top)) < 2) {
          clearTimeout(settle);
          settle = window.setTimeout(() => {
            jumping.current = null;
            settled.current = root.scrollTop;
          }, 120);
        }
        return;
      }

      // The tail of a jump that has already let go: same position, so not the
      // reader. See `settled`.
      if (settled.current !== null) {
        if (Math.abs(root.scrollTop - settled.current) < 2) return;
        settled.current = null;
      }

      // At the end of the scroll the sight-line can still sit inside the group
      // above a short final one, so the bottom wins outright — but only when
      // there is something to scroll: a pane taller than its content is always
      // "at the end" and would otherwise highlight the last group from the
      // start.
      const atEnd = scrolledToEnd(root);
      const line = root.scrollTop + root.clientHeight * 0.15;
      const last = offsets.current.at(-1)?.id ?? "appearance";
      let current: SectionId = offsets.current[0]?.id ?? "appearance";
      for (const entry of offsets.current) if (entry.top <= line) current = entry.id;
      setActive(atEnd ? last : current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    // Real input ends a jump that is still travelling, so a claim cannot outlive
    // the reader taking the pane for themselves. Driven by input rather than by
    // `scroll` because a jump's own smooth scroll fires that too — the same
    // reason the shelf does it, and the same events.
    const drop = () => {
      if (jumping.current === null) return;
      jumping.current = null;
      settled.current = root.scrollTop;
    };
    root.addEventListener("wheel", drop, { passive: true });
    root.addEventListener("pointerdown", drop);
    return () => {
      clearTimeout(settle);
      resize.disconnect();
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", drop);
      root.removeEventListener("pointerdown", drop);
    };
  }, [measure]);

  const jumpTo = (id: SectionId) => {
    const root = scrollRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!root || !target) return;
    const top = Math.max(target.offsetTop - 16, 0);
    // Set it now rather than waiting for the scroll: the smooth scroll would
    // otherwise leave the rail ticking through the groups it passes.
    jumping.current = { id, top };
    setActive(id);
    root.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    // A jump to where the pane can already reach fires no scroll event at all,
    // and a claim nobody releases would then swallow the reader's next scroll.
    // Compared against where the pane *can* go rather than where it was asked to
    // go: a pane parked at its bottom, asked for a group further up, is not there
    // yet — and releasing it here is what let the rule below light 关于 for a
    // click on 同步.
    if (Math.abs(root.scrollTop - reachableTop(root, top)) < 2) {
      jumping.current = null;
      settled.current = root.scrollTop;
    }
  };

  return (
    <div ref={scrollRef} data-settings-scroll className="relative h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pt-8 pb-16 lg:px-8">
        <header className="pb-8">
          <h1 className="text-text-1 text-2xl font-semibold tracking-tight">设置</h1>
          <p className="text-text-2 mt-1.5 text-sm leading-relaxed">
            外观、AI 助手、词典、字体与同步。所有配置只存在本机。
          </p>
        </header>

        <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
          <nav aria-label="设置分类" className="lg:sticky lg:top-8 lg:w-36 lg:self-start">
            <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
              {SECTIONS.map(({ id, label, icon: Icon }) => {
                const on = active === id;
                return (
                  <li key={id} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      aria-current={on ? "true" : undefined}
                      onClick={() => jumpTo(id)}
                      className={cn(
                        "press focus-visible:focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] whitespace-nowrap",
                        on
                          ? "bg-surface-3 text-text-1 shadow-glass font-medium"
                          : "text-text-2 hover:text-text-1 hover:bg-surface-1",
                      )}
                    >
                      <Icon
                        size={15}
                        weight={on ? "fill" : "regular"}
                        className={on ? "text-accent" : "text-text-3"}
                      />
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <AppearanceSection
              theme={theme}
              onThemeChange={setTheme}
              reducedTransparency={transparency === "reduced"}
              onTransparencyChange={(reduced) => setTransparency(reduced ? "reduced" : "full")}
            />
            <AiSection />
            <DictionarySection />
            <KeymapSection />
            <FontSection />
            <SyncSection />
            <BackupSection />
            <ResetSection />
            <AboutSection />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Quiet "this form has edits the store has not seen" flag. */
function Unsaved({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return (
    <span className="bg-accent-soft text-accent shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
      未保存
    </span>
  );
}

interface AppearanceSectionProps {
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  reducedTransparency: boolean;
  onTransparencyChange: (reduced: boolean) => void;
}

function AppearanceSection({
  theme,
  onThemeChange,
  reducedTransparency,
  onTransparencyChange,
}: AppearanceSectionProps) {
  const reduce = useReducedMotion();
  const groupId = useId();
  return (
    <SettingsGroup id="appearance" icon={Palette} title="外观">
      <Row label="主题" hint="控制整个界面的明暗。">
        <div className="glass inline-flex rounded-lg p-0.5" role="radiogroup" aria-label="主题">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              // Native radios keep arrow-key navigation and screen reader
              // semantics; the input is hidden and the label carries the whole
              // visual treatment.
              <label
                key={value}
                className={cn(
                  "focus-within:focus-ring relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors",
                  active ? "text-text-1" : "text-text-2 hover:text-text-1",
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={active}
                  onChange={() => onThemeChange(value)}
                  className="sr-only"
                />
                {active && (
                  <motion.span
                    layoutId={`settings-theme-${groupId}`}
                    className="bg-surface-3 shadow-glass absolute inset-0 rounded-md"
                    transition={reduce ? { duration: 0 } : SPRING.layout}
                  />
                )}
                <Icon size={14} weight={active ? "fill" : "regular"} className="relative" />
                <span className="relative">{label}</span>
              </label>
            );
          })}
        </div>
      </Row>

      <Row
        label="减少透明度"
        hint="关闭毛玻璃模糊，改用接近不透明的背景。对透明度敏感或在低端设备上更清晰。"
      >
        <GlassSwitch
          checked={reducedTransparency}
          onCheckedChange={onTransparencyChange}
          ariaLabel="减少透明度"
        />
      </Row>
    </SettingsGroup>
  );
}

/** The line beside the update button, and whether it is bad news. */
function updateStatus(state: UpdateState): { text: string; bad: boolean } {
  switch (state.status) {
    case "idle":
      return { text: "", bad: false };
    case "checking":
      return { text: "正在检查…", bad: false };
    case "current":
      return { text: "已是最新版本。", bad: false };
    case "available":
      return { text: `发现新版本 ${state.version}。`, bad: false };
    case "downloading":
      return {
        text: state.percent === null ? "正在下载…" : `正在下载 ${state.percent}%…`,
        bad: false,
      };
    case "failed":
      return { text: state.message, bad: true };
  }
}

/**
 * The library as one file — the half of the app that sync does not cover.
 *
 * Sync carries progress, highlights and bookmarks and nothing else, so a new
 * machine still means importing every book again. A backup is the data
 * directory verbatim, which is also why a restore cannot happen in place: the
 * running process holds the database open, so it is unpacked beside the data
 * directory and swapped in on the next start. The displaced library is kept
 * next to it rather than deleted.
 */
function BackupSection() {
  const { choose, error: dialogError } = useSavePath();
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const backup = useExportBackup();
  const restore = useStageBackup();

  const onExport = async () => {
    setStatus(null);
    // The browser has no panel to ask and nowhere to write: its archive is its
    // own (the stores have no desktop shape) and goes straight to a download.
    let path: string | null = null;
    if (isDesktopRuntime) {
      path = await choose({
        defaultPath: `fangce-backup-${stamp()}.zip`,
        filters: [{ name: "书库备份", extensions: ["zip"] }],
      });
      if (!path) return;
    }
    setBusy("export");
    backup.mutate(path, {
      onSuccess: (summary) =>
        setStatus({
          tone: "ok",
          text: `已备份 ${summary.files} 个文件 · ${formatFileSize(summary.bytes)}。`,
        }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
      onSettled: () => setBusy(null),
    });
  };

  const onRestore = async () => {
    setStatus(null);
    let target: string | File | null = null;
    if (isDesktopRuntime) {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "书库备份", extensions: ["zip"] }],
      });
      target = typeof picked === "string" ? picked : null;
    } else {
      target = (await pickBrowserFiles(acceptOf(["zip"])))[0] ?? null;
      // The desktop keeps the displaced library as `<data dir>-previous`, so a
      // restore it regrets can be undone. Here the stores are emptied first and
      // the archive the reader is holding is the only way back — worth asking.
      const go =
        target !== null &&
        window.confirm("恢复会用备份里的内容替换当前书库，现在的书、标注和书签都会清掉。继续？");
      if (!go) return;
    }
    if (target === null) return;
    setBusy("restore");
    restore.mutate(target, {
      onSuccess: (summary) => {
        setStatus({ tone: "ok", text: `已恢复 ${summary.files} 个文件。` });
        // The desktop can only swap directories before the database is opened,
        // which is during startup, so it restarts itself. The browser's stores
        // were written back directly — but everything the shelf is showing came
        // from queries, and a reload is the honest way to show the new library.
        if (isDesktopRuntime) void relaunch();
        else window.location.reload();
      },
      onError: (error) => {
        setStatus({ tone: "bad", text: String(error) });
        setBusy(null);
      },
    });
  };

  return (
    <SettingsGroup
      id="backup"
      icon={Archive}
      title="书库备份"
      description={
        isDesktopRuntime
          ? "把书文件、封面、词典、字体与阅读记录打包成一个 zip；WebDAV 同步只覆盖进度、标注与书签，不带这些。"
          : "把书、标注、书签与阅读记录打包成一个 zip 下载到本机。浏览器的存储可能被系统清理掉，这份文件是唯一的备份。"
      }
    >
      <Row
        label="备份"
        hint={
          isDesktopRuntime
            ? "整库打包，含导入的词典与字体。备份里带有 AI 与同步的本地凭据，请按密钥一样保管。"
            : "整库打包：书的原文件、封面、标注、书签与阅读记录。本机的浏览器数据被清掉时，用它恢复。"
        }
      >
        <GlassButton
          variant="subtle"
          size="sm"
          onClick={() => void onExport()}
          disabled={busy !== null}
        >
          {busy === "export" ? "正在备份…" : "导出备份"}
        </GlassButton>
      </Row>
      <Row
        label="恢复"
        hint={
          isDesktopRuntime
            ? "替换当前书库，并重启应用生效。被替换的书库会保留在数据目录旁的 -previous 目录里。"
            : "替换当前书库（会先问一次），恢复完页面重新载入。当前的书、标注与书签会被清掉。"
        }
      >
        <GlassButton
          variant="subtle"
          size="sm"
          onClick={() => void onRestore()}
          disabled={busy !== null}
        >
          {busy === "restore" ? "正在恢复…" : "从备份恢复"}
        </GlassButton>
      </Row>
      <Actions>
        <Feedback status={status} />
        {dialogError && <Feedback status={{ tone: "bad", text: dialogError }} />}
      </Actions>
    </SettingsGroup>
  );
}

/** Date stamp for the default backup file name: `20260919`. */
function stamp(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}${month}${day}`;
}

/**
 * The one control on this page that throws away more than one setting at a
 * time, and the only one the reader cannot preview — so it sits behind a
 * confirmation, and the row says what is out of scope as plainly as what is
 * in. "Restore" promises a state, not a list, and a reader who has spent an
 * evening tuning typography needs to know whether their books survive it.
 */
function ResetSection() {
  const [asking, setAsking] = useState(false);

  const restore = () => {
    resetAllSettings();
    showToast("success", "已还原所有设置");
    setAsking(false);
  };

  return (
    <SettingsGroup
      id="reset"
      icon={ArrowsClockwise}
      title="还原所有设置"
      description="把外观、书架与阅读排版恢复为默认值。"
    >
      <Row
        label="还原所有设置"
        hint="主题、侧边栏、书架布局、字号与行距、页边距、纸张、书页配色等都会回到默认值。书籍、批注、笔记、词典、AI 与同步配置不受影响；自己导入的字体文件会保留，从字体目录安装的字体则需要重新下载。"
      >
        <GlassButton
          size="sm"
          leading={<ArrowsClockwise size={13} weight="bold" />}
          onClick={() => setAsking(true)}
        >
          还原
        </GlassButton>
      </Row>

      <GlassDialog
        open={asking}
        onOpenChange={setAsking}
        title="还原所有设置？"
        description="所有设置会回到默认值，这一步无法撤销。"
        widthClass="w-[min(92vw,440px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton size="sm" variant="subtle" onClick={() => setAsking(false)}>
            取消
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={restore}>
            还原
          </GlassButton>
        </div>
      </GlassDialog>
    </SettingsGroup>
  );
}

/** Where the repository link points; the opener capability whitelists this URL.
 *  It used to live in the sidebar footer — a link is not a chrome action, and
 *  it was the one item down there nobody would ever press twice. */
const REPO_URL = "https://github.com/xlongDev/fangce";

function AboutSection() {
  const { data, isLoading } = useSystemInfo();
  const { state, checkForUpdate, installAndRestart } = useUpdater();
  const status = updateStatus(state);
  const installing = state.status === "available" || state.status === "downloading";

  const facts: [string, string][] = [
    ["版本", data?.appVersion ?? (isLoading ? "读取中" : "未知")],
    ["平台", data ? `${data.os} ${data.arch}` : "读取中"],
    ["渲染引擎", data?.webview ?? "未知"],
    ["数据目录", data?.dataDir ?? "读取中"],
  ];

  return (
    <SettingsGroup id="about" icon={Info} title="关于">
      {facts.map(([label, value]) => (
        <Row key={label} label={label}>
          <span
            className="text-text-2 w-full truncate text-right font-mono text-[12.5px]"
            title={value}
          >
            {value}
          </span>
        </Row>
      ))}

      <Row label="GitHub" hint="源码、更新日志与问题反馈">
        <button
          type="button"
          onClick={() => void openUrl(REPO_URL).catch(() => {})}
          className="text-accent focus-visible:focus-ring inline-flex items-center gap-1 text-[12.5px] transition-opacity hover:opacity-80"
        >
          xlongDev/fangce <ArrowSquareOut size={12} />
        </button>
      </Row>

      <Actions>
        {installing ? (
          <GlassButton
            size="sm"
            variant="primary"
            leading={<ArrowsClockwise size={13} weight="bold" />}
            disabled={state.status === "downloading"}
            onClick={() => void installAndRestart()}
          >
            下载并安装
          </GlassButton>
        ) : (
          <GlassButton
            size="sm"
            leading={<ArrowsClockwise size={13} weight="bold" />}
            disabled={state.status === "checking"}
            onClick={() => void checkForUpdate()}
          >
            检查更新
          </GlassButton>
        )}
        {status.text && (
          <output
            className={cn(
              "text-[12.5px] leading-relaxed",
              status.bad ? "text-danger" : "text-text-3",
            )}
          >
            {status.text}
          </output>
        )}
      </Actions>

      <div className="px-5 py-3.5">
        <p className="text-text-3 text-[12px] leading-relaxed">
          更新包在安装前用本地生成的密钥校验来源。应用未做平台签名，若首次打开被系统拦截，手动放行一次即可。
        </p>
      </div>
    </SettingsGroup>
  );
}

/** What a font file can be, named once for both pickers — the native dialog and
 *  the browser's own. The reader sees the same list in the group's description.
 */
const FONT_EXTENSIONS = ["ttf", "otf", "ttc", "woff", "woff2"] as const;

/** The form only mounts once the stored config is known, and remounts when the
 * stored value changes — typing stays local state, saving refills the form.
 */
function AiSection() {
  const config = useAiConfig();
  if (!config.data) return null;
  return <AiForm key={config.dataUpdatedAt} initial={config.data} />;
}

function AiForm({ initial }: { initial: AiConfig }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const save = useSaveAiConfig();
  const test = useTestAiConfig();
  const dirty = (Object.keys(initial) as (keyof AiConfig)[]).some(
    (key) => draft[key] !== initial[key],
  );

  const set = (field: keyof AiConfig) => (value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const onTest = () => {
    setStatus(null);
    test.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "连接成功，接口、Key 与模型都可用。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSave = () => {
    setStatus(null);
    save.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "已保存。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  return (
    <SettingsGroup
      id="ai"
      icon={Sparkle}
      title="AI 阅读助手"
      description="划词解释、翻译与整章问答都走这里配置的接口。"
      badge={<Unsaved dirty={dirty} />}
    >
      <Row label="接口地址" hint="OpenAI 兼容端点；本地模型（Ollama 等）填 http://localhost。">
        <GlassInput
          value={draft.baseUrl}
          onChange={(event) => set("baseUrl")(event.target.value)}
          placeholder="https://api.openai.com/v1"
          aria-label="接口地址"
          spellCheck={false}
        />
      </Row>
      <Row
        label="API Key"
        hint="只存在本地数据库，并用系统钥匙串加密保存，不会离开这台机器。本地模型可留空。"
      >
        <GlassInput
          type="password"
          value={draft.apiKey}
          onChange={(event) => set("apiKey")(event.target.value)}
          placeholder="sk-…"
          aria-label="API Key"
          autoComplete="off"
        />
      </Row>
      <Row
        label="DeepL API Key"
        hint="可选。填了之后划词翻译走 DeepL（免费版 Key 以 :fx 结尾），更即时、更准；留空则用上面的 AI 模型翻译。"
      >
        <GlassInput
          type="password"
          value={draft.deeplKey}
          onChange={(event) => set("deeplKey")(event.target.value)}
          placeholder="DeepL-Auth-Key…"
          aria-label="DeepL API Key"
          autoComplete="off"
        />
      </Row>
      <Row label="模型名称" hint="例如 gpt-4o-mini、qwen2.5、deepseek-chat。">
        <GlassInput
          value={draft.model}
          onChange={(event) => set("model")(event.target.value)}
          placeholder="gpt-4o-mini"
          aria-label="模型名称"
          spellCheck={false}
        />
      </Row>
      <Row
        label="向量模型"
        hint="用于全书检索问答（RAG）。留空则只有划词与整章问答；须与聊天模型同一服务商。"
      >
        <GlassInput
          value={draft.embeddingModel}
          onChange={(event) => set("embeddingModel")(event.target.value)}
          placeholder="text-embedding-3-small / nomic-embed-text"
          aria-label="向量模型"
          spellCheck={false}
        />
      </Row>
      <Row
        label="重排模型"
        hint="可选。检索问答的第二阶段精排（Cohere 兼容 /rerank，如 bge-reranker-v2-m3）。留空则直接用向量排序。"
      >
        <GlassInput
          value={draft.rerankModel}
          onChange={(event) => set("rerankModel")(event.target.value)}
          placeholder="bge-reranker-v2-m3"
          aria-label="重排模型"
          spellCheck={false}
        />
      </Row>
      <Row label="系统提示词" hint="每次提问都会附带，决定助手的语气与边界。">
        <GlassInput
          value={draft.systemPrompt}
          onChange={(event) => set("systemPrompt")(event.target.value)}
          aria-label="系统提示词"
        />
      </Row>

      <Actions>
        <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
          {test.isPending ? "正在连接…" : "测试连接"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>

      <SecretsNotice />
    </SettingsGroup>
  );
}

/** What each bundle format is called in the list. */
const FORMAT_LABELS: Record<string, string> = {
  stardict: "StarDict",
  mdict: "MDict",
};

/**
 * Local dictionaries.
 *
 * The offline layer under the platform dictionary: the reader imports a
 * dictionary they already have, and 词典 answers out of it with no key and no
 * network. On Windows and Linux, where there is no system dictionary, this is
 * the only offline path there is.
 *
 * Two formats, because that is where the files are: StarDict is the open one
 * with a published spec, MDict is the one Chinese dictionary releases mostly
 * ship as.
 */
function DictionarySection() {
  const dictionaries = useDictionaries();
  const upload = useImportDictionary();
  const remove = useDeleteDictionary();
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const pick = async () => {
    setStatus(null);
    try {
      // The desktop's dialog answers with a path; the browser can only answer
      // with the file itself — and only with an `.mdx`, since a StarDict
      // bundle's other two files have no way to come along.
      let chosen: string | File | null = null;
      if (isDesktopRuntime) {
        const picked = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "词典", extensions: ["ifo", "mdx"] }],
        });
        chosen = typeof picked === "string" ? picked : null;
      } else {
        chosen = (await pickBrowserFiles(acceptOf(["mdx"])))[0] ?? null;
      }
      if (chosen === null) return;
      upload.mutate(chosen, {
        onSuccess: (added) => setStatus({ tone: "ok", text: `已导入《${added.name}》。` }),
        onError: (error) => setStatus({ tone: "bad", text: String(error) }),
      });
    } catch (error) {
      // A rejected dialog is a real failure worth naming — the ACL rules deny
      // `dialog:allow-open` per command, and swallowing it reads as a dead button.
      setStatus({ tone: "bad", text: `无法打开文件选择器：${String(error)}` });
    }
  };

  const list = dictionaries.data ?? [];

  return (
    <SettingsGroup
      id="dictionary"
      icon={BookOpenText}
      title="本地词典"
      description={
        isDesktopRuntime
          ? "导入 StarDict（.ifo、.idx、.dict 放在同一目录）或 MDict（.mdx）。划词查词先用系统词典，再用这里导入的，都不收录才交给 AI；全部离线，不需要 Key。"
          : "浏览器端只能导入 MDict（.mdx）——它是单个文件；StarDict 的三个文件在浏览器里没法一起选中。划词查词先问这里导入的词典，都不收录才交给 AI；全部离线，不需要 Key。"
      }
    >
      {list.length === 0 ? (
        <Row label="已导入" hint="还没有导入词典。" />
      ) : (
        list.map((dictionary) => (
          <Row
            key={dictionary.id}
            label={dictionary.name}
            hint={FORMAT_LABELS[dictionary.kind ?? "stardict"]}
          >
            <span className="text-text-3 text-[12.5px]">
              {dictionary.wordcount.toLocaleString()} 条
            </span>
            <button
              type="button"
              aria-label={`删除 ${dictionary.name}`}
              title={`删除 ${dictionary.name}`}
              onClick={() => remove.mutate(dictionary.id)}
              disabled={remove.isPending}
              className="text-text-3 hover:text-danger focus-visible:focus-ring ml-3 shrink-0 rounded-md p-1 transition-colors disabled:opacity-50"
            >
              <Trash size={14} />
            </button>
          </Row>
        ))
      )}

      <Actions>
        <GlassButton size="sm" onClick={() => void pick()} disabled={upload.isPending}>
          {upload.isPending ? "正在导入…" : "导入词典…"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>

      <LookupSourceRows />
    </SettingsGroup>
  );
}

/**
 * The 词典 popup's own controls, under the imported list: which sources answer
 * at once (the readest source list), at what type size, and whether the term
 * is spoken when the panel opens. The web sources are desktop-only — the
 * browser has no backend to make the request from.
 */
function LookupSourceRows() {
  const sources = useSettings((state) => state.lookupSources);
  const setLookupSources = useSettings((state) => state.setLookupSources);
  const fontSize = useSettings((state) => state.dictFontSize);
  const setFontSize = useSettings((state) => state.setDictFontSize);
  const autoSpeak = useSettings((state) => state.dictAutoSpeak);
  const setAutoSpeak = useSettings((state) => state.setDictAutoSpeak);

  return (
    <>
      <Row label="启用来源" hint="划词查词会同时询问所有启用的来源，各自一块结果。" />
      <Row label="本地词典" hint="系统词典与已导入的词典，全部离线。">
        <GlassSwitch
          checked={sources.local}
          onCheckedChange={(local) => setLookupSources({ local })}
          ariaLabel="启用本地词典"
        />
      </Row>
      {isDesktopRuntime && (
        <>
          <Row label="维基词典" hint="网络来源，不需要 Key。">
            <GlassSwitch
              checked={sources.wiktionary}
              onCheckedChange={(wiktionary) => setLookupSources({ wiktionary })}
              ariaLabel="启用维基词典"
            />
          </Row>
          <Row label="维基百科" hint="网络来源，词条的百科摘要。">
            <GlassSwitch
              checked={sources.wikipedia}
              onCheckedChange={(wikipedia) => setLookupSources({ wikipedia })}
              ariaLabel="启用维基百科"
            />
          </Row>
          <Row label="Urban Dictionary" hint="网络来源，英语俚语。">
            <GlassSwitch
              checked={sources.urban}
              onCheckedChange={(urban) => setLookupSources({ urban })}
              ariaLabel="启用 Urban Dictionary"
            />
          </Row>
        </>
      )}
      <Row label="AI 兜底" hint="所有来源都未收录时，用 AI 解释这个词。">
        <GlassSwitch
          checked={sources.ai}
          onCheckedChange={(ai) => setLookupSources({ ai })}
          ariaLabel="启用 AI 兜底"
        />
      </Row>
      <Row label="词典字号" hint={`${fontSize} px，只影响查词弹窗，与阅读界面相互独立。`}>
        <input
          type="range"
          aria-label="词典字号"
          className="range w-36"
          min={12}
          max={20}
          step={1}
          value={fontSize}
          style={{
            ["--range-fill" as string]: `${((fontSize - 12) / 8) * 100}%`,
          }}
          onChange={(event) => setFontSize(Number(event.currentTarget.value))}
        />
      </Row>
      <Row label="自动播放发音" hint="打开查词弹窗时朗读一次所选词。">
        <GlassSwitch checked={autoSpeak} onCheckedChange={setAutoSpeak} ariaLabel="自动播放发音" />
      </Row>
    </>
  );
}

/**
 * Fonts for the reading surface.
 *
 * Two ways in. The reader can import a file they already have — nothing ships
 * with the app, because CJK faces are tens of megabytes and their licences
 * belong to their authors. Or they can install one of the catalogue fonts with
 * a click: the catalogue serves only the `@font-face` sheet, and the glyph
 * subsets stream per `unicode-range` while reading, so installing 霞鹜文楷
 * costs 0.2 MB rather than the face's twenty.
 *
 * The catalogue rows are offered, not installed: 下载 fetches the sheet and 删除
 * takes it back out, and both are honest about the one thing the reader gives up
 * — installing needs the network.
 *
 * A catalogue font is a *preference*, not a file: 下载 adopts the rules and
 * flags the entry in `downloadedFonts`, and nothing on disk changes. That is why
 * its row asks "is this entry in the settings" while the 已导入 list below asks
 * "is this font on disk" — two different questions, so two row shapes.
 */
function FontSection() {
  const fonts = useFonts();
  const upload = useImportFont();
  const remove = useDeleteFont();
  const catalogDownload = useDownloadCatalogFont();
  const catalogRemove = useRemoveCatalogFont();
  const downloaded = useSettings((state) => state.downloadedFonts);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const pick = async () => {
    setStatus(null);
    try {
      // The desktop's dialog answers with a path; the browser can only answer
      // with the file itself. Both are what `useImportFont` knows how to take.
      let chosen: string | File | null = null;
      if (isDesktopRuntime) {
        const picked = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "字体", extensions: [...FONT_EXTENSIONS] }],
        });
        chosen = typeof picked === "string" ? picked : null;
      } else {
        chosen = (await pickBrowserFiles(acceptOf(FONT_EXTENSIONS)))[0] ?? null;
      }
      if (chosen === null) return;
      upload.mutate(chosen, {
        onSuccess: (added) => setStatus({ tone: "ok", text: `已导入「${added.name}」。` }),
        onError: (error) => setStatus({ tone: "bad", text: String(error) }),
      });
    } catch (error) {
      // Same reasoning as the dictionary row: an ACL denial is a real failure,
      // and swallowing it reads as a button that does nothing.
      setStatus({ tone: "bad", text: `无法打开文件选择器：${String(error)}` });
    }
  };

  const installCatalog = (font: CatalogFont) => {
    setStatus(null);
    catalogDownload.mutate(font, {
      onSuccess: () =>
        setStatus({ tone: "ok", text: `「${font.name}」已安装，可以在阅读器的「字体」里选用。` }),
      onError: (error) =>
        setStatus({ tone: "bad", text: `「${font.name}」安装失败：${String(error)}` }),
    });
  };

  const removeCatalog = (font: CatalogFont) => {
    setStatus(null);
    catalogRemove.mutate(font, {
      onSuccess: () => setStatus({ tone: "ok", text: `「${font.name}」已移除。` }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const all = fonts.data ?? [];

  return (
    <SettingsGroup
      id="fonts"
      icon={TextAa}
      title="字体"
      description="导入 .ttf / .otf / .ttc / .woff / .woff2 文件，或从下方目录一键安装。目录条目只下载样式表（0.1–0.2 MB）并存在本机，装好之后断网也能用；正文字形在阅读时按 unicode-range 按需加载，读过的部分离线完整，没读过的字在断网时回退到字体栈里的下一款。所有字体都只存在本机，不随应用分发。"
    >
      {CATALOG_FONTS.map((font) => {
        const installed = downloaded.includes(font.id);
        const busy = catalogDownload.isPending && catalogDownload.variables?.id === font.id;
        return (
          <Row
            key={font.id}
            label={font.name}
            // The sheet's cost, and the licence it comes under. The URL is in
            // the catalogue (`src/lib/fontCatalog.ts`) rather than on a link
            // here: a desktop webview has no default handler for external
            // links, and a button that half-works is worse than the text.
            hint={`${formatFileSize(catalogSheetBytes(font))}样式表 · ${font.license}`}
          >
            {installed ? (
              <button
                type="button"
                aria-label={`删除 ${font.name}`}
                title={`删除 ${font.name}`}
                onClick={() => removeCatalog(font)}
                disabled={catalogRemove.isPending}
                className="text-text-3 hover:text-danger focus-visible:focus-ring shrink-0 rounded-md p-1 transition-colors disabled:opacity-50"
              >
                <Trash size={14} />
              </button>
            ) : (
              <GlassButton
                size="sm"
                onClick={() => installCatalog(font)}
                disabled={busy}
                // One 下载 per catalogue entry: the visible text names the
                // action, the label names the font it acts on.
                aria-label={`下载 ${font.name}`}
              >
                {busy ? "下载中…" : "下载"}
              </GlassButton>
            )}
          </Row>
        );
      })}

      {all.length === 0 ? (
        <Row label="已导入" hint="还没有导入字体。" />
      ) : (
        all.map((font) => (
          <Row key={font.id} label={font.name}>
            <button
              type="button"
              aria-label={`删除 ${font.name}`}
              title={`删除 ${font.name}`}
              onClick={() => remove.mutate(font.id)}
              disabled={remove.isPending}
              className="text-text-3 hover:text-danger focus-visible:focus-ring shrink-0 rounded-md p-1 transition-colors disabled:opacity-50"
            >
              <Trash size={14} />
            </button>
          </Row>
        ))
      )}

      <Actions>
        <GlassButton size="sm" onClick={() => void pick()} disabled={upload.isPending}>
          {upload.isPending ? "正在导入…" : "导入字体…"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>
    </SettingsGroup>
  );
}

/** The form only mounts once the stored config is known, and remounts when the
 * stored value changes — typing stays local state, saving refills the form.
 */
function SyncSection() {
  const config = useSyncConfig();
  if (!config.data) return null;
  return <SyncForm key={config.dataUpdatedAt} initial={config.data} />;
}

const DECISION_LABELS: Record<SyncChange["decision"], string> = {
  uploaded: "本地进度已上传",
  downloaded: "已应用云端进度",
  remoteOnly: "云端有此书，本地未导入",
  unchanged: "进度一致",
};

function SyncForm({ initial }: { initial: SyncConfig }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const save = useSaveSyncConfig();
  const test = useTestSyncConfig();
  const sync = useSyncNow();
  const dirty = (Object.keys(initial) as (keyof SyncConfig)[]).some(
    (key) => draft[key] !== initial[key],
  );

  const set = (field: keyof SyncConfig) => (value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }));

  const onTest = () => {
    setStatus(null);
    test.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "连接成功。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSave = () => {
    setStatus(null);
    save.mutate(draft, {
      onSuccess: () => setStatus({ tone: "ok", text: "已保存。" }),
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const onSync = () => {
    setStatus(null);
    setReport(null);
    sync.mutate(draft, {
      onSuccess: (result) => {
        setReport(result);
        setStatus({ tone: "ok", text: "同步完成。" });
      },
      onError: (error) => setStatus({ tone: "bad", text: String(error) }),
    });
  };

  const changes = report
    ? report.books.length > 0 || moved(report.annotations) || moved(report.bookmarks)
    : false;

  return (
    <SettingsGroup
      id="sync"
      icon={CloudArrowUp}
      title="WebDAV 同步"
      description="阅读进度、标注与书签存为服务器目录下的 state.json。"
      badge={<Unsaved dirty={dirty} />}
    >
      <Row
        label="服务器目录"
        hint="坚果云等 WebDAV 服务的目录地址；阅读进度、标注与书签存为目录下的 state.json。"
      >
        <GlassInput
          value={draft.url}
          onChange={(event) => set("url")(event.target.value)}
          placeholder="https://dav.jianguoyun.com/dav/方册"
          aria-label="服务器目录"
          spellCheck={false}
        />
      </Row>
      <Row label="账号" hint="服务器要求匿名时留空。">
        <GlassInput
          value={draft.username}
          onChange={(event) => set("username")(event.target.value)}
          aria-label="账号"
          autoComplete="off"
          spellCheck={false}
        />
      </Row>
      <Row
        label="密码"
        hint="坚果云用「应用密码」，不是登录密码。密码与账号一样用系统钥匙串加密保存。"
      >
        <GlassInput
          type="password"
          value={draft.password}
          onChange={(event) => set("password")(event.target.value)}
          aria-label="密码"
          autoComplete="off"
        />
      </Row>

      <Actions>
        <GlassButton variant="subtle" size="sm" onClick={onTest} disabled={test.isPending}>
          {test.isPending ? "正在连接…" : "测试连接"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "正在保存…" : "保存"}
        </GlassButton>
        <GlassButton size="sm" onClick={onSync} disabled={sync.isPending || save.isPending}>
          {sync.isPending ? "正在同步…" : "立即同步"}
        </GlassButton>
        <Feedback status={status} />
      </Actions>

      <SecretsNotice />

      {report && changes && (
        <div className="px-5 py-3.5">
          <ul className="grid gap-1.5">
            {report.books.map((change) => (
              <li
                key={`${change.title}-${change.decision}`}
                className="text-[12.5px] leading-relaxed"
              >
                <span className="text-text-1">{change.title}</span>
                <span className="text-text-3">
                  {" "}
                  · {DECISION_LABELS[change.decision]} · {Math.round((change.progress ?? 0) * 100)}%
                </span>
              </li>
            ))}
            <SyncTallyRow label="标注" tally={report.annotations} />
            <SyncTallyRow label="书签" tally={report.bookmarks} />
          </ul>
        </div>
      )}
    </SettingsGroup>
  );
}

/** Whether a merge moved anything at all for one kind of item. */
function moved(tally: SyncTally): boolean {
  return tally.uploaded + tally.downloaded + tally.deleted > 0;
}

/** One kind's merge counts; renders nothing when that kind did not move. */
function SyncTallyRow({ label, tally }: { label: string; tally: SyncTally }) {
  if (!moved(tally)) return null;
  const parts = [
    tally.uploaded > 0 ? `上传 ${tally.uploaded}` : null,
    tally.downloaded > 0 ? `下载 ${tally.downloaded}` : null,
    tally.deleted > 0 ? `删除 ${tally.deleted}` : null,
  ].filter(Boolean);
  return (
    <li className="text-[12.5px] leading-relaxed">
      <span className="text-text-1">{label}</span>
      <span className="text-text-3"> · {parts.join(" / ")}</span>
    </li>
  );
}
