import { useMemo } from "react";
import { BookOpenText } from "@phosphor-icons/react";

import { navigateTo } from "@/features/command/registerCoreCommands";
import { useBooks } from "@/hooks/useLibrary";
import type { Command } from "@/lib/commands";
import type { BookSummary } from "@/types/ipc";

/** How many books the palette offers for one query. Enough to find one, few
    enough that a short query cannot push every command off the list. */
const LIMIT = 12;

/**
 * Book results for the palette, as commands.
 *
 * The shelf is fetched once and filtered in memory rather than queried per
 * keystroke: `book_list` answers with whole book rows (description included),
 * so asking it on every character would re-serialize the library each time.
 * The list is already in the query cache from the shelf, and `recentlyRead`
 * puts the book being read at the top when the query is broad.
 */
export function useBookCommands(query: string): Command[] {
  const books = useBooks({ filter: "all", sort: "recentlyRead" });

  return useMemo(
    () => (books.data ? matchBooks(books.data, query).map(bookCommand) : []),
    [books.data, query],
  );
}

/** Substring match over title, authors and tags. Exported for its test. */
export function matchBooks(books: readonly BookSummary[], query: string): BookSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits = books.filter((book) => haystack(book).includes(needle));
  return hits.slice(0, LIMIT);
}

function haystack(book: BookSummary): string {
  return [book.title, ...book.authors, ...book.tags].join(" ").toLowerCase();
}

function bookCommand(book: BookSummary): Command {
  const percent = book.progress == null ? null : Math.round(book.progress * 100);
  const detail = [
    book.authors.join("、"),
    // Only say how far along a book is when it has been opened at all;
    // otherwise every untouched book would read "已读 0%".
    percent != null && percent > 0 ? `已读 ${percent}%` : "",
  ].filter(Boolean);

  return {
    id: `book.open.${book.id}`,
    title: book.title,
    description: detail.join(" · "),
    group: "书籍",
    // The palette scores on title plus keywords, so an author match has to be
    // a keyword too — otherwise the row is filtered straight back out.
    keywords: [...book.authors, ...book.tags, "book", "打开"],
    // The palette's icon slot is a ReactNode: a book's cover goes there
    // verbatim, so a row identifies the edition and not just the title.
    icon: book.coverUrl ? (
      <img
        src={book.coverUrl}
        alt=""
        className="h-7 w-[21px] shrink-0 rounded-[3px] object-cover"
        draggable={false}
      />
    ) : (
      <BookOpenText size={16} />
    ),
    run: () => navigateTo(`/reader?book=${book.id}`),
  };
}
