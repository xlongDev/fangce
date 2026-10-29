import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  BookOpenText,
  Check,
  CopySimple,
  Eraser,
  GlobeHemisphereWest,
  GlobeSimple,
  Highlighter,
  MagnifyingGlass,
  NotePencil,
  Sparkle,
  SpeakerHigh,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useAiChat, useAiConfig } from "@/hooks/useAi";
import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { activeReadingViewport } from "@/features/reader/readingViewport";
import { useSettings } from "@/stores/settings";
import type { WebDefinition } from "@/lib/bindings";
import { OverlayPortal } from "@/components/glass/overlay";
import type { Annotation, AnnotationStyle } from "@/types/ipc";
import { HIGHLIGHT_COLORS } from "@/stores/reader";
import { NoteAction } from "./AnnotationNote";
import { inkWash } from "./selection";
import type { PendingSelection } from "./selection";
import { SPRING } from "@/lib/motion";

/**
 * The floating toolbar a text selection opens (readest-style): the top row
 * acts on the selected text, the bottom row paints a highlight — one of three
 * styles in one of five inks. Tapping a style or a colour applies it at once,
 * so the reader can try combinations without re-selecting.
 *
 * With `annotation` set the toolbar edits an existing highlight instead: the
 * same bottom row restyles it in place and the top row gains a delete.
 *
 * 记笔记 opens a field under the two rows, so a thought about the passage can
 * be written where the reader is looking instead of in the side panel. It
 * commits on the way out — focus leaving the toolbar, or ⌘/Ctrl+Enter — and
 * Esc rewinds. The strip under the field finishes the job without leaving it:
 * 保存 writes, 清空 empties the field alone, and 删除 drops a note that was
 * already there and leaves the highlight standing.
 */

type Props = {
  x: number;
  y: number;
  /**
   * Which selection this toolbar is for, as a string that is stable across
   * re-measures of the *same* selection and different for a new one.
   *
   * The panel instance survives from one selection to the next, so this is
   * what tells it that the passage under it changed: the note field, its
   * draft and its caret all belong to the passage that was selected when the
   * field opened, and carrying them onto the next one would offer the reader
   * the previous note to commit onto words they never wrote it about.
   *
   * Built by `selectionKeyOf` — never from the box.
   */
  selectionKey: string;
  /** Bottom edge of the selection box, in host window coordinates — the
   *  lowest line carrying text, not the range's bounding box (see
   *  `selectionBottom`). */
  bottom?: number;
  /** The highlight the reader tapped; set = edit mode. */
  annotation?: Annotation | null;
  /** Reader's last-used ink, so a fresh selection paints predictably. */
  defaultColor: string;
  defaultStyle: AnnotationStyle;
  onCopy: () => void;
  onSearch: () => void;
  onSpeak: () => void;
  onAsk: () => void;
  onLookup: (kind: LookupKind) => void;
  onHighlight: (color: string, style: AnnotationStyle) => void;
  onRestyle: (color: string, style: AnnotationStyle) => void;
  /** Writes — or clears, with `null` — the reader's note on the selection. A
   *  bare selection gets a highlight created behind it (see `ReaderPage`). */
  onNote: (note: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
};

/** Viewport insets that keep the toolbar on screen (px). */
const EDGE = 12;
/** Toolbar width (px). The action row is 10 icons normally, 11 in edit mode;
 *  446 leaves a small cushion for borders and avoids crowding. */
const WIDTH = 446;
/** Floor for the width when the reading area is narrower than `WIDTH`. Below
 *  this the icon rows wrap onto a second line rather than shrink further. */
const MIN_WIDTH = 300;
/** Approximate height of the panel (px) — the action row plus the ink row.
 *  Used for one thing only: which side the entrance eases in from. The
 *  placement itself is measured (see the layout effect in `SelectionToolbar`),
 *  so drift here costs a 6px offset and nothing else. */
const ENTRANCE_HEIGHT = 96;
/** Clearance between the panel's edge and the selection box (px). The box ends
 *  on the text's own content box, so the line's remaining leading sits below
 *  it — a hair of clearance drops the icons into the middle of the gap between
 *  the selected line and the next one rather than below the words.
 *
 *  5 rather than 2, because "the gap between the lines" is not the same height
 *  on every platform: the line *box* a selection reports reaches further below
 *  the content box where the font's leading is larger, and on the CI runner's
 *  Noto CJK that is 3px more than on a Mac — enough that a 2px clearance put
 *  the panel's top edge 1px inside the line box, which is what
 *  `e2e/selection-toolbar.spec.ts` reads as "covering the words". Nothing about
 *  the ink changed; the panel now clears the line box on both. */
const GAP = 5;

/**
 * The reading content area's rect, in the window coordinates a `fixed` overlay
 * lives in.
 *
 * The window alone is too generous a frame: the reading card is inset from it
 * with rounded corners, so a panel clamped to the window pokes past the page
 * edge when the selection sits near it. We prefer the inner scroll surface
 * (`[data-reading-content]`), which carries the content's own inline margins,
 * and fall back to the outer viewport frame only during mount/tests.
 */
function readingViewport(): DOMRect | null {
  // The book being read, not "the first reading area in the document": a pair
  // has two, and the left one is always first.
  const host = activeReadingViewport();
  return (
    host?.querySelector("[data-reading-content]")?.getBoundingClientRect() ??
    host?.getBoundingClientRect() ??
    null
  );
}

/**
 * The toolbar's identity for one selection — the contract behind
 * `Props.selectionKey`.
 *
 * The range, never the box: `x`/`y`/`bottom` move every time the host
 * re-measures (a foliate page turn re-anchors the panel), and a key built from
 * them would close a note field the reader is still writing in. A highlight's
 * id stands in for its range in edit mode, and it is the *resolved* row's id —
 * the annotation query can still be in flight when the toolbar opens, and a key
 * that changed shape when it landed would close the field on its own.
 *
 * Takes the whole `PendingSelection`, box included, on purpose: a signature
 * that accepted only the range could not be tested against the mistake this
 * exists to prevent, because the box would not be there to leave out.
 */
export function selectionKeyOf(
  pending: PendingSelection,
  annotationId: string | null,
  chapterIdx: number,
): string {
  return annotationId !== null
    ? `a:${annotationId}`
    : `s:${pending.chapterIdx ?? chapterIdx}:${pending.range.start}:${pending.range.end}`;
}

const STYLES: { key: AnnotationStyle; label: string }[] = [
  { key: "highlight", label: "背景高亮" },
  { key: "underline", label: "直线" },
  { key: "squiggly", label: "波浪线" },
];

export function SelectionToolbar({
  x,
  y,
  bottom,
  annotation,
  defaultColor,
  defaultStyle,
  onCopy,
  onSearch,
  onSpeak,
  onAsk,
  onLookup,
  onHighlight,
  onRestyle,
  onNote,
  onDelete,
  onClose,
  selectionKey,
}: Props) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  // The draft ink: what the next apply paints. Edit mode starts from the
  // highlight's own values, a fresh selection from the reader's last pick.
  // Deliberately *not* reset with `selectionKey` below: it is the reader's last
  // pick, which `createHighlight` also folds into settings, so a new passage
  // starts where the last one left off.
  const [color, setColor] = useState(annotation?.color ?? defaultColor);
  // Rust stores the ink style as a plain `String` (validated on the way in), so
  // the narrowing to the three legal values happens here.
  const [style, setStyle] = useState<AnnotationStyle>(
    (annotation?.style as AnnotationStyle | undefined) ?? defaultStyle,
  );
  // The note field, open on demand and pre-filled from the highlight's own
  // note: `null` means closed, a string (even empty) means open. Escape
  // rewinds, so the blur that closing triggers must not commit what it just
  // threw away.
  const [draft, setDraft] = useState<string | null>(null);
  const rewound = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  /** The panel itself — its measured height is what places it. */
  const panel = useRef<HTMLDivElement>(null);
  const noting = draft !== null;

  // A new selection is a new thought. The panel instance outlives the passage
  // it was opened over, so without this the field would stay open — and stay
  // filled with the last passage's draft — under the next one, where clicking
  // 记笔记 reads as "close the field" instead of "open it". Measured on the
  // reader: selecting a second paragraph with the field open left it open, and
  // the blur the close raises then committed the stale draft onto the new
  // words.
  //
  // Render-phase rather than an effect: this codebase bans `setState` in
  // effects, and the field has to be gone in the same commit that shows the new
  // selection. The close is marked as the app's own so the blur the unmount
  // raises cannot commit the draft being dropped — `rewound` is the same flag
  // Escape uses, and it is cleared when a field opens again below.
  //
  // The ref write is in the render phase on purpose, and it has to be: the blur
  // it is guarding against is raised while React removes the textarea, which is
  // inside this very commit — before any layout or passive effect could run. An
  // effect would let the note be written onto the passage that just left.
  const [seenKey, setSeenKey] = useState(selectionKey);
  if (seenKey !== selectionKey) {
    setSeenKey(selectionKey);
    // oxlint-disable-next-line react-hooks/refs -- the mark must exist before the commit
    if (draft !== null) rewound.current = true;
    setDraft(null);
  }
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  // Focus the field as it appears — the reader asked for it by clicking. Not
  // via `autoFocus`: the a11y rule bans it for the page-load case it cannot
  // tell this apart from. The caret lands at the end of the note that is
  // already there, so editing one continues it instead of typing backwards.
  useEffect(() => {
    if (!noting) return;
    // A freshly opened field has nothing to rewind. The flag only means "the
    // close happening right now is the app's own, not the reader leaving", and
    // it is set by the selection change above and by Escape — both of which
    // close a field that is already open. Clearing it here is what stops a
    // close whose blur never arrived from swallowing the next real one.
    rewound.current = false;
    const el = field.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [noting]);

  /**
   * The one commit path: focus leaving the panel, its close button and
   * ⌘/Ctrl+Enter all land here. Esc deliberately does not — it closes
   * through `rewound` above. An unchanged draft costs no write, which is also
   * what makes clearing an absent note a no-op instead of a request.
   */
  const commitNote = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== (annotation?.note ?? "").trim()) onNote(next === "" ? null : next);
  };

  const apply = (nextColor: string, nextStyle: AnnotationStyle) => {
    if (annotation) onRestyle(nextColor, nextStyle);
    else onHighlight(nextColor, nextStyle);
  };

  const copy = () => {
    onCopy();
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  // The action row and ink row are always shown together; the note field
  // expands the panel when open.
  const page = readingViewport();
  // Clamp the whole toolbar inside the content area, treating `x` as the
  // centre point: left edge must stay >= page.left + EDGE, right edge must
  // stay <= page.right - EDGE. The width is capped by the page too — a fixed
  // 446px panel on a narrower reading area could not be clamped at all, and
  // the left bound would simply win, hanging the toolbar off the page edge.
  const frameLeft = page?.left ?? 0;
  const frameRight = page?.right ?? window.innerWidth;
  const width = Math.min(WIDTH, Math.max(frameRight - frameLeft - EDGE * 2, MIN_WIDTH));
  const minLeft = frameLeft + EDGE;
  const left = Math.min(
    Math.max(x - width / 2, minLeft),
    Math.max(frameRight - EDGE - width, minLeft),
  );
  // Anchor the toolbar below the selected text. The host passes the real
  // selection box bottom from all three renderers; when it is missing (taps on
  // an existing highlight) we infer a small offset from the top.
  const anchorBottom = bottom ?? y + 20;
  // Which side the panel will land on, near enough to aim the entrance's 6px
  // offset. The placement itself is measured — see the layout effect below.
  const above = anchorBottom + GAP + ENTRANCE_HEIGHT > (page?.bottom ?? window.innerHeight) - EDGE;

  // The panel's own top edge, in window coordinates.
  //
  // Measured after layout rather than computed from a constant. The height is
  // content-dependent — the icon row wraps when the page is narrow, and 记笔记
  // adds a field plus an action strip — and a constant that drifts from the
  // truth does not merely look wrong: it is what the clamp below is measured
  // against, so the panel hangs off the page's foot. It had already drifted
  // twice (the constants said 84 and 144; the panel measured 91 and 186, the
  // 42px gap arriving with the note field's action strip).
  //
  // Written straight to the DOM, not held in state: the value only exists
  // after layout, and `setState` in an effect is both banned in this codebase
  // and a round trip that would paint one frame at the wrong place. Same shape
  // as `GlassDialog`'s `--dialog-centre`.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const frame = readingViewport();
    const head = (frame?.top ?? 0) + EDGE;
    const foot = (frame?.bottom ?? window.innerHeight) - EDGE;
    const height = el.offsetHeight;
    // Below the selection while the whole panel fits there, above it
    // otherwise — anchored by whichever edge is nearer the words either way,
    // so the panel grows away from the passage rather than across it. When the
    // open field no longer fits below, the panel does cross to the other side;
    // that keeps the passage visible, which is the thing being written about.
    const wanted = anchorBottom + GAP + height <= foot ? anchorBottom + GAP : y - GAP - height;
    el.style.top = `${Math.min(Math.max(wanted, head), Math.max(foot - height, head))}px`;
  });

  const iconBtn =
    "press focus-visible:focus-ring text-text-1 hover:text-accent hover:bg-(--glass-btn) flex h-9 w-9 items-center justify-center rounded-xl";

  return (
    <motion.div
      ref={panel}
      data-toolbar-rev="6"
      // Fixed like the old pill: the selection can sit inside a foliate
      // iframe's coordinate space, and the host window is the only frame both
      // rendering paths agree on.
      className="glass-solid shadow-panel fixed z-40 flex flex-col gap-1 rounded-2xl p-1.5"
      // `top` is deliberately absent: it depends on the measured height and is
      // written by the layout effect above.
      style={{ left, width }}
      // One blur handler for the whole panel, because only the panel knows
      // whether focus left it: stepping between the toolbar's own controls
      // keeps the draft, and an Escape that closed the field itself must not
      // commit what it just rewound.
      //
      // A press on one of those controls must not be mistaken for leaving,
      // and WebKit makes it look like leaving: it does not focus a button on
      // mousedown, so focus falls to `body` and the field's focusout arrives
      // with `relatedTarget: null` — which the guard below reads as "outside".
      // The note then commits and the field unmounts before the click lands, so
      // the button's own handler never runs. (Measured on the demo book:
      // pressing 黄色 while writing left the toolbar open in Chromium and
      // closed it in WebKit, the focusout carrying `BUTTON[黄色]` against
      // `null`.) That is the engine this ships on — Tauri is WKWebView — and it
      // made 清空 and 删除 dead buttons. Holding focus where it is makes the two
      // agree, and costs nothing: `focus-visible` is for the keyboard, which
      // arrives by Tab and never through here.
      onMouseDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest("textarea")) return;
        event.preventDefault();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (rewound.current) {
          rewound.current = false;
          setDraft(null);
          return;
        }
        commitNote();
      }}
      initial={reduce ? false : { opacity: 0, scale: 0.92, y: above ? 6 : -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.95, y: 4 }}
      transition={SPRING.enter}
    >
      {/* Wraps only when the page forced the panel narrower than the ten
          icons need; at full width `justify-between` keeps the one row. */}
      <div className="flex flex-wrap items-center justify-between">
        <button type="button" aria-label="复制" className={iconBtn} onClick={copy}>
          {copied ? <Check size={16} className="text-accent" /> : <CopySimple size={16} />}
        </button>
        <button
          type="button"
          aria-label="词典查询"
          className={iconBtn}
          onClick={() => onLookup("dict")}
        >
          <BookOpenText size={16} />
        </button>
        <button
          type="button"
          aria-label="翻译"
          className={iconBtn}
          onClick={() => onLookup("translate")}
        >
          <GlobeSimple size={16} />
        </button>
        <button
          type="button"
          aria-label="维基百科"
          className={iconBtn}
          onClick={() => onLookup("wiki")}
        >
          <GlobeHemisphereWest size={16} />
        </button>
        <button type="button" aria-label="在本书中搜索" className={iconBtn} onClick={onSearch}>
          <MagnifyingGlass size={16} />
        </button>
        <button
          type="button"
          aria-label="应用当前高亮"
          className={iconBtn}
          onClick={() => apply(color, style)}
        >
          <Highlighter size={16} />
        </button>
        <button type="button" aria-label="朗读此处" className={iconBtn} onClick={onSpeak}>
          <SpeakerHigh size={16} />
        </button>
        <button type="button" aria-label="问 AI" className={iconBtn} onClick={onAsk}>
          <Sparkle size={16} />
        </button>
        <button
          type="button"
          aria-label="记笔记"
          aria-expanded={noting}
          className={cn(iconBtn, noting && "text-accent bg-(--glass-btn)")}
          onClick={() => {
            // Open on the highlight's own note. Closing re-enters here only
            // after the blur has already committed, which `commitNote` treats
            // as a no-op rather than a second write.
            if (noting) setDraft(null);
            else setDraft(annotation?.note ?? "");
          }}
        >
          <NotePencil size={16} />
        </button>
        {annotation && (
          <button
            type="button"
            aria-label="取消标注"
            className={cn(iconBtn, "hover:text-red-400")}
            onClick={onDelete}
          >
            <Trash size={16} />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭"
          className={cn(iconBtn, "text-text-3")}
          onClick={() => {
            // Closing the panel is the reader saying "done", not "discard":
            // a note in the field is written on the way out. Escape is the
            // one way to leave without it.
            commitNote();
            onClose();
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Ink row: always visible so the reader can switch style and colour
          without an extra toggle. */}
      <div className="border-hairline flex items-center justify-between gap-2 border-t px-1 pt-1.5 pb-0.5">
        <div className="flex items-center gap-1">
          {STYLES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-label={label}
              onClick={() => {
                setStyle(key);
                apply(color, key);
              }}
              className={cn(
                "press focus-visible:focus-ring flex h-7 w-7 items-center justify-center rounded-lg",
                style === key ? "text-text-1 bg-(--glass-btn)" : "text-text-3 hover:text-text-1",
              )}
            >
              <StyleSwatch style={key} color={color} />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {HIGHLIGHT_COLORS.map(({ hex, label }) => (
            <button
              key={hex}
              type="button"
              aria-label={label}
              onClick={() => {
                setColor(hex);
                apply(hex, style);
              }}
              className={cn(
                // No `press` here: the selected state is already a scale, and
                // two transforms on one element fight each other.
                "focus-visible:focus-ring flex h-5 w-5 items-center justify-center rounded-full transition-transform",
                color === hex ? "scale-110" : "hover:scale-105",
              )}
              style={
                color === hex
                  ? { boxShadow: `0 0 0 2px var(--glass-btn), 0 0 0 3.5px ${hex}` }
                  : undefined
              }
            >
              <span
                aria-hidden
                className="block h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: hex }}
              />
            </button>
          ))}
        </div>
      </div>

      {/* The note row. Its own line under the ink row, so writing about the
          passage never covers the controls that drew the highlight under it.
          The action strip under the field is what makes the note manageable
          without leaving it: 记笔记 opened a field with no way to finish other
          than clicking away, and nothing at all for clearing or dropping a
          note that was already there. */}
      {draft !== null && (
        <div className="flex flex-col gap-1">
          <textarea
            ref={field}
            aria-label="笔记"
            rows={2}
            value={draft}
            placeholder="写下你的想法"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Closes the field, keeps the toolbar: the reader is one step
                // back, not out — hence the event never reaches the page's own
                // Escape handling.
                event.stopPropagation();
                rewound.current = true;
                event.currentTarget.blur();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.blur();
              }
            }}
            className="border-hairline text-text-1 placeholder:text-text-3 focus-visible:border-accent w-full resize-none rounded-lg border bg-(--glass-btn) px-2.5 py-2 text-[12.5px] leading-relaxed transition-colors focus-visible:outline-none"
          />
          {/* None of these closes the field by hand. A button inside the panel
              does not trip the panel's own blur handler — that one only fires
              when focus leaves the panel entirely — so 保存 commits through
              the same path blur does, and the field unmounts because the
              draft became null, not because anything tore it down. */}
          <div className="flex items-center gap-0.5">
            <NoteAction
              label="保存笔记"
              text="保存"
              // Nothing to write when the field still says what is saved.
              disabled={draft.trim() === (annotation?.note ?? "").trim()}
              onClick={commitNote}
            >
              <Check size={14} />
            </NoteAction>
            <NoteAction
              label="清空输入"
              text="清空"
              disabled={draft === ""}
              // Only the field: the saved note is untouched until 保存 or
              // leaving the panel commits the empty value.
              onClick={() => setDraft("")}
            >
              <Eraser size={14} />
            </NoteAction>
            {annotation?.note != null && (
              <NoteAction
                label="删除笔记"
                text="删除"
                danger
                onClick={() => {
                  // Drops the note and keeps the highlight. The row above
                  // carries 取消标注, which is the one that removes both.
                  onNote(null);
                  setDraft(null);
                }}
              >
                <Trash size={14} />
              </NoteAction>
            )}
            <span className="text-text-3 ml-auto pr-1 text-[11px]">⌘↵ 保存 · Esc 取消</span>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/**
 * One button on the note field's action strip: `NoteAction`, shared with the
 * reader's own note cell — see `AnnotationNote` for why `label` and `text` are
 * two strings.
 */

/** The style preview inside its button: a wash, a line, a wave — drawn at the
 *  ink's own colour so the swatch previews the combination, not just the shape. */
function StyleSwatch({ style: kind, color }: { style: AnnotationStyle; color: string }) {
  if (kind === "highlight") {
    return (
      <span
        aria-hidden
        className="block h-3.5 w-4 rounded-[4px]"
        style={{ backgroundColor: inkWash(color, 0.55) }}
      />
    );
  }
  if (kind === "underline") {
    return <span aria-hidden className="block w-4 border-t-2" style={{ borderColor: color }} />;
  }
  return (
    <svg aria-hidden viewBox="0 0 16 4" className="block h-1 w-4">
      <path d="M0 2 Q 2 0, 4 2 T 8 2 T 12 2 T 16 2" fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

/**
 * 词典 / 翻译 / 维基百科 popup, anchored where the toolbar was. 词典 asks the
 * platform's own dictionary first — offline, key-free, instant — and falls
 * through to one streamed AI answer when the term is not a headword; 翻译 uses
 * DeepL when a key is configured (one fast round trip) and the same AI stream
 * otherwise; 维基百科 renders the article summary from the REST API, no key
 * needed.
 */

export type LookupKind = "dict" | "translate" | "wiki";

const DICT_PROMPT = (text: string) =>
  `解释下面的词或短语。若是外语，用简体中文给出音标、词性和释义，并附一个例句；若是中文，解释含义和常见用法。直接输出解释：\n\n${text}`;
const TRANSLATE_PROMPT = (text: string) =>
  `把下面的文本翻译成简体中文（若原文已是中文，则翻译成英文）。只输出译文：\n\n${text}`;

/** Renders the backend error the way a reader can act on it. */
function friendlyAiError(error: string): string {
  return error.includes("API") || error.length > 80
    ? "查询失败：请先在设置中配置 AI 服务。"
    : error;
}

export function QuickLookup({
  kind,
  text,
  x,
  y,
  onClose,
}: {
  kind: LookupKind;
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  if (kind === "wiki") return <WikiLookup text={text} x={x} y={y} onClose={onClose} />;
  if (kind === "translate") return <TranslateLookup text={text} x={x} y={y} onClose={onClose} />;
  return <DictLookup text={text} x={x} y={y} onClose={onClose} />;
}

/** Shared popup frame: title bar, scrollable body, anchored motion. */
function LookupPanel({
  title,
  x,
  y,
  onClose,
  children,
}: {
  title: string;
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  // Keep the panel over the page even near the edges — the page's own edges,
  // not the window's (see `readingViewport`). `x` is the anchor centre; clamp
  // the left edge so the whole panel stays inside the content area, and cap
  // its width by the page for the same reason the toolbar does.
  const PANEL_WIDTH = 380;
  const page = readingViewport();
  const frameLeft = page?.left ?? 0;
  const frameRight = page?.right ?? window.innerWidth;
  const width = Math.min(PANEL_WIDTH, Math.max(frameRight - frameLeft - EDGE * 2, MIN_WIDTH));
  const minLeft = frameLeft + EDGE;
  const left = Math.min(
    Math.max(x - width / 2, minLeft),
    Math.max(frameRight - EDGE - width, minLeft),
  );
  return (
    <motion.div
      className="glass-solid shadow-panel fixed z-40 flex max-h-80 flex-col overflow-hidden rounded-2xl"
      style={{ left, top: Math.max(y + 16, EDGE), width }}
      initial={reduce ? false : { opacity: 0, scale: 0.95, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.95 }}
      transition={SPRING.enter}
    >
      <div className="border-hairline flex items-center justify-between border-b px-4 py-2">
        <p className="text-text-1 text-xs font-medium">{title}</p>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="focus-visible:focus-ring text-text-3 hover:text-text-1 transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      <div className="text-text-2 overflow-y-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
        {children}
      </div>
    </motion.div>
  );
}

/**
 * One streamed AI answer; shared by the AI fallback of 词典 and 翻译. `hint` is
 * a quiet first line for when something else already declined the question, so
 * the reader can see why AI is answering at all.
 */
function AiLookup({
  title,
  prompt,
  hint,
  x,
  y,
  onClose,
}: {
  title: string;
  prompt: string;
  hint?: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { text: answer, streaming, error, send, reset } = useAiChat();
  useEffect(() => {
    // Send on mount, reset on unmount — no "already started" guard: the first
    // run's cleanup clears the active request id, so the remount's second run
    // must re-send for the stream events to match anything.
    send([{ role: "user", content: prompt }]);
    return () => reset();
  }, [prompt, send, reset]);

  return (
    <LookupPanel title={title} x={x} y={y} onClose={onClose}>
      {hint && <p className="text-text-3 mb-1.5 text-xs leading-relaxed">{hint}</p>}
      {error ? (
        <p className="text-text-3">{friendlyAiError(error)}</p>
      ) : (
        <>
          {answer}
          {streaming && <span className="text-accent animate-pulse">▍</span>}
          {!answer && !error && <span className="text-text-3">正在查询…</span>}
        </>
      )}
    </LookupPanel>
  );
}

/**
 * 词典: one term, every source at once — the platform dictionary and the
 * imported bundles in one offline chain, then 维基词典, 维基百科 and Urban
 * Dictionary from the network, each in its own block with its name on it (the
 * readest layout). The AI answer only takes over when every enabled source came
 * back empty, which is also where a selection longer than a headword always
 * lands.
 *
 * The browser answers the dictionary command from its imported bundles and
 * has no Rust-side network, so the web sources are desktop-only there.
 */
function DictLookup({
  text,
  x,
  y,
  onClose,
}: {
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const sources = useSettings((state) => state.lookupSources);
  const dictFontSize = useSettings((state) => state.dictFontSize);

  const entry = useQuery({
    queryKey: ["dictionary", text],
    queryFn: () => ipc.lookupDictionary(text),
    // An entry is a pure function of the term, so it never goes stale.
    enabled: sources.local,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const wiktionary = useQuery({
    queryKey: ["wiktionary", text],
    queryFn: () => ipc.lookupWiktionary(text),
    // Desktop only: the browser has no backend to make the request from, and
    // Urban Dictionary's API sends no CORS headers to do it client-side.
    enabled: sources.wiktionary && isDesktopRuntime,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const wikipedia = useQuery({
    queryKey: ["wikipedia", text],
    queryFn: () => ipc.lookupWikipedia(text),
    enabled: sources.wikipedia && isDesktopRuntime,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const urban = useQuery({
    queryKey: ["urban", text],
    queryFn: () => ipc.lookupUrban(text),
    enabled: sources.urban && isDesktopRuntime,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  // Pronounce the term once when the panel opens, if the reader asked for
  // that. The system voice is the right instrument: it is instant, offline,
  // and the panel is already gone by the time a full TTS session would start.
  const autoSpeak = useSettings((state) => state.dictAutoSpeak);
  useEffect(() => {
    if (!autoSpeak || typeof speechSynthesis === "undefined") return;
    const utterance = new SpeechSynthesisUtterance(text.trim());
    utterance.lang = /[\u4E00-\u9FFF]/.test(text) ? "zh-CN" : "en-US";
    utterance.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    return () => speechSynthesis.cancel();
  }, [autoSpeak, text]);

  const localFound = sources.local && entry.data?.status === "found";
  const wikiBlocks = sources.wiktionary ? (wiktionary.data ?? null) : null;
  const wikiPage = sources.wikipedia ? (wikipedia.data ?? null) : null;
  const urbanBlocks = sources.urban ? (urban.data ?? null) : null;
  const anyHit =
    Boolean(localFound) || wikiBlocks !== null || wikiPage !== null || urbanBlocks !== null;
  const settled =
    (!sources.local || !entry.isPending) &&
    (!sources.wiktionary || !isDesktopRuntime || !wiktionary.isPending) &&
    (!sources.wikipedia || !isDesktopRuntime || !wikipedia.isPending) &&
    (!sources.urban || !isDesktopRuntime || !urban.isPending);

  // Everything enabled came back empty: the AI explains the term instead,
  // with a hint only for the genuine "no dictionary has this word" case.
  if (settled && !anyHit) {
    if (!sources.ai) {
      return (
        <LookupPanel title="词典" x={x} y={y} onClose={onClose}>
          <span className="text-text-3">所有启用的来源都没有收录这个词。</span>
        </LookupPanel>
      );
    }
    return (
      <AiLookup
        title="词典"
        prompt={DICT_PROMPT(text)}
        hint={entry.data?.status === "missing" ? "词典未收录，用 AI 解释：" : undefined}
        x={x}
        y={y}
        onClose={onClose}
      />
    );
  }

  return (
    <LookupPanel title="词典" x={x} y={y} onClose={onClose}>
      <div style={{ fontSize: dictFontSize }}>
        {sources.local && (
          <LookupSource label="本地词典">
            {entry.isPending ? (
              <span className="text-text-3">正在查询…</span>
            ) : entry.data?.status === "found" ? (
              <>
                {entry.data.text}
                {entry.data.source && (
                  <p className="text-text-3 mt-2 text-[0.85em] leading-relaxed">
                    来自：{entry.data.source}
                  </p>
                )}
              </>
            ) : (
              <span className="text-text-3">未收录</span>
            )}
          </LookupSource>
        )}
        {sources.wiktionary && (
          <LookupSource label="维基词典">
            {wiktionary.isPending ? (
              <span className="text-text-3">正在查询…</span>
            ) : wikiBlocks?.length ? (
              <DefinitionBlocks blocks={wikiBlocks} />
            ) : (
              <span className="text-text-3">未收录</span>
            )}
          </LookupSource>
        )}
        {sources.wikipedia && (
          <LookupSource label="维基百科">
            {wikipedia.isPending ? (
              <span className="text-text-3">正在查询…</span>
            ) : wikiPage ? (
              <>
                <p className="text-text-1 font-medium">{wikiPage.title}</p>
                <p>{wikiPage.extract}</p>
                <a
                  href={wikiPage.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent text-[0.85em] hover:underline"
                >
                  在维基百科阅读 ↗
                </a>
              </>
            ) : (
              <span className="text-text-3">未收录</span>
            )}
          </LookupSource>
        )}
        {sources.urban && (
          <LookupSource label="Urban Dictionary">
            {urban.isPending ? (
              <span className="text-text-3">正在查询…</span>
            ) : urbanBlocks?.length ? (
              <DefinitionBlocks blocks={urbanBlocks} />
            ) : (
              <span className="text-text-3">未收录</span>
            )}
          </LookupSource>
        )}
      </div>
    </LookupPanel>
  );
}

/** One named block of the aggregated popup: the source on top, its answer
 *  under it, a hairline between blocks. */
function LookupSource({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-hairline not-first:mt-2.5 not-first:border-t not-first:pt-2.5">
      <p className="text-text-3 mb-1 text-[11px] font-medium">{label}</p>
      <div className="leading-relaxed whitespace-pre-wrap">{children}</div>
    </section>
  );
}

/** A web dictionary's sense blocks: part of speech in small type, meanings
 *  under it, each meaning linking to the source it came from. Keys are the
 *  content itself — a dictionary never repeats a sense block, and a repeated
 *  meaning would render identically anyway. */
function DefinitionBlocks({ blocks }: { blocks: WebDefinition[] }) {
  return (
    <>
      {blocks.map((block) => (
        <div key={`${block.partOfSpeech}:${block.meanings[0] ?? ""}`}>
          <p className="text-text-3 text-[0.85em]">{block.partOfSpeech}</p>
          {block.meanings.map((meaning) => (
            <p key={meaning}>{meaning}</p>
          ))}
          {block.sourceUrl && (
            <a
              href={block.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent text-[0.85em] hover:underline"
            >
              查看来源 ↗
            </a>
          )}
        </div>
      ))}
    </>
  );
}

/** 翻译 with a DeepL key: one fast round trip through the backend, no
 * streaming. Without a key the panel falls back to the AI path. */
function TranslateLookup({
  text,
  x,
  y,
  onClose,
}: {
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { data: config, isPending } = useAiConfig();
  const hasDeepl = (config?.deeplKey ?? "").trim() !== "";
  const deepl = useQuery({
    queryKey: ["deepl", text],
    queryFn: () => ipc.lookupTranslate(text),
    enabled: !isPending && hasDeepl,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (isPending || hasDeepl) {
    return (
      <LookupPanel title="翻译" x={x} y={y} onClose={onClose}>
        {deepl.error ? (
          <p className="text-text-3">{String(deepl.error)}</p>
        ) : deepl.data ? (
          <>
            {deepl.data.text}
            {deepl.data.detectedLang && (
              <p className="text-text-3 mt-2 text-xs">检测语言：{deepl.data.detectedLang}</p>
            )}
          </>
        ) : (
          <span className="text-text-3">正在翻译…</span>
        )}
      </LookupPanel>
    );
  }
  return <AiLookup title="翻译" prompt={TRANSLATE_PROMPT(text)} x={x} y={y} onClose={onClose} />;
}

/** 维基百科: the article summary for the selected term. */
function WikiLookup({
  text,
  x,
  y,
  onClose,
}: {
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["wikipedia", text],
    queryFn: () => ipc.lookupWikipedia(text),
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <LookupPanel title="维基百科" x={x} y={y} onClose={onClose}>
      {query.isPending ? (
        <span className="text-text-3">正在查阅…</span>
      ) : query.error ? (
        <p className="text-text-3">{String(query.error)}</p>
      ) : (
        query.data && (
          <div className="flex gap-3">
            {query.data.thumbnail && (
              <img
                src={query.data.thumbnail}
                alt=""
                className="h-20 w-20 shrink-0 rounded-xl object-cover"
              />
            )}
            <div className="min-w-0">
              <p className="text-text-1 text-sm font-semibold">{query.data.title}</p>
              <p className="mt-1 line-clamp-6">{query.data.extract}</p>
              <button
                type="button"
                className="focus-visible:focus-ring text-accent mt-2 inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-80"
                onClick={() => void openUrl(query.data!.pageUrl)}
              >
                阅读完整词条 <ArrowSquareOut size={12} />
              </button>
            </div>
          </div>
        )
      )}
    </LookupPanel>
  );
}

/**
 * Mount point shared by ReaderPage: toolbar or lookup, never both.
 *
 * Portalled to the shell's overlay host rather than rendered where it is
 * declared. The reading pane carries a `backdrop-filter` for the glass, which
 * makes it the containing block for `position: fixed` descendants — and it has
 * `overflow: hidden` on top. Left in place, the toolbar was therefore measured
 * from the pane's own origin instead of the window's (273px right, 37px low on
 * a default window) and sliced off at the page's right edge, which is exactly
 * the bug it was reported for.
 */
export function SelectionOverlay(props: {
  toolbar: Props | null;
  lookup: { kind: LookupKind; text: string; x: number; y: number } | null;
  onLookupClose: () => void;
}) {
  return (
    <OverlayPortal>
      <AnimatePresence>
        {props.toolbar && <SelectionToolbar key="toolbar" {...props.toolbar} />}
        {props.lookup && (
          <QuickLookup key="lookup" {...props.lookup} onClose={props.onLookupClose} />
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
