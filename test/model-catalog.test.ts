import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HitLogStore } from "../src/hit-log.ts";
import {
  clearModelCatalogCache,
  loadMagpieModelCatalog,
  loadModelsFromMagpieConfigDir,
  parseGatewayModelsPayload,
  parseMagpieModelsCliOutput,
} from "../src/model-catalog.ts";

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cat-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearModelCatalogCache();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("model-catalog", () => {
  test("parses magpie models CLI output including routing groups and ignores gateway URL", () => {
    const sample = `
  Routing groups
  group/deeepseek-flash                 deeepseek-flash  low/high
  Codex
  codex/gpt-6-luna                      GPT-6-Luna  low/medium/high/xhigh/max
  antigravity-bridge/gemini-4-hydrogen  Gemini 4 Hydrogen  low/medium/high/xhigh
  http://127.0.0.1:3425/v1
  magpie: ignoring noise
`;
    const parsed = parseMagpieModelsCliOutput(sample);
    expect(parsed.map((m) => m.id)).toEqual([
      "group/deeepseek-flash",
      "codex/gpt-6-luna",
      "antigravity-bridge/gemini-4-hydrogen",
    ]);
    expect(parsed[0].isGroup).toBe(true);
    expect(parsed[1].provider).toBe("codex");
    expect(parsed[1].model).toBe("gpt-6-luna");
    expect(parsed[1].label).toBe("GPT-6-Luna");
    expect(parsed[2].label).toBe("Gemini 4 Hydrogen");
  });

  test("parses OpenAI-compatible gateway /v1/models payload", () => {
    const parsed = parseGatewayModelsPayload({
      object: "list",
      data: [
        { id: "codex/gpt-6-luna", name: "GPT-6-Luna" },
        { id: "group/deeepseek-flash" },
        { id: "gpt-6.2", owned_by: "openai" },
      ],
    });
    expect(parsed.map((m) => m.id)).toEqual([
      "codex/gpt-6-luna",
      "group/deeepseek-flash",
      "openai/gpt-6.2",
    ]);
    expect(parsed[1].isGroup).toBe(true);
  });

  test("extracts models and routing groups from Magpie config JSONs without exposing secrets", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "openai",
            apiKey: "sk-super-secret",
            models: [{ id: "gpt-6.2", name: "GPT-6.2" }, "gpt-6.2-mini"],
          },
        ],
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "plugin-providers.json"),
      JSON.stringify({
        "antigravity-bridge": {
          id: "antigravity-bridge",
          models: [{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        groups: [{ id: "coding", name: "Coding Group" }],
      }),
      "utf8"
    );

    const models = loadModelsFromMagpieConfigDir(dir);
    expect(models.map((m) => m.id)).toEqual([
      "openai/gpt-6.2",
      "openai/gpt-6.2-mini",
      "antigravity-bridge/gemini-4-hydrogen",
      "group/coding",
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-super-secret");
  });

  test("merges config models with recently observed HitLog models", async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, "providers.json"),
      JSON.stringify([{ id: "openai", models: ["gpt-6.2"] }]),
      "utf8"
    );
    const logs = new HitLogStore();
    logs.record({
      id: "1",
      timestamp: new Date().toISOString(),
      agent: "pi",
      cwd: "/tmp",
      protocol: "anthropic",
      requestedModel: "group/fast",
      resolvedModel: "deepseek/deepseek-chat",
      stage: "response",
      status: "matched",
      matchedRuleNames: [],
      strippedBlocks: 0,
      injectedBytes: 0,
    });

    const snap = await loadMagpieModelCatalog({
      env: { ...process.env, MAGPIE_CONFIG_DIR: dir },
      logs,
      skipCli: true,
      skipGateway: true,
      forceRefresh: true,
    });

    expect(snap.models.map((m) => m.id)).toContain("openai/gpt-6.2");
    expect(snap.models.map((m) => m.id)).toContain("deepseek/deepseek-chat");
    expect(snap.groups).toContain("group/fast");
    expect(snap.providers).toEqual(["deepseek", "openai"]);
  });
});
