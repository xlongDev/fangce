import { open } from "@tauri-apps/plugin-dialog";

import { PACK_EXTENSIONS } from "@/features/library/pack";
import { ipc } from "@/lib/ipc";
import { acceptOf, pickFiles as pickBrowserFiles } from "@/lib/pickFile";

/** Every extension `BookFormat::from_path` accepts; kept here so the dialog and
    the Rust side never drift apart. */
export const BOOK_EXTENSIONS = [
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "prc",
  "fb2",
  "cbz",
  "txt",
  "md",
  "markdown",
] as const;

/** The same formats as a reader sees them, once each. Derived rather than
    written out, so the empty shelf and the drop overlay can never advertise a
    format the importer refuses (or forget one it takes). `markdown` folds into
    the `Markdown` chip: the two extensions are one format. */
export const BOOK_FORMAT_CHIPS = BOOK_EXTENSIONS.filter((ext) => ext !== "markdown").map((ext) =>
  ext === "md" ? "Markdown" : ext.toUpperCase(),
);

/** Native open dialog, restricted to the formats the library understands.
 *  Answers **absolute paths** — the desktop's import takes those — which is why
 *  it is not the `pickFiles` the browser uses (that one can only return the
 *  files themselves). */
export async function pickPaths(): Promise<string[]> {
  try {
    const picked = await open({
      multiple: true,
      title: "选择要导入的书籍",
      filters: [
        {
          name: "书籍与书档",
          extensions: [...BOOK_EXTENSIONS, ...PACK_EXTENSIONS],
        },
      ],
    });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    // Outside the Tauri shell there is no dialog; the web build picks files
    // through `pickBookFiles` instead.
    return [];
  }
}

/** Native folder picker for the batch import. The directory is scanned by
 *  `book.scanFolder` before anything is imported, so picking one is not a
 *  promise that every file inside is a book. */
export async function pickFolder(): Promise<string | null> {
  try {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择要导入书籍的文件夹",
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    // No dialog outside the Tauri shell; callers never render this button there.
    return null;
  }
}

/** A folder is just another import source: Rust expands it into book files,
 *  leaving loose files untouched. The picker and a native drop both use this,
 *  so there is only one shape of batch on this side of IPC. */
export function expandImportPaths(paths: string[]): Promise<string[]> {
  return ipc.bookScanPaths(paths);
}

/**
 * The browser's own picker: an `<input type="file">`, same extension filter.
 *
 * A browser cannot hand over paths, so the web build imports the `File`s
 * themselves — the bytes are what the shelf stores either way, and IndexedDB
 * keeps them. Cancelling resolves empty rather than hanging.
 */
/** The same picker as any other: a book's formats are just a longer filter. */
export function pickBookFiles(): Promise<File[]> {
  return pickBrowserFiles(acceptOf(BOOK_EXTENSIONS), true);
}
