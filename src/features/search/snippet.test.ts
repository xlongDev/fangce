import { describe, expect, it } from "vitest";

import { parseSnippet, pickFoliateHit, searchHitNeedle } from "./snippet";
import { MARK_END, MARK_START } from "@/types/ipc";

const hit = (cfi: string, pre: string, post: string) => ({ cfi, pre, post });

describe("parseSnippet", () => {
  it("splits the text around the marked run", () => {
    expect(parseSnippet(`前面${MARK_START}命中${MARK_END}后面`)).toEqual([
      { text: "前面", matched: false },
      { text: "命中", matched: true },
      { text: "后面", matched: false },
    ]);
  });

  it("keeps unmarked text as a single part", () => {
    expect(parseSnippet("没有标记")).toEqual([{ text: "没有标记", matched: false }]);
  });

  it("returns nothing for an empty snippet", () => {
    expect(parseSnippet("")).toEqual([]);
  });

  it("falls back to plain text when a marker is never closed", () => {
    // The backend always emits both markers; malformed input must still render.
    const malformed = `abc${MARK_START}def`;
    expect(parseSnippet(malformed)).toEqual([{ text: malformed, matched: false }]);
  });
});

describe("pickFoliateHit", () => {
  it("lands on the occurrence whose context matches the snippet's", () => {
    const snippet = `他只留了${MARK_START}苏东坡${MARK_END}的一首诗，祝所有人安好。`;
    const hits = [
      hit("cfi:1", "我对其中的一个帖子印象深刻", "的一首诗，祝所有人"),
      hit("cfi:2", "大家都去装苏东坡", "殿凡高喜帖，也没什么"),
    ];
    expect(pickFoliateHit(snippet, hits)).toBe("cfi:1");
  });

  it("prefers the hit sharing more context on both sides of the match", () => {
    const snippet = `大家都去${MARK_START}装苏东坡${MARK_END}殿凡高喜帖，也没什么意思`;
    const hits = [
      hit("cfi:1", "不理想的，天天装洋", "殿凡高喜帖，也没"),
      hit("cfi:2", "天天装洋身子好像也不理想", "殿凡高喜帖，也没什么意思"),
    ];
    expect(pickFoliateHit(snippet, hits)).toBe("cfi:2");
  });

  it("ignores whitespace and case, which the two pipelines disagree on", () => {
    const snippet = `he only kept${MARK_START}Su Dongpo${MARK_END}and his poem`;
    const hits = [hit("cfi:1", "he   only\nkept", "and  HIS poem")];
    expect(pickFoliateHit(snippet, hits)).toBe("cfi:1");
  });

  it("returns null when no hit's context overlaps at all", () => {
    const snippet = `前面${MARK_START}命中${MARK_END}后面`;
    expect(pickFoliateHit(snippet, [hit("cfi:1", "毫不相干", "也无关")])).toBeNull();
  });

  it("returns null for a snippet without a marked run", () => {
    expect(pickFoliateHit("没有标记", [hit("cfi:1", "前", "后")])).toBeNull();
  });
});

describe("searchHitNeedle", () => {
  it("returns the snippet text with the match run's span", () => {
    const needle = searchHitNeedle(`他只留了${MARK_START}苏东坡${MARK_END}的一首诗`);
    expect(needle).toEqual({ text: "他只留了苏东坡的一首诗", from: 4, to: 7 });
  });

  it("drops the truncation ellipses without moving the match span", () => {
    const needle = searchHitNeedle(`……了${MARK_START}苏东坡${MARK_END}的一首诗……`);
    expect(needle).toEqual({ text: "了苏东坡的一首诗", from: 1, to: 4 });
  });

  it("returns null for a snippet without a marked run", () => {
    expect(searchHitNeedle("没有标记")).toBeNull();
  });
});
