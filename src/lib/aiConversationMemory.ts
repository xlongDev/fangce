/**
 * Which conversation the assistant was in, per book.
 *
 * The transcript itself lives in the database; this is only the pointer to it.
 * It exists because the drawer unmounts its panel on close, and the panel's
 * stream state dies with it — so without a pointer the reader's whole
 * conversation becomes unreachable the moment they close the drawer, even
 * though every message of it was written to disk.
 *
 * Kept in `localStorage` rather than in a table: it is one short string per
 * book, it is per device by nature (two machines can be reading different
 * conversations of the same book), and losing it costs a dropdown selection.
 */
const KEY = (bookId: string) => `fangce.ai-conversation.${bookId}`;

/** The conversation to reopen, or `null` when the panel should start empty. */
export function rememberedConversation(bookId: string): string | null {
  try {
    const id = localStorage.getItem(KEY(bookId));
    return id ? id : null;
  } catch {
    // Private mode, or a storage quota of zero. Starting empty is a fine
    // outcome; throwing out of a render would not be.
    return null;
  }
}

/** Points the book at a conversation, or at nothing when `id` is `null`. */
export function rememberConversation(bookId: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY(bookId), id);
    else localStorage.removeItem(KEY(bookId));
  } catch {
    // Same as above: the only cost is that the panel opens empty next time.
  }
}

/** Forgets one book's pointer, e.g. when its conversation was deleted. */
export function forgetConversation(bookId: string): void {
  rememberConversation(bookId, null);
}
