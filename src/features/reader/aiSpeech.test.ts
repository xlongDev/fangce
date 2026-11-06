import { describe, expect, it } from "vitest";

import {
  AI_SPEECH_MAX_CHARS,
  aiSpeechLayout,
  aiSpeechRuns,
  aiSpeechSpans,
  aiSpeechUnits,
} from "./aiSpeech";
import { speechUnits } from "./speech";

const spoken = (source: string) => aiSpeechUnits(source).map((unit) => unit.text);
const joined = (source: string) => spoken(source).join("");

const GUIDE =
  "## 一句话概括\n\n在不制止、不强制的前提下。\n\n- 人是会受偏差影响的\n- 书里展开了选择体系";

describe("aiSpeechLayout", () => {
  it("cuts an answer with the book's sentence cutter, not its own sizing", () => {
    // Three rounds of "smarter" clip sizing all made Edge slower than the
    // book's ordinary sentences. The two queues must be the same shape.
    const prose = "第一句。第二句！第三句？";
    expect(spoken(prose)).toEqual(
      speechUnits([{ index: 0, text: prose }]).map((unit) => unit.text),
    );
  });

  it("keeps one unit per heading, sentence and bullet", () => {
    const layout = aiSpeechLayout(GUIDE);
    expect(layout.units.map((unit) => unit.text)).toEqual([
      "一句话概括",
      "在不制止、不强制的前提下。",
      "人是会受偏差影响的",
      "书里展开了选择体系",
    ]);
    expect(layout.runs.map((run) => run.text)).toEqual([
      "一句话概括",
      "在不制止、不强制的前提下。",
      "人是会受偏差影响的",
      "书里展开了选择体系",
    ]);
  });

  it("keeps the display runs' kinds, levels and list order", () => {
    const runs = aiSpeechRuns(GUIDE);
    expect(runs.map((run) => run.kind)).toEqual(["heading", "paragraph", "list", "list"]);
    expect(runs[0]!.level).toBe(2);
    expect(runs[2]!.order).toBe(1);
    expect(runs[3]!.order).toBe(2);
  });

  it("drops inline markup, links and citation indices", () => {
    const text = joined(
      "**助推** 不等于 `强制` [1]，见 [维基](https://example.com/a-b) ![图](x.png)。",
    );
    expect(text).toContain("助推 不等于 强制");
    expect(text).not.toContain("**");
    expect(text).not.toContain("`");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("[1]");
    expect(text).not.toContain("x.png");
  });

  it("leaves fenced code and table scaffolding out of the queue", () => {
    const text = joined(
      "先说结论。\n\n```python\nprint('这不该被念出来')\n```\n\n|---|---|\n| a | b |\n\n再说理由。",
    );
    expect(text).toContain("先说结论。");
    expect(text).toContain("再说理由。");
    expect(text).not.toContain("print");
    expect(text).not.toContain("|---|");
  });

  it("strips tags but keeps a real less-than comparison", () => {
    const text = joined("<p>甲</p> 比 乙 < 丙 更适合读。");
    expect(text).toContain("甲 比 乙 < 丙 更适合读。");
    expect(text).not.toContain("<p>");
  });

  it("never sends a request longer than the service's hard cap", () => {
    // A 900- or 120-character request still ran into tts.rs's 30s timeout;
    // only a sentence-sized one behaves like the book. Long run-on sentences
    // are the sole reason to cut at all.
    const raw = "字".repeat(2_500);
    const parts = spoken(raw);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((part) => part.length <= AI_SPEECH_MAX_CHARS)).toBe(true);
    expect(parts.join("")).toBe(raw);
  });

  it("prefers a punctuation boundary when a sentence must be cut", () => {
    const raw = `${"字".repeat(800)}，${"字".repeat(200)}。`;
    const parts = spoken(raw);
    expect(parts[0]).toHaveLength(801);
    expect(parts[0]?.endsWith("，")).toBe(true);
    expect(parts.join("")).toBe(raw);
  });

  it("has nothing to say for empty or code-only answers", () => {
    expect(spoken("")).toEqual([]);
    expect(spoken("```\nconst a = 1;\n```")).toEqual([]);
    expect(spoken("---\n\n")).toEqual([]);
  });
});

describe("aiSpeechSpans", () => {
  const layout = aiSpeechLayout(GUIDE);

  it("maps a spoken offset back to the run being displayed", () => {
    const unit = layout.units.findIndex((part) => part.text.includes("偏差"));
    const clip = layout.units[unit]!.text;
    const at = clip.indexOf("偏差");
    const spans = aiSpeechSpans(layout, unit, at, at + 2);
    expect(spans).toHaveLength(1);
    expect(layout.runs[spans[0]!.run]!.text.slice(spans[0]!.start, spans[0]!.end)).toBe("偏差");
  });

  it("never washes past the end of the clip, let alone the run", () => {
    const spans = aiSpeechSpans(layout, 0, 0, 100);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.end).toBe(layout.runs[0]!.text.length);
  });

  it("a clip belongs to exactly one display block", () => {
    for (let unit = 0; unit < layout.units.length; unit += 1) {
      const spans = aiSpeechSpans(layout, unit, 0, layout.units[unit]!.text.length);
      expect(new Set(spans.map((span) => span.run)).size).toBe(1);
    }
  });
});
