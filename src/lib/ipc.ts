import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { commands } from "@/lib/bindings";
import type { LocalDictionary, LocalFont } from "@/types/ipc";
import type { SleepChoice, SleepTimer } from "@/hooks/useSleepTimer";
import type { SpeechUnit } from "@/features/reader/speech";
import type { Voice } from "@/features/reader/voice";
import type { BackupSummary, Outcome, SecretsStatus } from "@/lib/bindings";
import type {
  AiDelta,
  BarFace,
  DeleteProgress,
  GraphProgress,
  ImportOutcome,
  ImportProgress,
  RagProgress,
  SourceProgress,
  SummaryProgress,
} from "@/lib/bindings";

/** Which face the floating bar is drawing — generated from the backend, where
 *  the geometry lives, and re-exported here so the bar's two contracts (what it
 *  draws, and what it tells the backend it is drawing) come from one place. */
export type { BarFace };

/** `true` only when the renderer is hosted inside the Tauri shell. */
export const isDesktopRuntime: boolean = isTauri();

/**
 * The commands the web build answers for itself.
 *
 * Same names, same shapes, storage swapped: IndexedDB in the browser, SQLite in
 * Rust. Everything above this line — hooks, query keys, caches — is then the
 * same code on both sides, which is the point of routing it here rather than
 * branching in fifteen hooks.
 *
 * Loaded on first use, not at import: the browser backend pulls in foliate's
 * book parsing and the reader's pdf.js path, and the desktop — which has Rust
 * for all of this — should not carry 25 kB of it in its main chunk.
 *
 * The ones left out are the ones that need a real backend (AI, RAG, graph,
 * sync, book sources, backup packs) or a filesystem (importing from a path);
 * those keep their existing "desktop only" behaviour.
 */
const LOCAL_COMMANDS = [
  "bookImportFiles",
  "bookList",
  "bookStats",
  "bookFacets",
  "bookGet",
  "bookDelete",
  "bookDeleteMany",
  "bookRestore",
  "bookPurge",
  "bookPurgeMany",
  "bookEmptyTrash",
  "bookSetFavorite",
  "bookSetFavoriteMany",
  "bookUpdate",
  "bookCoverSave",
  "bookExport",
  "bookImages",
  "fontList",
  "fontDelete",
  "dictionaryList",
  "dictionaryDelete",
  "lookupDictionary",
  "readerToc",
  "readerChapter",
  "readerSetProgress",
  "annotationList",
  "annotationCreate",
  "annotationDelete",
  "annotationDeleteMany",
  "annotationUpdate",
  "annotationAnchor",
  "annotationNote",
  "bookmarkList",
  "bookmarkCreate",
  "bookmarkDelete",
  "statsReading",
  "statsRecordSession",
  "statsClear",
  "tagList",
  "bookSetTags",
  "tagDelete",
  "searchQuery",
  "bookFile",
] as const;

/** One browser command, resolved when it is first called. Loose on purpose:
 *  the types the callers see are `LocalCommands` below, taken from the
 *  generated bindings, so a mismatch is reported at the implementation. */
const fromLocal =
  (name: string) =>
  (...args: unknown[]): Promise<unknown> =>
    import("@/lib/local/backend").then((module) => {
      const call = (module as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
      if (!call) throw new Error(`本地后端没有 ${name}`);
      return call(...args);
    });

/** What the browser answers: the same names the generated commands have, so a
 *  caller cannot tell the two builds apart. */
/** `bookFile` / `bookAsset` carry raw bytes and are hand-written on `ipc` below,
 *  so they are not part of the generated set this picks from. */
type LocalCommands = Pick<
  typeof commands,
  Exclude<(typeof LOCAL_COMMANDS)[number], "bookAsset" | "bookFile" | "bookImportFiles">
> & {
  /** Browser-only: the desktop imports by path instead. `onProgress` fires
   *  once per file, the browser's stand-in for the desktop's
   *  `book://import-progress` event — there is no event channel out here. */
  bookImportFiles: (files: File[], onProgress?: () => void) => Promise<ImportOutcome[]>;
};

const local: Partial<Record<keyof LocalCommands, (...args: never[]) => unknown>> = isDesktopRuntime
  ? {}
  : Object.fromEntries(LOCAL_COMMANDS.map((name) => [name, fromLocal(name)]));

/**
 * Every command that crosses as JSON is generated into `bindings.ts` straight
 * from the Rust signature (`cargo test export_bindings`) — there is no
 * hand-written mirror left to drift out of step with the backend.
 *
 * Three are hand-written because they cannot be generated: `book_asset` and
 * `book_source_file` return raw bytes over the binary channel (Rust returns
 * `tauri::ipc::Response`), a shape Specta cannot describe, and the webview
 * snapshot does too. They are therefore excluded from codegen and typed here.
 */
export const ipc = {
  ...commands,
  // Nothing at runtime on the desktop — the cast only keeps the names visible to
  // callers, so the web build's shelf and reader share one call site.
  ...(local as LocalCommands),

  /**
   * The floating bar's three commands, shadowing the generated ones so each is a
   * no-op outside the desktop app.
   *
   * The guard is not the "query answered with an empty value" this codebase
   * warns about: the bar *is* an OS window, so in a browser the question does not
   * exist, and a second window there would have nothing to be. Without this the
   * shell — which mounts the player on every route — would invoke into the
   * missing Tauri internals on the first render of the web build and of every
   * test that renders it.
   */
  miniBarWatch(active: boolean): Promise<void> {
    return isDesktopRuntime ? commands.miniBarWatch(active) : Promise.resolve();
  },
  miniBarDismiss(): Promise<void> {
    return isDesktopRuntime ? commands.miniBarDismiss() : Promise.resolve();
  },
  miniBarReveal(): Promise<void> {
    return isDesktopRuntime ? commands.miniBarReveal() : Promise.resolve();
  },
  /**
   * Resizes that window to the face it is about to draw — the capsule, or the
   * player card on one of its views.
   *
   * The bar says which one it is drawing (`minimal` is 设置 → 朗读 → 播放器样式)
   * and the geometry is the backend's, because a webview can see its content and
   * not the frame around it. Every face has its own height: the card's
   * drill-downs are a third of its main view, and a window sized for the
   * sentence list behind a row of rate chips is an empty half of a panel.
   */
  miniBarExpand(face: BarFace, minimal: boolean): Promise<void> {
    return isDesktopRuntime ? commands.miniBarExpand(face, minimal) : Promise.resolve();
  },

  /**
   * Whether credentials can be sealed on this machine.
   *
   * The browser build answers for itself, and the answer is no: it has no OS
   * credential store, and no AI or sync command to put a credential in either —
   * its config is a constant and nothing is persisted. Saying `available: false`
   * is the truth about this build; the settings page is what decides that a
   * build with no credentials has nothing to warn about.
   */
  secretsStatus(): Promise<SecretsStatus> {
    if (isDesktopRuntime) return commands.secretsStatus();
    return Promise.resolve({
      available: false,
      detail: "浏览器构建没有系统钥匙串，且不保存任何凭据",
    });
  },

  /** Raw bytes of one image inside a book's source EPUB (binary channel). */
  bookAsset(id: string, path: string): Promise<ArrayBuffer> {
    if (!isDesktopRuntime) return fromLocal("bookAsset")(id, path) as Promise<ArrayBuffer>;
    return invoke<ArrayBuffer>("book_asset", { id, path });
  },

  /** The whole stored source file (binary channel); powers pdf.js rendering. */
  bookFile(id: string): Promise<ArrayBuffer> {
    if (!isDesktopRuntime) return fromLocal("bookFile")(id) as Promise<ArrayBuffer>;
    return invoke<ArrayBuffer>("book_source_file", { id });
  },

  /** One book's highlights as a download. Browser-only, for the same reason as
   *  the selection below. */
  notesSave(bookId: string, name: string, format: string): Promise<null> {
    if (isDesktopRuntime) throw new Error("桌面端走 notes_export（路径）");
    return fromLocal("notesSave")(bookId, name, format) as Promise<null>;
  },

  /**
   * The notes page's highlights as a download.
   *
   * Browser-only: the desktop's command takes a path from its save panel and
   * reads the format off the extension, and a browser has neither. Everything
   * about the *file* — the Markdown, the CSV columns — is the same code path as
   * the desktop's, pinned by the tests on both sides.
   */
  notesSaveSelection(
    bookIds: string[],
    ids: string[],
    name: string,
    format: string,
  ): Promise<null> {
    if (isDesktopRuntime) throw new Error("桌面端走 notes_export_selection（路径）");
    return fromLocal("notesSaveSelection")(bookIds, ids, name, format) as Promise<null>;
  },

  /** Reads a clippings file back in. Browser-only: the desktop's command takes
   *  a path from its own picker. Only this app's own Markdown and CSV are
   *  understood — a Kindle `My Clippings.txt` is refused, not guessed at. */
  clippingsImportFile(file: File, dryRun: boolean): Promise<Outcome> {
    if (isDesktopRuntime) throw new Error("桌面端走 clippings_import（路径）");
    return fromLocal("clippingsImportFile")(file, dryRun) as Promise<Outcome>;
  },

  /**
   * The browser's own archive: packs the library into a ZIP and downloads it.
   *
   * Browser-only. The desktop's archive is its data directory verbatim — a
   * SQLite file, the fonts, the dictionaries — and there is no browser shape of
   * that to write. What both keep is the thing that matters: a file the reader
   * can put somewhere else and put back.
   */
  backupSave(): Promise<BackupSummary> {
    if (isDesktopRuntime) throw new Error("桌面端走 backup_export（数据目录）");
    return fromLocal("backupSave")() as Promise<BackupSummary>;
  },

  /** Puts one of those archives back. Replaces the library, as the desktop
   *  does: a merge would have to decide what two rows with one id mean. */
  backupLoad(file: File): Promise<BackupSummary> {
    if (isDesktopRuntime) throw new Error("桌面端走 backup_stage（路径）");
    return fromLocal("backupLoad")(file) as Promise<BackupSummary>;
  },

  /**
   * Imports a font the *browser* picked.
   *
   * Browser-only, and for the same reason as `bookImportFiles`: the desktop
   * takes a path from its native dialog (`fontImport`), the browser can only
   * hand over the file itself. Everything after that — the bytes, the URL the
   * face is declared from — is the same on both sides.
   */
  fontImportFile(file: File): Promise<LocalFont> {
    if (isDesktopRuntime) {
      throw new Error("桌面端走 font_import（路径），这里是浏览器端的入口");
    }
    return fromLocal("fontImportFile")(file) as Promise<LocalFont>;
  },

  /**
   * Imports a dictionary the *browser* picked.
   *
   * Browser-only, and for the same reason as `fontImportFile`: the desktop
   * takes a path from its native dialog (`dictionaryImport`), the browser can
   * only hand over the file itself.
   *
   * Only `.mdx` is accepted — a StarDict bundle is three files that the desktop
   * finds next to each other on disk, and a file picker has no directory to
   * offer. The refusal is the backend's, and it names the format.
   */
  dictionaryImportFile(file: File): Promise<LocalDictionary> {
    if (isDesktopRuntime) {
      throw new Error("桌面端走 dictionary_import（路径），这里是浏览器端的入口");
    }
    return fromLocal("dictionaryImportFile")(file) as Promise<LocalDictionary>;
  },

  /**
   * Imports files the *browser* picked. The desktop takes paths from its native
   * dialog instead (`bookImport`); this exists so the shelf's import button has
   * one shape to call in both builds.
   *
   * `onProgress` fires once per file — the browser's stand-in for the
   * desktop's `book://import-progress` event, which exists because there is
   * no event channel out here.
   */
  bookImportFiles(files: File[], onProgress?: () => void) {
    if (isDesktopRuntime) {
      throw new Error("桌面端走 bookImport（路径），这里是浏览器端的入口");
    }
    return fromLocal("bookImportFiles")(files, onProgress) as Promise<ImportOutcome[]>;
  },

  /**
   * PNG snapshot of one region of the running webview, in viewport CSS px —
   * the texture the 「仿真」page curl is drawn from (binary channel).
   */
  webviewCaptureRegion(region: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("webview_capture_region", { region });
  },
};

/** Event the backend emits once per file while an import batch runs. */
const IMPORT_PROGRESS_EVENT = "book://import-progress";

/** Event the backend emits once per book while a batch delete runs. */
const DELETE_PROGRESS_EVENT = "book://delete-progress";

/** Event carrying streamed AI answer chunks. */
const AI_STREAM_EVENT = "ai://stream";

/** Event carrying RAG index build progress. */
const RAG_INDEX_EVENT = "rag://index-progress";
/** Counted in books, not chunks — see `commands::rag::RAG_LIBRARY_EVENT`. */
const RAG_LIBRARY_EVENT = "rag://library-progress";

/** Event carrying knowledge graph build progress. */
const GRAPH_BUILD_EVENT = "graph://build-progress";
const SUMMARY_BUILD_EVENT = "summary://build-progress";

/** Event carrying one book download's chapter progress. */
const SOURCE_DOWNLOAD_EVENT = "source://download-progress";

/**
 * Event the tray menu and the floating bar use for what they cannot carry out
 * themselves.
 *
 * Showing the window and quitting need the window; play/pause, the sentence
 * steps, stop and "take me back to the text" need the *session*, which lives
 * here. The backend does not know which of those it is looking at — it forwards
 * the menu item's id and the main window decides. Both sides have to agree on
 * the spelling, and neither can be generated from the other, so the union below
 * is the contract: a name that is not in it is ignored rather than acted on.
 */
const TRAY_CONTROL_EVENT = "tts://control";

/**
 * One verb of that vocabulary, as `install_tray` emits it or the bar forwards
 * it. The bar reuses these names rather than inventing a second set for the
 * same transport; the one item the tray has no menu entry for is `focus`, which
 * needs a reader to return to.
 */
export type TrayControl = "toggle" | "prev" | "next" | "stop" | "focus";

/**
 * What the bar's *card* needs and a menu entry cannot express.
 *
 * A menu is a list of names; a card has a scrubber, a sentence list, three
 * drill-downs and a row of chips, and every one of those carries a value. The
 * two share the event above because they are the same conversation — "this is
 * what I want the voice to do" — and a second event would be a second
 * subscription to the same handler, in the same component, for the same
 * purpose.
 *
 * Deliberately flat, like `MiniBarState`: an event payload is structured-cloned
 * across the process, so a class or a callback in here would arrive as
 * something else.
 */
export type BarAction =
  /** The scrubber, or a sentence in the list: jump to one utterance. */
  | { kind: "seek"; index: number }
  /** 上一段 / 下一段: the neighbouring run of units from another block. */
  | { kind: "skip"; dir: 1 | -1 }
  /** A rate chip. */
  | { kind: "rate"; value: number }
  /** A voice picked from the catalogue. */
  | { kind: "voice"; uri: string }
  /** The timer view — arm, re-arm or clear it. */
  | { kind: "sleep"; choice: SleepChoice };

/** Everything a surface with no transport of its own can ask the player for. */
export type SpeechControl = TrayControl | BarAction;

/** Subscribes to backend import progress; no-op outside the Tauri shell. */
export async function onImportProgress(
  handler: (progress: ImportProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<ImportProgress>(IMPORT_PROGRESS_EVENT, (event) => handler(event.payload));
}

/** Subscribes to backend batch-delete progress; no-op outside the Tauri shell.
 *
 *  Same contract as `onImportProgress`, and deliberately so: the browser
 *  build deletes from IndexedDB on this thread, where a per-book event would
 *  be the work announcing itself. */
export async function onDeleteProgress(
  handler: (progress: DeleteProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<DeleteProgress>(DELETE_PROGRESS_EVENT, (event) => handler(event.payload));
}

/** Subscribes to streamed AI chunks; no-op outside the Tauri shell. */
export async function onAiStream(
  handler: (delta: AiDelta) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<AiDelta>(AI_STREAM_EVENT, (event) => handler(event.payload));
}

/** Subscribes to RAG index progress; no-op outside the Tauri shell. */
export async function onRagProgress(
  handler: (progress: RagProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<RagProgress>(RAG_INDEX_EVENT, (event) => handler(event.payload));
}

/** Subscribes to a whole-library index rebuild; no-op outside the Tauri shell. */
export async function onRagLibraryProgress(
  handler: (progress: RagProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<RagProgress>(RAG_LIBRARY_EVENT, (event) => handler(event.payload));
}

/** Subscribes to graph build progress; no-op outside the Tauri shell. */
export async function onGraphProgress(
  handler: (progress: GraphProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<GraphProgress>(GRAPH_BUILD_EVENT, (event) => handler(event.payload));
}

/** Subscribes to chapter-summary build progress; no-op outside the Tauri shell. */
export async function onSummaryProgress(
  handler: (progress: SummaryProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<SummaryProgress>(SUMMARY_BUILD_EVENT, (event) => handler(event.payload));
}

/** Subscribes to book download progress; no-op outside the Tauri shell. */
export async function onSourceProgress(
  handler: (progress: SourceProgress) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<SourceProgress>(SOURCE_DOWNLOAD_EVENT, (event) => handler(event.payload));
}

/**
 * Subscribes to what the tray menu and the floating bar ask for; no-op outside
 * the Tauri shell.
 *
 * One subscription for both shapes: a bare name is a menu entry, an object is
 * the card. The caller tells them apart with `typeof`, which is also how the
 * unknown-name branch stays reachable — a build that meets a verb it does not
 * know ignores it rather than guessing.
 */
export async function onSpeechControl(
  handler: (control: SpeechControl) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<SpeechControl>(TRAY_CONTROL_EVENT, (event) => handler(event.payload));
}

/**
 * Event carrying what the floating read-aloud bar should draw.
 *
 * The bar is a window of its own, so it has no store to read from: the session,
 * the queue and the clock all live in the main window, and this is the way
 * across. Everything in the payload is therefore pre-chewed — the clocks are
 * already formatted — because a window that only draws should not have to carry
 * the speech queue to work out what `-4:12` means.
 */
const MINI_BAR_STATE_EVENT = "tts://mini-state";

/**
 * Event asking for one, sent by the bar itself.
 *
 * The bar is built the moment it is needed, which is *after* the state it would
 * have drawn went past, so it asks rather than waiting for the next sentence.
 */
const MINI_BAR_ASK_EVENT = "tts://mini-ask";

/**
 * What the floating bar draws, assembled by `TtsPlayer` and drawn by `MiniBar`.
 *
 * The bar is a window of its own, so it has no store to read from: the session,
 * the queue and the clock all live in the main window, and this is the way
 * across. What the *capsule* draws is pre-chewed — its clocks arrive already
 * formatted, because a window that only draws should not have to work out what
 * `-4:12` means — while the *card* is the app's own card, and it needs the
 * queue it is listing and the scrubber's own scale. One payload carries both
 * because they are one session: two events would be two chances to be told
 * about a different sentence.
 *
 * Deliberately flat and made of primitives: an event payload is structured-
 * cloned across the process, so a function or a class in here would arrive as
 * something else.
 */
export interface MiniBarState {
  /** Whether a voice is on at all. `false` draws nothing — a bar for a session
   *  that has ended is a frame that outlived it. */
  live: boolean;
  playing: boolean;
  /** The service is synthesising, so there is nothing to play yet. */
  loading: boolean;
  title: string;
  chapter: string;
  coverUrl: string | null;
  /** `m:ss`, already formatted: both sides of where the voice is. */
  elapsed: string;
  remaining: string;
  /** 0–100, drawn along the capsule's own bottom edge. */
  percent: number;
  /** The failure, in place of the clock. */
  error: string | null;
  /** So the bar follows the app's appearance without a store of its own. */
  theme: "light" | "dark";
  /** The queue the voice is walking — the card's sentence list, and what tells
   *  its scrubber where a character position lands.
   *
   *  The one large thing in here, and it rides along rather than on an event of
   *  its own: the card draws the list and the row being read as one picture, and
   *  two events could be drawn a sentence apart — a list from one chapter
   *  against an index from the next. */
  units: readonly SpeechUnit[];
  /** Which of them the voice is on, or `null` before the first one. */
  index: number | null;
  /** Characters spoken and in total: the scrubber's value and its range. */
  spoken: number;
  total: number;
  /** The rate in force. The card's 语速 tile shows it; nothing else needs it,
   *  because both clocks arrive above already worked out. */
  rate: number;
  /** The voice in use, as the id `useReaderSettings` stores — the bar resolves
   *  it against the catalogue it was handed separately. */
  voice: string | null;
  /** The book's language, for the picker's leading chips. */
  bookLanguage: string | null;
  /** What the sleep timer will do, or `null` for off. The countdown ticks in
   *  the bar; the deadline is what travels. */
  sleep: SleepTimer;
  /** 设置 → 朗读 → 播放器样式. 简约 is a shorter card, and a shorter window. */
  minimal: boolean;
}

/**
 * The voice catalogue, on an event of its own.
 *
 * Deliberately not part of the state above, which is published once per
 * sentence: the catalogue is a hundred-odd rows and changes about as often as
 * the network does, so putting it in the same payload would clone the whole
 * thing every time the voice moved on.
 */
const MINI_BAR_VOICES_EVENT = "tts://mini-voices";

/** What the picker's view of the catalogue needs: the voices, and whether the
 *  service that supplies most of them could be reached. */
export interface MiniBarVoices {
  voices: Voice[];
  edgeError: string | null;
}

export async function publishMiniBarVoices(catalogue: MiniBarVoices): Promise<void> {
  if (!isTauri()) return;
  await emit(MINI_BAR_VOICES_EVENT, catalogue);
}

/** Subscribes to it; no-op outside the Tauri shell. */
export async function onMiniBarVoices(
  handler: (catalogue: MiniBarVoices) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<MiniBarVoices>(MINI_BAR_VOICES_EVENT, (event) => handler(event.payload));
}

/** Publishes the bar's state to whichever windows are listening. */
export async function publishMiniBarState(state: MiniBarState): Promise<void> {
  if (!isTauri()) return;
  await emit(MINI_BAR_STATE_EVENT, state);
}

/** Subscribes to it; no-op outside the Tauri shell. */
export async function onMiniBarState(
  handler: (state: MiniBarState) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<MiniBarState>(MINI_BAR_STATE_EVENT, (event) => handler(event.payload));
}

/** Asks for one, for a bar that was built after the last publish. */
export async function askMiniBarState(): Promise<void> {
  if (!isTauri()) return;
  await emit(MINI_BAR_ASK_EVENT, null);
}

/** Subscribes to those requests; no-op outside the Tauri shell. The payload is
 *  `null` — the request *is* the message — but it is spelled out so this
 *  subscribes through the same shape as every other event handler. */
export async function onMiniBarAsk(
  handler: (payload: null) => void,
): Promise<UnlistenFn | undefined> {
  if (!isTauri()) return undefined;
  return listen<null>(MINI_BAR_ASK_EVENT, (event) => handler(event.payload));
}

/**
 * Forwards one control from a surface that has no transport of its own.
 *
 * The floating bar reuses this contract rather than inventing a second
 * vocabulary for the same verbs: both are surfaces that are used *because* the
 * main window is out of the way, and both are carried out by the player that
 * owns the transport.
 */
export async function sendSpeechControl(control: SpeechControl): Promise<void> {
  if (!isTauri()) return;
  await emit(TRAY_CONTROL_EVENT, control);
}

/**
 * Query body for something only the desktop app can answer.
 *
 * The web preview has no backend, so every such query owes the UI a stand-in —
 * an empty list, a default config. Taking it as an argument makes that a
 * requirement rather than a thing to remember: a new query cannot be written
 * without deciding what the browser shows.
 */
export function desktopQuery<T>(offline: T, call: () => Promise<T>): () => Promise<T> {
  return () => (isDesktopRuntime ? call() : Promise.resolve(offline));
}
