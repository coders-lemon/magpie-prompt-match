import fs from "node:fs";
import path from "node:path";
import { hasExactModelPattern } from "./matcher.ts";
import { parseConditionalBlocks, parseFrontmatter } from "./parser.ts";
import type { PluginOptions, PromptRule, RuleScope } from "./types.ts";

interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

const fileContentCache = new Map<string, CachedFileEntry>();

export function clearDiscoveryCache(): void {
  fileContentCache.clear();
}

function readFileCached(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const cached = fileContentCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.content;
    }
    const content = fs.readFileSync(filePath, "utf8");
    fileContentCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      content,
    });
    return content;
  } catch {
    fileContentCache.delete(filePath);
    return null;
  }
}

function listMarkdownFiles(dirPath: string): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith(".md"))
      .map((e) => path.join(dirPath, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Infer model pattern from filename if frontmatter omits `models`.
 * - `gpt-6.2.md` -> ["gpt-6.2"]
 * - `AGENTS.gpt-6.2.md` -> ["gpt-6.2"]
 * - `CLAUDE.gpt-6.2.md` -> ["gpt-6.2"]
 */
export function inferModelFromFilename(
  fileName: string,
  siblingPrefixes: string[] = ["AGENTS"]
): string[] {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".md")) return [];
  const base = fileName.slice(0, -3);

  for (const prefix of siblingPrefixes) {
    const dotPrefix = `${prefix}.`;
    if (base.toLowerCase().startsWith(dotPrefix.toLowerCase())) {
      const rest = base.slice(dotPrefix.length).trim();
      return rest ? [rest] : [];
    }
  }

  return base.trim() ? [base.trim()] : [];
}

/**
 * Walk upward from `cwd` to git root (directory containing `.git`).
 * Returns directories ordered from OUTERMOST (git root) to INNERMOST (`cwd`).
 * If no `.git` is found, returns `[resolvedCwd]`.
 */
export function resolveProjectAncestors(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const chain: string[] = [];
  let current = resolved;

  while (true) {
    chain.push(current);
    const gitMarker = path.join(current, ".git");
    if (fs.existsSync(gitMarker)) {
      return chain.reverse();
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // No .git found anywhere up to filesystem root -> scope strictly to cwd
      return [resolved];
    }
    current = parent;
  }
}

function buildRuleFromMarkdownFile(
  filePath: string,
  scopeHint: "global" | "project-dir" | "project-sibling",
  depth: number,
  siblingPrefixes: string[]
): PromptRule | null {
  const raw = readFileCached(filePath);
  if (raw === null) return null;

  const { meta, body } = parseFrontmatter(raw);
  const fileName = path.basename(filePath);
  const models =
    meta.models && meta.models.length > 0
      ? meta.models
      : inferModelFromFilename(fileName, siblingPrefixes);

  if (models.length === 0) return null;

  let scope: RuleScope;
  if (scopeHint === "global") {
    scope = hasExactModelPattern(models) ? "global-exact" : "global-wildcard";
  } else {
    scope = scopeHint;
  }

  return {
    id: filePath,
    name: scopeHint === "global" ? `global/${fileName}` : fileName,
    sourcePath: filePath,
    scope,
    depth,
    models,
    agents: meta.agents && meta.agents.length > 0 ? meta.agents : ["*"],
    mode: meta.mode ?? "append",
    position: meta.position ?? "system-end",
    priority: meta.priority ?? 0,
    includeUtility: meta.includeUtility ?? false,
    enabled: meta.enabled ?? true,
    content: body,
  };
}

function discoverInstructionBlocks(
  filePath: string,
  depth: number,
  displayLabel: string
): PromptRule[] {
  const raw = readFileCached(filePath);
  if (!raw) return [];

  const blocks = parseConditionalBlocks(raw);
  return blocks.map((block, idx) => ({
    id: `${filePath}#block-${idx}`,
    name: `${displayLabel} [@model: ${block.rawMatch}]`,
    sourcePath: filePath,
    scope: "project-block" as const,
    depth,
    models: block.models,
    agents: block.agents,
    mode: block.mode,
    position: block.position,
    priority: block.priority,
    includeUtility: block.includeUtility,
    enabled: true,
    content: block.content,
    blockSignature: block.signature,
  }));
}

function findSiblingModelFiles(dirPath: string, prefixes: string[]): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const matched: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const base = entry.name.slice(0, -3);
      for (const prefix of prefixes) {
        const dotPrefix = `${prefix}.`;
        if (
          base.toLowerCase().startsWith(dotPrefix.toLowerCase()) &&
          base.length > dotPrefix.length
        ) {
          matched.push(path.join(dirPath, entry.name));
          break;
        }
      }
    }
    return matched.sort();
  } catch {
    return [];
  }
}

export interface DiscoverySnapshot {
  globalRules: PromptRule[];
  projectRules: PromptRule[];
  allRules: PromptRule[];
  scannedDirs: string[];
}

/**
 * Discover all global and project-scoped prompt rules for a given `cwd` and options.
 */
export function discoverRules(
  cwd: string | undefined,
  options: Pick<PluginOptions, "promptsDir" | "extraInstructionFiles">
): DiscoverySnapshot {
  const instructionFiles = Array.from(
    new Set(["AGENTS.md", ...(options.extraInstructionFiles || [])])
  );
  const siblingPrefixes = instructionFiles
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => f.slice(0, -3));

  const globalRules: PromptRule[] = [];
  if (options.promptsDir) {
    for (const filePath of listMarkdownFiles(options.promptsDir)) {
      const rule = buildRuleFromMarkdownFile(filePath, "global", 0, []);
      if (rule) globalRules.push(rule);
    }
  }

  const projectRules: PromptRule[] = [];
  const scannedDirs: string[] = [];

  if (cwd && fs.existsSync(cwd)) {
    const ancestors = resolveProjectAncestors(cwd);
    const rootDir = ancestors[0];

    for (let i = 0; i < ancestors.length; i++) {
      const dir = ancestors[i];
      const depth = i + 1;
      scannedDirs.push(dir);
      const relDir = path.relative(rootDir, dir) || ".";

      // 1. Instruction files (AGENTS.md + extraInstructionFiles) -> conditional blocks
      for (const instName of instructionFiles) {
        const instPath = path.join(dir, instName);
        if (fs.existsSync(instPath)) {
          const label = relDir === "." ? instName : `${relDir}/${instName}`;
          projectRules.push(...discoverInstructionBlocks(instPath, depth, label));
        }
      }

      // 2. .agents/prompts/*.md
      const projectPromptsDir = path.join(dir, ".agents", "prompts");
      for (const filePath of listMarkdownFiles(projectPromptsDir)) {
        const rule = buildRuleFromMarkdownFile(
          filePath,
          "project-dir",
          depth,
          siblingPrefixes
        );
        if (rule) {
          rule.name =
            relDir === "."
              ? `.agents/prompts/${path.basename(filePath)}`
              : `${relDir}/.agents/prompts/${path.basename(filePath)}`;
          projectRules.push(rule);
        }
      }

      // 3. Sibling model files (AGENTS.<model>.md, CLAUDE.<model>.md, ...)
      for (const filePath of findSiblingModelFiles(dir, siblingPrefixes)) {
        const rule = buildRuleFromMarkdownFile(
          filePath,
          "project-sibling",
          depth,
          siblingPrefixes
        );
        if (rule) {
          rule.name =
            relDir === "."
              ? path.basename(filePath)
              : `${relDir}/${path.basename(filePath)}`;
          projectRules.push(rule);
        }
      }
    }
  }

  return {
    globalRules,
    projectRules,
    allRules: [...globalRules, ...projectRules],
    scannedDirs,
  };
}
