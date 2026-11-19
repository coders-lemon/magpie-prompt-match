import { describe, expect, test } from "bun:test";
import {
  hasExactModelPattern,
  matchesAgentPatterns,
  matchesModelPatterns,
} from "../src/core/matcher.ts";

describe("matcher", () => {
  test("matches exact model and provider/model", () => {
    expect(matchesModelPatterns(["gpt-6.2"], { model: "gpt-6.2" })).toBe(true);
    expect(
      matchesModelPatterns(["gpt-6.2"], { provider: "openai", model: "gpt-6.2" })
    ).toBe(true);
    expect(
      matchesModelPatterns(["openai/gpt-6.2"], {
        provider: "openai",
        model: "gpt-6.2",
      })
    ).toBe(true);
    expect(
      matchesModelPatterns(["workbuddy/gpt-6.2"], {
        provider: "openai",
        model: "gpt-6.2",
      })
    ).toBe(false);
  });

  test("supports glob wildcards and case-insensitivity", () => {
    expect(matchesModelPatterns(["gpt-6*"], { model: "GPT-6.2-Codex" })).toBe(true);
    expect(matchesModelPatterns(["gpt-6.?"], { model: "gpt-6.2" })).toBe(true);
    expect(matchesModelPatterns(["gpt-6.?"], { model: "gpt-6.20" })).toBe(false);
  });

  test("supports comma lists and negation", () => {
    expect(
      matchesModelPatterns(["gpt-6*, !gpt-6-mini"], { model: "gpt-6.2" })
    ).toBe(true);
    expect(
      matchesModelPatterns(["gpt-6*, !gpt-6-mini"], { model: "gpt-6-mini" })
    ).toBe(false);
    expect(
      matchesModelPatterns(["!claude-*"], { model: "gpt-6.2" })
    ).toBe(true);
    expect(
      matchesModelPatterns(["!claude-*"], { model: "claude-sonnet-4" })
    ).toBe(false);
  });

  test("matches requested routing group explicitly when pattern targets group/", () => {
    expect(
      matchesModelPatterns(["group/coding"], {
        provider: "openai",
        model: "gpt-6.2",
        requestedModel: "group/coding",
      })
    ).toBe(true);
  });

  test("matches agent filters including negation", () => {
    expect(matchesAgentPatterns(["*"], "pi")).toBe(true);
    expect(matchesAgentPatterns(["pi", "codex"], "pi")).toBe(true);
    expect(matchesAgentPatterns(["pi", "codex"], "claude")).toBe(false);
    expect(matchesAgentPatterns(["*", "!claude"], "claude")).toBe(false);
    expect(matchesAgentPatterns(["*", "!claude"], "pi")).toBe(true);
  });

  test("distinguishes exact vs wildcard patterns", () => {
    expect(hasExactModelPattern(["gpt-6.2"])).toBe(true);
    expect(hasExactModelPattern(["gpt-6*"])).toBe(false);
    expect(hasExactModelPattern(["gpt-6*", "gpt-6.2"])).toBe(true);
  });
});
