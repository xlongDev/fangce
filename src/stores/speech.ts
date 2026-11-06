import { create } from "zustand";

import type { SpeechTransport, SpeechUnit, SpeechView } from "@/features/reader/speech";

/**
 * The read-aloud session, shared by the reader and the shell's player.
 *
 * The player used to live inside `ReaderPage` and die with it: leaving the
 * reader cancelled the voice mid-sentence, which is exactly what a reader
 * listening to a book while browsing their shelf does not want. The engine and
 * the player now sit in the shell (`TtsHost`), and this store is the seam — the
 * reader publishes what is being read and hands over its transport while it is
 * on screen, and the player renders from whatever is left when it is not.
 *
 * Not persisted, and it must not be: a session is the voice that is speaking
 * right now, not a preference. `speechRate` / `speechVoiceURI` — the parts worth
 * keeping — live in `useReaderSettings`.
 */
/**
 * Whose text the voice is on.
 *
 * `ai` means the queue came from an answer, not from the book. The engine is
 * one singleton, so the two cannot play at once, but the reader must be able
 * to tell them apart: its follow-scroll, wash and transport all read the same
 * `unit` index the engine publishes, and an answer's third sentence is not the
 * book's third sentence.
 */
export type SpeechOrigin = "book" | "ai";

/** What an AI answer says about the session it starts. */
export interface AiSessionPatch {
  /** Which answer is speaking, so only its own button becomes a stop button. */
  id: string;
  title: string;
  chapter: string;
  units: readonly SpeechUnit[];
}

interface SpeechSessionState {
  /** The book the voice belongs to, or `null` before the first session. Read
   *  by the reader on mount, to tell "carry on with this book" from "the voice
   *  is reading something else entirely". */
  bookId: string | null;
  title: string;
  coverUrl: string | null;
  /** Chapter (prose) or section (Kindle) label, under the title. */
  chapter: string;
  /** The chapter the voice is inside — the second half of the same check. A
   *  reader coming back to a *different* chapter must not adopt the queue. */
  chapterIdx: number;
  /** BCP-47 tag of the book's language, for the voice picker's leading chips. */
  bookLanguage: string | null;
  /** The queue the voice is walking, exactly as the reader built it. */
  units: readonly SpeechUnit[];
  /** Transport lent by the mounted reader; `null` while the voice plays on
   *  alone, which is when the player drives the engine itself. */
  controls: SpeechTransport | null;
  /** The full card. The bar is governed by the engine's status instead. */
  open: boolean;
  /** Which of the card's four views the next open lands on. The reader's own
   *  倍速 button is a shortcut *past* the tiles and straight into 语速, and the
   *  capsule's is not — so this is the one thing about opening that has to be
   *  said rather than derived. Reset to `main` on every open that does not name
   *  a view, so the shortcut never becomes where the next reader lands too. */
  openAt: SpeechView;
  /** Which of the two origins owns the voice right now. */
  origin: SpeechOrigin;
  /** The answer being read, or `null` while the voice belongs to a book. */
  activeId: string | null;
  publish: (patch: SpeechSessionPatch) => void;
  setControls: (controls: SpeechTransport | null) => void;
  setOpen: (open: boolean, at?: SpeechView) => void;
  /** Hands the voice to one answer, clearing every book-shaped fact that
   *  would make the player claim it is reading a chapter. */
  startAi: (patch: AiSessionPatch) => void;
  /** Hands it back. Called when the voice goes idle, or when the reader starts
   *  reading the book itself — whichever comes first. */
  endAi: () => void;
}

/** What a reader says about the session it is running. */
export type SpeechSessionPatch = Partial<
  Pick<
    SpeechSessionState,
    "bookId" | "title" | "coverUrl" | "chapter" | "chapterIdx" | "bookLanguage" | "units"
  >
>;

export const useSpeechSession = create<SpeechSessionState>()((set) => ({
  bookId: null,
  title: "",
  coverUrl: null,
  chapter: "",
  chapterIdx: 0,
  bookLanguage: null,
  units: [],
  controls: null,
  open: false,
  openAt: "main",
  origin: "book",
  activeId: null,
  publish: (patch) => set(patch),
  setControls: (controls) => set({ controls }),
  setOpen: (open, at = "main") => set({ open, openAt: at }),
  startAi: (patch) =>
    set((state) => ({
      origin: "ai",
      activeId: patch.id,
      units: patch.units,
      title: patch.title,
      chapter: patch.chapter,
      // No book to go back to by chapter: 「回到阅读」 is a promise this
      // session cannot keep. The cover *is* the book's though — an answer is
      // about the book on screen, and a player that drops its artwork the
      // moment the voice changes subject looks broken. Inherited rather than
      // looked up: a second answer starts while the first one's session is
      // still the current one, whose cover is already the right one.
      bookId: null,
      coverUrl: state.coverUrl,
      chapterIdx: 0,
      bookLanguage: null,
      // The reader's transport would jump into the *book's* queue. With none
      // lent, the player drives the engine off the published units instead.
      controls: null,
      open: false,
      openAt: "main",
    })),
  // A no-op on a book session: the idle-voice effect also fires when the
  // reader merely stops its own chapter, and that must not clear its queue.
  endAi: () =>
    set((state) =>
      state.origin === "ai" ? { origin: "book", activeId: null, units: [], open: false } : state,
    ),
}));

/** The session as it stands outside a render — the reader's mount check reads
 *  it before it publishes anything, and must not be answered by this render's
 *  own (stale) subscription. */
export const sessionNow = () => useSpeechSession.getState();
