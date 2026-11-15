/**
 * `tiny-pinyin` ships the dictionary but no declarations.
 *
 * Only the three functions this app uses are declared; `patchDict` is left in
 * because it is the escape hatch for a wrong reading, not because it is used.
 */
declare module "tiny-pinyin" {
  /** A parsed run: Han characters carry `target` (their pinyin), everything
   *  else is passed through in `source`. */
  export interface PinyinToken {
    type: number;
    source: string;
    target: string;
  }

  export function isSupported(): boolean;
  export function parse(text: string): PinyinToken[];
  export function convertToPinyin(text: string, separator?: string, lowerCase?: boolean): string;
  export function patchDict(dict: Record<string, string>): void;
}
