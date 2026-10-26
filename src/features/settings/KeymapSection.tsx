import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowCounterClockwise, Keyboard } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import {
  effectiveKeys,
  formatShortcut,
  sharedShortcuts,
  shortcutFromStroke,
  type Shortcut,
} from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";
import { useSettings } from "@/stores/settings";
import { bindingKeys, READER_KEYS, unreachableBindings } from "@/features/reader/readerKeys";
import { Actions, Row, SettingsGroup } from "@/features/settings/section";

/** One rebindable thing: a registered command, or one of the reader's keys. */
interface KeyEntry {
  readonly id: string;
  readonly title: string;
  readonly keys: readonly Shortcut[];
  /** Whether this entry is on an override rather than its own default. */
  readonly overridden: boolean;
}

/**
 * Rebind the keys, both kinds of them.
 *
 * The two lists are one section because they are one question — "what does
 * this key do?" — but they are not the same kind of thing, and the difference
 * is worth keeping visible: an app command is a *global* hotkey and fires
 * wherever the reader is, while the reader's keys depend on what is on screen
 * (the arrows turn pages in a paged layout and step chapters in the scrolled
 * one). That is why the reader's list can hold the same key twice on purpose
 * and the app's cannot, and why a clash between the two lists is reported
 * while a clash inside the reader's is not.
 */
export function KeymapSection() {
  const overrides = useSettings((s) => s.keyOverrides);
  const setKeyOverride = useSettings((s) => s.setKeyOverride);
  const resetKeyOverrides = useSettings((s) => s.resetKeyOverrides);
  const commands = useCommandStore((s) => s.commands);
  const [recording, setRecording] = useState<string | null>(null);

  const globalEntries = useMemo<KeyEntry[]>(
    () =>
      commands
        .filter((command) => command.shortcut)
        .map((command) => ({
          id: command.id,
          title: command.title,
          keys: effectiveKeys(command.id, command.shortcut, overrides) ?? [],
          overridden: overrides[command.id] !== undefined,
        })),
    [commands, overrides],
  );

  const readerEntries = useMemo<KeyEntry[]>(
    () =>
      READER_KEYS.map((binding) => ({
        id: binding.id,
        title: binding.title,
        keys: bindingKeys(binding, overrides),
        overridden: overrides[binding.id] !== undefined,
      })),
    [overrides],
  );

  // What the reader has just made unreachable, and what is now on two things at
  // once. Both are computed from the table rather than guessed: the reader's
  // gates are four booleans, so `unreachableBindings` can enumerate every
  // context a key could be pressed in.
  const problems = useMemo(() => {
    const globalIds = new Set(globalEntries.map((entry) => entry.id));
    return {
      blocked: unreachableBindings(overrides).map(({ blocked, by }) =>
        // Two ways to be unreachable, and they are not the same news: someone
        // else took the key, or the key never reaches this action in the first
        // place. A sentence that named no one would read as a half-sentence.
        by.length > 0
          ? `「${blocked.title}」按不到了：键被${by.map((taker) => `「${taker.title}」`).join("、")}拿走。`
          : `「${blocked.title}」按不到了：这个键走不到它，换一个试试。`,
      ),
      shared: sharedShortcuts([...globalEntries, ...readerEntries])
        // Two of the reader's own bindings sharing a key is the table working,
        // not a clash — the gates decide which one is live. A *global* command
        // has no gate, so anything it shares a key with fires alongside it.
        .filter((entry) => entry.ids.some((id) => globalIds.has(id)))
        .map(
          (entry) =>
            `${formatShortcut(entry.shortcut)} 同时绑在${entry.titles.map((title) => `「${title}」`).join("和")}上，一次按键会同时触发。`,
        ),
    };
  }, [globalEntries, overrides, readerEntries]);

  const stop = useCallback(() => setRecording(null), []);
  useRecorder(recording, setKeyOverride, stop);

  const anyOverride = Object.keys(overrides).length > 0;

  return (
    <SettingsGroup
      id="keys"
      icon={Keyboard}
      title="快捷键"
      description="点「改键」再按下想用的组合即可。同一组合出现在多条上时，按阅读器自己的顺序生效——左右方向键在翻页版式里翻页、滚动版式里翻章，这不是冲突。"
    >
      {globalEntries.length > 0 && (
        <>
          <Subhead>应用</Subhead>
          {globalEntries.map((entry) => (
            <KeyRow
              key={entry.id}
              entry={entry}
              recording={recording === entry.id}
              onRecord={() => setRecording(entry.id)}
              onReset={() => setKeyOverride(entry.id, null)}
            />
          ))}
        </>
      )}

      <Subhead>阅读器</Subhead>
      {readerEntries.map((entry) => (
        <KeyRow
          key={entry.id}
          entry={entry}
          recording={recording === entry.id}
          onRecord={() => setRecording(entry.id)}
          onReset={() => setKeyOverride(entry.id, null)}
        />
      ))}

      {problems.blocked.length + problems.shared.length > 0 && (
        <Row label="需要注意" hint="同一组合被两处占用时只有一个会生效；上面这两条是刚刚改出来的。">
          <ul className="text-danger space-y-1 text-[12.5px] leading-relaxed">
            {[...problems.shared, ...problems.blocked].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Row>
      )}

      <Actions>
        <GlassButton size="sm" disabled={!anyOverride} onClick={resetKeyOverrides}>
          全部恢复默认
        </GlassButton>
      </Actions>
    </SettingsGroup>
  );
}

function KeyRow({
  entry,
  recording,
  onRecord,
  onReset,
}: {
  entry: KeyEntry;
  recording: boolean;
  onRecord: () => void;
  onReset: () => void;
}) {
  return (
    <Row label={entry.title}>
      {recording ? (
        <span className="text-text-2 text-[12.5px]">
          按下新键…<span className="text-text-3 ml-2">Esc 取消</span>
        </span>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {entry.keys.map((key) => (
            <kbd
              key={formatShortcut(key)}
              className="border-hairline bg-surface-2 text-text-2 rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
            >
              {formatShortcut(key)}
            </kbd>
          ))}
          <button
            type="button"
            onClick={onRecord}
            aria-label={`修改 ${entry.title} 的按键`}
            className="text-text-3 hover:text-text-1 focus-visible:focus-ring rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors"
          >
            改键
          </button>
          {entry.overridden && (
            <button
              type="button"
              onClick={onReset}
              aria-label={`恢复 ${entry.title} 的默认按键`}
              title="恢复默认"
              className="text-text-3 hover:text-text-1 focus-visible:focus-ring rounded-md p-1 transition-colors"
            >
              <ArrowCounterClockwise size={13} />
            </button>
          )}
        </div>
      )}
    </Row>
  );
}

/** A heading inside the card, so the two lists of keys read as two lists. */
function Subhead({ children }: { children: ReactNode }) {
  return (
    <p className="text-text-3 bg-surface-1 px-5 py-2 text-[11.5px] font-medium tracking-wide">
      {children}
    </p>
  );
}

/**
 * Capture the next press as a binding.
 *
 * The listener is in the capture phase and stops what it hears. `useHotkeys`
 * is a bubble-phase listener on the same window, so a recorder that let ⌘K
 * through would open the palette on top of the panel the reader is trying to
 * rebind from — and the recorded key would be the one they pressed to get
 * there, not the one they meant.
 */
function useRecorder(
  recording: string | null,
  bind: (id: string, keys: readonly Shortcut[]) => void,
  stop: () => void,
) {
  useEffect(() => {
    if (recording === null) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Escape is the way out of the recorder, so it is not bindable — a
      // binding the reader cannot cancel out of is worse than one they cannot
      // make.
      if (event.key === "Escape") {
        stop();
        return;
      }
      const shortcut = shortcutFromStroke(event);
      // A bare modifier is a key on the way to another one: keep waiting.
      if (!shortcut) return;
      bind(recording, [shortcut]);
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bind, recording, stop]);
}
