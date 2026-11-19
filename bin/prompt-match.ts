#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { discoverRules } from "../src/core/discovery.ts";
import { matchesModelPatterns } from "../src/core/matcher.ts";
import { formatInjectedBlock, resolveRules } from "../src/core/resolver.ts";
import type { InjectionPosition } from "../src/core/types.ts";
import { loadMagpieModelCatalog } from "../src/model-catalog.ts";
import { resolveEffectiveOptions } from "../src/settings.ts";
import { BUILTIN_TEMPLATES, findTemplateById } from "../src/templates.ts";
import { createUiService } from "../src/ui-service.ts";

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function printHelp(): void {
  console.log(`magpie-prompt-match CLI

Usage:
  prompt-match test --model <model> [--provider <id>] [--cwd <dir>] [--agent <name>] [--utility]
  prompt-match list [--cwd <dir>]
  prompt-match models
  prompt-match init-template [template-id]
  prompt-match serve [--port <port>]

Templates:
${BUILTIN_TEMPLATES.map((t) => `  - ${t.id} (${t.fileName}): ${t.title}`).join("\n")}
`);
}

const { command, positional, flags } = parseArgs(process.argv.slice(2));
const options = resolveEffectiveOptions();

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "models") {
  const catalog = await loadMagpieModelCatalog({ forceRefresh: true });
  const discovered = discoverRules(undefined, options);
  const enabledGlobal = discovered.globalRules.filter((r) => r.enabled);

  console.log(
    `Discovered ${catalog.models.length} models (sources: ${catalog.sources.join(", ") || "none"})\n`
  );
  if (catalog.models.length === 0) {
    console.log("No Magpie models found.");
    process.exit(0);
  }
  for (const m of catalog.models) {
    const matched = enabledGlobal
      .filter((r) =>
        matchesModelPatterns(r.models, {
          provider: m.isGroup ? undefined : m.provider,
          model: m.isGroup ? m.id : m.model,
          requestedModel: m.id,
        })
      )
      .map((r) => r.name);
    const suffix = matched.length ? `  -> [${matched.join(", ")}]` : "";
    console.log(`  ${m.id}${suffix}`);
  }
  process.exit(0);
}

if (command === "list") {
  const cwd = typeof flags.cwd === "string" ? path.resolve(flags.cwd) : process.cwd();
  const snapshot = discoverRules(cwd, options);
  console.log(`Global dir: ${options.promptsDir}`);
  console.log(`Scanned project dirs: ${snapshot.scannedDirs.join(" -> ") || "(none)"}\n`);

  if (snapshot.allRules.length === 0) {
    console.log("No prompt rules discovered.");
    process.exit(0);
  }

  for (const r of snapshot.allRules) {
    console.log(
      `[${r.scope}] ${r.name} | models=${r.models.join(",")} | agents=${r.agents.join(",")} | mode=${r.mode} | pos=${r.position} | enabled=${r.enabled}`
    );
  }
  process.exit(0);
}

if (command === "init-template") {
  const id = positional[0] || "gpt-6.2-anti-defensive";
  const template = findTemplateById(id) || BUILTIN_TEMPLATES.find((t) => t.fileName === `${id}.md`);
  if (!template) {
    console.error(`Unknown template "${id}". Available: ${BUILTIN_TEMPLATES.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }
  fs.mkdirSync(options.promptsDir, { recursive: true });
  const targetPath = path.join(options.promptsDir, template.fileName);
  fs.writeFileSync(targetPath, template.content, "utf8");
  console.log(`Created ${targetPath}`);
  process.exit(0);
}

if (command === "test") {
  const model = typeof flags.model === "string" ? flags.model : positional[0] || "";
  if (!model) {
    console.error("Missing --model <model>.");
    process.exit(1);
  }
  const provider = typeof flags.provider === "string" ? flags.provider : undefined;
  const cwd = typeof flags.cwd === "string" ? path.resolve(flags.cwd) : process.cwd();
  const agent = typeof flags.agent === "string" ? flags.agent : undefined;
  const isUtility = Boolean(flags.utility);

  const snapshot = discoverRules(cwd, options);
  const plan = resolveRules(snapshot.allRules, {
    provider,
    model,
    agent,
    isUtility,
  });

  console.log(`Target: ${provider ? `${provider}/` : ""}${model} (agent=${agent || "*"}, cwd=${cwd})`);
  console.log(`Candidates: ${snapshot.allRules.length}, Matched: ${plan.matchedRules.length}`);
  if (plan.matchedRules.length > 0) {
    console.log("\nMatched rules (in application order):");
    for (const r of plan.matchedRules) {
      console.log(`  - ${r.name} [${r.scope}, mode=${r.mode}, position=${r.position}]`);
    }
    const label = provider ? `${provider}/${model}` : model;
    for (const pos of ["system-start", "system-end", "developer-reminder"] as InjectionPosition[]) {
      const text = formatInjectedBlock(plan.byPosition[pos], pos, label);
      if (text) {
        console.log(`\n=== [${pos}] ===\n${text}`);
      }
    }
  }
  process.exit(0);
}

if (command === "serve") {
  const port = typeof flags.port === "string" ? Number(flags.port) : options.uiPort;
  const handle = await createUiService({ port });
  console.log(`Prompt Match UI listening on http://127.0.0.1:${handle.port}/`);
  // Keep process alive when launched explicitly via CLI
  await new Promise(() => {});
}

console.error(`Unknown command: ${command}`);
printHelp();
process.exit(1);
