/** Extensions the importer and exporter both understand. */
export const PACK_EXTENSIONS = ["ctz", "ctzx"] as const;

export const ENCRYPTED_EXTENSION = ".ctzx";

function isEncryptedPack(path: string): boolean {
  return path.toLowerCase().endsWith(ENCRYPTED_EXTENSION);
}

const BATCH_PACK_ARCHIVE = ".zip";

/** `true` when the batch contains at least one encrypted pack. */
export function batchNeedsPassword(paths: string[]): boolean {
  // A batch-pack archive keeps the encrypted members inside it, so the picker
  // cannot see their extensions. Asking once for any ZIP is cheap; book import
  // has no other reason to accept one.
  return paths.some(
    (path) => isEncryptedPack(path) || path.toLowerCase().endsWith(BATCH_PACK_ARCHIVE),
  );
}
