import { describe, expect, test } from "bun:test";
import {
  parseConditionalBlocks,
  parseFrontmatter,
  rewriteInlineConditionalBlocks,
} from "../src/core/parser.ts";

describe("parser", () => {
  test("parses YAML frontmatter with multi-line lists and inline arrays", () => {
    const md = `---
models:
  - "gpt-6.2"
  - "!gpt-6.2-mini" # comment
agents: [pi, codex]
mode: replace
position: developer-reminder
priority: 5
includeUtility: true
enabled: true
---
不要写冗余防御代码。
`;
    const { meta, body } = parseFrontmatter(md);
    expect(meta.models).toEqual(["gpt-6.2", "!gpt-6.2-mini"]);
    expect(meta.agents).toEqual(["pi", "codex"]);
    expect(meta.mode).toBe("replace");
    expect(meta.position).toBe("developer-reminder");
    expect(meta.priority).toBe(5);
    expect(meta.includeUtility).toBe(true);
    expect(meta.enabled).toBe(true);
    expect(body).toBe("不要写冗余防御代码。");
  });

  test("parses conditional blocks and attributes", () => {
    const md = `通用内容
<!-- @model: gpt-6*, !gpt-6-mini agents=pi,codex mode=replace -->
不要过度防御性编程
<!-- @end -->
中间内容
<!-- @model: claude-* -->
直接改代码
<!-- @end -->`;

    const blocks = parseConditionalBlocks(md);
    expect(blocks.length).toBe(2);
    expect(blocks[0].models).toEqual(["gpt-6*", "!gpt-6-mini"]);
    expect(blocks[0].agents).toEqual(["pi", "codex"]);
    expect(blocks[0].mode).toBe("replace");
    expect(blocks[0].content).toBe("不要过度防御性编程");
    expect(blocks[1].models).toEqual(["claude-*"]);
  });

  test("rewrites inline conditional blocks cleanly without leaving unmatched text", () => {
    const md = `通用规则

<!-- @model: gpt-6.2 -->
GPT专属规则
<!-- @end -->

<!-- @model: claude-* -->
Claude专属规则
<!-- @end -->`;

    const res = rewriteInlineConditionalBlocks(md, {
      model: "gpt-6.2",
      agent: "pi",
    });

    expect(res.changed).toBe(true);
    expect(res.strippedCount).toBe(1);
    expect(res.unwrappedCount).toBe(1);
    expect(res.matchedSignatures.length).toBe(1);
    expect(res.text).toContain("通用规则");
    expect(res.text).toContain("GPT专属规则");
    expect(res.text).not.toContain("Claude专属规则");
    expect(res.text).not.toContain("@model");
    expect(res.text).not.toContain("@end");
  });

  test("fails open on unclosed conditional tags", () => {
    const md = `通用规则\n<!-- @model: gpt-6.2 -->\n未闭合内容`;
    const res = rewriteInlineConditionalBlocks(md, { model: "claude-4" });
    expect(res.changed).toBe(false);
    expect(res.text).toBe(md);
  });
});
