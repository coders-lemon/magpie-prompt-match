import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearDiscoveryCache,
  discoverRules,
  resolveProjectAncestors,
} from "../src/core/discovery.ts";

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-disc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearDiscoveryCache();
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("discovery", () => {
  test("walks from cwd up to git root in outer-to-inner order", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, ".git"));
    const sub = path.join(root, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });

    const ancestors = resolveProjectAncestors(sub);
    expect(ancestors).toEqual([root, path.join(root, "packages"), sub]);
  });

  test("discovers global, root AGENTS.md blocks, .agents/prompts, and sibling files + hot reloads", () => {
    const root = makeTmpDir();
    const globalDir = path.join(root, "global-prompts");
    const repo = path.join(root, "repo");
    const sub = path.join(repo, "apps", "api");

    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".agents", "prompts"), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });

    fs.writeFileSync(path.join(globalDir, "gpt-6*.md"), "全局通配规则", "utf8");
    fs.writeFileSync(path.join(globalDir, "gpt-6.2.md"), "全局精确规则", "utf8");
    fs.writeFileSync(
      path.join(repo, "AGENTS.md"),
      "通用\n<!-- @model: gpt-6.2 -->\n根项目块\n<!-- @end -->",
      "utf8"
    );
    fs.writeFileSync(
      path.join(repo, ".agents", "prompts", "custom.md"),
      `---\nmodels: ["gpt-6.2"]\n---\n项目目录规则`,
      "utf8"
    );
    fs.writeFileSync(path.join(sub, "AGENTS.gpt-6.2.md"), "子目录同级覆盖", "utf8");

    const snap1 = discoverRules(sub, {
      promptsDir: globalDir,
      extraInstructionFiles: ["CLAUDE.md"],
    });

    expect(snap1.globalRules.length).toBe(2);
    expect(snap1.projectRules.length).toBe(3);
    expect(snap1.globalRules.find((r) => r.name.includes("gpt-6*"))?.scope).toBe(
      "global-wildcard"
    );
    expect(snap1.globalRules.find((r) => r.name.includes("gpt-6.2"))?.scope).toBe(
      "global-exact"
    );

    // Hot reload check: modify file and verify updated content is read
    const subFile = path.join(sub, "AGENTS.gpt-6.2.md");
    fs.writeFileSync(subFile, "子目录同级覆盖-v2-热更新", "utf8");
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(subFile, future, future);

    const snap2 = discoverRules(sub, {
      promptsDir: globalDir,
      extraInstructionFiles: ["CLAUDE.md"],
    });
    const updated = snap2.projectRules.find((r) => r.sourcePath === subFile);
    expect(updated?.content).toBe("子目录同级覆盖-v2-热更新");
  });
});
