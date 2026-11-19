import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PROMPT_MATCH_DISABLE_UI = "1";

import { clearDiscoveryCache } from "../src/core/discovery.ts";
import { hitLogStore } from "../src/hit-log.ts";
import { onRequest, onResponse } from "../src/hooks.ts";
import { onProvider } from "../dist/middleware.js";

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-pipe-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearDiscoveryCache();
  hitLogStore.clear();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("two-stage pipeline (hooks -> routing group / fallback -> middleware)", () => {
  test("resolves routing group & cross-model fallback cleanly with inline block stripping and zero leakage", async () => {
    const root = makeTmpDir();
    const globalDir = path.join(root, "global");
    const repo = path.join(root, "repo");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

    fs.writeFileSync(
      path.join(globalDir, "gpt-6.2.md"),
      `---\nmodels: ["gpt-6.2"]\n---\n全局GPT-6.2反防御性编程规则`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(globalDir, "claude.md"),
      `---\nmodels: ["claude-*"]\n---\n全局Claude精简规则`,
      "utf8"
    );

    const agentsMd = `通用项目说明

<!-- @model: gpt-6.2 -->
项目级GPT-6.2块：不要写冗余判空
<!-- @end -->

<!-- @model: claude-* -->
项目级Claude块：直接编辑文件
<!-- @end -->`;
    fs.writeFileSync(path.join(repo, "AGENTS.md"), agentsMd, "utf8");

    // Simulate an Anthropic-format request where Agent natively loaded AGENTS.md into system
    const clientReq = {
      model: "group/coding",
      system: [
        {
          type: "text",
          text: `Agent built-in system\n\n${agentsMd}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ name: "edit", input_schema: {} }],
      messages: [{ role: "user", content: "Refactor parser" }],
    };

    const state: Record<string, unknown> = {};
    const afterHooks = await onRequest(clientReq, {
      protocol: "anthropic",
      model: "group/coding",
      agent: "pi",
      cwd: repo,
      options: { promptsDir: globalDir },
      state,
    });

    expect(afterHooks).toBeDefined();

    // Attempt 1: Routing group tries Claude first
    const claudeTry = onProvider(structuredClone(afterHooks), {
      protocol: "anthropic",
      model: "group/coding",
      provider: { id: "anthropic", model: "claude-sonnet-4" },
    });

    const claudeJson = JSON.stringify(claudeTry);
    expect(claudeJson).not.toContain("magpie-prompt-match-carrier:");
    expect(claudeJson).toContain("全局Claude精简规则");
    expect(claudeJson).toContain("项目级Claude块：直接编辑文件");
    // Must strip GPT block and NOT double-inject Claude block
    expect(claudeJson).not.toContain("项目级GPT-6.2块");
    expect(claudeJson.match(/项目级Claude块：直接编辑文件/g)?.length).toBe(1);

    // Attempt 2: Claude fails -> Magpie falls back to GPT-6.2 starting fresh from afterHooks
    const gptTry = onProvider(structuredClone(afterHooks), {
      protocol: "anthropic",
      model: "group/coding",
      provider: { id: "openai", model: "gpt-6.2" },
    });

    const gptJson = JSON.stringify(gptTry);
    expect(gptJson).not.toContain("magpie-prompt-match-carrier:");
    expect(gptJson).toContain("全局GPT-6.2反防御性编程规则");
    expect(gptJson).toContain("项目级GPT-6.2块：不要写冗余判空");
    expect(gptJson).not.toContain("全局Claude精简规则");
    expect(gptJson).not.toContain("项目级Claude块");
    // Unwrapped in-place, never duplicated
    expect(gptJson.match(/项目级GPT-6\.2块：不要写冗余判空/g)?.length).toBe(1);

    // Completed response updates hit log with actual served model
    await onResponse({ model: "gpt-6.2" }, { state });
    const logs = hitLogStore.list(5);
    expect(logs[0].resolvedModel).toBe("gpt-6.2");
    expect(logs[0].status).toBe("matched");
    expect(logs[0].matchedRuleNames).toContain("global/gpt-6.2.md");
  });

  test("honors mode: replace in project sibling file to override global rule", async () => {
    const root = makeTmpDir();
    const globalDir = path.join(root, "global");
    const repo = path.join(root, "repo");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

    fs.writeFileSync(path.join(globalDir, "gpt-6.2.md"), "全局默认规则", "utf8");
    fs.writeFileSync(
      path.join(repo, "AGENTS.gpt-6.2.md"),
      `---\nmode: replace\n---\n项目完全接管规则`,
      "utf8"
    );

    const req = {
      model: "openai/gpt-6.2",
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [{ role: "user", content: "Implement feature" }],
    };

    const afterHooks = await onRequest(req, {
      protocol: "chat",
      model: "openai/gpt-6.2",
      agent: "codex",
      cwd: repo,
      options: { promptsDir: globalDir },
    });

    const finalBody = onProvider(afterHooks, {
      protocol: "chat",
      provider: { id: "openai", model: "gpt-6.2" },
    });

    const serialized = JSON.stringify(finalBody);
    expect(serialized).toContain("项目完全接管规则");
    expect(serialized).not.toContain("全局默认规则");
  });

  test("skips lightweight utility requests when skipUtilityRequests is enabled", async () => {
    const root = makeTmpDir();
    const globalDir = path.join(root, "global");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "gpt-6.2.md"), "编码风格规则", "utf8");

    const titleReq = {
      model: "gpt-6.2",
      max_tokens: 64,
      messages: [
        { role: "system", content: "Generate a concise title for this conversation." },
        { role: "user", content: "Help me refactor auth" },
      ],
    };

    const result = await onRequest(titleReq, {
      protocol: "chat",
      model: "gpt-6.2",
      agent: "pi",
      options: { promptsDir: globalDir, skipUtilityRequests: true },
    });

    expect(result).toBeUndefined();
    expect(hitLogStore.list(1)[0].status).toBe("skipped-utility");
  });
});
