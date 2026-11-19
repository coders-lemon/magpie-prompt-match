import { describe, expect, test } from "bun:test";
import {
  attachCarrier,
  base64ToUtf8,
  extractAndStripCarrier,
  utf8ToBase64,
} from "../src/core/carrier.ts";
import { detectProtocol, injectPromptText } from "../src/core/protocols.ts";
import type { CarrierPayload } from "../src/core/types.ts";

describe("protocols & carrier", () => {
  test("pure-JS UTF-8 base64 roundtrips CJK and emoji cleanly", () => {
    const sample = "禁止过度防御性编程 🚀 — GPT-6.2 & AGENTS.md";
    expect(base64ToUtf8(utf8ToBase64(sample))).toBe(sample);
  });

  test("preserves Anthropic cache_control breakpoints when injecting at system-end", () => {
    const body = {
      model: "claude-sonnet-4",
      system: [
        {
          type: "text",
          text: "Cached system prompt",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    };

    const next = injectPromptText(body, "anthropic", "system-end", "Model patch");
    const sys = next.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(sys.length).toBe(2);
    expect(sys[0]).toEqual({
      type: "text",
      text: "Cached system prompt",
      cache_control: { type: "ephemeral" },
    });
    expect(sys[1]).toEqual({ type: "text", text: "Model patch" });
  });

  test("injects into OpenAI Chat, Responses, and Gemini protocols properly", () => {
    const chatBody = {
      model: "gpt-6.2",
      messages: [
        { role: "developer", content: "Base dev prompt" },
        { role: "user", content: "Fix bug" },
      ],
    };
    const chatNext = injectPromptText(chatBody, "chat", "system-end", "No defensive code");
    const msgs = chatNext.messages as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["developer", "developer", "user"]);
    expect(msgs[1].content).toBe("No defensive code");

    const respBody = {
      model: "gpt-6.2",
      instructions: "Base instructions",
      input: [{ role: "user", content: "Hello" }],
    };
    const respNext = injectPromptText(respBody, "responses", "developer-reminder", "Reminder");
    expect(detectProtocol(respBody)).toBe("responses");
    expect((respNext.input as Array<{ role: string; content: string }>)[1]).toEqual({
      role: "developer",
      content: "Reminder",
    });

    const gemBody = {
      systemInstruction: { parts: [{ text: "Base Gemini" }] },
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    };
    const gemNext = injectPromptText(gemBody, "gemini", "system-end", "Patch");
    expect(detectProtocol(gemBody)).toBe("gemini");
    expect(
      (gemNext.systemInstruction as { parts: Array<{ text: string }> }).parts
    ).toEqual([{ text: "Base Gemini" }, { text: "Patch" }]);
  });

  test("attaches and unconditionally strips carrier without leaving blank messages", () => {
    const payload: CarrierPayload = {
      v: 1,
      reqId: "req-1",
      agent: "pi",
      requestedModel: "group/coding",
      isUtility: false,
      rules: [],
    };

    const original = {
      model: "group/coding",
      messages: [{ role: "user", content: "Write code" }],
    };

    const withCarrier = attachCarrier(original, "chat", payload);
    expect(JSON.stringify(withCarrier)).toContain("magpie-prompt-match-carrier:");

    const stripped = extractAndStripCarrier(withCarrier, "chat");
    expect(stripped.found).toBe(true);
    expect(stripped.payload?.reqId).toBe("req-1");
    expect(JSON.stringify(stripped.body)).not.toContain("magpie-prompt-match-carrier:");
    expect((stripped.body.messages as unknown[]).length).toBe(1);
  });
});
