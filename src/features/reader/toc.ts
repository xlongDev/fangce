/**
 * The table of contents as one folded tree, whatever produced it.
 *
 * Two sources feed the drawer and they differ only in what a row points at: a
 * PDF contributes the document's own outline (rows point at pages), every other
 * book contributes chapters (rows point at chapter indices, and a foliate-driven
 * book tags its nested TOC with a depth). Normalising both here is what lets an
 * EPUB or Kindle TOC fold exactly like a PDF's — before this, only the outline
 * carried the depth the folding needs.
 */

export interface TocChapter {
  idx: number;
  title: string;
  /** Present on a nested TOC (foliate), absent on a flat chapter list. */
  depth?: number;
}

export interface TocOutlineItem {
  title: string;
  page: number;
  /** Nesting level, 0-based. */
  depth: number;
}

export interface TocRow {
  /** Gutter text: a page or chapter number, empty when the book has none. */
  marker: string;
  title: string;
  /** Nesting level, 0-based. */
  depth: number;
  /** Handed back to the jump callback: a page for an outline, else a chapter. */
  target: number;
}

export interface TocNode {
  row: TocRow;
  /** Position in the flat list; the expanded set and the current row key on it. */
  index: number;
  children: TocNode[];
}

/** One row shape for both sources, so the tree below never asks which it got.
 *
 * The gutter carries a page or chapter number. A foliate row is a TOC entry
 * with no page of its own — numbering it by its position in the flattened list
 * would invent a page number the book never printed — so it gets none, while a
 * flat chapter list (txt, markdown, cbz) is honestly numbered by index. */
export function tocRows(chapters: TocChapter[], outline: TocOutlineItem[]): TocRow[] {
  if (outline.length > 0) {
    return outline.map((item) => ({
      marker: String(item.page + 1),
      title: item.title,
      depth: item.depth,
      target: item.page,
    }));
  }
  return chapters.map((chapter) => ({
    marker: chapter.depth === undefined ? String(chapter.idx + 1) : "",
    // 「节」 for the same reason the extractor uses it: an untitled section is
    // not necessarily a chapter, and calling a cover page 第 1 章 collides with
    // the book's own 第 1 章.
    title: chapter.title || `第 ${chapter.idx + 1} 节`,
    depth: chapter.depth ?? 0,
    target: chapter.idx,
  }));
}

/** Flat depth-tagged rows → tree, so each level folds as one animated track.
 * Both sources emit a parent immediately before its children and never skip a
 * level, which is what lets one stack walk rebuild the nesting. */
export function tocTree(rows: TocRow[]): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  rows.forEach((row, index) => {
    const node: TocNode = { row, index, children: [] };
    while (stack.length > row.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}

/** Indices of the rows that have children: exactly the rows that can fold. */
export function parentIndices(nodes: TocNode[]): number[] {
  const indices: number[] = [];
  const walk = (list: TocNode[]) => {
    for (const node of list) {
      if (node.children.length > 0) indices.push(node.index);
      walk(node.children);
    }
  };
  walk(nodes);
  return indices;
}

/** Row to mark as being read. An outline's entries overlap — several cover the
 * page you are on — so the current one is the last at or before the position;
 * a chapter list is one entry per chapter and matches its index exactly. */
export function currentTocRow(rows: TocRow[], current: number, byPage: boolean): number {
  if (!byPage) return rows.findIndex((row) => row.target === current);
  let active = -1;
  rows.forEach((row, index) => {
    if (row.target <= current) active = index;
  });
  return active;
}

/** Indices of `active`'s ancestors: the rows left open when the drawer shows,
 * so the entry being read is visible in a tree that starts collapsed. */
export function pathToCurrent(rows: { depth: number }[], active: number): Set<number> {
  const path = new Set<number>();
  if (active < 0) return path;
  let target = active;
  for (let i = active; i >= 0; i--) {
    if (rows[i]!.depth < rows[target]!.depth) {
      path.add(i);
      target = i;
    }
  }
  return path;
}
