import { describe, expect, it } from "vitest";

import { authorNames } from "@/lib/local/rows";

/**
 * What a row's `authors` can hold, settled once here.
 *
 * The shapes come from the containers' own readers: a MOBI hands over a list of
 * strings, and foliate's EPUB reader keeps a contributor an **object** whenever
 * it carries a role or a file-as (`opf:role="aut"`, a MARC `role` refinement) —
 * only a contributor with nothing but a name collapses to that name. Stored as
 * it arrived, such a list takes the shelf down on `authorLine`'s `name.trim()`
 * (`TypeError: e.trim is not a function`), which is what the deployed web build
 * did until this settled the shape.
 */
describe("authorNames", () => {
  it("takes a plain string, and a list of them, as they are", () => {
    expect(authorNames("余华")).toEqual(["余华"]);
    expect(authorNames(["余华", "李四"])).toEqual(["余华", "李四"]);
  });

  it("trims, and drops the blank names", () => {
    expect(authorNames(["  余华  ", "", "   "])).toEqual(["余华"]);
  });

  it("takes the name out of a contributor object", () => {
    // The reported shape: an EPUB 2 creator carrying `opf:role="aut"`. foliate's
    // tidy() keeps the object because of the role; the name is what the shelf
    // prints.
    expect(authorNames({ name: "张三", role: ["aut"] })).toEqual(["张三"]);
    expect(
      authorNames([
        { name: "张三", role: ["aut"] },
        { name: "李四", sortAs: "Li, Si" },
      ]),
    ).toEqual(["张三", "李四"]);
  });

  it("keeps the plain names beside the objects", () => {
    expect(authorNames(["余华", { name: "李四", role: ["aut"] }])).toEqual(["余华", "李四"]);
  });

  it("drops a language-mapped name rather than guessing at it", () => {
    // `alternate-script` (or an `xml:lang` off the base) leaves the name a map
    // of language to string; there is no single string to take.
    expect(authorNames({ name: { "zh-Hant": "張三" } })).toEqual([]);
  });

  it("drops every shape that carries no name", () => {
    expect(authorNames(undefined)).toEqual([]);
    expect(authorNames(null)).toEqual([]);
    expect(authorNames([])).toEqual([]);
    expect(authorNames([9, null, undefined, {}, []])).toEqual([]);
  });
});
