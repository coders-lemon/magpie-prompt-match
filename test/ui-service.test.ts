import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearDiscoveryCache } from "../src/core/discovery.ts";
import { HitLogStore } from "../src/hit-log.ts";
import {
  CAPABILITY_HEADER,
  createUiService,
  type UiServiceHandle,
} from "../src/ui-service.ts";

const tempDirs: string[] = [];
const services: UiServiceHandle[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-ui-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearDiscoveryCache();
  while (services.length > 0) {
    await services.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ui-service", () => {
  test("enforces capability token, manages rules/templates, and runs dry-run match test", async () => {
    const root = makeTmpDir();
    fs.writeFileSync(
      path.join(root, "providers.json"),
      JSON.stringify({
        providers: [
          { id: "openai", models: ["gpt-6.2", "gpt-6.2-mini"] },
          { id: "antigravity-bridge", models: ["gemini-4-hydrogen"] },
        ],
      }),
      "utf8"
    );
    const env = { ...process.env, MAGPIE_CONFIG_DIR: root };
    const logs = new HitLogStore();

    const handle = await createUiService({
      port: 0,
      env,
      logs,
      skipCliCatalog: true,
      skipGatewayCatalog: true,
    });
    services.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;

    // 1. HTML page serves cleanly and embeds capability token
    const htmlRes = await fetch(`${base}/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain(handle.capability);

    // 1b. Sandboxed iframe CORS preflight (Origin: null) succeeds with 204, external origin denied
    const preflight = await fetch(`${base}/api/status`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
        "access-control-request-headers": CAPABILITY_HEADER,
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      CAPABILITY_HEADER
    );

    const evilOrigin = await fetch(`${base}/api/status`, {
      headers: {
        origin: "https://evil.example",
        [CAPABILITY_HEADER]: handle.capability,
      },
    });
    expect(evilOrigin.status).toBe(403);

    // 2. API without capability token is rejected with 403
    const unauth = await fetch(`${base}/api/status`);
    expect(unauth.status).toBe(403);

    const headers = {
      "content-type": "application/json",
      [CAPABILITY_HEADER]: handle.capability,
    };

    // 3. Create GPT-6.2 template via API
    const tplRes = await fetch(`${base}/api/templates/gpt-6.2-anti-defensive`, {
      method: "POST",
      headers,
    });
    expect(tplRes.status).toBe(200);

    // 4. Reject path traversal filenames
    const badSave = await fetch(`${base}/api/rules`, {
      method: "POST",
      headers,
      body: JSON.stringify({ fileName: "../evil.md", content: "bad" }),
    });
    expect(badSave.status).toBe(400);

    // 5. Run dry-run match test
    const testRes = await fetch(`${base}/api/test`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-6.2",
        agent: "pi",
        protocol: "anthropic",
        sampleSystemPrompt:
          "Base\n<!-- @model: claude-* -->\nOnly Claude\n<!-- @end -->",
      }),
    });
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as {
      matchedRules: Array<{ name: string }>;
      strippedInlineBlocks: number;
      rewrittenSampleSystem: string;
      previews: Record<string, string>;
    };
    expect(testJson.matchedRules.some((r) => r.name === "global/gpt-6.2.md")).toBe(true);
    expect(testJson.strippedInlineBlocks).toBe(1);
    expect(testJson.rewrittenSampleSystem).not.toContain("Only Claude");
    expect(testJson.previews["system-end"]).toContain("防御性编程");

    // 6. Model catalog endpoint returns Magpie models with rule coverage metadata
    const modelsRes = await fetch(`${base}/api/models?refresh=1`, { headers });
    expect(modelsRes.status).toBe(200);
    const modelsJson = (await modelsRes.json()) as {
      providers: string[];
      models: Array<{ id: string; matchedRules: string[] }>;
    };
    expect(modelsJson.providers).toEqual(["antigravity-bridge", "openai"]);
    const gptEntry = modelsJson.models.find((m) => m.id === "openai/gpt-6.2");
    const geminiEntry = modelsJson.models.find(
      (m) => m.id === "antigravity-bridge/gemini-4-hydrogen"
    );
    expect(gptEntry?.matchedRules).toContain("global/gpt-6.2.md");
    expect(geminiEntry?.matchedRules).toEqual([]);
  });
});
