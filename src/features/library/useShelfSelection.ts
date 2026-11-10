import { useCallback, useEffect, useState } from "react";

import type { BookSummary } from "@/types/ipc";

interface ShelfSelectionOptions {
  /** The books currently on the shelf, in shelf order. */
  list: BookSummary[];
  /** Favourite flag for a batch of ids. */
  onFavorite: (ids: string[], favorite: boolean) => void;
  /** Delete a batch of ids. */
  onDelete: (ids: string[]) => void;
  /** Open the label sheet for a batch. */
  onRequestTags: (books: BookSummary[]) => void;
  /** Take a batch back out of the bin. Only the bin passes this. */
  onRestore?: (ids: string[]) => void;
  /**
   * Selection is the shelf's only interaction.
   *
   * The bin has no "read this book" action to offer — the file is still there
   * but the book is not on the shelf — so a card that opened the reader would
   * be a card that lies. It also has no way out of the mode: leaving would
   * strand the reader on a grid where nothing responds.
   */
  alwaysManaging?: boolean;
}

/**
 * Batch-manage mode for the shelf.
 *
 * Selection lives outside `BookCard` because the cards are windowed: only the
 * rows the viewport can reach are mounted, so a card cannot remember whether
 * it was picked — it would come back unselected on every scroll.
 */
export function useShelfSelection({
  list,
  onFavorite,
  onDelete,
  onRequestTags,
  onRestore,
  alwaysManaging = false,
}: ShelfSelectionOptions) {
  const [picking, setPicking] = useState(false);
  const managing = alwaysManaging || picking;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  const exit = useCallback(() => {
    setPicking(false);
    setSelected(new Set());
    setDeleteOpen(false);
  }, []);

  /**
   * Escape leaves batch-manage mode.
   *
   * It has to be a key handler rather than a click target, because the shelf
   * is the mode's own selection surface and any layer that catches a click
   * "outside" catches clicks on the books too. A keyboard user still needs a
   * way out that is not the bar's 完成 button.
   *
   * Suppressed while the delete confirmation is up, so Escape there closes
   * the dialog rather than the mode behind it.
   */
  useEffect(() => {
    if (!managing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || deleteOpen) return;
      exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managing, deleteOpen, exit]);

  /**
   * Clicking empty space also leaves batch-manage mode.
   *
   * Also a window listener and not a scrim, for the same reason Escape is: a
   * scrim over the shelf would turn every card press into an exit (the bug the
   * batch bar's comment records). "Empty" is defined negatively — a press that
   * lands on nothing interactive. Cards, buttons, inputs, the batch bar, any
   * dialog (its content *and* its scrim, so dismissing the tag sheet by
   * clicking outside does not take the mode down with it) all keep the mode;
   * a press whose target is the scroller itself is the scrollbar, and dragging
   * it must not exit either.
   */
  useEffect(() => {
    if (!managing) return;
    const onPointerDown = (event: PointerEvent) => {
      if (deleteOpen) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-shelf-scroller]") === target) return;
      if (
        target.closest(
          "button, a, input, textarea, select, label, [role='button'], [role='dialog'], " +
            "[data-dialog-overlay], [data-batch-bar], [data-guide-batch-pill]",
        )
      )
        return;
      exit();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [managing, deleteOpen, exit]);

  const toggle = (book: BookSummary) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });

  const allSelected = list.length > 0 && list.every((b) => selected.has(b.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((b) => b.id)));

  return {
    managing,
    begin: () => setPicking(true),
    exit,
    count: selected.size,
    selected,
    toggle,
    allSelected,
    toggleAll,
    /** Labels the whole selection: the sheet only ever adds in this mode. */
    requestTags: () => onRequestTags(list.filter((book) => selected.has(book.id))),
    /** The selection as book rows, for surfaces that need titles (the tag
     *  sheet, the batch guide). */
    selectedBooks: list.filter((book) => selected.has(book.id)),
    favorite: (favorite: boolean) => onFavorite([...selected], favorite),
    /** Back onto the shelf, and the selection goes with them: the rows they
     *  pointed at are no longer in this list. */
    restore: () => {
      onRestore?.([...selected]);
      setSelected(new Set());
    },
    deleteOpen,
    openDelete: () => setDeleteOpen(true),
    closeDelete: () => setDeleteOpen(false),
    confirmDelete: () => {
      onDelete([...selected]);
      setSelected(new Set());
      setDeleteOpen(false);
    },
  };
}

export type ShelfSelection = ReturnType<typeof useShelfSelection>;
